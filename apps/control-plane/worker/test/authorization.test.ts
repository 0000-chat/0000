import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthorizationResult } from "../control-directory/authorization";
import { resolveAuthorization } from "../control-directory/authorization";
import { clearDirectory, seedDirectory } from "./support/directory-fixtures";

const issuer = "https://issuer.example/";

async function update(sql: string, ...values: string[]) {
  await env.CONTROL_DB.prepare(sql).bind(...values).run();
}

async function insertServicePrincipal() {
  await env.CONTROL_DB.prepare(
    "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    "principal_service",
    issuer,
    "service-subject",
    "service",
    "Service",
    "active",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
  ).run();
  await env.CONTROL_DB.prepare(
    "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    "membership_service",
    "tenant_pilot",
    "principal_service",
    "member",
    "active",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
  ).run();
}

function failure(result: AuthorizationResult, code: string) {
  expect(result).toEqual({ ok: false, code });
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
});

describe("resolveAuthorization", () => {
  it("resolves only the Human identity and its explicit scopes", async () => {
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "human-subject",
    });

    expect(result).toEqual({
      ok: true,
      context: {
        tenant: { id: "tenant_pilot", slug: "pilot", display_name: "Pilot" },
        principal: { id: "principal_human", type: "human", display_name: "Human" },
        membership: { id: "membership_human", role: "owner" },
        identities: [{
          identity_id: "identity_human",
          kind: "human",
          display_name: "Human",
          scopes: [
            "conversation.read",
            "message.send",
            "receipt.send",
            "connection.read",
            "connection.manage",
          ],
        }],
      },
    });
  });

  it("resolves only the Agent identity and its explicit scopes", async () => {
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "agent-subject",
      token_id: "agent-token",
    });

    expect(result).toMatchObject({
      ok: true,
      context: {
        principal: { id: "principal_agent", type: "agent" },
        identities: [{
          identity_id: "identity_agent",
          kind: "agent",
          scopes: ["conversation.read", "message.send", "connection.read"],
        }],
      },
    });
  });

  it("does not give an Operator normal Agent access", async () => {
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "operator-subject",
    });

    expect(result).toMatchObject({
      ok: true,
      context: {
        principal: { id: "principal_operator", type: "operator" },
        identities: [{ identity_id: "identity_human", scopes: ["connection.read"] }],
      },
    });
  });

  it("returns not_found for a tenant hint outside the membership set", async () => {
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "human-subject",
    }, "tenant_other");
    failure(result, "not_found");
  });

  it("selects the only active membership when no tenant hint is provided", async () => {
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "human-subject",
    });
    expect(result).toMatchObject({ ok: true, context: { tenant: { id: "tenant_pilot" } } });
  });

  it("requires a tenant hint when multiple active memberships exist", async () => {
    await update(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "tenant_other",
      "other",
      "Other",
      "active",
      "2026-08-29T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
    );
    await update(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "membership_other",
      "tenant_other",
      "principal_human",
      "member",
      "active",
      "2026-08-29T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
    );

    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "human-subject",
    });
    failure(result, "tenant_selection_required");
  });

  it.each(["disabled", "revoked"])("returns not_found for a %s principal", async (status) => {
    await update("UPDATE principals SET status = ? WHERE id = ?", status, "principal_human");
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "human-subject",
    });
    failure(result, "not_found");
  });

  it.each(["disabled", "revoked"])("returns not_found for a %s tenant", async (status) => {
    await update("UPDATE tenants SET status = ? WHERE id = ?", status, "tenant_pilot");
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "human-subject",
    });
    failure(result, "not_found");
  });

  it.each(["disabled", "revoked"])("returns not_found for a %s membership", async (status) => {
    await update("UPDATE memberships SET status = ? WHERE id = ?", status, "membership_human");
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "human-subject",
    });
    failure(result, "not_found");
  });

  it("omits a disabled identity and its grants", async () => {
    await update("UPDATE identities SET status = ? WHERE id = ?", "disabled", "identity_human");
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "human-subject",
    });
    expect(result).toMatchObject({ ok: true, context: { identities: [] } });
  });

  it.each([
    ["agent", "principal_agent", "agent-subject"],
    ["service", "principal_service", "service-subject"],
  ])("rejects a %s principal token without jti", async (kind, principalId, subject) => {
    if (kind === "service") await insertServicePrincipal();
    const result = await resolveAuthorization(env.CONTROL_DB, { issuer, subject });
    expect(principalId).toMatch(/^principal_/);
    failure(result, "unauthenticated");
  });

  it("rejects an agent token whose jti has been revoked", async () => {
    await update(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
      issuer,
      "revoked-agent-token",
      "principal_agent",
      "security review",
      "2026-08-29T00:00:00.000Z",
    );
    const result = await resolveAuthorization(env.CONTROL_DB, {
      issuer,
      subject: "agent-subject",
      token_id: "revoked-agent-token",
    });
    failure(result, "unauthenticated");
  });

  it("returns directory_unavailable without falling back to token claims", async () => {
    const failingDb = {
      withSession: () => {
        throw new Error("local D1 failure");
      },
    } as unknown as D1Database;
    const result = await resolveAuthorization(failingDb, {
      issuer,
      subject: "human-subject",
    });
    failure(result, "directory_unavailable");
  });
});
