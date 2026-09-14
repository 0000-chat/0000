import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import type {
  ConnectionGateway,
  GatewayOwner,
  GatewayPollResult,
} from "../../linking/gateway-client";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";

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
  expectedSessionGeneration?: string,
) =>
  request(
    app,
    "/api/v1/connections/connection_human_whatsapp/relink-sessions",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        provider: "whatsapp",
        method: "qr",
        confirmed_identity_id: "identity_human",
        ...(expectedSessionGeneration === undefined
          ? {}
          : { expected_session_generation: expectedSessionGeneration }),
      }),
    },
  );

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
    expect(((await replay.json()) as { id: string }).id).toBe(session.id);
    expect(owners).toHaveLength(1);

    const completed = await pollRelink(app, session.id, session.generation);
    expect(completed.status).toBe(200);
    expect(((await completed.json()) as { status: string }).status).toBe(
      "connected",
    );
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
    const session = (await started.json()) as {
      id: string;
      generation: number;
    };
    expect(started.status).toBe(201);
    const completed = await pollRelink(app, session.id, session.generation);
    expect(completed.status).toBe(200);
    expect(((await completed.json()) as { status: string }).status).toBe(
      "connected",
    );

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
    expect(((await response.json()) as { status: string }).status).toBe(
      "succeeded",
    );
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
    expect(disconnected).toEqual({
      status: "disconnected",
      attention_code: null,
    });

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
    expect(((await replay.json()) as { status: string }).status).toBe(
      "succeeded",
    );
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
    expect(
      ((await unavailableResponse.json()) as { status: string }).status,
    ).toBe("reconciliation_required");
    const attention = await workerEnv.CONTROL_DB.prepare(
      "SELECT status, attention_code FROM connections WHERE id = ?",
    )
      .bind("connection_human_whatsapp")
      .first<{ status: string; attention_code: string | null }>();
    expect(attention).toEqual({
      status: "disconnected",
      attention_code: "disconnect_reconciliation_required",
    });

    const retry = await startRelink(
      appFor({
        async start() {
          return {
            gateway_ref: "relink-after-unavailable-gateway",
            action: "scan_qr",
            qr: "qr-relink",
            action_expires_at: "2026-09-13T00:01:00.000Z",
          };
        },
        async poll() {
          return connected("login-one");
        },
        async cancel() {},
      }),
      "relink-after-unavailable-001",
    );
    expect(retry.status).toBe(201);

    await seedConnection();
    const constructorUnavailable = createApp({
      createConnectionGateway: () => {
        throw new Error("gateway configuration unavailable");
      },
      createTokenVerifier: verifier,
    });
    const constructorUnavailableResponse = await request(
      constructorUnavailable,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "disconnect-constructor-001" },
        body: "{}",
      },
    );
    expect(constructorUnavailableResponse.status).toBe(200);
    expect(
      ((await constructorUnavailableResponse.json()) as { status: string })
        .status,
    ).toBe("reconciliation_required");
  });

  it("can relink an explicitly disconnected connection after local fencing", async () => {
    const gateway: ConnectionGateway = {
      async start() {
        return {
          gateway_ref: "relink-after-disconnect-gateway",
          action: "scan_qr",
          qr: "qr-relink",
          action_expires_at: "2026-09-13T00:01:00.000Z",
        };
      },
      async poll() {
        return connected("login-one");
      },
      async cancel() {},
      async disconnect() {
        return { status: "disconnected", provider_login_id: "login-one" };
      },
    };
    const app = appFor(gateway);
    const disconnected = await request(
      app,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "disconnect-before-relink-001" },
        body: "{}",
      },
    );
    expect(disconnected.status).toBe(200);
    expect(((await disconnected.json()) as { status: string }).status).toBe(
      "succeeded",
    );

    const started = await startRelink(app, "relink-after-disconnect-001");
    expect(started.status).toBe(201);
    const session = (await started.json()) as {
      id: string;
      generation: number;
    };
    const completed = await pollRelink(app, session.id, session.generation);
    expect(completed.status).toBe(200);
    expect(((await completed.json()) as { status: string }).status).toBe(
      "connected",
    );
    const connection = await workerEnv.CONTROL_DB.prepare(
      "SELECT status, attention_code FROM connections WHERE id = ?",
    )
      .bind("connection_human_whatsapp")
      .first<{ status: string; attention_code: string | null }>();
    expect(connection).toEqual({ status: "connected", attention_code: null });
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
    const session = (await started.json()) as {
      id: string;
      generation: number;
    };
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
    expect(((await disconnected.json()) as { status: string }).status).toBe(
      "succeeded",
    );
    releasePoll(connected("login-one"));
    expect((await latePoll).status).toBe(503);

    const finalRow = await workerEnv.CONTROL_DB.prepare(
      "SELECT status, attention_code FROM connections WHERE id = ?",
    )
      .bind("connection_human_whatsapp")
      .first<{ status: string; attention_code: string | null }>();
    expect(finalRow?.status).toBe("disconnected");
  });

  it("allows one relink provider claim and binds idempotent replay identity", async () => {
    let releaseStart!: () => void;
    let startedStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      startedStart = resolve;
    });
    const startRelease = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startCalls = 0;
    const gateway: ConnectionGateway = {
      async start() {
        startCalls += 1;
        startedStart();
        await startRelease;
        return {
          gateway_ref: "relink-claim-gateway",
          action: "scan_qr",
          qr: "qr-relink",
          action_expires_at: "2026-09-13T00:01:00.000Z",
        };
      },
      async poll() {
        return connected("login-one");
      },
      async cancel() {},
    };
    const app = appFor(gateway);
    const firstPromise = startRelink(app, "relink-claim-001");
    await startEntered;

    const second = await startRelink(app, "relink-claim-002");
    expect(second.status).toBe(409);
    expect(startCalls).toBe(1);

    releaseStart();
    const first = await firstPromise;
    expect(first.status).toBe(201);
    const replayWithDifferentGeneration = await startRelink(
      app,
      "relink-claim-001",
      "2026-09-13T00:00:01.000Z",
    );
    expect(replayWithDifferentGeneration.status).toBe(409);
  });

  it("allows one disconnect provider claim for distinct idempotency keys", async () => {
    let releaseLogout!: () => void;
    let startedLogout!: () => void;
    const logoutEntered = new Promise<void>((resolve) => {
      startedLogout = resolve;
    });
    const logoutRelease = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    let logoutCalls = 0;
    const gateway: ConnectionGateway = {
      async start() {
        throw new Error("not used");
      },
      async poll() {
        throw new Error("not used");
      },
      async cancel() {},
      async disconnect() {
        logoutCalls += 1;
        startedLogout();
        await logoutRelease;
        return { status: "disconnected", provider_login_id: "login-one" };
      },
    };
    const app = appFor(gateway);
    const firstPromise = request(
      app,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "disconnect-claim-001" },
        body: "{}",
      },
    );
    await logoutEntered;

    const second = await request(
      app,
      "/api/v1/connections/connection_human_whatsapp/disconnect",
      {
        method: "POST",
        headers: { "Idempotency-Key": "disconnect-claim-002" },
        body: "{}",
      },
    );
    expect(second.status).toBe(409);
    expect(logoutCalls).toBe(1);

    releaseLogout();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe(
      "succeeded",
    );
  });

  it("keeps a replacement uncreated when the old relink fence is lost", async () => {
    const gateway: ConnectionGateway = {
      async start() {
        return {
          gateway_ref: "relink-fence-gateway",
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
    const started = await startRelink(app, "relink-fence-001");
    expect(started.status).toBe(201);
    const session = (await started.json()) as {
      id: string;
      generation: number;
    };
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE connections SET lifecycle_operation_id = ?, status = 'disconnected', updated_at = ? WHERE id = ?",
    )
      .bind(
        "foreign-lifecycle-operation",
        "2026-09-13T00:00:01.000Z",
        "connection_human_whatsapp",
      )
      .run();

    const completed = await pollRelink(app, session.id, session.generation);
    expect(completed.status).toBe(503);
    const connections = await workerEnv.CONTROL_DB.prepare(
      "SELECT id, status FROM connections WHERE tenant_id = ? ORDER BY id",
    )
      .bind("tenant_pilot")
      .all<{ id: string; status: string }>();
    expect(connections.results).toEqual([
      { id: "connection_agent_whatsapp", status: "ready" },
      { id: "connection_human_whatsapp", status: "disconnected" },
    ]);
  });

  it("rechecks current administrator authority before relink finalization", async () => {
    let releasePoll!: (result: GatewayPollResult) => void;
    let enteredPoll!: () => void;
    const pollEntered = new Promise<void>((resolve) => {
      enteredPoll = resolve;
    });
    const pollResult = new Promise<GatewayPollResult>((resolve) => {
      releasePoll = resolve;
    });
    const gateway: ConnectionGateway = {
      async start() {
        return {
          gateway_ref: "relink-authority-gateway",
          action: "scan_qr",
          qr: "qr-relink",
          action_expires_at: "2026-09-13T00:01:00.000Z",
        };
      },
      async poll() {
        enteredPoll();
        return pollResult;
      },
      async cancel() {},
    };
    const app = appFor(gateway);
    const started = await startRelink(app, "relink-authority-001");
    const session = (await started.json()) as {
      id: string;
      generation: number;
    };
    const pollPromise = pollRelink(app, session.id, session.generation);
    await pollEntered;
    await workerEnv.CONTROL_DB.prepare(
      "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND operation_scope = 'connection.manage'",
    )
      .bind("tenant_pilot", "membership_human", "identity_human")
      .run();
    releasePoll(connected("login-one"));
    expect((await pollPromise).status).toBe(503);

    const operation = await workerEnv.CONTROL_DB.prepare(
      "SELECT status FROM connection_lifecycle_operations WHERE idempotency_key = ?",
    )
      .bind("relink-authority-001")
      .first<{ status: string }>();
    expect(operation?.status).toBe("reconciliation_required");
    const connection = await workerEnv.CONTROL_DB.prepare(
      "SELECT status FROM connections WHERE id = ?",
    )
      .bind("connection_human_whatsapp")
      .first<{ status: string }>();
    expect(connection?.status).toBe("ready");
  });
});
