import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import type {
  ConnectionGateway,
  GatewayOwner,
  GatewayPollResult,
} from "../../linking/gateway-client";
import { clearDirectory, seedAccountAccess, seedDirectory } from "../support/directory-fixtures";

const workerEnv = env as typeof env & {
  CONTROL_DB: D1Database;
};

const timestamp = "2026-09-13T00:00:00.000Z";

const request = async (
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
  token = "human-token",
) =>
  app.request(
    `http://example.test${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    workerEnv,
  );

const verifier = () => ({
  verify: async (token: string): Promise<VerifiedSubject> => {
    if (token === "human-token")
      return { issuer: "https://issuer.example/", subject: "human-subject" };
    if (token === "agent-token")
      return {
        issuer: "https://issuer.example/",
        subject: "agent-subject",
        token_id: "agent-token-id",
      };
    throw new Error("invalid token");
  },
});

const connected = (loginId: string): GatewayPollResult => ({
  status: "connected",
  provider_identity: {
    user_login_id: loginId,
    display_label: "Relinked WhatsApp",
    route: {
      gateway_route_id: "gateway_route_human",
      bridge_instance_id: "bridge-human",
      matrix_user_id: "route-user-human",
      matrix_room_namespace: "route-room-human",
    },
  },
});

const appFor = (gateway: ConnectionGateway) =>
  createApp({
    createConnectionGateway: () => gateway,
    createTokenVerifier: verifier,
  });

const seedConnection = async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
  await workerEnv.CONTROL_DB.prepare(
    `INSERT INTO connection_provider_identities
       (tenant_id, provider, identity_key, provider_login_id, connection_id, link_session_id, created_at)
     VALUES (?, 'whatsapp', ?, ?, ?, ?, ?)`,
  )
    .bind(
      "tenant_pilot",
      "a".repeat(64),
      "login-one",
      "connection_human_whatsapp",
      "initial-link",
      timestamp,
    )
    .run();
};

const startRelink = (
  app: ReturnType<typeof createApp>,
  idempotencyKey: string,
) =>
  request(app, "/api/v1/connections/connection_human_whatsapp/relink-sessions", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      provider: "whatsapp",
      method: "qr",
      confirmed_identity_id: "identity_human",
    }),
  });

const pollRelink = (
  app: ReturnType<typeof createApp>,
  sessionId: string,
  generation = 1,
) =>
  request(app, `/api/v1/link-sessions/${sessionId}/actions`, {
    method: "POST",
    headers: { "Idempotency-Key": `poll-${sessionId}` },
    body: JSON.stringify({ generation, action: "poll" }),
  });

describe("administrator connection relink and disconnect", () => {
  beforeEach(seedConnection);

  it("relinks the same verified identity in place and fences duplicate starts", async () => {
    const owners: GatewayOwner[] = [];
    let pollCalls = 0;
    const gateway: ConnectionGateway = {
      async start(owner) {
        owners.push(owner);
        return {
          gateway_ref: "relink-gateway",
          action: "scan_qr",
          qr: "qr-relink",
          action_expires_at: "2026-09-13T00:01:00.000Z",
        };
      },
      async poll(owner) {
        owners.push(owner);
        pollCalls += 1;
        return connected("login-one");
      },
      async cancel() {},
    };
    const app = appFor(gateway);

    const before = await workerEnv.CONTROL_DB.prepare(
      `SELECT c.updated_at, ca.account_id, cr.gateway_route_id,
              pi.provider_login_id, g.id AS grant_id
         FROM connections c
         JOIN connection_accounts ca ON ca.connection_id = c.id AND ca.status = 'active'
         JOIN connection_routes cr ON cr.connection_id = c.id
         JOIN connection_provider_identities pi ON pi.connection_id = c.id
         JOIN account_grants g ON g.account_id = ca.account_id AND g.status = 'active'
        WHERE c.id = ?`,
    )
      .bind("connection_human_whatsapp")
      .first<Record<string, string>>();
    expect(before).toMatchObject({
      account_id: "account_human",
      gateway_route_id: "gateway_route_human",
      provider_login_id: "login-one",
      grant_id: "grant_fixture_human",
    });

    const started = await startRelink(app, "relink-same-001");
    expect(started.status).toBe(201);
    const session = (await started.json()) as {
      id: string;
      generation: number;
      connection_id: string;
    };
    expect(session.connection_id).toBe("connection_human_whatsapp");
    expect(owners[0]).toMatchObject({
      connection_id: "connection_human_whatsapp",
      provider_login_id: "login-one",
    });

    const replay = await startRelink(app, "relink-same-001");
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe(session.id);
    expect(owners).toHaveLength(1);

    const completed = await pollRelink(app, session.id, session.generation);
    expect(completed.status).toBe(200);
    expect((await completed.json()).status).toBe("connected");
    expect(pollCalls).toBe(1);

    const after = await workerEnv.CONTROL_DB.prepare(
      `SELECT c.status, c.updated_at, ca.account_id, cr.gateway_route_id,
              pi.provider_login_id, g.id AS grant_id
         FROM connections c
         JOIN connection_accounts ca ON ca.connection_id = c.id AND ca.status = 'active'
         JOIN connection_routes cr ON cr.connection_id = c.id
         JOIN connection_provider_identities pi ON pi.connection_id = c.id
         JOIN account_grants g ON g.account_id = ca.account_id AND g.status = 'active'
        WHERE c.id = ?`,
    )
      .bind("connection_human_whatsapp")
      .first<Record<string, string>>();
    expect(after).toMatchObject({
      status: "connected",
      account_id: before?.account_id,
      gateway_route_id: before?.gateway_route_id,
      provider_login_id: before?.provider_login_id,
      grant_id: before?.grant_id,
    });
    expect(after?.updated_at).not.toBe(before?.updated_at);
    const operations = await workerEnv.CONTROL_DB.prepare(
      "SELECT status, COUNT(*) AS count FROM connection_lifecycle_operations WHERE connection_id = ? GROUP BY status",
    )
      .bind("connection_human_whatsapp")
      .all<{ status: string; count: number }>();
    expect(operations.results).toEqual([{ status: "succeeded", count: 1 }]);
  });

  it("creates a separate ungranted resource for a different verified provider identity", async () => {
    const gateway: ConnectionGateway = {
      async start() {
        return {
          gateway_ref: "relink-different-gateway",
          action: "scan_qr",
          qr: "qr-relink",
          action_expires_at: "2026-09-13T00:01:00.000Z",
        };
      },
      async poll() {
        return connected("login-two");
      },
      async cancel() {},
    };
    const app = appFor(gateway);
    const started = await startRelink(app, "relink-different-001");
    const session = (await started.json()) as { id: string; generation: number };
    expect(started.status).toBe(201);
    const completed = await pollRelink(app, session.id, session.generation);
    expect(completed.status).toBe(200);
    expect((await completed.json()).status).toBe("connected");

    const rows = await workerEnv.CONTROL_DB.prepare(
      `SELECT c.id AS connection_id, c.identity_id, ca.account_id,
              pi.provider_login_id, g.id AS grant_id
         FROM connections c
         JOIN connection_accounts ca ON ca.connection_id = c.id AND ca.status = 'active'
         JOIN connection_provider_identities pi ON pi.connection_id = c.id
         LEFT JOIN account_grants g ON g.account_id = ca.account_id AND g.status = 'active'
        WHERE c.tenant_id = ? AND c.identity_id = ?
        ORDER BY c.id`,
    )
      .bind("tenant_pilot", "identity_human")
      .all<Record<string, string | null>>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection_id: "connection_human_whatsapp",
          account_id: "account_human",
          provider_login_id: "login-one",
          grant_id: "grant_fixture_human",
        }),
        expect.objectContaining({
          provider_login_id: "login-two",
          grant_id: null,
        }),
      ]),
    );
  });

  it("fences locally before selected-login logout and retains attention when logout is unavailable", async () => {
    const logoutCalls: GatewayOwner[] = [];
    const gateway: ConnectionGateway = {
      async start() {
        throw new Error("not used");
      },
      async poll() {
        throw new Error("not used");
      },
      async cancel() {},
      async disconnect(owner) {
        logoutCalls.push(owner);
        return { status: "disconnected", provider_login_id: "login-one" };
      },
    };
    const app = appFor(gateway);
    const response = await request(
      app,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "disconnect-one-001" },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("succeeded");
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0]).toMatchObject({
      connection_id: "connection_human_whatsapp",
      provider_login_id: "login-one",
    });
    const disconnected = await workerEnv.CONTROL_DB.prepare(
      "SELECT status, attention_code FROM connections WHERE id = ?",
    )
      .bind("connection_human_whatsapp")
      .first<{ status: string; attention_code: string | null }>();
    expect(disconnected).toEqual({ status: "disconnected", attention_code: null });

    const replay = await request(
      app,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "disconnect-one-001" },
        body: "{}",
      },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).status).toBe("succeeded");
    expect(logoutCalls).toHaveLength(1);

    await seedConnection();
    const unavailable = appFor({
      async start() {
        throw new Error("not used");
      },
      async poll() {
        throw new Error("not used");
      },
      async cancel() {},
    });
    const unavailableResponse = await request(
      unavailable,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "disconnect-unavailable-001" },
        body: "{}",
      },
    );
    expect(unavailableResponse.status).toBe(200);
    expect((await unavailableResponse.json()).status).toBe(
      "reconciliation_required",
    );
    const attention = await workerEnv.CONTROL_DB.prepare(
      "SELECT status, attention_code FROM connections WHERE id = ?",
    )
      .bind("connection_human_whatsapp")
      .first<{ status: string; attention_code: string | null }>();
    expect(attention).toEqual({
      status: "disconnected",
      attention_code: "disconnect_reconciliation_required",
    });
  });

  it("rejects agent mutation and ignores a late relink callback after disconnect", async () => {
    let releasePoll!: (result: GatewayPollResult) => void;
    const pollResult = new Promise<GatewayPollResult>((resolve) => {
      releasePoll = resolve;
    });
    const gateway: ConnectionGateway = {
      async start() {
        return {
          gateway_ref: "relink-race-gateway",
          action: "scan_qr",
          qr: "qr-relink",
          action_expires_at: "2026-09-13T00:01:00.000Z",
        };
      },
      async poll() {
        return pollResult;
      },
      async cancel() {},
      async disconnect() {
        return { status: "disconnected", provider_login_id: "login-one" };
      },
    };
    const app = appFor(gateway);
    const started = await startRelink(app, "relink-race-001");
    const session = (await started.json()) as { id: string; generation: number };
    const latePoll = pollRelink(app, session.id, session.generation);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const agent = await request(
      app,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "agent-disconnect-001" },
        body: "{}",
      },
      "agent-token",
    );
    expect(agent.status).toBe(403);

    const disconnected = await request(
      app,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "race-disconnect-001" },
        body: "{}",
      },
    );
    expect(disconnected.status).toBe(200);
    expect((await disconnected.json()).status).toBe("succeeded");
    releasePoll(connected("login-one"));
    expect((await latePoll).status).toBe(503);

    const finalRow = await workerEnv.CONTROL_DB.prepare(
      "SELECT status, attention_code FROM connections WHERE id = ?",
    )
      .bind("connection_human_whatsapp")
      .first<{ status: string; attention_code: string | null }>();
    expect(finalRow?.status).toBe("disconnected");
  });
});
