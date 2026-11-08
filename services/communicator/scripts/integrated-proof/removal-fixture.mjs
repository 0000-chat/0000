import { archiveCanonicalEventBatch } from "../../apps/control-plane/worker/archive/writer.ts";
import { readRestoreReplayPage } from "../../apps/control-plane/worker/archive/replay.ts";
import {
  readCommittedArchiveBatch,
  readReplayPage,
} from "../../apps/control-plane/worker/archive/reader.ts";
import { sha256Hex } from "../../apps/control-plane/worker/archive/codec.ts";
import { runWebhookRetryTick } from "../../apps/control-plane/worker/webhooks/delivery.ts";
import { recordRemovalWithArchivePurge } from "../../apps/control-plane/worker/archive/lifecycle.ts";
import { listRemovalAuthorities } from "../../apps/control-plane/worker/removals/ledger.ts";
import { deriveArchiveKeys } from "../../apps/control-plane/worker/archive/keys.ts";
import { isArchiveError } from "../../apps/control-plane/worker/archive/errors.ts";
import { restoreTenantProjectionFromArchive } from "../../apps/control-plane/worker/restore/activation.ts";
import { ProjectionErrorCodeSchema } from "../../packages/contracts/src/projection.ts";

const tenant = "tenant_pilot";
const conversation = "conversation_removal_proof";
const message = "message_removal_proof";
const attachment = "attachment_removal_proof";
const timestamp = "2026-08-29T01:00:00.000Z";
const secretBody = "Controlled removal proof body must not resurrect";
const auth = (scopes) => ({
  schema_version: 1,
  tenant_id: tenant,
  principal_id: "principal_human",
  allowed_identity_ids: ["identity_human"],
  scopes,
});
const connections = [
  {
    account_id: "account_human",
    connection_id: "connection_human_whatsapp",
    identity_id: "identity_human",
    platform: "whatsapp",
  },
];
const envelope = (id, type, payload) => ({
  schema_version: 1,
  event_id: id,
  event_type: type,
  event_source: "live",
  tenant_id: tenant,
  identity_id: "identity_human",
  platform: "whatsapp",
  account_id: "account_human",
  conversation_id: conversation,
  matrix_room_id: "!integrated:example.test",
  matrix_event_id: `$${id}:example.test`,
  remote_message_id: null,
  occurred_at: timestamp,
  observed_at: timestamp,
  payload,
});
const apply = (projection, events) =>
  projection.applyBatch({
    schema_version: 1,
    tenant_id: tenant,
    authorization: auth(["projection.write"]),
    mode: "live",
    rebuild_id: null,
    connections,
    events,
    checkpoint: null,
  });

// Wire only in the local fixture wrapper, before delegating to production:
// if (pathname.startsWith('/__fixture/removal/')) return handleRemovalFixture(request, env);
// No production auth, network transport, or send-authority implementation is replaced.
export async function handleRemovalFixture(request, env) {
  const operation = new URL(request.url).pathname.replace(
    "/__fixture/removal/",
    "",
  );
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const projection = env.TENANT_PROJECTION.getByName(tenant);
  if (operation === "archive-owner-coverage") {
    // Compare the actual durable ledger with committed canonical sources.
    const commands = await projection.inspectRetainedOwners();
    const authorities = await listRemovalAuthorities(env.CONTROL_DB, tenant);
    const owners = new Set();
    let cursor;
    let archivedEvents = 0;
    do {
      const page = await readReplayPage(
        env.EVENT_ARCHIVE,
        tenant,
        cursor ? { cursor } : undefined,
      );
      archivedEvents += page.events.length;
      for (const event of page.events)
        if (event.event_type === "conversation.updated")
          owners.add(
            JSON.stringify([
              event.identity_id,
              event.account_id,
              event.conversation_id,
            ]),
          );
      cursor = page.next_cursor;
    } while (cursor);
    return Response.json({
      archived_event_count: archivedEvents,
      retained_ledger_count: commands.length,
      ledger_owners: commands.map((command) => ({
        command_id: command.command_id,
        conversation_id: command.conversation_id,
        account_id: command.account_id,
        connection_id: command.connection_id,
        resource_identity_id: command.resource_identity_id,
        derived_owner_present: Boolean(command.derived_owner_present),
        currently_removed: authorities.some(
          (authority) =>
            authority.resource_type === "conversation" &&
            authority.resource_id === command.conversation_id,
        ),
        immutable_source_owner_present: owners.has(
          JSON.stringify([
            command.resource_identity_id,
            command.account_id,
            command.conversation_id,
          ]),
        ),
      })),
    });
  }
  if (operation === "status") {
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(["projection.status"]),
    });
    const authorities = await listRemovalAuthorities(env.CONTROL_DB, tenant);
    return Response.json({
      ...status,
      removal_authorities: authorities.map(
        ({
          id,
          tenant_id,
          resource_type,
          resource_id,
          content_generation,
          deletion_epoch,
          account_id,
          conversation_id,
        }) => ({
          id,
          tenant_id,
          resource_type,
          resource_id,
          content_generation,
          deletion_epoch,
          account_id,
          conversation_id,
        }),
      ),
    });
  }
  if (operation === "trace-restore-failure") {
    const stages = [];
    const safeProjectionCode = (error) => {
      for (const code of ProjectionErrorCodeSchema.options)
        if (error?.code === code || error?.message === code) return code;
      return isArchiveError(error) ? error.code : "unknown_error";
    };
    const traced = new Proxy(projection, {
      get(target, name) {
        return async (...args) => {
          const stage = { stage: String(name), complete: false };
          if (name === "applyReplayPage")
            Object.assign(stage, {
              manifest_count: args[0].page.manifests.length,
              manifest_event_count: args[0].page.manifests.reduce(
                (total, manifest) => total + manifest.event_count,
                0,
              ),
              sanitized_event_count: args[0].page.events.length,
            });
          stages.push(stage);
          try {
            const result = await target[name](...args);
            stage.complete = true;
            return result;
          } catch (error) {
            stage.code = safeProjectionCode(error);
            if (name === "completeRebuild")
              stage.retained_owner_rows_before_abort =
                await projection.inspectRetainedOwners();
            throw error;
          }
        };
      },
    });
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(["projection.status"]),
    });
    const now = new Date().toISOString();
    const tracedEnv = new Proxy(env, {
      get(target, name) {
        return name === "TENANT_PROJECTION"
          ? { getByName: () => traced }
          : Reflect.get(target, name);
      },
    });
    try {
      await restoreTenantProjectionFromArchive({
        env: tracedEnv,
        tenantId: tenant,
        principalId: "principal_human",
        rebuildId: "integrated_restore_failure_probe",
        expectedGeneration: status.generation,
        startedAt: now,
        completedAt: now,
      });
      return Response.json({ completed: true, stages });
    } catch (error) {
      return Response.json({
        completed: false,
        code: safeProjectionCode(error),
        stages,
        retained_owner_rows: await projection.inspectRetainedOwners(),
        removed_conversations: (
          await listRemovalAuthorities(env.CONTROL_DB, tenant)
        )
          .filter((authority) => authority.resource_type === "conversation")
          .map((authority) => authority.resource_id),
      });
    }
  }
  if (operation === "restore-diagnostics") {
    const safeCode = (error) =>
      isArchiveError(error) ? error.code : "non_archive_error";
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(["projection.status"]),
    });
    const fixtureKeys = deriveArchiveKeys(
      tenant,
      "batch_removal_proof_before",
      timestamp,
    );
    const manifests = [];
    let cursor;
    do {
      const listed = await env.EVENT_ARCHIVE.list({
        prefix: `manifests/${tenant}/`,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of listed.objects) {
        const fact = {
          fixture_original: object.key === fixtureKeys.manifestKey,
          data_present: false,
          committed_read: false,
        };
        try {
          const manifest = await env.EVENT_ARCHIVE.get(object.key);
          const body = await manifest.json();
          fact.data_present =
            typeof body.data_key === "string" &&
            (await env.EVENT_ARCHIVE.head(body.data_key)) !== null;
          await readCommittedArchiveBatch(
            env.EVENT_ARCHIVE,
            tenant,
            object.key,
          );
          fact.committed_read = true;
        } catch (error) {
          fact.code = safeCode(error);
        }
        manifests.push(fact);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    const stages = [];
    for (const [stage, read] of [
      [
        "raw_archive_pages",
        (options) => readReplayPage(env.EVENT_ARCHIVE, tenant, options),
      ],
      [
        "authority_filtered_pages",
        (options) =>
          readRestoreReplayPage(
            env.EVENT_ARCHIVE,
            env.CONTROL_DB,
            tenant,
            options,
          ),
      ],
    ]) {
      let pages = 0;
      let next;
      try {
        do {
          const page = await read(next ? { cursor: next } : undefined);
          pages += 1;
          next = page.next_cursor;
        } while (next && pages < 100);
        stages.push({ stage, complete: next === null, pages });
      } catch (error) {
        stages.push({ stage, complete: false, pages, code: safeCode(error) });
      }
    }
    const purgeRows = await env.CONTROL_DB.prepare(
      "SELECT original_manifest_key, original_data_key, state, manifest_deleted_at, data_deleted_at FROM archive_purge_objects WHERE tenant_id = ?",
    )
      .bind(tenant)
      .all();
    const purgeObjects = [];
    for (const row of purgeRows.results)
      purgeObjects.push({
        fixture_original: row.original_manifest_key === fixtureKeys.manifestKey,
        state: row.state,
        manifest_deletion_recorded: row.manifest_deleted_at !== null,
        data_deletion_recorded: row.data_deleted_at !== null,
        manifest_present:
          (await env.EVENT_ARCHIVE.head(row.original_manifest_key)) !== null,
        data_present:
          (await env.EVENT_ARCHIVE.head(row.original_data_key)) !== null,
      });
    return Response.json({
      projection_state: status.state,
      generation: status.generation,
      last_rebuild_failure_code: status.last_rebuild_failure_code,
      manifests,
      stages,
      purge_objects: purgeObjects,
    });
  }
  if (operation === "seed") {
    const bytes = new TextEncoder().encode("Controlled removal proof file");
    const sha256 = await sha256Hex(bytes);
    const mediaKey = `media/${tenant}/${sha256}`;
    await env.EVENT_ARCHIVE.put(mediaKey, bytes);
    const events = [
      envelope("event_removal_conversation", "conversation.updated", {
        title: "Removal proof",
        archived: false,
        muted: false,
      }),
      envelope("event_removal_message", "message.created", {
        message_id: message,
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Removal proof sender",
        body: secretBody,
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: true,
      }),
      envelope("event_removal_attachment", "attachment.observed", {
        attachment_id: attachment,
        message_id: message,
        file_name: "removal-proof.txt",
        mime_type: "text/plain",
        size_bytes: bytes.byteLength,
        sha256,
        r2_key: mediaKey,
        expires_at: null,
      }),
    ];
    await apply(projection, events);
    const archived = await archiveCanonicalEventBatch({
      bucket: env.EVENT_ARCHIVE,
      tenantId: tenant,
      batchId: "batch_removal_proof_before",
      events,
      archivedAt: timestamp,
      producerVersion: "integrated-removal-proof/1",
      sourceCheckpoint: null,
    });
    const committed = await readCommittedArchiveBatch(
      env.EVENT_ARCHIVE,
      tenant,
      archived.manifestKey,
    );
    return Response.json({
      manifest_key: archived.manifestKey,
      media_key: mediaKey,
      archived_events: committed.events.length,
      original_body_archived: committed.events.some(
        (event) => event.payload.body === secretBody,
      ),
      original_file_present: (await env.EVENT_ARCHIVE.head(mediaKey)) !== null,
    });
  }
  if (operation === "copy-source") {
    // Capture actual original archive/file bytes before removal, not invented
    // successful retention evidence. The Node proof keeps this private; only
    // body-free facts may be returned from its observe callbacks.
    const keys = deriveArchiveKeys(
      tenant,
      "batch_removal_proof_before",
      timestamp,
    );
    const committed = await readCommittedArchiveBatch(
      env.EVENT_ARCHIVE,
      tenant,
      keys.manifestKey,
    );
    const attachmentEvent = committed.events.find(
      (event) =>
        event.event_type === "attachment.observed" &&
        event.payload.attachment_id === attachment,
    );
    if (!attachmentEvent)
      throw new Error("controlled archive attachment missing");
    const file = await env.EVENT_ARCHIVE.get(attachmentEvent.payload.r2_key);
    if (!file)
      throw new Error("controlled original file missing before removal");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if ((await sha256Hex(bytes)) !== attachmentEvent.payload.sha256)
      throw new Error("controlled file digest mismatch");
    return Response.json({ events: committed.events, file_bytes: [...bytes] });
  }
  if (operation === "remove") {
    const result = await recordRemovalWithArchivePurge(
      { database: env.CONTROL_DB, bucket: env.EVENT_ARCHIVE },
      {
        tenant_id: tenant,
        resource_type: "conversation",
        resource_id: conversation,
        content_generation: conversation,
        account_id: "account_human",
        conversation_id: conversation,
        source_event_id: null,
        source_object_key: null,
        reason: "requested",
      },
    );
    return Response.json({
      deletion_epoch: result.authority.deletion_epoch,
      authority_id: result.authority.id,
      archive_status: result.archive.status,
    });
  }
  if (operation === "replay") {
    const { manifest_key: manifestKey } = await request.json();
    const stale = await readCommittedArchiveBatch(
      env.EVENT_ARCHIVE,
      tenant,
      manifestKey,
    );
    // Apply the actual decoded pre-removal archive to SQLite as a hostile late
    // import, then independently drive the production restore page reader.
    await apply(projection, stale.events);
    const late = envelope("event_removal_late_edit", "message.edited", {
      message_id: message,
      body: secretBody,
      editor_participant_id: null,
    });
    await apply(projection, [late]);
    const pages = [];
    let cursor;
    do {
      const page = await readRestoreReplayPage(
        env.EVENT_ARCHIVE,
        env.CONTROL_DB,
        tenant,
        cursor ? { cursor } : undefined,
      );
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor);
    const projected = await projection.getWebhookMessage({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_human",
      account_id: "account_human",
      conversation_id: conversation,
      message_id: message,
      authorization: auth(["projection.read"]),
    });
    const file = await projection.getAttachment({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_human",
      attachment_id: attachment,
      authorization: auth(["projection.read"]),
    });
    return Response.json({
      raw_archive_still_has_body: stale.events.some(
        (event) => event.payload.body === secretBody,
      ),
      restore_has_body: pages
        .flatMap((page) => page.events)
        .some((event) => event.payload.body === secretBody),
      restore_has_attachment: pages
        .flatMap((page) => page.events)
        .some((event) => JSON.stringify(event.payload).includes(attachment)),
      removed_events: pages.flatMap((page) => page.evidence.removed_event_ids),
      deletion_epoch: pages.at(-1).evidence.deletion_epoch,
      tombstones_reapplied: pages.reduce(
        (total, page) => total + page.evidence.tombstones_reapplied.length,
        0,
      ),
      projected_body_empty: projected === null || projected.body === "",
      projected_file_redacted:
        file === null || (file.deleted_at !== null && file.media_key === null),
    });
  }
  if (operation === "post-activation-webhook") {
    await env.CONTROL_DB.prepare(
      "UPDATE webhook_deliveries SET status = 'pending', cancellation_reason = NULL, cancelled_at = NULL WHERE id = ? AND tenant_id = ?",
    )
      .bind("delivery_removal_proof", tenant)
      .run();
    await runWebhookRetryTick({
      database: env.CONTROL_DB,
      projectionForTenant: (id) => env.TENANT_PROJECTION.getByName(id),
    });
    const row = await env.CONTROL_DB.prepare(
      "SELECT status, cancellation_reason, provider_request_started_at, http_status FROM webhook_deliveries WHERE id = ? AND tenant_id = ?",
    )
      .bind("delivery_removal_proof", tenant)
      .first();
    if (!row) throw new Error("controlled removal webhook row missing");
    return Response.json({
      status: row.status,
      cancellation_reason: row.cancellation_reason,
      provider_request_started: row.provider_request_started_at !== null,
      http_status: row.http_status,
    });
  }
  if (operation === "webhook-tick") {
    const result = await runWebhookRetryTick({
      database: env.CONTROL_DB,
      projectionForTenant: (id) => env.TENANT_PROJECTION.getByName(id),
    });
    return Response.json(result);
  }
  return new Response(null, { status: 404 });
}
