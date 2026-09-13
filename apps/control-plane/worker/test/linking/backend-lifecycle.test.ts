import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import type {
  ConnectionGateway,
  GatewayPollResult,
} from "../../linking/gateway-client";
import { clearDirectory, seedDirectory } from "../support/directory-fixtures";

const workerEnv = env as typeof env & {
  CONTROL_DB: D1Database;
  LINK_SESSIONS: DurableObjectNamespace;
};

const timestamp = "2026-09-13T00:00:00.000Z";

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await workerEnv.CONTROL_DB.prepare(
    "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
  )
    .bind("gateway_route_link", "principal_operator", timestamp, timestamp)
    .run();
});

const request = async (
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
) =>
  app.request(
    `http://example.test${path}`,
    {
      ...init,
      headers: {
        Authorization: "Bearer human-token",
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
    if (token === "operator-token")
      return { issuer: "https://issuer.example/", subject: "operator-subject" };
    if (token === "agent-token")
      return {
        issuer: "https://issuer.example/",
        subject: "agent-subject",
        token_id: "agent-token-id",
      };
    throw new Error("invalid token");
  },
});

const connectedResult = (userLoginId = "15551234567"): GatewayPollResult => ({
  status: "connected",
  provider_identity: {
    user_login_id: userLoginId,
    display_label: "Linked WhatsApp",
    route: {
      gateway_route_id: "gateway_route_link",
      bridge_instance_id: "bridge-link",
      matrix_user_id: "@communicator:communicator.0000.gold",
      matrix_room_namespace: "!link:communicator.0000.gold",
    },
  },
});

const startGateway = (poll: ConnectionGateway["poll"]): ConnectionGateway => ({
  async start() {
    return {
      gateway_ref: "opaque-gateway-ref",
      action: "scan_qr",
      qr: "qr-fixture-never-persisted",
      action_expires_at: "2026-09-13T00:01:00.000Z",
    };
  },
  poll,
  async cancel() {},
});

const createTestApp = (gateway: ConnectionGateway) =>
  createApp({
    createConnectionGateway: () => gateway,
    createTokenVerifier: verifier,
  });

const startSession = async (
  app: ReturnType<typeof createApp>,
  idempotencyKey: string,
) => {
  const response = await request(
    app,
    "/api/v1/identities/identity_human/link-sessions",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        provider: "whatsapp",
        method: "qr",
        confirmed_identity_id: "identity_human",
      }),
    },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    generation: number;
  };
};

const pollSession = (
  app: ReturnType<typeof createApp>,
  session: { id: string; generation: number },
) =>
  request(app, `/api/v1/link-sessions/${session.id}/actions`, {
    method: "POST",
    headers: { "Idempotency-Key": `poll-${session.id}` },
    body: JSON.stringify({ generation: session.generation, action: "poll" }),
  });

describe("link session lifecycle guards", () => {
  it("serializes cancel before a delayed provider completion", async () => {
    let providerStarted!: () => void;
    let releaseProvider!: (result: GatewayPollResult) => void;
    const providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerResult = new Promise<GatewayPollResult>((resolve) => {
      releaseProvider = resolve;
    });
    const gateway = startGateway(async () => {
      providerStarted();
      return providerResult;
    });
    const app = createTestApp(gateway);
    const session = await startSession(app, "delayed-poll-001");
    const latePoll = pollSession(app, session);
    await providerStartedPromise;

    const cancelled = await request(
      app,
      `/api/v1/link-sessions/${session.id}`,
      {
        method: "DELETE",
        headers: { "Idempotency-Key": "cancel-delayed-001" },
      },
    );
    expect(cancelled.status).toBe(200);

    releaseProvider(connectedResult());
    expect((await latePoll).status).toBe(409);
    const linked = await workerEnv.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM connection_provider_identities",
    ).first<{ count: number }>();
    expect(linked?.count).toBe(0);
  });

  it("strips injected QR and bridge fields from persisted DO state", async () => {
    const stub = workerEnv.LINK_SESSIONS.getByName("link_injected_state");
    const initial = {
      id: "link_injected_state",
      tenant_id: "tenant_pilot",
      actor_principal_id: "principal_human",
      membership_id: "membership_human",
      target_identity_id: "identity_human",
      provider: "whatsapp",
      generation: 1,
      status: "awaiting_user",
      action: "scan_qr",
      expires_at: "2099-01-01T00:00:00.000Z",
      action_expires_at: null,
      gateway_ref: "opaque-gateway-ref",
      connection_id: null,
      account_id: null,
      provider_label: null,
      error_code: null,
      request_key_digest: "a".repeat(64),
      created_at: timestamp,
      updated_at: timestamp,
      qr: "must-not-persist",
      process_id: "bridge-process-id",
      txn_id: "bridge-transaction-id",
    };
    const response = await stub.fetch("https://link-session.internal/command", {
      method: "POST",
      body: JSON.stringify({ command: "create", state: initial }),
    });
    expect(response.status).toBe(200);
    const stored = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get<Record<string, unknown>>("link-session"),
    );
    expect(stored).not.toHaveProperty("qr");
    expect(stored).not.toHaveProperty("process_id");
    expect(stored).not.toHaveProperty("txn_id");
    expect(JSON.stringify(stored)).not.toContain("must-not-persist");
  });

  it("rejects stale generations after refresh and denies non-owner administrators", async () => {
    const gateway = startGateway(async () => connectedResult());
    const app = createTestApp(gateway);
    const session = await startSession(app, "refresh-generation-001");
    const refreshed = await request(
      app,
      `/api/v1/link-sessions/${session.id}/actions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "refresh-generation-action-001" },
        body: JSON.stringify({
          generation: session.generation,
          action: "refresh",
        }),
      },
    );
    expect(refreshed.status).toBe(200);
    const stale = await pollSession(app, session);
    expect(stale.status).toBe(409);

    const operatorResponse = await app.request(
      `http://example.test/api/v1/link-sessions/${session.id}`,
      { headers: { Authorization: "Bearer operator-token" } },
      workerEnv,
    );
    expect(operatorResponse.status).toBe(403);
    const agentResponse = await app.request(
      "http://example.test/api/v1/identities/identity_human/link-sessions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer agent-token",
          "Content-Type": "application/json",
          "Idempotency-Key": "agent-link-denied-001",
        },
        body: JSON.stringify({
          provider: "whatsapp",
          method: "qr",
          confirmed_identity_id: "identity_human",
        }),
      },
      workerEnv,
    );
    expect(agentResponse.status).toBe(403);
  });

  it("marks a repeated provider identity for relinking without creating an account", async () => {
    const gateway = startGateway(async () => connectedResult());
    const app = createTestApp(gateway);
    const first = await startSession(app, "duplicate-provider-001");
    const firstResult = await pollSession(app, first);
    expect(firstResult.status).toBe(200);
    const second = await startSession(app, "duplicate-provider-002");
    const secondResult = await pollSession(app, second);
    expect(secondResult.status).toBe(200);
    const secondBody = (await secondResult.json()) as {
      status: string;
      account_id: string | null;
    };
    expect(secondBody.status).toBe("relink_required");
    expect(secondBody.account_id).toBeNull();
    const linked = await workerEnv.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM connection_provider_identities",
    ).first<{ count: number }>();
    expect(linked?.count).toBe(1);
  });

  it("records provider expiry and failure without directory mutations", async () => {
    const expired = createTestApp(
      startGateway(async () => ({ status: "expired", error_code: "expired" })),
    );
    const expiredSession = await startSession(expired, "provider-expired-001");
    const expiredResponse = await pollSession(expired, expiredSession);
    expect(expiredResponse.status).toBe(200);
    expect(((await expiredResponse.json()) as { status: string }).status).toBe(
      "expired",
    );

    const failed = createTestApp(
      startGateway(async () => ({
        status: "failed",
        error_code: "provider_error",
      })),
    );
    const failedSession = await startSession(failed, "provider-failed-001");
    const failedResponse = await pollSession(failed, failedSession);
    expect(failedResponse.status).toBe(200);
    expect(((await failedResponse.json()) as { status: string }).status).toBe(
      "failed",
    );
    const linked = await workerEnv.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM connection_provider_identities",
    ).first<{ count: number }>();
    expect(linked?.count).toBe(0);
  });
});
