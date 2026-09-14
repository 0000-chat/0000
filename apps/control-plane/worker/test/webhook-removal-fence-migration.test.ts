import { env as runtimeEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedDirectory } from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & {
  CONTROL_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const timestamp = "2026-09-14T00:00:00.000Z";
const retryDeadline = "2026-09-15T00:00:00.000Z";

const migration = (name: string): D1Migration => {
  const found = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`missing migration ${name}`);
  return found;
};

const resetSchema = async (): Promise<void> => {
  await env.CONTROL_DB.prepare("PRAGMA foreign_keys = OFF").run();
  const triggers = await env.CONTROL_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  ).all<{ name: string }>();
  for (const row of triggers.results) {
    if (!/^[A-Za-z0-9_]+$/u.test(row.name)) {
      throw new Error("unexpected trigger name");
    }
    await env.CONTROL_DB.prepare(`DROP TRIGGER IF EXISTS "${row.name}"`).run();
  }
  const tables = [
    // Keep this teardown ordered from foreign-key children to their parents.
    // These tables are created by migrations after the schema under test, so
    // they may still exist when this fixture is reused by another test file.
    "controlled_copy_evidence",
    "controlled_copy_operations",
    "group_management_evidence",
    "group_management_operations",
    "group_management_groups",
    "group_dispatch_claims",
    "group_authority_intents",
    "receipt_dispatch_claims",
    "receipt_authority_intents",
    "receipt_operation_evidence",
    "receipt_operations",
    "outbound_dispatch_claims",
    "outbound_acceptance_intents",
    "outbound_authority_heads",
    "connection_lifecycle_operations",
    "archive_purge_locks",
    "archive_purge_objects",
    "archive_purge_operations",
    "group_creation_webhook_evaluations",
    "group_creation_access_grants",
    "group_creation_operations",
    "contact_dispatch_claims",
    "contact_authority_intents",
    "removal_expiry_schedule",
    "removal_authority",
    "direct_chat_creation_operations",
    "contact_resolution_candidates",
    "attachment_download_grants",
    "audit_events",
    "control_event_outbox",
    "directory_mutations",
    "oauth_authorization_codes",
    "oauth_upstream_login_transactions",
    "oauth_authorization_transactions",
    "oauth_client_installations",
    "oauth_clients",
    "webhook_deliveries",
    "webhook_subscription_chat_rules",
    "webhook_subscription_account_rules",
    "webhook_subscriptions",
    "history_import_events",
    "history_import_ranges",
    "history_imports",
    "provider_capability_records",
    "break_glass_grants",
    "revoked_tokens",
    "connection_capabilities",
    "connection_provider_identities",
    "connection_routes",
    "connection_accounts",
    "account_grant_chats",
    "account_grants",
    "permission_requests",
    "realtime_tickets",
    "connections",
    "identity_grants",
    "identities",
    "memberships",
    "gateway_routes",
    "principals",
    "tenants",
    "d1_migrations",
  ];
  for (const name of tables) {
    await env.CONTROL_DB.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
};

const insertLegacyWebhookRows = async (): Promise<void> => {
  await env.CONTROL_DB.prepare(
    `INSERT INTO webhook_subscriptions
     (id, tenant_id, creation_idempotency_key, owner_installation_id,
      owner_principal_id, creator_principal_id, creator_membership_id,
      creator_identity_id, logical_agent_id, ownership_mode, destination_url,
      destination_credential_ref, destination_version, event_filter_json,
      global_enabled, status, created_at, updated_at, revoked_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'human_owner', ?, NULL, 1,
             ?, 1, 'active', ?, ?, NULL)`,
  )
    .bind(
      "webhook_upgrade",
      "tenant_pilot",
      "webhook_upgrade_creation",
      "principal_human",
      "principal_human",
      "membership_human",
      "identity_human",
      "https://hooks.example.test/upgrade",
      JSON.stringify({ event_types: ["message.created"] }),
      timestamp,
      timestamp,
    )
    .run();

  const columns = `
    id, tenant_id, subscription_id, source_event_id, source_message_id,
    source_identity_id, source_account_id, source_conversation_id,
    source_revision, destination_version, status, first_pending_at,
    retry_deadline, attempt_count, next_attempt_at, cancelled_at,
    cancellation_reason, lease_id, lease_expires_at, last_attempt_at,
    delivered_at, http_status, error_code, payload_json, last_response_body,
    manual_retry_at, uncertain_at, uncertainty_reason`;
  const insert = `INSERT INTO webhook_deliveries (${columns})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(insert).bind(
      "delivery_legacy_leased",
      "tenant_pilot",
      "webhook_upgrade",
      "event_legacy_leased",
      "message_legacy_leased",
      "identity_human",
      "account_human",
      "conversation_one",
      "revision_legacy",
      1,
      "leased",
      timestamp,
      retryDeadline,
      4,
      null,
      null,
      null,
      "lease_legacy",
      "2026-09-14T00:01:00.000Z",
      timestamp,
      null,
      202,
      null,
      '{"type":"message.created","text":"legacy evidence"}',
      "accepted",
      null,
      null,
      null,
    ),
    env.CONTROL_DB.prepare(insert).bind(
      "delivery_legacy_pending",
      "tenant_pilot",
      "webhook_upgrade",
      "event_legacy_pending",
      "message_legacy_pending",
      "identity_human",
      "account_human",
      "conversation_one",
      "revision_pending",
      1,
      "pending",
      timestamp,
      retryDeadline,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      '{"type":"message.created","text":"pending evidence"}',
      null,
      null,
      null,
      null,
    ),
  ]);
};

beforeEach(async () => {
  await resetSchema();
  await applyD1Migrations(
    env.CONTROL_DB,
    env.TEST_MIGRATIONS.filter(
      (candidate) => candidate.name < "0024_webhook_removal_fence.sql",
    ),
  );
  await seedDirectory(env.CONTROL_DB);
  await insertLegacyWebhookRows();
});

describe("webhook removal fence migration", () => {
  it("makes legacy leased rows uncertain while retaining pending work and evidence", async () => {
    await applyD1Migrations(env.CONTROL_DB, [
      migration("0024_webhook_removal_fence.sql"),
    ]);

    const rows = await env.CONTROL_DB.prepare(
      `SELECT id, status, retry_deadline, attempt_count, lease_id,
                lease_expires_at, next_attempt_at, error_code, payload_json,
                last_response_body, uncertain_at, uncertainty_reason,
                removal_epoch, provider_request_started_at
         FROM webhook_deliveries ORDER BY id`,
    ).all<{
      id: string;
      status: string;
      retry_deadline: string;
      attempt_count: number;
      lease_id: string | null;
      lease_expires_at: string | null;
      next_attempt_at: string | null;
      error_code: string | null;
      payload_json: string | null;
      last_response_body: string | null;
      uncertain_at: string | null;
      uncertainty_reason: string | null;
      removal_epoch: number;
      provider_request_started_at: string | null;
    }>();
    const legacy = rows.results[0];
    const pending = rows.results[1];
    expect(legacy).toMatchObject({
      id: "delivery_legacy_leased",
      status: "uncertain",
      retry_deadline: retryDeadline,
      attempt_count: 4,
      lease_id: null,
      lease_expires_at: null,
      next_attempt_at: null,
      error_code: "delivery_uncertain",
      payload_json: '{"type":"message.created","text":"legacy evidence"}',
      last_response_body: "accepted",
      uncertain_at: timestamp,
      uncertainty_reason: "legacy_lease_unknown_provider_state",
      removal_epoch: 0,
      provider_request_started_at: null,
    });
    expect(pending).toMatchObject({
      id: "delivery_legacy_pending",
      status: "pending",
      retry_deadline: retryDeadline,
      attempt_count: 0,
      lease_id: null,
      next_attempt_at: null,
      removal_epoch: 0,
      provider_request_started_at: null,
    });
  });
});
