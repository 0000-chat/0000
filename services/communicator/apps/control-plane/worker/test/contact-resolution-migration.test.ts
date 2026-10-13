import { env as runtimeEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hasAccountOperationGrantForAccount } from "../control-directory/grants";

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
];

const migration = (name: string): D1Migration => {
  const found = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error("missing migration " + name);
  return found;
};

async function resetSchema(): Promise<void> {
  await env.CONTROL_DB.prepare("PRAGMA foreign_keys = OFF").run();
  const triggers = await env.CONTROL_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  ).all<{ name: string }>();
  for (const { name } of triggers.results) {
    if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("unexpected trigger");
    await env.CONTROL_DB.prepare('DROP TRIGGER IF EXISTS "' + name + '"').run();
  }
  const tables = [
    "group_dispatch_claims",
    "group_authority_intents",
    "contact_dispatch_claims",
    "contact_authority_intents",
    "receipt_dispatch_claims",
    "receipt_authority_intents",
    "receipt_operation_evidence",
    "receipt_operations",
    "outbound_dispatch_claims",
    "outbound_acceptance_intents",
    "connection_lifecycle_operations",
    "outbound_authority_heads",
    "group_management_evidence",
    "group_management_operations",
    "group_management_groups",
    "group_creation_webhook_evaluations",
    "group_creation_access_grants",
    "group_creation_operations",
    "direct_chat_creation_operations",
    "contact_resolution_candidates",
    "archive_purge_locks",
    "archive_purge_objects",
    "archive_purge_operations",
    "removal_expiry_schedule",
    "removal_authority",
    "attachment_download_grants",
    "controlled_copy_evidence",
    "controlled_copy_operations",
    "audit_events",
    "control_event_outbox",
    "directory_mutations",
    "platform_bindings",
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
    await env.CONTROL_DB.prepare('DROP TABLE IF EXISTS "' + name + '"').run();
  }
}

async function seedLegacyRows(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind(
      "tenant_upgrade",
      "tenant-upgrade",
      "Upgrade tenant",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, 'active', ?, ?)",
    ).bind(
      "principal_upgrade",
      "https://upgrade.example/",
      "upgrade-subject",
      "Upgrade principal",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
    ).bind(
      "membership_upgrade",
      "tenant_upgrade",
      "principal_upgrade",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'human', ?, 'active', ?, ?)",
    ).bind(
      "identity_upgrade",
      "tenant_upgrade",
      "Upgrade identity",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, 'whatsapp', ?, 'ready', ?, ?)",
    ).bind(
      "connection_upgrade",
      "tenant_upgrade",
      "identity_upgrade",
      "Upgrade WhatsApp",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "connection_upgrade",
      "gateway_upgrade",
      "bridge-upgrade",
      "@upgrade:example.test",
      "upgrade.example.test",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind("gateway_upgrade", "principal_upgrade", timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind("account_upgrade", "connection_upgrade", timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, connection_id, link_session_id, created_at) VALUES (?, 'whatsapp', ?, ?, ?, ?)",
    ).bind(
      "tenant_upgrade",
      "a".repeat(64),
      "connection_upgrade",
      "link_upgrade",
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, 'conversation.read', ?)",
    ).bind(
      "tenant_upgrade",
      "membership_upgrade",
      "identity_upgrade",
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, 'message.send', 'selected_chats', 'active', ?, ?, NULL)",
    ).bind(
      "grant_upgrade_selected",
      "tenant_upgrade",
      "membership_upgrade",
      "identity_upgrade",
      "account_upgrade",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grant_chats (grant_id, tenant_id, account_id, chat_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "grant_upgrade_selected",
      "tenant_upgrade",
      "account_upgrade",
      "conversation_existing",
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, 'webhook.manage', 'all_chats', 'revoked', ?, ?, ?)",
    ).bind(
      "grant_upgrade_revoked",
      "tenant_upgrade",
      "membership_upgrade",
      "identity_upgrade",
      "account_upgrade",
      timestamp,
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO permission_requests (id, tenant_id, requester_principal_id, requester_membership_id, identity_id, account_id, operation_scope, chat_scope, chat_ids_json, reason, status, created_at, updated_at, decided_at, decided_by_principal_id) VALUES (?, ?, ?, ?, ?, ?, 'message.send', 'selected_chats', ?, ?, 'rejected', ?, ?, ?, ?)",
    ).bind(
      "permission_upgrade",
      "tenant_upgrade",
      "principal_upgrade",
      "membership_upgrade",
      "identity_upgrade",
      "account_upgrade",
      '["conversation_existing"]',
      "legacy request retained during upgrade",
      timestamp,
      timestamp,
      timestamp,
      "principal_upgrade",
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO directory_mutations (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      "mutation_upgrade",
      "tenant_upgrade",
      "principal_upgrade",
      "grant.created",
      "b".repeat(64),
      timestamp,
    ),
  ]);
}

beforeEach(async () => {
  await resetSchema();
  await applyD1Migrations(
    env.CONTROL_DB,
    baseMigrationNames.map((name) => migration(name)),
  );
  await seedLegacyRows();
});

describe("contact resolution upgrade migration", () => {
  it("preserves populated grants, revocations, requests and mutation history", async () => {
    const before = {
      identityGrant: await env.CONTROL_DB.prepare(
        "SELECT tenant_id, membership_id, identity_id, operation_scope, created_at FROM identity_grants WHERE tenant_id = ?",
      )
        .bind("tenant_upgrade")
        .all(),
      accountGrant: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_scope, status, revoked_at FROM account_grants WHERE tenant_id = ? ORDER BY id",
      )
        .bind("tenant_upgrade")
        .all(),
      selectedChat: await env.CONTROL_DB.prepare(
        "SELECT grant_id, tenant_id, account_id, chat_id FROM account_grant_chats WHERE tenant_id = ?",
      )
        .bind("tenant_upgrade")
        .all(),
      permission: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_ids_json, reason, status, decided_at, decided_by_principal_id FROM permission_requests WHERE tenant_id = ?",
      )
        .bind("tenant_upgrade")
        .all(),
      mutation: await env.CONTROL_DB.prepare(
        "SELECT idempotency_key, mutation_type, request_hash FROM directory_mutations WHERE tenant_id = ?",
      )
        .bind("tenant_upgrade")
        .all(),
    };

    await applyD1Migrations(env.CONTROL_DB, [
      migration("0017_contact_resolution.sql"),
    ]);

    const after = {
      identityGrant: await env.CONTROL_DB.prepare(
        "SELECT tenant_id, membership_id, identity_id, operation_scope, created_at FROM identity_grants WHERE tenant_id = ?",
      )
        .bind("tenant_upgrade")
        .all(),
      accountGrant: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_scope, status, revoked_at FROM account_grants WHERE tenant_id = ? ORDER BY id",
      )
        .bind("tenant_upgrade")
        .all(),
      selectedChat: await env.CONTROL_DB.prepare(
        "SELECT grant_id, tenant_id, account_id, chat_id FROM account_grant_chats WHERE tenant_id = ?",
      )
        .bind("tenant_upgrade")
        .all(),
      permission: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_ids_json, reason, status, decided_at, decided_by_principal_id FROM permission_requests WHERE tenant_id = ?",
      )
        .bind("tenant_upgrade")
        .all(),
      mutation: await env.CONTROL_DB.prepare(
        "SELECT idempotency_key, mutation_type, request_hash FROM directory_mutations WHERE tenant_id = ?",
      )
        .bind("tenant_upgrade")
        .all(),
    };
    expect(after.identityGrant.results).toEqual(before.identityGrant.results);
    expect(after.accountGrant.results).toEqual(before.accountGrant.results);
    expect(after.selectedChat.results).toEqual(before.selectedChat.results);
    expect(after.permission.results).toEqual(before.permission.results);
    expect(after.mutation.results).toEqual(before.mutation.results);

    const foreignKeys = await env.CONTROL_DB.prepare(
      "PRAGMA foreign_key_check",
    ).all();
    expect(foreignKeys.results).toEqual([]);
    const foreignKeysEnabled = await env.CONTROL_DB.prepare(
      "PRAGMA foreign_keys",
    ).first<{ foreign_keys: number }>();
    expect(foreignKeysEnabled?.foreign_keys).toBe(1);

    await env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, 'conversation.create', ?)",
    )
      .bind(
        "tenant_upgrade",
        "membership_upgrade",
        "identity_upgrade",
        timestamp,
      )
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, 'conversation.create', 'all_chats', 'active', ?, ?, NULL)",
    )
      .bind(
        "grant_upgrade_create",
        "tenant_upgrade",
        "membership_upgrade",
        "identity_upgrade",
        "account_upgrade",
        timestamp,
        timestamp,
      )
      .run();
    await expect(
      hasAccountOperationGrantForAccount(
        env.CONTROL_DB.withSession("first-primary"),
        "tenant_upgrade",
        "membership_upgrade",
        "identity_upgrade",
        "account_upgrade",
        "conversation.create",
      ),
    ).resolves.toBe(true);

    const providerIdentity = await env.CONTROL_DB.prepare(
      "SELECT provider_login_id FROM connection_provider_identities WHERE connection_id = ?",
    )
      .bind("connection_upgrade")
      .first<{ provider_login_id: string | null }>();
    expect(providerIdentity?.provider_login_id).toBeNull();
    const tables = await env.CONTROL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('contact_resolution_candidates', 'direct_chat_creation_operations') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "contact_resolution_candidates",
      "direct_chat_creation_operations",
    ]);
  });
});
