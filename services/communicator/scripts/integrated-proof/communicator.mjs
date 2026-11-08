import worker, {
  TenantProjectionDO as ProductionTenantProjectionDO,
  LinkSessionDO,
} from "../../apps/control-plane/worker/index.ts";
import {
  seedDirectory,
  seedAccountAccess,
} from "../../apps/control-plane/worker/test/support/directory-fixtures.ts";
import { handleRemovalFixture } from "./removal-fixture.mjs";
import { handleRetentionFixture } from "./retention-fixture.mjs";
import { handleRecoveryFixture } from "./recovery-fixture.mjs";
import { handleBootstrapFixture } from "./bootstrap-fixture.mjs";
import { archiveCanonicalEventBatch } from "../../apps/control-plane/worker/archive/writer.ts";

export { LinkSessionDO };
export class TenantProjectionDO extends ProductionTenantProjectionDO {
  // Read-only local diagnostics. All production methods remain inherited.
  inspectRetainedOwners() {
    return this.ctx.storage.sql
      .exec(`SELECT d.command_id, d.conversation_id,
      d.resource_identity_id, d.account_id, d.connection_id, d.platform,
      c.id IS NOT NULL AS derived_owner_present,
      c.identity_id AS derived_identity_id, c.account_id AS derived_account_id,
      c.connection_id AS derived_connection_id, c.platform AS derived_platform
      FROM outbound_dispatches d LEFT JOIN conversations c ON c.id = d.conversation_id
      ORDER BY d.created_at, d.id`)
      .toArray();
  }
}
const tenant = "tenant_pilot";
const conversation = "conversation_integrated";
const timestamp = "2026-08-29T00:00:00.000Z";
const authorization = (scopes) => ({
  schema_version: 1,
  tenant_id: tenant,
  principal_id: "principal_human",
  allowed_identity_ids: ["identity_human"],
  scopes,
});
const claimTraces = [];

// This wrapper adds fixture setup only. Every /api and /internal operation
// delegates unchanged to the actual production entry point and middleware.
export default {
  async fetch(request, env, context) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__fixture/bootstrap")
      return handleBootstrapFixture(request, env);
    if (pathname.startsWith("/__fixture/recovery/"))
      return handleRecoveryFixture(request, env);
    if (pathname === "/__fixture/retention/sweep")
      return handleRetentionFixture(request, env);
    if (pathname.startsWith("/__fixture/removal/"))
      return handleRemovalFixture(request, env);
    if (pathname === "/__fixture/claim-traces")
      return Response.json(claimTraces);
    if (pathname === "/internal/v1/outbound/dispatch-claims") {
      const result = await worker.fetch(request, env, context);
      claimTraces.push({
        status: result.status,
        envelope: await result.clone().json(),
      });
      return result;
    }
    if (new URL(request.url).pathname !== "/__fixture/seed")
      return worker.fetch(request, env, context);
    const fixture = await request.json();
    const db = env.CONTROL_DB;
    await seedDirectory(db);
    await db
      .prepare(
        "INSERT INTO principals (id, issuer, subject, display_name, principal_type, status, created_at, updated_at) VALUES ('principal_integrated_gateway', 'fixture', 'integrated_gateway', 'Controlled gateway', 'service', 'active', ?, ?)",
      )
      .bind(timestamp, timestamp)
      .run();
    await db
      .prepare(
        "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES ('membership_integrated_gateway', ?, 'principal_integrated_gateway', 'member', 'active', ?, ?)",
      )
      .bind(tenant, timestamp, timestamp)
      .run();
    await seedAccountAccess(db, "principal_integrated_gateway");
    await db
      .prepare(
        "UPDATE connection_routes SET matrix_user_id = '@t13:example.test', matrix_room_namespace = 'example.test' WHERE connection_id = 'connection_human_whatsapp'",
      )
      .run();
    await db
      .prepare(`INSERT INTO platform_bindings (binding_id, platform_authority, platform_kind, platform_subject_id, platform_organization_id, platform_membership_id, platform_grant_id, local_tenant_id, local_principal_id, local_membership_id, local_identity_id, local_installation_id, local_client_id, status, created_at, updated_at)
      VALUES ('binding_integrated_human', 'integrated-authority', 'human', ?, ?, ?, NULL, ?, 'principal_human', 'membership_human', 'identity_human', NULL, NULL, 'active', ?, ?)`)
      .bind(
        fixture.human.userId,
        fixture.human.organizationId,
        fixture.human.membershipId,
        tenant,
        timestamp,
        timestamp,
      )
      .run();
    for (const [kind, target, principal, membership, identity] of [
      [
        "agent",
        fixture.actor,
        "principal_agent",
        "membership_agent",
        "identity_agent",
      ],
      [
        "service",
        fixture.gateway,
        "principal_integrated_gateway",
        "membership_integrated_gateway",
        null,
      ],
    ]) {
      await db
        .prepare(`INSERT INTO platform_bindings (binding_id, platform_authority, platform_kind, platform_subject_id, platform_organization_id, platform_membership_id, platform_grant_id, local_tenant_id, local_principal_id, local_membership_id, local_identity_id, local_installation_id, local_client_id, status, created_at, updated_at)
        VALUES (?, 'integrated-authority', ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?)`)
        .bind(
          `binding_integrated_${kind}`,
          kind,
          target.agentId,
          fixture.actor.organizationId,
          target.grantId,
          tenant,
          principal,
          membership,
          identity,
          timestamp,
          timestamp,
        )
        .run();
    }
    await db
      .prepare(
        "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, connection_id, link_session_id, provider_login_id, created_at) VALUES (?, 'whatsapp', ?, 'connection_human_whatsapp', 'link_integrated', 'integrated-login', ?)",
      )
      .bind(tenant, "b".repeat(64), timestamp)
      .run();
    await db
      .prepare(
        "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, 'membership_agent', 'identity_agent', 'receipt.send', ?)",
      )
      .bind(tenant, timestamp)
      .run();
    for (const scope of ["conversation.read", "message.send", "receipt.send"]) {
      await db
        .prepare(
          "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, 'membership_agent', 'identity_agent', 'account_human', ?, 'all_chats', 'active', ?, ?)",
        )
        .bind(
          `grant_integrated_${scope.replaceAll(".", "_")}`,
          tenant,
          scope,
          timestamp,
          timestamp,
        )
        .run();
    }
    const projection = env.TENANT_PROJECTION.getByName(tenant);
    await projection.initialize({
      schema_version: 1,
      tenant_id: tenant,
      initialized_at: timestamp,
      authorization: authorization(["projection.initialize"]),
    });
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
      matrix_event_id: "$inbound:example.test",
      remote_message_id: null,
      occurred_at: timestamp,
      observed_at: timestamp,
      payload,
    });
    const events = [
      envelope("event_integrated_conversation", "conversation.updated", {
        title: "Integrated controlled conversation",
        archived: false,
        muted: false,
      }),
      envelope("event_integrated_message", "message.created", {
        message_id: "message_integrated",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Controlled participant",
        body: "Controlled integration fixture",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: true,
      }),
    ];
    // Preserve the exact legitimately seeded source owner for a later whole-
    // tenant rebuild. Retained send ledgers require this immutable context.
    await archiveCanonicalEventBatch({
      bucket: env.EVENT_ARCHIVE,
      tenantId: tenant,
      batchId: "batch_integrated_initial_context",
      events,
      archivedAt: timestamp,
      producerVersion: "integrated-proof/1",
      sourceCheckpoint: null,
    });
    await projection.applyBatch({
      schema_version: 1,
      tenant_id: tenant,
      authorization: authorization(["projection.write"]),
      mode: "live",
      rebuild_id: null,
      connections: [
        {
          account_id: "account_human",
          connection_id: "connection_human_whatsapp",
          identity_id: "identity_human",
          platform: "whatsapp",
        },
      ],
      events,
      checkpoint: null,
    });
    return Response.json({ seeded: true });
  },
};
