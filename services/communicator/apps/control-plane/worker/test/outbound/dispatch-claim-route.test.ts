import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  dispatchClaimHandler,
  dispatchClaimHandlerAt,
} from "../../outbound/dispatch-claim-route";

const secret = "dispatch-claim-test-secret-012345";
const workerNow = new Date("2026-09-14T00:00:00.000Z");
const digest = "a".repeat(64);

const environment = {
  CONNECTION_GATEWAY_TOKEN: secret,
} as Cloudflare.Env & { CONNECTION_GATEWAY_TOKEN: string };

const app = new Hono<{ Bindings: typeof environment }>();
app.post("/claims", (context) =>
  dispatchClaimHandlerAt(context, () => workerNow, {
    // This direct component fixture intentionally opts into the retired
    // transport-secret branch; the exported deployed handler never does.
    allowLegacyGatewaySecret: true,
  }),
);

const deployedApp = new Hono<{ Bindings: typeof environment }>();
deployedApp.post("/claims", dispatchClaimHandler);

const messageClaim = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  operation: "message.send",
  tenant_id: "tenant_test",
  membership_id: "membership_test",
  identity_id: "identity_test",
  account_id: "account_test",
  conversation_id: "conversation_test",
  connection_id: "connection_test",
  reservation_id: "reservation_test",
  operation_id: "dispatch_test",
  request_hash: digest,
  capability: {
    kind: "account_grant",
    grant_id: "grant_test",
    authorization_epoch: 1,
  },
  now: workerNow.toISOString(),
  expires_at: new Date(workerNow.getTime() + 30_000).toISOString(),
  command_id: "command_test",
  dispatch_id: "dispatch_test",
  transaction_id: "transaction_test",
  request_digest: digest,
  body_digest: digest,
  ...overrides,
});

const request = (body: BodyInit, headers: Record<string, string> = {}) =>
  app.request(
    "https://control-plane.test/claims",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body,
    },
    environment,
  );

describe("private dispatch claim route", () => {
  it("does not revive the retired transport-secret inbound path", async () => {
    const response = await deployedApp.request(
      "https://control-plane.test/claims",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messageClaim()),
      },
      environment,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
  });

  it("anchors the requested claim window to the Worker clock", async () => {
    const stale = await request(
      JSON.stringify(
        messageClaim({
          now: new Date(workerNow.getTime() - 30_001).toISOString(),
        }),
      ),
    );
    expect(stale.status).toBe(400);

    const future = await request(
      JSON.stringify(
        messageClaim({
          now: new Date(workerNow.getTime() + 30_001).toISOString(),
        }),
      ),
    );
    expect(future.status).toBe(400);

    const longLived = await request(
      JSON.stringify(
        messageClaim({
          expires_at: new Date(workerNow.getTime() + 60_001).toISOString(),
        }),
      ),
    );
    expect(longLived.status).toBe(400);

    const validWindow = await request(JSON.stringify(messageClaim()));
    expect(validWindow.status).toBe(503);
  });

  it("enforces the body limit while streaming without Content-Length", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const response = await request(oversized);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "body_too_large" });
  });

  it("authenticates before reading an oversized or malformed body", async () => {
    const response = await app.request(
      "https://control-plane.test/claims",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-secret",
          "Content-Type": "application/json",
        },
        body: "x".repeat(64 * 1024 + 1),
      },
      environment,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
