import { env as runtimeEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearDirectory, seedDirectory } from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & {
  CONTROL_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const applicationTables = [
  "tenants",
  "principals",
  "memberships",
  "identities",
  "identity_grants",
  "connections",
  "connection_capabilities",
  "connection_routes",
  "gateway_routes",
  "connection_accounts",
  "connection_provider_identities",
  "contact_resolution_candidates",
  "direct_chat_creation_operations",
  "account_grants",
  "account_grant_chats",
  "attachment_download_grants",
  "permission_requests",
  "break_glass_grants",
  "revoked_tokens",
  "directory_mutations",
  "control_event_outbox",
  "audit_events",
  "realtime_tickets",
  "oauth_clients",
  "oauth_client_installations",
  "oauth_authorization_transactions",
  "oauth_authorization_codes",
  "oauth_upstream_login_transactions",
  "webhook_subscriptions",
  "webhook_subscription_account_rules",
  "webhook_subscription_chat_rules",
  "webhook_deliveries",
  "provider_capability_records",
  "history_imports",
  "history_import_ranges",
  "history_import_events",
  "archive_purge_locks",
  "archive_purge_objects",
  "archive_purge_operations",
  "removal_authority",
  "removal_expiry_schedule",
  "group_creation_operations",
  "group_creation_access_grants",
  "group_creation_webhook_evaluations",
  "group_management_groups",
  "group_management_operations",
  "group_management_evidence",
  "receipt_operations",
  "receipt_operation_evidence",
  "receipt_authority_intents",
  "receipt_dispatch_claims",
  "outbound_authority_heads",
  "outbound_acceptance_intents",
  "outbound_dispatch_claims",
  "group_authority_intents",
  "group_dispatch_claims",
];

const timestamp = "2026-08-29T00:00:00.000Z";

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
});

async function insertTenant(id: string) {
  await env.CONTROL_DB.prepare(
    "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, id.replaceAll("_", "-"), id, "active", timestamp, timestamp)
    .run();
}

async function insertPrincipal(
  id: string,
  issuer = "https://issuer.example/",
  subject = id,
) {
  await env.CONTROL_DB.prepare(
    "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, issuer, subject, "human", id, "active", timestamp, timestamp)
    .run();
}

async function insertMembership(
  id: string,
  tenantId: string,
  principalId: string,
) {
  await env.CONTROL_DB.prepare(
    "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, tenantId, principalId, "owner", "active", timestamp, timestamp)
    .run();
}

async function insertIdentity(id: string, tenantId: string) {
  await env.CONTROL_DB.prepare(
    "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, tenantId, "human", id, "active", timestamp, timestamp)
    .run();
}

async function dropControlDirectorySchema(db: D1Database) {
  const triggers = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )
    .all<{ name: string }>();
  for (const { name } of triggers.results) {
    if (!/^[A-Za-z0-9_]+$/.test(name))
      throw new Error("unexpected trigger name");
    await db.prepare(`DROP TRIGGER IF EXISTS "${name}"`).run();
  }

  for (const table of [
    "group_dispatch_claims",
    "group_authority_intents",
    "receipt_dispatch_claims",
    "receipt_authority_intents",
    "receipt_operation_evidence",
    "receipt_operations",
    "outbound_dispatch_claims",
    "outbound_acceptance_intents",
    "outbound_authority_heads",
    "attachment_download_grants",
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
    "break_glass_grants",
    "revoked_tokens",
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
    await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  }
}

describe("control directory schema", () => {
  it("creates every authoritative application table", async () => {
    const result = await env.CONTROL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY name",
    ).all<{ name: string }>();

    expect(result.results.map((row) => row.name).sort()).toEqual(
      [...applicationTables, "d1_migrations"].sort(),
    );
  });

  it("applies the forward-only routing migration after the control-directory migration", async () => {
    const migrations = await env.CONTROL_DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>();
    expect(migrations.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "0001_control_directory.sql",
        "0002_ingestion_routing.sql",
        "0003_connection_read_metadata.sql",
        "0004_realtime_tickets.sql",
        "0005_account_grants.sql",
        "0006_oauth_installations.sql",
        "0010_webhook_subscriptions.sql",
      ]),
    );
    expect(
      migrations.results.findIndex(
        (row) => row.name === "0002_ingestion_routing.sql",
      ),
    ).toBeGreaterThan(
      migrations.results.findIndex(
        (row) => row.name === "0001_control_directory.sql",
      ),
    );
    expect(
      migrations.results.findIndex(
        (row) => row.name === "0003_connection_read_metadata.sql",
      ),
    ).toBeGreaterThan(
      migrations.results.findIndex(
        (row) => row.name === "0002_ingestion_routing.sql",
      ),
    );
    expect(
      migrations.results.findIndex(
        (row) => row.name === "0004_realtime_tickets.sql",
      ),
    ).toBeGreaterThan(
      migrations.results.findIndex(
        (row) => row.name === "0003_connection_read_metadata.sql",
      ),
    );
    expect(
      migrations.results.findIndex(
        (row) => row.name === "0005_account_grants.sql",
      ),
    ).toBeGreaterThan(
      migrations.results.findIndex(
        (row) => row.name === "0004_realtime_tickets.sql",
      ),
    );
    expect(
      migrations.results.findIndex(
        (row) => row.name === "0006_oauth_installations.sql",
      ),
    ).toBeGreaterThan(
      migrations.results.findIndex(
        (row) => row.name === "0005_account_grants.sql",
      ),
    );
    expect(
      migrations.results.findIndex(
        (row) => row.name === "0010_webhook_subscriptions.sql",
      ),
    ).toBeGreaterThan(
      migrations.results.findIndex(
        (row) => row.name === "0006_oauth_installations.sql",
      ),
    );
    const legacyTables = await env.CONTROL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connection_routes'",
    ).all<{ name: string }>();
    expect(legacyTables.results).toEqual([{ name: "connection_routes" }]);
  });

  it("reapplying the complete migration harness is idempotent", async () => {
    await expect(
      applyD1Migrations(env.CONTROL_DB, env.TEST_MIGRATIONS),
    ).resolves.toBeUndefined();
    const migrations = await env.CONTROL_DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>();
    expect(
      migrations.results.filter(
        (row) => row.name === "0003_connection_read_metadata.sql",
      ),
    ).toHaveLength(1);
  });

  it("creates bounded connection metadata and capability constraints", async () => {
    await seedDirectory(env.CONTROL_DB);
    const columns = await env.CONTROL_DB.prepare(
      "SELECT name, dflt_value FROM pragma_table_info('connections') WHERE name IN ('last_synced_at', 'attention_code', 'sort_position') ORDER BY name",
    ).all<{ name: string; dflt_value: string | null }>();
    expect(columns.results).toEqual([
      { name: "attention_code", dflt_value: null },
      { name: "last_synced_at", dflt_value: null },
      { name: "sort_position", dflt_value: "0" },
    ]);

    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_capabilities (tenant_id, connection_id, capability, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(
          "tenant_pilot",
          "connection_human_whatsapp",
          "not-a-capability",
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE connections SET sort_position = -1 WHERE id = ?",
      )
        .bind("connection_human_whatsapp")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE connections SET attention_code = ? WHERE id = ?",
      )
        .bind("a".repeat(101), "connection_human_whatsapp")
        .run(),
    ).rejects.toThrow();

    await insertTenant("tenant_other");
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_capabilities (tenant_id, connection_id, capability, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(
          "tenant_other",
          "connection_human_whatsapp",
          "message.send",
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("contains no forbidden secret or message columns", async () => {
    const forbiddenColumns = [
      "message_body",
      "matrix_access_token",
      "e2ee_key",
      "bridge_secret",
      "provider_cookie",
      "provider_password",
      "qr_payload",
      "ticket",
      "raw_ticket",
      "ticket_url",
      "token",
    ];
    const columns: string[] = [];

    for (const table of applicationTables) {
      const result = await env.CONTROL_DB.prepare(
        `PRAGMA table_info(${table})`,
      ).all<{ name: string }>();
      columns.push(...result.results.map((column) => column.name));
    }

    expect(
      columns.filter((column) => forbiddenColumns.includes(column)),
    ).toEqual([]);
  });

  it("stores realtime ticket digests and no raw ticket column", async () => {
    const columns = await env.CONTROL_DB.prepare(
      "SELECT name FROM pragma_table_info('realtime_tickets') ORDER BY cid",
    ).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "ticket_digest",
      "tenant_id",
      "principal_id",
      "membership_id",
      "subscriptions_json",
      "resume_json",
      "created_at",
      "expires_at",
      "expires_at_ms",
    ]);
    expect(columns.results.map((column) => column.name)).not.toContain(
      "ticket",
    );
    expect(columns.results.map((column) => column.name)).not.toContain(
      "raw_ticket",
    );
    const definition = await env.CONTROL_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'realtime_tickets'",
    ).first<{ sql: string }>();
    expect(definition?.sql).toContain("ticket_digest TEXT PRIMARY KEY");
    expect(definition?.sql).not.toMatch(
      /\b(?:raw_ticket|ticket_url|token|url)\b/i,
    );
  });

  it("rejects duplicate issuer and subject principals", async () => {
    await insertPrincipal(
      "principal_one",
      "https://issuer.example/",
      "same-subject",
    );
    await expect(
      insertPrincipal(
        "principal_two",
        "https://issuer.example/",
        "same-subject",
      ),
    ).rejects.toThrow();
  });

  it("rejects a grant that crosses membership and identity tenants", async () => {
    await insertTenant("tenant_one");
    await insertTenant("tenant_two");
    await insertPrincipal("principal_one");
    await insertMembership("membership_one", "tenant_one", "principal_one");
    await insertIdentity("identity_two", "tenant_two");

    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "tenant_one",
          "membership_one",
          "identity_two",
          "conversation.read",
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a connection whose identity belongs to another tenant", async () => {
    await insertTenant("tenant_one");
    await insertTenant("tenant_two");
    await insertIdentity("identity_two", "tenant_two");

    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "connection_one",
          "tenant_one",
          "identity_two",
          "whatsapp",
          "Other tenant",
          "ready",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a scoped break-glass grant whose identity belongs to another tenant", async () => {
    await insertTenant("tenant_one");
    await insertTenant("tenant_two");
    await insertPrincipal("principal_operator");
    await insertIdentity("identity_two", "tenant_two");

    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO break_glass_grants (id, tenant_id, operator_principal_id, identity_id, operation_scope, reason, starts_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "grant_one",
          "tenant_one",
          "principal_operator",
          "identity_two",
          "break_glass.inspect",
          "approved emergency review",
          timestamp,
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a break-glass reason shorter than ten characters", async () => {
    await insertTenant("tenant_one");
    await insertPrincipal("principal_operator");

    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO break_glass_grants (id, tenant_id, operator_principal_id, operation_scope, reason, starts_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "grant_one",
          "tenant_one",
          "principal_operator",
          "break_glass.inspect",
          "too short",
          timestamp,
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("rejects duplicate issuer and token revocations", async () => {
    await insertPrincipal("principal_one");
    const values = [
      "https://issuer.example/",
      "token-one",
      "principal_one",
      "security review",
      timestamp,
    ];
    await env.CONTROL_DB.prepare(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(...values)
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(...values)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects invalid outbox JSON", async () => {
    await insertTenant("tenant_one");

    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO control_event_outbox (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "event_one",
          "tenant_one",
          "authorization.changed",
          "membership",
          "membership_one",
          "not-json",
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("seeds Human and Agent grants without crossing identity boundaries", async () => {
    await seedDirectory(env.CONTROL_DB);
    const result = await env.CONTROL_DB.prepare(
      "SELECT membership_id, identity_id FROM identity_grants ORDER BY membership_id, identity_id",
    ).all<{ membership_id: string; identity_id: string }>();

    expect(
      result.results
        .filter((row) => row.membership_id === "membership_human")
        .every((row) => row.identity_id === "identity_human"),
    ).toBe(true);
    expect(
      result.results
        .filter((row) => row.membership_id === "membership_agent")
        .every((row) => row.identity_id === "identity_agent"),
    ).toBe(true);
  });

  it("creates bounded ingestion routing tables, indexes, and lifecycle triggers", async () => {
    const tableInfo = await env.CONTROL_DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('gateway_routes', 'connection_accounts') ORDER BY name",
    ).all<{ name: string; sql: string }>();
    expect(tableInfo.results.map((row) => row.name)).toEqual([
      "connection_accounts",
      "gateway_routes",
    ]);
    expect(
      tableInfo.results.find((row) => row.name === "gateway_routes")?.sql,
    ).toContain("status IN ('active', 'disabled', 'revoked')");
    expect(
      tableInfo.results.find((row) => row.name === "connection_accounts")?.sql,
    ).toContain("status IN ('active', 'retired')");

    const indexes = await env.CONTROL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('gateway_routes_service_status_idx', 'connection_accounts_connection_status_idx') ORDER BY name",
    ).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual([
      "connection_accounts_connection_status_idx",
      "gateway_routes_service_status_idx",
    ]);

    const triggers = await env.CONTROL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'ingestion_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "ingestion_gateway_routes_insert_no_replace",
        "ingestion_gateway_routes_immutable",
        "ingestion_gateway_routes_no_delete",
        "ingestion_connection_accounts_insert_no_replace",
        "ingestion_connection_accounts_require_route",
        "ingestion_connection_accounts_immutable",
        "ingestion_connection_accounts_no_delete",
        "ingestion_connection_routes_ownership_immutable",
        "ingestion_connection_routes_connection_immutable",
        "ingestion_connection_routes_insert_no_replace",
        "ingestion_principals_revocation_insert_no_replace",
        "ingestion_principals_revocation_identity_immutable",
        "ingestion_principals_revocation_identity_conflict",
        "ingestion_principals_revocation_no_delete",
        "ingestion_principals_revocation_terminal",
        "ingestion_revoked_tokens_insert_no_replace",
        "ingestion_revoked_tokens_append_only",
      ]),
    );
  });

  it("enforces ingestion routing checks and foreign-key ownership", async () => {
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "gateway_route_missing_principal",
          "principal_missing",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "gateway_route_bad_status",
          "principal_missing",
          "paused",
          timestamp,
          timestamp,
          null,
        )
        .run(),
    ).rejects.toThrow();

    await seedDirectory(env.CONTROL_DB);
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "gateway_route_check",
          "principal_human",
          "revoked",
          timestamp,
          timestamp,
          null,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_missing_connection",
          "connection_missing",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_bad_status",
          "connection_human_whatsapp",
          "paused",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at, retired_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "account_bad_retired_at",
          "connection_human_whatsapp",
          "active",
          timestamp,
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("freezes ownership and terminal history once an account is registered", async () => {
    await seedDirectory(env.CONTROL_DB);
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "gateway_route_human",
        "principal_human",
        "active",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "account_human_whatsapp",
        "connection_human_whatsapp",
        "active",
        timestamp,
        timestamp,
      ),
    ]);

    for (const [sql, value] of [
      [
        "UPDATE gateway_routes SET id = ? WHERE id = 'gateway_route_human'",
        "gateway_route_other",
      ],
      [
        "UPDATE gateway_routes SET service_principal_id = ? WHERE id = 'gateway_route_human'",
        "principal_agent",
      ],
      [
        "UPDATE connection_accounts SET account_id = ? WHERE account_id = 'account_human_whatsapp'",
        "account_other",
      ],
      [
        "UPDATE connection_accounts SET connection_id = ? WHERE account_id = 'account_human_whatsapp'",
        "connection_other",
      ],
      [
        "UPDATE connections SET tenant_id = ? WHERE id = 'connection_human_whatsapp'",
        "tenant_other",
      ],
      [
        "UPDATE connections SET identity_id = ? WHERE id = 'connection_human_whatsapp'",
        "identity_agent",
      ],
      [
        "UPDATE connections SET provider = ? WHERE id = 'connection_human_whatsapp'",
        "telegram",
      ],
      [
        "UPDATE principals SET issuer = ? WHERE id = 'principal_human'",
        "https://other.example/",
      ],
      [
        "UPDATE principals SET subject = ? WHERE id = 'principal_human'",
        "other-subject",
      ],
      [
        "UPDATE principals SET principal_type = ? WHERE id = 'principal_human'",
        "agent",
      ],
      [
        "UPDATE connection_routes SET connection_id = ? WHERE connection_id = 'connection_human_whatsapp'",
        "connection_other",
      ],
      [
        "UPDATE connection_routes SET gateway_route_id = ? WHERE connection_id = 'connection_human_whatsapp'",
        "gateway_route_other",
      ],
    ] as const) {
      await expect(
        env.CONTROL_DB.prepare(sql).bind(value).run(),
      ).rejects.toThrow();
    }
    await expect(
      env.CONTROL_DB.prepare(
        "DELETE FROM gateway_routes WHERE id = 'gateway_route_human'",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "DELETE FROM connection_accounts WHERE account_id = 'account_human_whatsapp'",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "DELETE FROM connection_routes WHERE connection_id = 'connection_human_whatsapp'",
      ).run(),
    ).rejects.toThrow();

    await env.CONTROL_DB.prepare(
      "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = 'principal_human'",
    )
      .bind(timestamp)
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE principals SET status = 'active' WHERE id = 'principal_human'",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE principals SET revoked_at = NULL WHERE id = 'principal_human'",
      ).run(),
    ).rejects.toThrow();

    await env.CONTROL_DB.prepare(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "https://issuer.example/",
        "jti_append_only",
        "principal_human",
        "security review",
        timestamp,
      )
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE revoked_tokens SET reason = ? WHERE token_id = 'jti_append_only'",
      )
        .bind("changed")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "DELETE FROM revoked_tokens WHERE token_id = 'jti_append_only'",
      ).run(),
    ).rejects.toThrow();

    await env.CONTROL_DB.prepare(
      "UPDATE gateway_routes SET status = 'revoked', revoked_at = ? WHERE id = 'gateway_route_human'",
    )
      .bind(timestamp)
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE gateway_routes SET status = 'active', revoked_at = NULL WHERE id = 'gateway_route_human'",
      ).run(),
    ).rejects.toThrow();
    await env.CONTROL_DB.prepare(
      "UPDATE connection_accounts SET status = 'retired', retired_at = ? WHERE account_id = 'account_human_whatsapp'",
    )
      .bind(timestamp)
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE connection_accounts SET status = 'active', retired_at = NULL WHERE account_id = 'account_human_whatsapp'",
      ).run(),
    ).rejects.toThrow();
  });

  it("rejects INSERT OR REPLACE hijacks while recursive triggers remain disabled", async () => {
    const recursiveTriggers = await env.CONTROL_DB.prepare(
      "PRAGMA recursive_triggers",
    ).first<{ recursive_triggers: number }>();
    expect(recursiveTriggers?.recursive_triggers).toBe(0);

    await insertTenant("tenant_replace");
    await insertPrincipal(
      "principal_replace_route",
      "https://replace.example/",
      "route",
    );
    await env.CONTROL_DB.prepare(
      "UPDATE principals SET principal_type = 'service' WHERE id = 'principal_replace_route'",
    ).run();
    await insertPrincipal(
      "principal_replace_route_other",
      "https://replace.example/",
      "route-other",
    );
    await env.CONTROL_DB.prepare(
      "UPDATE principals SET principal_type = 'service' WHERE id = 'principal_replace_route_other'",
    ).run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "gateway_route_replace",
        "principal_replace_route",
        "active",
        timestamp,
        timestamp,
      )
      .run();

    await expect(
      env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "gateway_route_replace",
          "principal_replace_route_other",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();

    await insertIdentity("identity_replace_one", "tenant_replace");
    await insertIdentity("identity_replace_two", "tenant_replace");
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "connection_replace_one",
        "tenant_replace",
        "identity_replace_one",
        "whatsapp",
        "One",
        "ready",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "connection_replace_two",
        "tenant_replace",
        "identity_replace_two",
        "telegram",
        "Two",
        "ready",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "connection_replace_one",
        "gateway_route_replace",
        "bridge-one",
        "user-one",
        "room-one",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "connection_replace_two",
        "gateway_route_replace",
        "bridge-two",
        "user-two",
        "room-two",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "account_replace_one",
        "connection_replace_one",
        "active",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "account_replace_two",
        "connection_replace_two",
        "active",
        timestamp,
        timestamp,
      ),
    ]);

    await expect(
      env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_replace_one",
          "connection_replace_two",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_replace_other",
          "connection_replace_one",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "connection_replace_one",
          "gateway_route_other",
          "bridge-hijack",
          "user-hijack",
          "room-hijack",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();

    await insertPrincipal(
      "principal_replace_token",
      "https://replace.example/",
      "token",
    );
    await env.CONTROL_DB.prepare(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "https://replace.example/",
        "jti_replace",
        "principal_replace_token",
        "security review",
        timestamp,
      )
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "https://replace.example/",
          "jti_replace",
          "principal_replace_route",
          "replacement",
          timestamp,
        )
        .run(),
    ).rejects.toThrow();

    await insertPrincipal(
      "principal_replace_revoked",
      "https://replace.example/",
      "revoked",
    );
    await env.CONTROL_DB.prepare(
      "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = 'principal_replace_revoked'",
    )
      .bind(timestamp)
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "principal_replace_revoked",
          "https://replace.example/",
          "replacement",
          "service",
          "Replacement",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          "principal_replace_revoked_other",
          "https://replace.example/",
          "revoked",
          "service",
          "Replacement",
          "active",
          timestamp,
          timestamp,
          null,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("keeps a pre-migration legacy route unregistered until explicit registration", async () => {
    await insertTenant("tenant_legacy");
    await insertPrincipal("principal_legacy");
    await insertIdentity("identity_legacy", "tenant_legacy");
    await env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "connection_legacy",
        "tenant_legacy",
        "identity_legacy",
        "whatsapp",
        "Legacy",
        "ready",
        timestamp,
        timestamp,
      )
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "connection_legacy",
        "gateway-legacy",
        "bridge",
        "user",
        "room",
        timestamp,
        timestamp,
      )
      .run();

    await expect(
      env.CONTROL_DB.prepare(
        "SELECT gateway_route_id FROM connection_routes WHERE connection_id = ?",
      )
        .bind("connection_legacy")
        .first(),
    ).resolves.toMatchObject({ gateway_route_id: "gateway-legacy" });
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_legacy",
          "connection_legacy",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
    await insertPrincipal(
      "principal_legacy_service",
      "https://legacy.example/",
      "legacy-service",
    );
    await env.CONTROL_DB.prepare(
      "UPDATE principals SET principal_type = 'service' WHERE id = 'principal_legacy_service'",
    ).run();
    await env.CONTROL_DB.prepare(
      "UPDATE connection_routes SET gateway_route_id = ? WHERE connection_id = ?",
    )
      .bind("gateway_route_legacy", "connection_legacy")
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "gateway_route_legacy",
        "principal_legacy_service",
        "active",
        timestamp,
        timestamp,
      )
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_legacy",
          "connection_legacy",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).resolves.toBeDefined();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE connection_routes SET gateway_route_id = ? WHERE connection_id = ?",
      )
        .bind("gateway_route_legacy_other", "connection_legacy")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_legacy",
          "connection_legacy",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("migrates a real 0001-only legacy database and also boots a fresh 0001+0002 database", async () => {
    const migrationOne = env.TEST_MIGRATIONS.find(
      (migration) => migration.name === "0001_control_directory.sql",
    );
    const migrationTwo = env.TEST_MIGRATIONS.find(
      (migration) => migration.name === "0002_ingestion_routing.sql",
    );
    expect(migrationOne).toBeDefined();
    expect(migrationTwo).toBeDefined();
    if (!migrationOne || !migrationTwo)
      throw new Error("expected control-directory migrations");

    await dropControlDirectorySchema(env.CONTROL_DB);
    await applyD1Migrations(env.CONTROL_DB, [migrationOne]);
    const legacyMigrations = await env.CONTROL_DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>();
    expect(legacyMigrations.results.map((row) => row.name)).toEqual([
      "0001_control_directory.sql",
    ]);
    await insertTenant("tenant_migration_legacy");
    await insertPrincipal(
      "principal_migration_legacy",
      "https://migration.example/",
      "legacy",
    );
    await env.CONTROL_DB.prepare(
      "UPDATE principals SET principal_type = 'service' WHERE id = 'principal_migration_legacy'",
    ).run();
    await insertIdentity(
      "identity_migration_legacy",
      "tenant_migration_legacy",
    );
    await env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "connection_migration_legacy",
        "tenant_migration_legacy",
        "identity_migration_legacy",
        "telegram",
        "Legacy",
        "ready",
        timestamp,
        timestamp,
      )
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "connection_migration_legacy",
        "gateway-legacy-migration",
        "bridge",
        "user",
        "room",
        timestamp,
        timestamp,
      )
      .run();

    await applyD1Migrations(env.CONTROL_DB, [migrationTwo]);
    await expect(
      env.CONTROL_DB.prepare(
        "SELECT gateway_route_id FROM connection_routes WHERE connection_id = ?",
      )
        .bind("connection_migration_legacy")
        .first(),
    ).resolves.toEqual({
      gateway_route_id: "gateway-legacy-migration",
    });
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_migration_legacy",
          "connection_migration_legacy",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow();

    await env.CONTROL_DB.prepare(
      "UPDATE connection_routes SET gateway_route_id = ? WHERE connection_id = ?",
    )
      .bind("gateway_route_migration_legacy", "connection_migration_legacy")
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "gateway_route_migration_legacy",
        "principal_migration_legacy",
        "active",
        timestamp,
        timestamp,
      )
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "account_migration_legacy",
        "connection_migration_legacy",
        "active",
        timestamp,
        timestamp,
      )
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE connection_routes SET gateway_route_id = ? WHERE connection_id = ?",
      )
        .bind("gateway_route_migration_other", "connection_migration_legacy")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "DELETE FROM connection_routes WHERE connection_id = ?",
      )
        .bind("connection_migration_legacy")
        .run(),
    ).rejects.toThrow();

    await dropControlDirectorySchema(env.CONTROL_DB);
    const staleCapabilityTable = await env.CONTROL_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connection_capabilities'",
    ).all<{ name: string }>();
    expect(staleCapabilityTable.results).toEqual([]);
    await applyD1Migrations(env.CONTROL_DB, [migrationOne, migrationTwo]);
    const freshMigrations = await env.CONTROL_DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>();
    expect(freshMigrations.results.map((row) => row.name)).toEqual([
      "0001_control_directory.sql",
      "0002_ingestion_routing.sql",
    ]);
    await insertTenant("tenant_migration_fresh");
    await insertPrincipal(
      "principal_migration_fresh",
      "https://migration.example/",
      "fresh",
    );
    await env.CONTROL_DB.prepare(
      "UPDATE principals SET principal_type = 'service' WHERE id = 'principal_migration_fresh'",
    ).run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "gateway_route_migration_fresh",
        "principal_migration_fresh",
        "active",
        timestamp,
        timestamp,
      )
      .run();
    await insertIdentity("identity_migration_fresh", "tenant_migration_fresh");
    await env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "connection_migration_fresh",
        "tenant_migration_fresh",
        "identity_migration_fresh",
        "whatsapp",
        "Fresh",
        "ready",
        timestamp,
        timestamp,
      )
      .run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "connection_migration_fresh",
        "gateway_route_migration_fresh",
        "bridge",
        "user",
        "room",
        timestamp,
        timestamp,
      )
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "account_migration_fresh",
          "connection_migration_fresh",
          "active",
          timestamp,
          timestamp,
        )
        .run(),
    ).resolves.toBeDefined();
  });
});
