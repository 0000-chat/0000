import { env as runtimeEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  hasAccountOperationGrant,
  hasAccountOperationGrantForAccount,
} from "../control-directory/grants";

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
  "0021_archive_purge.sql",
  "0022_group_management.sql",
  "0024_webhook_removal_fence.sql",
  "0025_outbound_authority.sql",
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
  for (const name of [
    "receipt_operation_evidence",
    "receipt_operations",
    "outbound_dispatch_claims",
    "outbound_acceptance_intents",
    "outbound_authority_heads",
    "attachment_download_grants",
    "contact_dispatch_claims",
    "contact_authority_intents",
    "direct_chat_creation_operations",
    "contact_resolution_candidates",
    "group_creation_webhook_evaluations",
    "group_creation_access_grants",
    "group_creation_operations",
    "group_management_evidence",
    "group_management_operations",
    "group_management_groups",
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
    "archive_purge_locks",
    "archive_purge_objects",
    "archive_purge_operations",
    "removal_expiry_schedule",
    "removal_authority",
    "break_glass_grants",
    "revoked_tokens",
    "connection_provider_identities",
    "connection_capabilities",
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
  ]) {
    await env.CONTROL_DB.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
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
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES ('gateway_upgrade', 'principal_upgrade', 'active', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES ('connection_upgrade', 'gateway_upgrade', 'bridge-upgrade', '@upgrade:example.test', 'upgrade.example.test', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES ('account_upgrade', 'connection_upgrade', 'active', ?, ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES ('tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'conversation.read', ?), ('tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'receipt.send', ?)",
    ).bind(timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES ('grant_upgrade_selected', 'tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'message.send', 'selected_chats', 'active', ?, ?, NULL), ('grant_upgrade_revoked', 'tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'webhook.manage', 'all_chats', 'revoked', ?, ?, ?)",
    ).bind(timestamp, timestamp, timestamp, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grant_chats (grant_id, tenant_id, account_id, chat_id, created_at) VALUES ('grant_upgrade_selected', 'tenant_upgrade', 'account_upgrade', 'conversation_existing', ?)",
    ).bind(timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO permission_requests (id, tenant_id, requester_principal_id, requester_membership_id, identity_id, account_id, operation_scope, chat_scope, chat_ids_json, reason, status, created_at, updated_at, decided_at, decided_by_principal_id) VALUES ('permission_upgrade', 'tenant_upgrade', 'principal_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'message.send', 'selected_chats', '[\"conversation_existing\"]', 'legacy receipt migration request', 'rejected', ?, ?, ?, 'principal_upgrade')",
    ).bind(timestamp, timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO directory_mutations (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at) VALUES ('mutation_upgrade', 'tenant_upgrade', 'principal_upgrade', 'grant.created', ?, ?)",
    ).bind("a".repeat(64), timestamp),
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

describe("explicit receipt migration", () => {
  it("preserves populated grants and authority epochs while adding receipt.send", async () => {
    const before = {
      account: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_scope, status, revoked_at, authorization_epoch FROM account_grants WHERE tenant_id = 'tenant_upgrade' ORDER BY id",
      ).all(),
      selected: await env.CONTROL_DB.prepare(
        "SELECT grant_id, account_id, chat_id FROM account_grant_chats WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      permission: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, status, decided_at, decided_by_principal_id FROM permission_requests WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      mutation: await env.CONTROL_DB.prepare(
        "SELECT idempotency_key, mutation_type, request_hash FROM directory_mutations WHERE tenant_id = 'tenant_upgrade'",
      ).all(),
      heads: await env.CONTROL_DB.prepare(
        "SELECT authority_kind, authority_id, epoch FROM outbound_authority_heads WHERE tenant_id = 'tenant_upgrade' ORDER BY authority_kind, authority_id",
      ).all(),
    };
    await applyD1Migrations(env.CONTROL_DB, [
      migration("0026_receipt_operations.sql"),
    ]);

    const accountRows = await env.CONTROL_DB.prepare(
      "SELECT id, operation_scope, chat_scope, status, revoked_at, authorization_epoch FROM account_grants WHERE tenant_id = 'tenant_upgrade' ORDER BY id",
    ).all();
    expect(accountRows.results).toEqual(before.account.results);
    expect(
      (
        await env.CONTROL_DB.prepare(
          "SELECT grant_id, account_id, chat_id FROM account_grant_chats WHERE tenant_id = 'tenant_upgrade'",
        ).all()
      ).results,
    ).toEqual(before.selected.results);
    expect(
      (
        await env.CONTROL_DB.prepare(
          "SELECT id, operation_scope, status, decided_at, decided_by_principal_id FROM permission_requests WHERE tenant_id = 'tenant_upgrade'",
        ).all()
      ).results,
    ).toEqual(before.permission.results);
    expect(
      (
        await env.CONTROL_DB.prepare(
          "SELECT idempotency_key, mutation_type, request_hash FROM directory_mutations WHERE tenant_id = 'tenant_upgrade'",
        ).all()
      ).results,
    ).toEqual(before.mutation.results);
    expect(
      (
        await env.CONTROL_DB.prepare(
          "SELECT authority_kind, authority_id, epoch FROM outbound_authority_heads WHERE tenant_id = 'tenant_upgrade' ORDER BY authority_kind, authority_id",
        ).all()
      ).results,
    ).toEqual(before.heads.results);
    expect(
      (await env.CONTROL_DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(await env.CONTROL_DB.prepare("PRAGMA foreign_keys").first()).toEqual(
      { foreign_keys: 1 },
    );

    await env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES ('grant_upgrade_receipt', 'tenant_upgrade', 'membership_upgrade', 'identity_upgrade', 'account_upgrade', 'receipt.send', 'all_chats', 'active', ?, ?, NULL)",
    )
      .bind(timestamp, timestamp)
      .run();
    await expect(
      hasAccountOperationGrant(
        env.CONTROL_DB.withSession("first-primary"),
        "tenant_upgrade",
        "membership_upgrade",
        "identity_upgrade",
        "account_upgrade",
        "conversation_existing",
        "receipt.send",
      ),
    ).resolves.toBe(true);
    await expect(
      hasAccountOperationGrantForAccount(
        env.CONTROL_DB.withSession("first-primary"),
        "tenant_upgrade",
        "membership_upgrade",
        "identity_upgrade",
        "account_upgrade",
        "receipt.send",
      ),
    ).resolves.toBe(true);

    const initial = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE id = 'grant_upgrade_selected'",
    ).first<{ authorization_epoch: number }>();
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = 'grant_upgrade_selected'",
    )
      .bind(timestamp, "2026-09-14T00:01:00.000Z")
      .run();
    const revoked = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE id = 'grant_upgrade_selected'",
    ).first<{ authorization_epoch: number }>();
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'active', revoked_at = NULL, updated_at = ? WHERE id = 'grant_upgrade_selected'",
    )
      .bind("2026-09-14T00:02:00.000Z")
      .run();
    const regranted = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE id = 'grant_upgrade_selected'",
    ).first<{ authorization_epoch: number }>();
    expect(revoked?.authorization_epoch).toBeGreaterThan(
      initial?.authorization_epoch ?? 0,
    );
    expect(regranted?.authorization_epoch).toBeGreaterThan(
      revoked?.authorization_epoch ?? 0,
    );
    expect(
      await env.CONTROL_DB.prepare(
        "SELECT epoch FROM outbound_authority_heads WHERE tenant_id = 'tenant_upgrade' AND authority_kind = 'account_grant' AND authority_id = 'grant_upgrade_selected'",
      ).first(),
    ).toEqual({ epoch: regranted?.authorization_epoch });
  });
});
