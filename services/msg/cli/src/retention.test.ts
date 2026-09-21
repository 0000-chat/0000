import { expect, test } from "bun:test";

import { parseRetentionCommand, RetentionSignalError, runRetention } from "./retention";

const managementUrl = "https://msg.0000.chat/manage/room-1/owner-token";

test("parses and validates the private retention management URL", () => {
  expect(parseRetentionCommand(["retention", managementUrl, "inspect"])).toEqual({ managementUrl, operation: "inspect" });
  expect(parseRetentionCommand(["retention", managementUrl, "extend"])).toEqual({ managementUrl, operation: "extend" });
  for (const value of [
    "https://evil.example/manage/room-1/owner-token",
    `${managementUrl}?leak=1`,
    `${managementUrl}/retention`,
    "http://msg.0000.chat/manage/room-1/owner-token",
  ]) expect(() => parseRetentionCommand(["retention", value, "inspect"])).toThrow("management URL is invalid");
});

test("inspects through the exact private URL without printing or changing it", async () => {
  let request: { method?: string; url?: string; body?: unknown } = {};
  const value = await runRetention({
    fetch: async (input, init) => {
      request = { method: init?.method, url: String(input), body: init?.body };
      return Response.json({ expires_at: "2026-08-16T00:00:00.000Z", maximum_expires_at: "2026-08-23T00:00:00.000Z" });
    },
    managementUrl,
    operation: "inspect",
  });
  expect(request).toEqual({ method: "GET", url: managementUrl, body: undefined });
  expect(value).toMatchObject({ maximum_expires_at: "2026-08-23T00:00:00.000Z" });
});

test("extends with one strict JSON object and preserves the supplied absolute instant", async () => {
  let request: { method?: string; url?: string; body?: string } = {};
  const supplied = "2026-08-23T12:34:56.123+12:00";
  const value = await runRetention({
    fetch: async (input, init) => {
      request = { method: init?.method, url: String(input), body: String(init?.body) };
      return Response.json({ client_retry_id: "retry-1", requested_expires_at: supplied, replayed: false }, { status: 201 });
    },
    managementUrl,
    operation: "extend",
    readStdin: async () => JSON.stringify({ client_retry_id: "retry-1", expires_at: supplied }),
  });
  expect(request).toEqual({ method: "POST", url: `${managementUrl}/retention`, body: JSON.stringify({ client_retry_id: "retry-1", expires_at: supplied }) });
  expect(value).toMatchObject({ client_retry_id: "retry-1", replayed: false });
});

test("rejects invalid calendar timestamps and keeps capability URLs out of errors", async () => {
  await expect(runRetention({
    fetch: async () => Response.json({}),
    managementUrl,
    operation: "extend",
    readStdin: async () => JSON.stringify({ client_retry_id: "retry-1", expires_at: "2026-02-30T00:00:00Z" }),
  })).rejects.toThrow("valid absolute expires_at");

  await expect(runRetention({
    fetch: async () => Response.json({ error: { message: `Do not expose ${managementUrl}` } }, { status: 400 }),
    managementUrl,
    operation: "inspect",
  })).rejects.toThrow("HTTP 400");

  await expect(runRetention({
    fetch: async () => { throw new Error(`network failed for ${managementUrl}`); },
    managementUrl,
    operation: "inspect",
  })).rejects.toThrow("request failed");
});

test("rejects malformed or non-object successful responses", async () => {
  await expect(runRetention({
    fetch: async () => new Response("{", { status: 200 }),
    managementUrl,
    operation: "inspect",
  })).rejects.toThrow("invalid JSON response");

  await expect(runRetention({
    fetch: async () => Response.json(["unexpected"]),
    managementUrl,
    operation: "inspect",
  })).rejects.toThrow("invalid JSON response");
});

test("maps an aborted response-body read to the established interrupted exit", async () => {
  const controller = new AbortController();
  const response = { ok: true, status: 200, json: async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); } } as unknown as Response;
  await expect(runRetention({ fetch: async () => response, managementUrl, operation: "inspect", signal: controller.signal })).rejects.toBeInstanceOf(RetentionSignalError);
});


test("accepts literal loopback management origins for CLI-created preview rooms", () => {
  for (const origin of ["http://localhost:8791", "http://127.0.0.1:8791", "https://[::1]:8791"]) {
    const localManagementUrl = origin + "/manage/room-1/owner-token";
    expect(parseRetentionCommand(["retention", localManagementUrl, "inspect"])).toEqual({ managementUrl: localManagementUrl, operation: "inspect" });
  }
});
