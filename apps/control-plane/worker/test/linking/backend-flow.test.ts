import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import type { ConnectionGateway } from "../../linking/gateway-client";
import { LinkSessionSchema } from "@communicator/contracts";
import { clearDirectory, seedDirectory } from "../support/directory-fixtures";

const workerEnv = env as typeof env & {
  CONTROL_DB: D1Database;
  LINK_SESSIONS: DurableObjectNamespace;
};

const timestamp = "2026-09-13T00:00:00.000Z";

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await workerEnv.CONTROL_DB
    .prepare(
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

describe("administrator WhatsApp linking", () => {
  it("runs start QR through verified completion without persisting the QR or granting an agent", async () => {
    const calls: string[] = [];
    let pollCount = 0;
    const gateway: ConnectionGateway = {
      async start(owner) {
        calls.push(`start:${owner.generation}`);
        return {
          gateway_ref: "opaque-gateway-ref",
          action: "scan_qr",
          qr: "qr-fixture-never-persisted",
          action_expires_at: "2026-09-13T00:01:00.000Z",
        };
      },
      async poll(owner) {
        calls.push(`poll:${owner.generation}`);
        pollCount += 1;
        if (pollCount === 1) {
          return {
            status: "connected",
            provider_identity: {
              user_login_id: "15551234567",
              display_label: "Linked WhatsApp",
              route: {
                gateway_route_id: "gateway_route_link",
                bridge_instance_id: "bridge-link",
                matrix_user_id: "@communicator:communicator.0000.gold",
                matrix_room_namespace: "!link:communicator.0000.gold",
              },
            },
          };
        }
        throw new Error("duplicate provider call");
      },
      async cancel(owner) {
        calls.push(`cancel:${owner.generation}`);
      },
    };
    const app = createApp({
      createConnectionGateway: () => gateway,
      createTokenVerifier: () => ({
        verify: async (token: string): Promise<VerifiedSubject> => {
          if (token === "human-token")
            return { issuer: "https://issuer.example/", subject: "human-subject" };
          throw new Error("invalid token");
        },
      }),
    });

    const started = await request(app, "/api/v1/identities/identity_human/link-sessions", {
      method: "POST",
      headers: { "Idempotency-Key": "link-flow-001" },
      body: JSON.stringify({
        provider: "whatsapp",
        method: "qr",
        confirmed_identity_id: "identity_human",
      }),
    });
    expect(started.status).toBe(201);
    const challenge = LinkSessionSchema.parse(await started.json());
    expect(challenge.status).toBe("awaiting_user");
    expect(challenge.qr).toBe("qr-fixture-never-persisted");
    expect(calls).toEqual(["start:1"]);

    const stub = workerEnv.LINK_SESSIONS.getByName(challenge.id);
    const stored = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get<Record<string, unknown>>("link-session"),
    );
    expect(stored).not.toHaveProperty("qr");
    expect(JSON.stringify(stored)).not.toContain("qr-fixture-never-persisted");
    expect(stored).toMatchObject({
      tenant_id: "tenant_pilot",
      actor_principal_id: "principal_human",
      target_identity_id: "identity_human",
      generation: 1,
      gateway_ref: "opaque-gateway-ref",
    });

    const completed = await request(
      app,
      `/api/v1/link-sessions/${challenge.id}/actions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "link-flow-poll-001" },
        body: JSON.stringify({ generation: challenge.generation, action: "poll" }),
      },
    );
    expect(completed.status).toBe(200);
    const result = LinkSessionSchema.parse(await completed.json());
    expect(result.status).toBe("connected");
    expect(result.qr).toBeNull();
    expect(result.account_id).toMatch(/^account_/);
    expect(calls).toEqual(["start:1", "poll:1"]);

    const created = await workerEnv.CONTROL_DB
      .prepare(
        "SELECT c.id, ca.account_id FROM connections AS c JOIN connection_accounts AS ca ON ca.connection_id = c.id WHERE c.identity_id = ? AND c.id <> ?",
      )
      .bind("identity_human", "connection_human_whatsapp")
      .all<{ id: string; account_id: string }>();
    expect(created.results).toHaveLength(1);
    expect(created.results[0]?.account_id).toBe(result.account_id);
    const grants = await workerEnv.CONTROL_DB
      .prepare("SELECT COUNT(*) AS count FROM identity_grants WHERE identity_id = ?")
      .bind("identity_human")
      .first<{ count: number }>();
    expect(grants?.count).toBe(6);
  });
});
