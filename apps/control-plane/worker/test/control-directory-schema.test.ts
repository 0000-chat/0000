import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { seedDirectory } from "./support/directory-fixtures";

const applicationTables = [
  "tenants",
  "principals",
  "memberships",
  "identities",
  "identity_grants",
  "connections",
  "connection_routes",
  "break_glass_grants",
  "revoked_tokens",
  "directory_mutations",
  "control_event_outbox",
  "audit_events",
];

const timestamp = "2026-08-29T00:00:00.000Z";

beforeEach(async () => {
  for (const table of [...applicationTables].reverse()) {
    await env.CONTROL_DB.prepare(`DELETE FROM ${table}`).run();
  }
});

async function insertTenant(id: string) {
  await env.CONTROL_DB.prepare(
    "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, id.replaceAll("_", "-"), id, "active", timestamp, timestamp).run();
}

async function insertPrincipal(id: string, issuer = "https://issuer.example/", subject = id) {
  await env.CONTROL_DB.prepare(
    "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, issuer, subject, "human", id, "active", timestamp, timestamp).run();
}

async function insertMembership(id: string, tenantId: string, principalId: string) {
  await env.CONTROL_DB.prepare(
    "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, tenantId, principalId, "owner", "active", timestamp, timestamp).run();
}

async function insertIdentity(id: string, tenantId: string) {
  await env.CONTROL_DB.prepare(
    "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, tenantId, "human", id, "active", timestamp, timestamp).run();
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

  it("contains no forbidden secret or message columns", async () => {
    const forbiddenColumns = [
      "message_body",
      "matrix_access_token",
      "e2ee_key",
      "bridge_secret",
      "provider_cookie",
      "provider_password",
      "qr_payload",
    ];
    const columns: string[] = [];

    for (const table of applicationTables) {
      const result = await env.CONTROL_DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      columns.push(...result.results.map((column) => column.name));
    }

    expect(columns.filter((column) => forbiddenColumns.includes(column))).toEqual([]);
  });

  it("rejects duplicate issuer and subject principals", async () => {
    await insertPrincipal("principal_one", "https://issuer.example/", "same-subject");
    await expect(insertPrincipal("principal_two", "https://issuer.example/", "same-subject")).rejects.toThrow();
  });

  it("rejects a grant that crosses membership and identity tenants", async () => {
    await insertTenant("tenant_one");
    await insertTenant("tenant_two");
    await insertPrincipal("principal_one");
    await insertMembership("membership_one", "tenant_one", "principal_one");
    await insertIdentity("identity_two", "tenant_two");

    await expect(env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_one", "membership_one", "identity_two", "conversation.read", timestamp).run()).rejects.toThrow();
  });

  it("rejects a connection whose identity belongs to another tenant", async () => {
    await insertTenant("tenant_one");
    await insertTenant("tenant_two");
    await insertIdentity("identity_two", "tenant_two");

    await expect(env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("connection_one", "tenant_one", "identity_two", "whatsapp", "Other tenant", "ready", timestamp, timestamp).run()).rejects.toThrow();
  });

  it("rejects a scoped break-glass grant whose identity belongs to another tenant", async () => {
    await insertTenant("tenant_one");
    await insertTenant("tenant_two");
    await insertPrincipal("principal_operator");
    await insertIdentity("identity_two", "tenant_two");

    await expect(env.CONTROL_DB.prepare(
      "INSERT INTO break_glass_grants (id, tenant_id, operator_principal_id, identity_id, operation_scope, reason, starts_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("grant_one", "tenant_one", "principal_operator", "identity_two", "break_glass.inspect", "approved emergency review", timestamp, timestamp, timestamp).run()).rejects.toThrow();
  });

  it("rejects a break-glass reason shorter than ten characters", async () => {
    await insertTenant("tenant_one");
    await insertPrincipal("principal_operator");

    await expect(env.CONTROL_DB.prepare(
      "INSERT INTO break_glass_grants (id, tenant_id, operator_principal_id, operation_scope, reason, starts_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("grant_one", "tenant_one", "principal_operator", "break_glass.inspect", "too short", timestamp, timestamp, timestamp).run()).rejects.toThrow();
  });

  it("rejects duplicate issuer and token revocations", async () => {
    await insertPrincipal("principal_one");
    const values = ["https://issuer.example/", "token-one", "principal_one", "security review", timestamp];
    await env.CONTROL_DB.prepare(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(...values).run();
    await expect(env.CONTROL_DB.prepare(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(...values).run()).rejects.toThrow();
  });

  it("rejects invalid outbox JSON", async () => {
    await insertTenant("tenant_one");

    await expect(env.CONTROL_DB.prepare(
      "INSERT INTO control_event_outbox (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("event_one", "tenant_one", "authorization.changed", "membership", "membership_one", "not-json", timestamp).run()).rejects.toThrow();
  });

  it("seeds Human and Agent grants without crossing identity boundaries", async () => {
    await seedDirectory(env.CONTROL_DB);
    const result = await env.CONTROL_DB.prepare(
      "SELECT membership_id, identity_id FROM identity_grants ORDER BY membership_id, identity_id",
    ).all<{ membership_id: string; identity_id: string }>();

    expect(result.results.filter((row) => row.membership_id === "membership_human")
      .every((row) => row.identity_id === "identity_human")).toBe(true);
    expect(result.results.filter((row) => row.membership_id === "membership_agent")
      .every((row) => row.identity_id === "identity_agent")).toBe(true);
  });
});
