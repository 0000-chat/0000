import { expect, test } from "bun:test";

import { createSecureWebhookFetch, isPublicIpAddress, type SecureWebhookConnection, type SecureWebhookTransport } from "./mcp-webhook-transport";

const encoder = new TextEncoder();

test("accepts global addresses and rejects private, reserved, and mapped addresses", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1",
    "192.0.2.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "::", "::1", "fc00::1", "fe80::1",
    "ff02::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "2001:0::1", "2001:db8::1",
  ]) expect(isPublicIpAddress(address)).toBe(false);
  for (const address of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPublicIpAddress(address)).toBe(true);
});

test("rejects a mixed DNS result set before opening a connection", async () => {
  let connections = 0;
  const transport: SecureWebhookTransport = {
    resolve: async () => ["93.184.216.34", "10.0.0.1"],
    connect: async () => { connections += 1; return fakeConnection("HTTP/1.1 204 No Content\r\n\r\n"); },
  };
  await expect(createSecureWebhookFetch({ transport })("https://callback.example.test/events", { method: "POST", body: "{}" })).rejects.toThrow("public addresses");
  expect(connections).toBe(0);
});

test("connects to the validated IP while retaining the original TLS hostname", async () => {
  let observed: { hostname: string; address: string; port: number } | undefined;
  const transport: SecureWebhookTransport = {
    resolve: async (hostname) => { expect(hostname).toBe("callback.example.test"); return ["93.184.216.34"]; },
    connect: async ({ hostname, address, port }) => {
      observed = { hostname, address, port };
      return fakeConnection("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    },
  };
  const response = await createSecureWebhookFetch({ transport })("https://callback.example.test/events?cursor=1", {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": "evt_1" },
    body: "{}",
    redirect: "error",
  });
  expect(observed).toEqual({ hostname: "callback.example.test", address: "93.184.216.34", port: 443 });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});

test("returns redirects without following or retrying them", async () => {
  let connections = 0;
  const transport: SecureWebhookTransport = {
    resolve: async () => ["93.184.216.34"],
    connect: async () => { connections += 1; return fakeConnection("HTTP/1.1 302 Found\r\nLocation: https://other.example/events\r\nContent-Length: 0\r\n\r\n"); },
  };
  const response = await createSecureWebhookFetch({ transport })("https://callback.example.test/events", { method: "POST", body: "{}", redirect: "error" });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://other.example/events");
  expect(connections).toBe(1);
});

test("rejects informational responses instead of treating them as final", async () => {
  const transport: SecureWebhookTransport = {
    resolve: async () => ["93.184.216.34"],
    connect: async () => fakeConnection("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n"),
  };
  await expect(createSecureWebhookFetch({ transport })("https://callback.example.test/events", { method: "POST", body: "{}" })).rejects.toThrow("informational");
});

test("parses bounded chunked responses and rejects oversized bodies", async () => {
  const transport: SecureWebhookTransport = {
    resolve: async () => ["93.184.216.34"],
    connect: async () => fakeConnection("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n"),
  };
  const response = await createSecureWebhookFetch({ transport })("https://callback.example.test/events", { method: "POST", body: "{}" });
  expect(await response.text()).toBe("ok");

  const oversized: SecureWebhookTransport = {
    resolve: async () => ["93.184.216.34"],
    connect: async () => fakeConnection("HTTP/1.1 200 OK\r\nContent-Length: 65537\r\n\r\n"),
  };
  await expect(createSecureWebhookFetch({ transport: oversized })("https://callback.example.test/events", { method: "POST", body: "{}" })).rejects.toThrow("too large");
});

test("fails closed on DNS failure and connection timeouts", async () => {
  let connections = 0;
  const dnsFailure: SecureWebhookTransport = {
    resolve: async () => { throw new Error("resolver unavailable"); },
    connect: async () => { connections += 1; return fakeConnection("HTTP/1.1 204 No Content\r\n\r\n"); },
  };
  await expect(createSecureWebhookFetch({ transport: dnsFailure, timeoutMs: 20 })("https://callback.example.test/events", { method: "POST", body: "{}" })).rejects.toThrow("resolver unavailable");
  expect(connections).toBe(0);

  const connectionTimeout: SecureWebhookTransport = {
    resolve: async () => ["93.184.216.34"],
    connect: () => new Promise<SecureWebhookConnection>(() => undefined),
  };
  await expect(createSecureWebhookFetch({ transport: connectionTimeout, timeoutMs: 10 })("https://callback.example.test/events", { method: "POST", body: "{}" })).rejects.toThrow();
});

test("times out a response that never arrives", async () => {
  const transport: SecureWebhookTransport = {
    resolve: async () => ["93.184.216.34"],
    connect: async () => ({
      write: async () => undefined,
      read: () => new Promise<Uint8Array | null>(() => undefined),
      close: () => undefined,
    }),
  };
  await expect(createSecureWebhookFetch({ transport, timeoutMs: 10 })("https://callback.example.test/events", { method: "POST", body: "{}" })).rejects.toThrow();
});

function fakeConnection(response: string): SecureWebhookConnection {
  let sent = false;
  return {
    write: async () => undefined,
    read: async () => {
      if (sent) return null;
      sent = true;
      return encoder.encode(response);
    },
    close: () => undefined,
  };
}
