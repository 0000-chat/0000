import { env as runtimeEnv, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeEach, describe, expect, it } from "vitest";

const env = runtimeEnv as typeof runtimeEnv & {
  CONTROL_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const timestamp = "2026-09-14T00:00:00.000Z";

const migration = (name: string): D1Migration => {
  const found = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`missing migration ${name}`);
  return found;
};

async function resetSchema() {
  await env.CONTROL_DB.prepare("PRAGMA foreign_keys = OFF").run();
  const triggers = await env.CONTROL_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  ).all<{ name: string }>();
  for (const trigger of triggers.results) {
    if (!/^[A-Za-z0-9_]+$/u.test(trigger.name))
      throw new Error(`unexpected trigger ${trigger.name}`);
    await env.CONTROL_DB.prepare(
      `DROP TRIGGER IF EXISTS "${trigger.name}"`,
    ).run();
  }
  for (const table of [
    "group_dispatch_claims",
    "group_authority_intents",
    "contact_dispatch_claims",
    "contact_authority_intents",
    "receipt_dispatch_claims",
    "receipt_authority_intents",
    "connection_lifecycle_operations",
    "outbound_dispatch_claims",
    "outbound_acceptance_intents",
    "outbound_authority_heads",
    "receipt_operation_evidence",
    "receipt_operations",
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
    "restore_activation_leases",
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
    "platform_browser_oauth_transactions",
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
  ]) {
    await env.CONTROL_DB.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  }
}

async function seedPopulatedDirectory() {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind("tenant_upgrade", "upgrade", "Upgrade", timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, 'active', ?, ?)",
    ).bind(
      "principal_upgrade",
      "https://issuer.example/",
      "upgrade-subject",
      "Upgrade",
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
      "Upgrade",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, 'connection.manage', ?)",
    ).bind(
      "tenant_upgrade",
      "membership_upgrade",
      "identity_upgrade",
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind("gateway_upgrade", "principal_upgrade", timestamp, timestamp),
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
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    ).bind("account_upgrade", "connection_upgrade", timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, provider_login_id, connection_id, link_session_id, created_at) VALUES (?, 'whatsapp', ?, ?, ?, ?, ?)",
    ).bind(
      "tenant_upgrade",
      "a".repeat(64),
      "login-upgrade",
      "connection_upgrade",
      "link-upgrade",
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, 'message.send', 'selected_chats', 'active', ?, ?, NULL)",
    ).bind(
      "grant_upgrade",
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
      "grant_upgrade",
      "tenant_upgrade",
      "account_upgrade",
      "conversation_existing",
      timestamp,
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
    env.CONTROL_DB.prepare(
      "INSERT INTO audit_events (id, tenant_id, actor_principal_id, action, target_type, target_id, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)",
    ).bind(
      "audit_upgrade",
      "tenant_upgrade",
      "principal_upgrade",
      "grant.created",
      "grant",
      "grant_upgrade",
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO control_event_outbox (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?)",
    ).bind(
      "outbox_upgrade",
      "tenant_upgrade",
      "grant.created",
      "grant",
      "grant_upgrade",
      timestamp,
    ),
  ]);
}

beforeEach(async () => {
  await resetSchema();
  const base = env.TEST_MIGRATIONS.map((candidate) => candidate.name)
    .filter((name) => name !== "0029_connection_lifecycle.sql")
    .map(migration);
  await applyD1Migrations(env.CONTROL_DB, base);
  await seedPopulatedDirectory();
});

describe("connection lifecycle migration", () => {
  it("adds lifecycle records without changing populated authority, grants or routing rows", async () => {
    const before = {
      connection: await env.CONTROL_DB.prepare(
        "SELECT id, identity_id, provider, status, created_at, updated_at FROM connections WHERE id = ?",
      )
        .bind("connection_upgrade")
        .first(),
      route: await env.CONTROL_DB.prepare(
        "SELECT * FROM connection_routes WHERE connection_id = ?",
      )
        .bind("connection_upgrade")
        .first(),
      account: await env.CONTROL_DB.prepare(
        "SELECT * FROM connection_accounts WHERE account_id = ?",
      )
        .bind("account_upgrade")
        .first(),
      providerIdentity: await env.CONTROL_DB.prepare(
        "SELECT provider, identity_key, provider_login_id, connection_id, link_session_id FROM connection_provider_identities WHERE connection_id = ?",
      )
        .bind("connection_upgrade")
        .first(),
      grant: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_scope, status, authorization_epoch FROM account_grants WHERE id = ?",
      )
        .bind("grant_upgrade")
        .first(),
      selectedChat: await env.CONTROL_DB.prepare(
        "SELECT * FROM account_grant_chats WHERE grant_id = ?",
      )
        .bind("grant_upgrade")
        .first(),
      authorityHead: await env.CONTROL_DB.prepare(
        "SELECT authority_kind, authority_id, epoch FROM outbound_authority_heads WHERE tenant_id = ? ORDER BY authority_kind, authority_id",
      )
        .bind("tenant_upgrade")
        .all()
        .then((result) => result.results),
      mutation: await env.CONTROL_DB.prepare(
        "SELECT * FROM directory_mutations WHERE idempotency_key = ?",
      )
        .bind("mutation_upgrade")
        .first(),
      audit: await env.CONTROL_DB.prepare(
        "SELECT * FROM audit_events WHERE id = ?",
      )
        .bind("audit_upgrade")
        .first(),
      outbox: await env.CONTROL_DB.prepare(
        "SELECT * FROM control_event_outbox WHERE event_id = ?",
      )
        .bind("outbox_upgrade")
        .first(),
    };
    const grantEpoch = Number(
      (before.grant as { authorization_epoch: number }).authorization_epoch,
    );

    await applyD1Migrations(env.CONTROL_DB, [
      migration("0029_connection_lifecycle.sql"),
    ]);

    const after = {
      connection: await env.CONTROL_DB.prepare(
        "SELECT id, identity_id, provider, status, created_at, updated_at FROM connections WHERE id = ?",
      )
        .bind("connection_upgrade")
        .first(),
      route: await env.CONTROL_DB.prepare(
        "SELECT * FROM connection_routes WHERE connection_id = ?",
      )
        .bind("connection_upgrade")
        .first(),
      account: await env.CONTROL_DB.prepare(
        "SELECT * FROM connection_accounts WHERE account_id = ?",
      )
        .bind("account_upgrade")
        .first(),
      providerIdentity: await env.CONTROL_DB.prepare(
        "SELECT provider, identity_key, provider_login_id, connection_id, link_session_id FROM connection_provider_identities WHERE connection_id = ?",
      )
        .bind("connection_upgrade")
        .first(),
      grant: await env.CONTROL_DB.prepare(
        "SELECT id, operation_scope, chat_scope, status, authorization_epoch FROM account_grants WHERE id = ?",
      )
        .bind("grant_upgrade")
        .first(),
      selectedChat: await env.CONTROL_DB.prepare(
        "SELECT * FROM account_grant_chats WHERE grant_id = ?",
      )
        .bind("grant_upgrade")
        .first(),
      authorityHead: await env.CONTROL_DB.prepare(
        "SELECT authority_kind, authority_id, epoch FROM outbound_authority_heads WHERE tenant_id = ? ORDER BY authority_kind, authority_id",
      )
        .bind("tenant_upgrade")
        .all()
        .then((result) => result.results),
      mutation: await env.CONTROL_DB.prepare(
        "SELECT * FROM directory_mutations WHERE idempotency_key = ?",
      )
        .bind("mutation_upgrade")
        .first(),
      audit: await env.CONTROL_DB.prepare(
        "SELECT * FROM audit_events WHERE id = ?",
      )
        .bind("audit_upgrade")
        .first(),
      outbox: await env.CONTROL_DB.prepare(
        "SELECT * FROM control_event_outbox WHERE event_id = ?",
      )
        .bind("outbox_upgrade")
        .first(),
    };
    expect(after).toEqual(before);
    expect(
      Number(
        (after.grant as { authorization_epoch: number }).authorization_epoch,
      ),
    ).toBe(grantEpoch);
    const lifecycleTable = await env.CONTROL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connection_lifecycle_operations'",
    ).all<{ name: string }>();
    expect(lifecycleTable.results).toEqual([
      { name: "connection_lifecycle_operations" },
    ]);
    expect(
      (await env.CONTROL_DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);

    await env.CONTROL_DB.prepare(
      `INSERT INTO connection_lifecycle_operations
         (operation_id, tenant_id, actor_principal_id, membership_id,
          connection_id, identity_id, provider, kind,
          session_id, idempotency_key, expected_session_generation, provider_login_id,
          status, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'whatsapp', 'disconnect', NULL, ?, ?, ?, 'pending', '[]', ?, ?)`,
    )
      .bind(
        "lifecycle_upgrade",
        "tenant_upgrade",
        "principal_upgrade",
        "membership_upgrade",
        "connection_upgrade",
        "identity_upgrade",
        "lifecycle-upgrade-key",
        timestamp,
        "login-upgrade",
        timestamp,
        timestamp,
      )
      .run();
    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(timestamp, timestamp, "grant_upgrade")
      .run();
    const afterRevoke = await env.CONTROL_DB.prepare(
      "SELECT authorization_epoch FROM account_grants WHERE id = ?",
    )
      .bind("grant_upgrade")
      .first<{ authorization_epoch: number }>();
    expect(Number(afterRevoke?.authorization_epoch)).toBeGreaterThan(
      grantEpoch,
    );
  });
});
