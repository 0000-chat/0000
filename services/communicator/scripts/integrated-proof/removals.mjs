import assert from "node:assert/strict";

const tenant = "tenant_pilot";
const conversation = "conversation_removal_proof";
const message = "message_removal_proof";
const attachment = "attachment_removal_proof";
const query = "identity_id=identity_agent&account_id=account_human";
let originalRemovalCopy;
let restoreOriginalArchive;

export async function runRemovalProof({
  observe,
  api,
  humanApi,
  getRuntime,
  fixtureCall,
}) {
  const db = await getRuntime().getD1Database("CONTROL_DB", "communicator");
  let archive;
  let savedArchive;
  let oldGrant;
  let accepted;
  let removal;
  const subscription = "subscription_removal_proof";
  const delivery = "delivery_removal_proof";
  const fixture = async (operation, input = {}) => {
    const result = await fixtureCall(`/__fixture/removal/${operation}`, input);
    assert.equal(
      result.status,
      200,
      `removal fixture ${operation} must execute`,
    );
    return result.body;
  };
  const send = () =>
    api(
      `/api/v1/conversations/${conversation}/messages`,
      {
        identity_id: "identity_agent",
        account_id: "account_human",
        body: "Controlled removal proof outbound",
        delivery_mode: "direct",
      },
      { "idempotency-key": "removal-proof-send" },
    );

  await observe("removal-preconditions-real-stores", async () => {
    archive = await fixture("seed");
    assert.equal(archive.archived_events, 3);
    assert.equal(archive.original_body_archived, true);
    assert.equal(archive.original_file_present, true);
    originalRemovalCopy = await fixture("copy-source");
    assert.equal(originalRemovalCopy.events.length, 3);
    assert.ok(originalRemovalCopy.file_bytes.length > 0);
    // Snapshot exact R2 bytes and metadata before the production purge. Replay
    // restores these bytes, not a synthesized or already-sanitized archive.
    const bucket = await getRuntime().getR2Bucket(
      "EVENT_ARCHIVE",
      "communicator",
    );
    const manifest = await bucket.get(archive.manifest_key);
    assert.ok(manifest);
    const manifestBody = await manifest.json();
    savedArchive = [];
    for (const key of [archive.manifest_key, manifestBody.data_key]) {
      const object = await bucket.get(key);
      assert.ok(object);
      savedArchive.push({
        key,
        bytes: await object.arrayBuffer(),
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
      });
    }
    restoreOriginalArchive = async () => {
      const currentBucket = await getRuntime().getR2Bucket(
        "EVENT_ARCHIVE",
        "communicator",
      );
      // Publish the exact saved data before its manifest, as a coherent
      // hostile pre-removal snapshot. Never rewrite the purge ledger.
      for (const object of savedArchive.slice().reverse())
        await currentBucket.put(object.key, object.bytes, {
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
        });
      return archive.manifest_key;
    };
    const read = await api(
      `/api/v1/conversations/${conversation}/messages?${query}`,
    );
    assert.equal(read.status, 200);
    assert.ok(JSON.stringify(read.body).includes(message));
    const metadata = await api(`/api/v1/attachments/${attachment}?${query}`);
    assert.equal(metadata.status, 200);
    oldGrant = metadata.body.download_grant;
    assert.ok(
      oldGrant,
      "pre-removal metadata must issue a real download grant",
    );
    accepted = await send();
    assert.equal(
      accepted.status,
      202,
      "send must use current real Platform authority",
    );
    return {
      d1: true,
      sqlite_projection: true,
      r2_original_archive: true,
      r2_original_file: true,
      authenticated_metadata_grant: true,
      fresh_authorized_send_status: 202,
    };
  });

  await observe("removal-pending-webhook-fixture", async () => {
    const now = new Date().toISOString();
    const deadline = new Date(Date.now() + 86_400_000).toISOString();
    await db
      .prepare(
        `INSERT INTO webhook_subscriptions (id, tenant_id, creation_idempotency_key, owner_installation_id, owner_principal_id, creator_principal_id, creator_membership_id, creator_identity_id, logical_agent_id, ownership_mode, destination_url, destination_credential_ref, destination_version, event_filter_json, global_enabled, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, NULL, 'principal_human', 'principal_human', 'membership_human', 'identity_human', NULL, 'human_owner', 'https://removal-proof.invalid/hook', NULL, 1, ?, 1, 'active', ?, ?, NULL)`,
      )
      .bind(
        subscription,
        tenant,
        subscription,
        JSON.stringify({ event_types: ["message.created"] }),
        now,
        now,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO webhook_deliveries (id, tenant_id, subscription_id, source_event_id, source_message_id, source_identity_id, source_account_id, source_conversation_id, source_revision, destination_version, status, first_pending_at, retry_deadline, attempt_count) VALUES (?, ?, ?, 'event_removal_message', ?, 'identity_human', 'account_human', ?, 'event_removal_message', 1, 'pending', ?, ?, 0)`,
      )
      .bind(
        delivery,
        tenant,
        subscription,
        message,
        conversation,
        now,
        deadline,
      )
      .run();
    assert.equal(
      (
        await db
          .prepare("SELECT status FROM webhook_deliveries WHERE id = ?")
          .bind(delivery)
          .first()
      ).status,
      "pending",
    );
    return {
      pending_delivery_persisted_in_d1: true,
      fixture_only_destination: true,
    };
  });

  await observe(
    "removal-retained-ledger-immutable-owner-coverage",
    async () => {
      const coverage = await fixture("archive-owner-coverage");
      assert.ok(coverage.retained_ledger_count > 1);
      assert.ok(coverage.archived_event_count >= 5);
      assert.ok(
        coverage.ledger_owners.some(
          (owner) => owner.conversation_id === "conversation_integrated",
        ),
      );
      assert.ok(
        coverage.ledger_owners.some(
          (owner) => owner.conversation_id === conversation,
        ),
      );
      for (const owner of coverage.ledger_owners) {
        assert.equal(owner.immutable_source_owner_present, true);
        assert.equal(owner.account_id, "account_human");
        assert.equal(owner.connection_id, "connection_human_whatsapp");
        assert.equal(owner.resource_identity_id, "identity_human");
      }
      return coverage;
    },
  );

  await observe("removal-authority-production-lifecycle", async () => {
    const denied = await api("/api/v1/removals", {
      tenant_id: tenant,
      resource_type: "conversation",
      resource_id: conversation,
      content_generation: conversation,
      account_id: "account_human",
      conversation_id: conversation,
      source_event_id: null,
      source_object_key: null,
      reason: "requested",
    });
    assert.equal(
      denied.status,
      403,
      "managed agent must not gain human administrator authority",
    );
    const authorized = await humanApi("/api/v1/removals", {
      tenant_id: tenant,
      resource_type: "conversation",
      resource_id: conversation,
      content_generation: conversation,
      account_id: "account_human",
      conversation_id: conversation,
      source_event_id: null,
      source_object_key: null,
      reason: "requested",
    });
    assert.equal(authorized.status, 201);
    removal = authorized.body;
    assert.ok(removal.deletion_epoch > 0);
    return {
      managed_agent_http_status: 403,
      human_http_status: 201,
      deletion_epoch: removal.deletion_epoch,
      authority_source: "actual session-lineaged human administrator HTTP",
    };
  });

  await observe("removal-old-download-grant-denied", async () => {
    assert.ok(oldGrant);
    assert.ok(removal?.deletion_epoch);
    const result = await api(
      `/api/v1/attachments/${attachment}/download`,
      undefined,
      { "x-communicator-download-grant": oldGrant },
    );
    assert.equal(
      result.status,
      410,
      "old signed grant must not release a removed file",
    );
    assert.equal(result.body.error.code, "attachment_removed");
    return { stale_grant_http_status: result.status, file_released: false };
  });

  await observe("removal-webhook-retry-no-resurrection", async () => {
    assert.ok(removal?.deletion_epoch);
    const tick = await fixture("webhook-tick");
    const row = await db
      .prepare(
        "SELECT status, cancellation_reason, attempt_count FROM webhook_deliveries WHERE id = ?",
      )
      .bind(delivery)
      .first();
    assert.equal(row.status, "cancelled");
    assert.equal(row.cancellation_reason, "source_removed");
    assert.equal(row.attempt_count, 0);
    return {
      delivery_status: row.status,
      cancellation_reason: row.cancellation_reason,
      attempts: row.attempt_count,
      retry_tick_scanned: tick.scanned,
    };
  });

  await observe("removal-restore-stale-r2-to-sqlite", async () => {
    assert.ok(savedArchive?.length);
    assert.ok(removal?.deletion_epoch);
    const bucket = await getRuntime().getR2Bucket(
      "EVENT_ARCHIVE",
      "communicator",
    );
    for (const object of savedArchive)
      await bucket.put(object.key, object.bytes, {
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
      });
    const replay = await fixture("replay", {
      manifest_key: archive.manifest_key,
    });
    assert.equal(replay.raw_archive_still_has_body, true);
    assert.equal(replay.restore_has_body, false);
    assert.equal(replay.restore_has_attachment, false);
    assert.equal(replay.projected_body_empty, true);
    assert.equal(replay.projected_file_redacted, true);
    assert.ok(replay.removed_events.includes("event_removal_message"));
    assert.ok(replay.removed_events.includes("event_removal_attachment"));
    assert.ok(replay.tombstones_reapplied > 0);
    const deniedFile = await api(
      `/api/v1/attachments/${attachment}/download`,
      undefined,
      { "x-communicator-download-grant": oldGrant },
    );
    assert.equal(deniedFile.status, 410);
    assert.equal(deniedFile.body.error.code, "attachment_removed");
    // Reintroduce a pre-removal queue pointer after archive replay, too. The
    // production retry reconciler must cancel it again before claiming I/O.
    await db
      .prepare(
        "UPDATE webhook_deliveries SET status = 'pending', cancellation_reason = NULL, cancelled_at = NULL WHERE id = ?",
      )
      .bind(delivery)
      .run();
    await fixture("webhook-tick");
    const deliveryRow = await db
      .prepare(
        "SELECT status, cancellation_reason, attempt_count, provider_request_started_at, http_status FROM webhook_deliveries WHERE id = ?",
      )
      .bind(delivery)
      .first();
    assert.equal(deliveryRow.status, "cancelled");
    assert.equal(deliveryRow.cancellation_reason, "source_removed");
    // The retry worker counts a preparation attempt before checking source
    // removal. Only provider_request_started_at records crossing the I/O fence.
    assert.equal(deliveryRow.attempt_count, 1);
    assert.equal(deliveryRow.provider_request_started_at, null);
    assert.equal(deliveryRow.http_status, null);
    return {
      stale_original_r2_bytes_reintroduced: true,
      production_restore_page_filtered: true,
      sqlite_late_archive_and_edit_redacted: true,
      restore_rejected_event_count: replay.removed_events.length,
      deletion_epoch: replay.deletion_epoch,
      file_reference_restored: false,
      reintroduced_webhook_cancelled_before_provider_io: true,
      scope:
        "archive replay and active SQLite suppression; not full multi-store restore activation",
    };
  });

  await observe("removal-stale-send-replay-denied", async () => {
    assert.equal(accepted?.status, 202);
    assert.ok(removal?.deletion_epoch);
    const replay = await send();
    assert.ok(
      [403, 404, 409, 410].includes(replay.status),
      "removed conversation must not accept stale send",
    );
    const read = await api(
      `/api/v1/conversations/${conversation}/messages?${query}`,
    );
    assert.ok([200, 404, 410].includes(read.status));
    assert.equal(
      JSON.stringify(read.body).includes("Controlled removal proof"),
      false,
    );
    return {
      stale_send_http_status: replay.status,
      content_visible_on_http: false,
      scope:
        "actual previously accepted HTTP request replay; pending restored dispatch not claimed",
    };
  });
}

export async function runRestoreActivationProof({
  observe,
  humanApi,
  fixtureCall,
  calls,
  retention,
}) {
  await observe("removal-full-projection-restore-activation", async () => {
    assert.ok(
      retention,
      "main must bind and route the same retention fixture instance",
    );
    assert.ok(
      originalRemovalCopy,
      "runRemovalProof must first capture actual original R2 content",
    );
    const before = await calls();
    const status = await fixtureCall("/__fixture/removal/status", {});
    assert.equal(status.status, 200);
    const authorities = status.body.removal_authorities;
    assert.ok(Array.isArray(authorities) && authorities.length > 0);
    // Do not invent source copies for authorities outside the controlled
    // conversation fixture. Additional unrelated removals must be investigated.
    for (const authority of authorities) {
      assert.equal(authority.tenant_id, tenant);
      assert.equal(authority.resource_type, "conversation");
      assert.equal(authority.resource_id, conversation);
      assert.equal(authority.content_generation, conversation);
      assert.equal(authority.account_id, "account_human");
      assert.equal(authority.conversation_id, conversation);
      assert.ok(authority.deletion_epoch > 0);
    }
    const stores = [
      "projection_backup",
      "synapse",
      "bridge_database",
      "media_store",
      "queue",
      "restic_snapshot",
      "session_credentials",
      "account_keys",
    ];
    for (const store of stores)
      assert.deepEqual(
        retention.facts()[store],
        { copies: 0, content_present: 0 },
        "restore proof requires its own empty local stores",
      );
    const source = originalRemovalCopy;
    const event = source.events.find(
      (item) =>
        item.event_type === "message.created" &&
        item.payload.message_id === message,
    );
    assert.ok(event?.payload.body?.length > 0);
    assert.ok(event.matrix_room_id && event.matrix_event_id);
    const callStart = retention.calls.length;
    try {
      for (const authority of authorities) {
        const mediaPath = `/integrated-retention/${authority.id}/removal-proof.txt`;
        const payloads = {
          projection_backup: { events: source.events },
          synapse: {
            room_id: event.matrix_room_id,
            event_id: event.matrix_event_id,
            type: "m.room.message",
            content: { body: event.payload.body },
            media_paths: [mediaPath],
          },
          bridge_database: {
            local_fixture_mapping: true,
            event_id: event.matrix_event_id,
            message_id: message,
            conversation_id: conversation,
          },
          media_store: { path: mediaPath, bytes: source.file_bytes },
          queue: { pending_local_archive_events: source.events },
          restic_snapshot: {
            isolated_message_snapshot: true,
            events: source.events,
            media: { [mediaPath]: source.file_bytes },
          },
          session_credentials: {
            synthetic_local_session_material:
              "retention-proof-no-real-credential",
          },
          account_keys: {
            synthetic_local_key_material: "retention-proof-no-real-key",
          },
        };
        for (const store of stores)
          retention.seedCopy(
            store,
            {
              tenant_id: authority.tenant_id,
              resource_id: authority.resource_id,
              content_generation: authority.content_generation,
              reference: `integrated-local:${store}:${authority.id}`,
              ...(store === "synapse"
                ? {
                    restore_target: {
                      database: "synapse",
                      contract: "synapse-event-json-v1",
                      resource_id: authority.resource_id,
                      content_generation: authority.content_generation,
                      room_id: event.matrix_room_id,
                      event_id: event.matrix_event_id,
                      event_type: "m.room.message",
                      media_paths: [mediaPath],
                      media_paths_complete: true,
                    },
                  }
                : {}),
            },
            payloads[store],
          );
      }
    } finally {
      // Release the cross-proof cache once the stores have cloned their data.
      originalRemovalCopy = undefined;
    }
    for (const store of stores)
      assert.deepEqual(retention.facts()[store], {
        copies: authorities.length,
        content_present: authorities.length,
      });
    const sweep = await fixtureCall("/__fixture/retention/sweep", {});
    assert.equal(sweep.status, 200);
    assert.equal(
      sweep.body.errors,
      0,
      "production retention sweep must not suppress errors",
    );
    assert.equal(sweep.body.incomplete, 0);
    assert.equal(sweep.body.processed, authorities.length);
    assert.equal(sweep.body.complete, authorities.length);
    const facts = retention.facts();
    for (const store of stores) {
      const preserved =
        store === "session_credentials" || store === "account_keys";
      assert.deepEqual(facts[store], {
        copies: authorities.length,
        content_present: preserved ? authorities.length : 0,
      });
      const cleanups = retention.calls
        .slice(callStart)
        .filter((call) => call.store === store && call.operation === "cleanup");
      assert.equal(
        cleanups.length,
        authorities.length,
        "each real seeded copy must cross the production HTTP cleanup adapter",
      );
      assert.ok(
        cleanups.every(
          (call) => call.was_present && call.content_present === preserved,
        ),
      );
    }
    const exported = await humanApi("/api/v1/removals/restore-authority");
    assert.equal(exported.status, 200);
    assert.equal(exported.body.authority_count, authorities.length);
    assert.deepEqual(
      exported.body.authority_ids.slice().sort(),
      authorities.map((item) => item.id).sort(),
    );
    assert.equal(exported.body.archive.status, "complete");
    for (const store of stores) {
      const evidence = exported.body.stores.find(
        (item) => item.store === store,
      );
      const preserved =
        store === "session_credentials" || store === "account_keys";
      assert.equal(evidence?.status, preserved ? "preserved" : "complete");
      assert.equal(evidence.content_present, preserved);
      assert.equal(evidence.copies.length, authorities.length);
    }
    assert.ok(
      exported.body.authorities.every((item) =>
        item.targets.some(
          (target) =>
            target.database === "synapse" &&
            target.room_id === event.matrix_room_id &&
            target.event_id === event.matrix_event_id &&
            target.media_paths_complete,
        ),
      ),
    );
    let failedGeneration;
    await observe(
      "removal-incoherent-archive-activation-fails-closed",
      async () => {
        const beforeFailure = await fixtureCall(
          "/__fixture/removal/restore-diagnostics",
          {},
        );
        assert.equal(beforeFailure.status, 200);
        assert.ok(
          beforeFailure.body.manifests.some(
            (item) =>
              item.fixture_original &&
              !item.data_present &&
              item.code === "archive_corrupt",
          ),
        );
        const rejected = await humanApi("/api/v1/removals/restore-projection", {
          rebuild_id: "integrated_removal_restore_corrupt",
          expected_generation: status.body.generation,
          started_at: new Date().toISOString(),
        });
        assert.equal(
          rejected.status,
          503,
          "a dangling manifest must not activate a projection",
        );
        const diagnostic = await fixtureCall(
          "/__fixture/removal/restore-diagnostics",
          {},
        );
        assert.equal(diagnostic.status, 200);
        assert.equal(diagnostic.body.projection_state, "rebuild_failed");
        assert.equal(
          diagnostic.body.last_rebuild_failure_code,
          "validation_failed",
        );
        assert.equal(diagnostic.body.generation, status.body.generation + 1);
        assert.ok(
          diagnostic.body.stages.every(
            (item) => !item.complete && item.code === "archive_corrupt",
          ),
        );
        assert.ok(
          diagnostic.body.purge_objects.some(
            (item) =>
              item.fixture_original &&
              item.state === "data_deleted" &&
              item.manifest_present &&
              !item.data_present,
          ),
        );
        failedGeneration = diagnostic.body.generation;
        return {
          restore_http_status: rejected.status,
          ...diagnostic.body,
          cause:
            "fixture reintroduced original manifest before the delayed original-data purge",
        };
      },
    );
    assert.ok(
      Number.isSafeInteger(failedGeneration),
      "negative corruption gate must be verified before retry",
    );
    assert.equal(typeof restoreOriginalArchive, "function");
    const manifestKey = await restoreOriginalArchive();
    restoreOriginalArchive = undefined;
    const coherent = await fixtureCall(
      "/__fixture/removal/restore-diagnostics",
      {},
    );
    assert.equal(coherent.status, 200);
    assert.ok(
      coherent.body.manifests.some(
        (item) =>
          item.fixture_original && item.data_present && item.committed_read,
      ),
    );
    assert.ok(
      coherent.body.stages.every((item) => item.complete && item.pages > 0),
    );
    const retryStatus = await fixtureCall("/__fixture/removal/status", {});
    assert.equal(retryStatus.status, 200);
    assert.equal(retryStatus.body.state, "rebuild_failed");
    assert.equal(retryStatus.body.generation, failedGeneration);
    const result = await humanApi("/api/v1/removals/restore-projection", {
      rebuild_id: "integrated_removal_restore_coherent",
      expected_generation: retryStatus.body.generation,
      started_at: new Date().toISOString(),
    });
    if (result.status !== 200)
      await observe("removal-restore-archive-failure-diagnostic", async () => {
        const diagnostic = await fixtureCall(
          "/__fixture/removal/restore-diagnostics",
          {},
        );
        assert.equal(diagnostic.status, 200);
        const trace = await fixtureCall(
          "/__fixture/removal/trace-restore-failure",
          {},
        );
        assert.equal(trace.status, 200);
        return {
          restore_http_status: result.status,
          ...diagnostic.body,
          production_rpc_trace: trace.body,
        };
      });
    assert.equal(
      result.status,
      200,
      "actual multi-store restore activation must satisfy its production gate",
    );
    assert.equal(result.body.readiness.state, "ready");
    assert.deepEqual(result.body.readiness.incomplete_stores, []);
    assert.deepEqual(result.body.readiness.blocked_reasons, []);
    assert.equal(result.body.projection.state, "ready");
    assert.equal(
      result.body.projection.generation,
      retryStatus.body.generation + 1,
    );
    assert.equal(
      result.body.projection.last_completed_rebuild_id,
      "integrated_removal_restore_coherent",
    );
    assert.equal(result.body.deletion_epoch, exported.body.deletion_epoch);
    assert.ok(result.body.page_count > 0);
    assert.ok(result.body.removed_event_ids.includes("event_removal_message"));
    assert.ok(
      result.body.removed_event_ids.includes("event_removal_attachment"),
    );
    const read = await humanApi(
      `/api/v1/conversations/${conversation}/messages?identity_id=identity_human&account_id=account_human`,
    );
    assert.ok([200, 404, 410].includes(read.status));
    assert.equal(
      JSON.stringify(read.body).includes("Controlled removal proof"),
      false,
    );
    const file = await humanApi(
      `/api/v1/attachments/${attachment}?identity_id=identity_human&account_id=account_human`,
    );
    assert.ok(
      [404, 410].includes(file.status),
      "activated projection must not resurrect an attachment grant",
    );
    const lateReplay = await fixtureCall("/__fixture/removal/replay", {
      manifest_key: manifestKey,
    });
    assert.equal(lateReplay.status, 200);
    assert.equal(lateReplay.body.raw_archive_still_has_body, true);
    assert.equal(lateReplay.body.restore_has_body, false);
    assert.equal(lateReplay.body.restore_has_attachment, false);
    assert.equal(lateReplay.body.projected_body_empty, true);
    assert.equal(lateReplay.body.projected_file_redacted, true);
    const staleSend = await humanApi(
      `/api/v1/conversations/${conversation}/messages`,
      {
        identity_id: "identity_human",
        account_id: "account_human",
        body: "Controlled removal proof outbound",
        delivery_mode: "direct",
      },
      { "idempotency-key": "removal-proof-post-restore-human-send" },
    );
    assert.ok(
      [403, 404, 409, 410].includes(staleSend.status),
      "current human owner must not send into a restored removed conversation",
    );
    const webhook = await fixtureCall(
      "/__fixture/removal/post-activation-webhook",
      {},
    );
    assert.equal(webhook.status, 200);
    assert.equal(webhook.body.status, "cancelled");
    assert.equal(webhook.body.cancellation_reason, "source_removed");
    assert.equal(webhook.body.provider_request_started, false);
    assert.equal(webhook.body.http_status, null);
    const after = await calls();
    for (const key of [
      "send_requests",
      "receipt_requests",
      "evidence_requests",
    ]) {
      assert.ok(
        Number.isSafeInteger(before[key]) && Number.isSafeInteger(after[key]),
        `boundary counter ${key} must exist`,
      );
    }
    const requestCounters = Object.keys(before).filter((key) =>
      key.endsWith("_requests"),
    );
    assert.deepEqual(
      Object.keys(after)
        .filter((key) => key.endsWith("_requests"))
        .sort(),
      requestCounters.slice().sort(),
    );
    for (const key of requestCounters) {
      assert.equal(
        after[key],
        before[key],
        `restore must not cross measured gateway/Matrix boundary ${key}`,
      );
    }
    return {
      http_status: 200,
      production_restore_activation: true,
      authority_count: authorities.length,
      deletion_epoch: result.body.deletion_epoch,
      archive_pages_replayed: result.body.page_count,
      generation_advanced: true,
      required_stores_deleted: 6,
      auxiliary_stores_preserved: 2,
      controlled_copy_facts: facts,
      removed_body_visible: false,
      removed_attachment_grant_visible: false,
      incoherent_archive_refused_http_status: 503,
      exact_original_archive_reintroduced_after_purge: true,
      late_archive_and_edit_still_suppressed: true,
      post_restore_owner_send_status: staleSend.status,
      restored_webhook_cancelled_before_provider_io: true,
      additional_matrix_sends: 0,
      additional_matrix_receipts: 0,
      additional_gateway_evidence_requests: 0,
      unchanged_request_counters: requestCounters,
      scope:
        "production D1/R2/SQLite projection activation with finite local HTTP controlled-copy stores; not a host database restore or production provider inventory",
    };
  });
}
