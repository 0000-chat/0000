import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveAuthorization } from "../control-directory/authorization";
import {
  replaceIdentityGrants,
  setMembershipStatus,
} from "../control-directory/repository";
import type { GrantReplacement } from "../control-directory/repository";
import { clearDirectory, seedDirectory } from "./support/directory-fixtures";

const occurredAt = "2026-08-29T00:00:00.000Z";
const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
});

describe("directory mutations", () => {
  it("replaces grants and records one mutation, audit event, and outbox event", async () => {
    await replaceIdentityGrants(env.CONTROL_DB, {
      idempotency_key: "replace-human-grants",
      tenant_id: "tenant_pilot",
      actor_principal_id: "principal_human",
      membership_id: "membership_human",
      grants: [{ identity_id: "identity_human", scopes: ["message.send"] }],
      occurred_at: occurredAt,
    });

    const grants = await env.CONTROL_DB.prepare(
      "SELECT identity_id, operation_scope FROM identity_grants WHERE tenant_id = ? AND membership_id = ? ORDER BY identity_id, operation_scope",
    ).bind("tenant_pilot", "membership_human").all();
    const counts = await env.CONTROL_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM directory_mutations) AS mutations, (SELECT COUNT(*) FROM audit_events) AS audits, (SELECT COUNT(*) FROM control_event_outbox) AS outbox",
    ).first<{ mutations: number; audits: number; outbox: number }>();

    expect(grants.results).toEqual([{ identity_id: "identity_human", operation_scope: "message.send" }]);
    expect(counts).toEqual({ mutations: 1, audits: 1, outbox: 1 });
  });

  it("retries an identical grant replacement idempotently", async () => {
    const input: GrantReplacement = {
      idempotency_key: "replace-human-retry",
      tenant_id: "tenant_pilot",
      actor_principal_id: "principal_human",
      membership_id: "membership_human",
      grants: [{ identity_id: "identity_human", scopes: ["message.send", "conversation.read"] }],
      occurred_at: occurredAt,
    };
    await replaceIdentityGrants(env.CONTROL_DB, input);
    await replaceIdentityGrants(env.CONTROL_DB, input);

    const counts = await env.CONTROL_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM directory_mutations) AS mutations, (SELECT COUNT(*) FROM audit_events) AS audits, (SELECT COUNT(*) FROM control_event_outbox) AS outbox",
    ).first<{ mutations: number; audits: number; outbox: number }>();
    expect(counts).toEqual({ mutations: 1, audits: 1, outbox: 1 });
  });

  it("rolls back a cross-tenant grant replacement completely", async () => {
    const before = await env.CONTROL_DB.prepare(
      "SELECT identity_id, operation_scope FROM identity_grants WHERE tenant_id = ? AND membership_id = ? ORDER BY identity_id, operation_scope",
    ).bind("tenant_pilot", "membership_human").all();
    await env.CONTROL_DB.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("tenant_other", "other", "Other", "active", occurredAt, occurredAt).run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("identity_other", "tenant_other", "human", "Other", "active", occurredAt, occurredAt).run();

    await expect(replaceIdentityGrants(env.CONTROL_DB, {
      idempotency_key: "replace-cross-tenant",
      tenant_id: "tenant_pilot",
      actor_principal_id: "principal_human",
      membership_id: "membership_human",
      grants: [{ identity_id: "identity_other", scopes: ["conversation.read"] }],
      occurred_at: occurredAt,
    })).rejects.toThrow();

    const after = await env.CONTROL_DB.prepare(
      "SELECT identity_id, operation_scope FROM identity_grants WHERE tenant_id = ? AND membership_id = ? ORDER BY identity_id, operation_scope",
    ).bind("tenant_pilot", "membership_human").all();
    const counts = await env.CONTROL_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM directory_mutations) AS mutations, (SELECT COUNT(*) FROM audit_events) AS audits, (SELECT COUNT(*) FROM control_event_outbox) AS outbox",
    ).first<{ mutations: number; audits: number; outbox: number }>();

    expect(after.results).toEqual(before.results);
    expect(counts).toEqual({ mutations: 0, audits: 0, outbox: 0 });
  });

  it("revokes a membership immediately and records one outbox event", async () => {
    await setMembershipStatus(env.CONTROL_DB, {
      idempotency_key: "revoke-human-membership",
      tenant_id: "tenant_pilot",
      actor_principal_id: "principal_operator",
      membership_id: "membership_human",
      status: "revoked",
      occurred_at: occurredAt,
    });

    const authorization = await resolveAuthorization(env.CONTROL_DB, {
      issuer: "https://issuer.example/",
      subject: "human-subject",
    });
    const outbox = await env.CONTROL_DB.prepare(
      "SELECT event_type, aggregate_id, payload_json FROM control_event_outbox",
    ).all<{ event_type: string; aggregate_id: string; payload_json: string }>();

    expect(authorization).toEqual({ ok: false, code: "not_found" });
    expect(outbox.results).toHaveLength(1);
    expect(outbox.results[0]).toMatchObject({
      event_type: "authorization.membership.updated",
      aggregate_id: "membership_human",
    });
    expect(outbox.results[0]?.payload_json).toContain('"status":"revoked"');
  });

  it("keeps audit and outbox payloads limited to directory identifiers and scopes", async () => {
    await replaceIdentityGrants(env.CONTROL_DB, {
      idempotency_key: "replace-safe-payload",
      tenant_id: "tenant_pilot",
      actor_principal_id: "principal_human",
      membership_id: "membership_human",
      grants: [{ identity_id: "identity_human", scopes: ["conversation.read"] }],
      occurred_at: occurredAt,
    });

    const rows = await env.CONTROL_DB.prepare(
      "SELECT metadata_json AS payload FROM audit_events UNION ALL SELECT payload_json AS payload FROM control_event_outbox",
    ).all<{ payload: string }>();
    const payloadText = rows.results.map((row) => row.payload).join(" ");

    expect(payloadText).toContain("identity_human");
    expect(payloadText).toContain("conversation.read");
    expect(payloadText).not.toMatch(/issuer|subject|message|route|credential/i);
  });
});
