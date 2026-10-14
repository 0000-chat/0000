import { expect, test } from "bun:test";
import type { Server } from "node:http";

import { authorized, createMcpWebhookDispatcherServer, dispatchWebhookPayload, validateDispatcherListenerSecurity, validatePayload } from "./mcp-webhook-dispatcher";

test("authenticates the exact bearer token in constant-time comparison", () => {
  expect(authorized("Bearer secret", "secret")).toBe(true);
  expect(authorized("Bearer secretx", "secret")).toBe(false);
  expect(authorized("Basic secret", "secret")).toBe(false);
  expect(authorized(undefined, "secret")).toBe(false);
});

test("accepts only HTTPS POST relay payloads and the signed header allowlist", () => {
  expect(validatePayload({ url: "https://receiver.example/events", method: "POST", headers: { "webhook-id": "evt", "webhook-signature": "v1,sig" }, body: "{}" })).toEqual({
    url: "https://receiver.example/events",
    method: "POST",
    headers: { "webhook-id": "evt", "webhook-signature": "v1,sig" },
    body: "{}",
  });
  for (const value of [
    { url: "http://receiver.example/events", method: "POST", headers: {}, body: "{}" },
    { url: "https://receiver.example/events", method: "GET", headers: {}, body: "{}" },
    { url: "https://receiver.example/events", method: "POST", headers: { authorization: "Bearer leak" }, body: "{}" },
    { url: "https://receiver.example/events", method: "POST", headers: { "webhook-id": "bad\r\nX-Leak: yes" }, body: "{}" },
  ]) expect(() => validatePayload(value)).toThrow();
});

test("dispatches exact body and signed headers, returning only safe response headers", async () => {
  let observed: { url: string; init?: RequestInit } | undefined;
  const envelope = await dispatchWebhookPayload({
    url: "https://receiver.example/events",
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": "evt_1", "webhook-signature": "v1,sig" },
    body: '{"message":"exact"}',
  }, {
    fetch: async (url, init) => {
      observed = { url: String(url), init };
      return new Response('{"challenge":"exact"}', { status: 200, headers: { "content-type": "application/json", authorization: "must-not-forward" } });
    },
  });
  expect(observed?.url).toBe("https://receiver.example/events");
  expect(observed?.init?.redirect).toBe("error");
  expect(observed?.init?.headers).toEqual({ "content-type": "application/json", "webhook-id": "evt_1", "webhook-signature": "v1,sig" });
  expect(observed?.init?.body).toBe('{"message":"exact"}');
  expect(envelope).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: '{"challenge":"exact"}' });
});

test("returns a transient envelope when secure delivery cannot connect", async () => {
  const envelope = await dispatchWebhookPayload({ url: "https://receiver.example/events", method: "POST", headers: {}, body: "{}" }, {
    fetch: async () => { throw new Error("network failure"); },
  });
  expect(envelope).toEqual({ status: 599, headers: {}, body: "" });
});

test("bounds relay bodies", () => {
  expect(() => validatePayload({ url: "https://receiver.example/events", method: "POST", headers: {}, body: "x".repeat(256 * 1024 + 1) })).toThrow("body_too_large");
});

test("requires explicit private proxy mode for non-loopback HTTP", () => {
  expect(() => validateDispatcherListenerSecurity({ host: "0.0.0.0", hasTls: false, trustedInternalProxy: false })).toThrow();
  expect(() => validateDispatcherListenerSecurity({ host: "0.0.0.0", hasTls: true, trustedInternalProxy: true })).toThrow();
  expect(() => validateDispatcherListenerSecurity({ host: "0.0.0.0", hasTls: false, trustedInternalProxy: true })).not.toThrow();
  expect(() => validateDispatcherListenerSecurity({ host: "127.0.0.1", hasTls: false, trustedInternalProxy: false })).not.toThrow();
});

test("serves authenticated metadata health checks", async () => {
  const server = createMcpWebhookDispatcherServer({ token: "health-secret" });
  const unauthorized = await invokeRequest(server, { url: "/healthz", method: "GET", authorization: undefined });
  expect(unauthorized.status).toBe(401);
  expect(JSON.parse(unauthorized.body)).toEqual({ error: "unauthorized" });

  const authorizedHealth = await invokeRequest(server, { url: "/healthz", method: "GET", authorization: "Bearer health-secret" });
  expect(authorizedHealth.status).toBe(200);
  expect(JSON.parse(authorizedHealth.body)).toEqual({ ok: true, service: "msg-webhook-dispatcher" });

  const wrongMethod = await invokeRequest(server, { url: "/healthz", method: "POST", authorization: "Bearer health-secret" });
  expect(wrongMethod.status).toBe(405);
});

async function invokeRequest(
  server: Server,
  input: { readonly url: string; readonly method: string; readonly authorization: string | undefined },
): Promise<{ readonly status: number; readonly headers: Record<string, string | number>; readonly body: string }> {
  return await new Promise((resolve) => {
    const response = {
      writeHead(status: number, headers: Record<string, string | number>) { this.status = status; this.headers = headers; },
      end(body?: Uint8Array) { resolve({ status: this.status, headers: this.headers, body: body ? Buffer.from(body).toString("utf8") : "" }); },
      status: 0,
      headers: {},
    };
    server.emit("request", {
      url: input.url,
      method: input.method,
      headers: input.authorization === undefined ? {} : { authorization: input.authorization },
      socket: { remoteAddress: "127.0.0.1" },
      setTimeout() { return this; },
      resume() { return this; },
    }, response);
  });
}
