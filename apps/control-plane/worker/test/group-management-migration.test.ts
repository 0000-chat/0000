import { env as runtimeEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const env = runtimeEnv as typeof runtimeEnv & {
  CONTROL_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};
const timestamp = "2026-09-14T00:00:00.000Z";
const baseMigrationNames = [
  "0001_control_directory.sql",
  "0002_ingestion_routing.sql",
  "0003_connection_read_metadata.sql",
  "0004_realtime_tickets.sql",
  "0005_account_grants.sql",
  "0006_oauth_installations.sql",
  "0007_account_linking.sql",
  "0010_webhook_subscriptions.sql",
  "0011_history_imports.sql",
  "0012_history_import_scheduler.sql",
  "0013_attachment_download_grants.sql",
  "0014_outbound_capabilities.sql",
  "0015_webhook_delivery_execution.sql",
  "0016_webhook_retry_ledger.sql",
  "0017_contact_resolution.sql",
  "0018_removal_authority.sql",
  "0019_group_creation.sql",
  "0020_webhook_revision_events.sql",
];

const migration = (name: string): D1Migration => {
  const found = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`missing migration ${name}`);
  return found;
};

async function resetSchema(): Promise<void> {
  await env.CONTROL_DB.prepare("PRAGMA foreign_keys = OFF").run();
  const triggers = await env.CONTROL_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  ).all<{ name: string }>();
  for (const { name } of triggers.results) {
    if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("unexpected trigger");
    await env.CONTROL_DB.prepare(`DROP TRIGGER IF EXISTS "${name}"`).run();
  }
  const tables = [
    "group_management_evidence",
    "group_management_operations",
    "group_management_groups",
    "group_creation_webhook_evaluations",
    "group_creation_access_grants",
    "group_creation_operations",
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
  for (const table of tables)
    await env.CONTROL_DB.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
}

async function seedPopulatedDirectory(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES ('tenant_upgrade', 'upgrade', 'Upgrade', 'active', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES ('principal_upgrade', 'https://upgrade.example/', 'upgrade-subject', 'human', 'Upgrade', 'active', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES ('membership_upgrade', 'tenant_upgrade', 'principal_upgrade', 'owner', 'active', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES ('identity_upgrade', 'tenant_upgrade', 'human', 'Upgrade identity', 'active', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES ('connection_upgrade', 'tenant_upgrade', 'identity_upgrade', 'whatsapp', 'Upgrade WhatsApp', 'ready', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES ('connection_upgrade', 'gateway_upgrade', 'bridge-upgrade', '@upgrade:example.test', 'upgrade.example.test', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES ('gateway_upgrade', 'principal_upgrade', 'active', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES ('account_upgrade', 'connection_upgrade', 'active', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES ('tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'conversation.read', ?), ('tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'group.create', ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES ('grant_upgrade_read', 'tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'conversation.read', 'all_chats', 'active', ?, ?, NULL), ('grant_upgrade_send', 'tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'message.send', 'selected_chats', 'active', ?, ?, NULL), ('grant_upgrade_revoked', 'tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'webhook.manage', 'all_chats', 'revoked', ?, ?, ?)",
    ).bind(
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grant_chats (grant_id, tenant_id, account_id, chat_id, created_at) VALUES ('grant_upgrade_send', 'tenant_upgrade', 'account_upgrade', 'conversation_existing', ?)",
    ).bind(timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO permission_requests (id, tenant_id, requester_principal_id, requester_membership_id, identity_id, account_id, operation_scope, chat_scope, chat_ids_json, reason, status, created_at, updated_at, decided_at, decided_by_principal_id) VALUES ('permission_upgrade', 'tenant_upgrade', 'principal_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'message.send', 'selected_chats', '[\"conversation_existing\"]', 'legacy request', 'rejected', ?, ?, ?, 'principal_upgrade')",
    ).bind(timestamp, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO directory_mutations (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at) VALUES ('mutation_upgrade', 'tenant_upgrade', 'principal_upgrade', 'grant.created', ?, ?)",
    ).bind("a".repeat(64), timestamp),
    env.CONTROL_DB.prepare(
      `INSERT INTO removal_authority
       (id, tenant_id, resource_type, resource_id, content_generation,
        account_id, conversation_id, source_event_id, source_object_key, reason,
        removed_at, deletion_epoch, status, purge_status, created_at, updated_at)
       VALUES ('removal_upgrade', 'tenant_upgrade', 'message', 'message_upgrade',
        'generation_upgrade', 'account_upgrade', 'conversation_existing',
        'event_upgrade', 'object_upgrade', 'requested', ?, 4, 'active',
        'not_started', ?, ?)`,
    ).bind(timestamp, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      `INSERT INTO removal_expiry_schedule
       (id, tenant_id, resource_type, resource_id, content_generation,
        account_id, conversation_id, source_event_id, source_object_key,
        expires_at, status, created_at, updated_at)
       VALUES ('expiry_upgrade', 'tenant_upgrade', 'message', 'message_upgrade',
        'generation_upgrade', 'account_upgrade', 'conversation_existing',
        'event_upgrade', 'object_upgrade', '2026-10-01T00:00:00.000Z',
        'scheduled', ?, ?)`,
    ).bind(timestamp, timestamp),
  ]);
}

beforeEach(async () => {
  await resetSchema();
  await applyD1Migrations(
    env.CONTROL_DB,
    baseMigrationNames.map((name) => migration(name)),
  );
  await seedPopulatedDirectory();
});

describe("group management upgrade migration", () => {
  it("preserves populated authority and history while adding management grants and tables", async () => {
    const before = {
      identity: await env.CONTROL_DB.prepare(
        "SELECT operation_scope, created_at FROM identity_grants WHERE tenant_id = 'tenant_upgrade' ORDER BY operation_scope",
      ).all(),
      account: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_scope, status, revoked_at FROM account_grants WHERE tenant_id = 'tenant_upgrade' ORDER BY id",
      ).all(),
      selected: await env.CONTROL_DB.prepare(
        "SELECT grant_id, account_id, chat_id FROM account_grant_chats WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      permission: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_ids_json, reason, status, decided_at, decided_by_principal_id FROM permission_requests WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      mutation: await env.CONTROL_DB.prepare(
        "SELECT idempotency_key, mutation_type, request_hash FROM directory_mutations WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      removal: await env.CONTROL_DB.prepare(
        "SELECT id, resource_id, deletion_epoch, status, purge_status FROM removal_authority WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
    };

    await applyD1Migrations(env.CONTROL_DB, [
      migration("0022_group_management.sql"),
    ]);

    const after = {
      identity: await env.CONTROL_DB.prepare(
        "SELECT operation_scope, created_at FROM identity_grants WHERE tenant_id = 'tenant_upgrade' ORDER BY operation_scope",
      ).all(),
      account: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_scope, status, revoked_at FROM account_grants WHERE tenant_id = 'tenant_upgrade' ORDER BY id",
      ).all(),
      selected: await env.CONTROL_DB.prepare(
        "SELECT grant_id, account_id, chat_id FROM account_grant_chats WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      permission: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_ids_json, reason, status, decided_at, decided_by_principal_id FROM permission_requests WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      mutation: await env.CONTROL_DB.prepare(
        "SELECT idempotency_key, mutation_type, request_hash FROM directory_mutations WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      removal: await env.CONTROL_DB.prepare(
        "SELECT id, resource_id, deletion_epoch, status, purge_status FROM removal_authority WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
    };
    expect(after.identity.results).toEqual(before.identity.results);
    expect(after.account.results).toEqual(before.account.results);
    expect(after.selected.results).toEqual(before.selected.results);
    expect(after.permission.results).toEqual(before.permission.results);
    expect(after.mutation.results).toEqual(before.mutation.results);
    expect(after.removal.results).toEqual(before.removal.results);
    expect(
      (await env.CONTROL_DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(await env.CONTROL_DB.prepare("PRAGMA foreign_keys").first()).toEqual(
      { foreign_keys: 1 },
    );

    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES ('tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'group.manage', ?)",
      ).bind(timestamp),
      env.CONTROL_DB.prepare(
        "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES ('grant_upgrade_manage', 'tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'group.manage', 'all_chats', 'active', ?, ?, NULL)",
      ).bind(timestamp, timestamp),
    ]);
    expect(
      await env.CONTROL_DB.prepare(
        "SELECT operation_scope FROM identity_grants WHERE tenant_id = 'tenant_upgrade' AND operation_scope = 'group.manage'",
      ).first(),
    ).toEqual({ operation_scope: "group.manage" });
    expect(
      await env.CONTROL_DB.prepare(
        "SELECT operation_scope FROM account_grants WHERE tenant_id = 'tenant_upgrade' AND operation_scope = 'group.manage'",
      ).first(),
    ).toEqual({ operation_scope: "group.manage" });
    const tables = await env.CONTROL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'group_management_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "group_management_evidence",
      "group_management_groups",
      "group_management_operations",
    ]);
  });
});
