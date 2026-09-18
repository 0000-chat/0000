import { describe, expect, mock, test } from "bun:test";

let accessCalls = 0;
mock.module("./auth", () => ({
  authorizeAccess: () => {
    accessCalls += 1;
    return true;
  },
}));
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) {
      this.ctx = ctx;
    }
  },
}));

const { default: worker } = await import(
  `./worker?worker-test=${crypto.randomUUID()}`
);

type Call = { method: string; value: unknown };

function makeStub(start: Record<string, unknown>, unlockError?: Error) {
  const calls: Call[] = [];
  return {
    calls,
    beginDecision: async (value: unknown) => {
      calls.push({ method: "beginDecision", value });
      return start;
    },
    finishDecision: async (
      decisionId: unknown,
      attemptedAt: unknown,
      status: unknown,
      error?: unknown,
    ) => {
      calls.push({
        method: "finishDecision",
        value: { decisionId, attemptedAt, status, error },
      });
    },
    unlockDecision: async (streamId: unknown, decisionId?: unknown) => {
      calls.push({ method: "unlockDecision", value: { streamId, decisionId } });
      if (unlockError) throw unlockError;
      return { streamId, status: "ongoing", decisionLock: null };
    },
    patchStreams: async (patches: unknown) => {
      calls.push({ method: "patchStreams", value: patches });
      return patches;
    },
    fetch: async (request: Request) => {
      calls.push({ method: "fetch", value: request });
      return new Response(null, { status: 101 });
    },
  };
}

function makeEnv(stub: ReturnType<typeof makeStub>): Env {
  return {
    ACCESS_TEAM_NAME: "team",
    ACCESS_AUD: "aud",
    DON_EMAIL: "don@example.com",
    MCP_AUTH_TOKEN: "mcp-token",
    GROK_WEBHOOK_URL: "https://grok.example/hook",
    GROK_WEBHOOK_AUTHORIZATION: "webhook-token",
    STREAMS: { getByName: () => stub } as never,
  };
}

describe("Helm Streams Worker decision routes", () => {
  test("keeps MCP before Access authentication", async () => {
    accessCalls = 0;
    const stub = makeStub({ action: "submitted" });
    const response = await worker.fetch(
      new Request("https://don.0000.gold/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer mcp-token",
          "content-type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      makeEnv(stub),
    );

    expect(response.status).toBe(200);
    expect(accessCalls).toBe(0);
  });

  test("builds webhook payload and idempotency from stored decision fields", async () => {
    const stub = makeStub({
      action: "send",
      decisionId: "stored-decision",
      streamId: "stored-stream",
      choiceId: "stored-choice",
      value: "stored-value",
      freeText: "stored text",
      createdAt: "2026-09-05T16:00:00.000Z",
      attemptedAt: "2026-09-06T00:00:01.000Z",
      kind: "correction",
      correctionOf: "prior-decision",
    });
    const originalFetch = globalThis.fetch;
    let webhookRequest: Request | undefined;
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        webhookRequest = new Request(input, init);
        return new Response("ok", { status: 200 });
      },
    ) as typeof fetch;
    try {
      const response = await worker.fetch(
        new Request("https://don.0000.gold/api/decisions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decisionId: "request-id",
            streamId: "request-stream",
            choiceId: "request-choice",
            value: "request-value",
            freeText: "request text",
          }),
        }),
        makeEnv(stub),
      );

      expect(response.status).toBe(200);
      expect(webhookRequest?.headers.get("idempotency-key")).toBe(
        "stored-decision",
      );
      expect(webhookRequest?.headers.get("authorization")).toBe(
        "Bearer webhook-token",
      );
      expect(await webhookRequest?.json()).toEqual({
        stream_id: "stored-stream",
        choice_id: "stored-choice",
        value: "stored-value",
        free_text: "stored text",
        timestamp_manila: "2026-09-06T00:00:00+08:00",
        decision_id: "stored-decision",
        kind: "correction",
        correctionOf: "prior-decision",
      });
      expect(stub.calls.at(-1)).toEqual({
        method: "finishDecision",
        value: {
          decisionId: "stored-decision",
          attemptedAt: "2026-09-06T00:00:01.000Z",
          status: "submitted",
          error: undefined,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns a retryable result and keeps a failed decision lock", async () => {
    const stub = makeStub({
      action: "send",
      decisionId: "decision-1",
      streamId: "travel",
      choiceId: "send",
      value: "send_draft",
      freeText: "",
      createdAt: "2026-09-06T00:00:00.000Z",
      attemptedAt: "2026-09-06T00:00:02.000Z",
      kind: "decision",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response("no", { status: 503 }),
    ) as typeof fetch;
    try {
      const response = await worker.fetch(
        new Request("https://don.0000.gold/api/decisions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decisionId: "decision-1",
            streamId: "travel",
            choiceId: "send",
            value: "send_draft",
          }),
        }),
        makeEnv(stub),
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "Grok webhook did not accept the decision",
        decisionId: "decision-1",
        status: "failed",
        retryable: true,
      });
      expect(stub.calls.at(-1)).toEqual({
        method: "finishDecision",
        value: {
          decisionId: "decision-1",
          attemptedAt: "2026-09-06T00:00:02.000Z",
          status: "failed",
          error: "HTTP 503",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unlocks through the Access-protected API route", async () => {
    const stub = makeStub({ action: "submitted" });
    const response = await worker.fetch(
      new Request("https://don.0000.gold/api/decisions/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamId: "travel", decisionId: "decision-1" }),
      }),
      makeEnv(stub),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      stream: { streamId: "travel", status: "ongoing", decisionLock: null },
    });
    expect(stub.calls).toContainEqual({
      method: "unlockDecision",
      value: { streamId: "travel", decisionId: "decision-1" },
    });
  });

  test("requires a nonempty decision ID when unlocking", async () => {
    const stub = makeStub({ action: "submitted" });
    const env = makeEnv(stub);
    for (const body of [
      { streamId: "travel" },
      { streamId: "travel", decisionId: "" },
    ]) {
      const response = await worker.fetch(
        new Request("https://don.0000.gold/api/decisions/unlock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error?: string }).error).toContain(
        "decisionId",
      );
    }
    expect(
      stub.calls.filter((call) => call.method === "unlockDecision"),
    ).toEqual([]);
  });

  test("passes a stale decision ID to the Durable Object for rejection", async () => {
    const stub = makeStub(
      { action: "submitted" },
      new Error("decision lock does not match"),
    );
    const response = await worker.fetch(
      new Request("https://don.0000.gold/api/decisions/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "travel",
          decisionId: "stale-decision",
        }),
      }),
      makeEnv(stub),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "decision lock does not match",
    });
    expect(stub.calls).toContainEqual({
      method: "unlockDecision",
      value: { streamId: "travel", decisionId: "stale-decision" },
    });
  });

  test("routes patch_streams MCP calls to the Durable Object", async () => {
    const stub = makeStub({ action: "submitted" });
    const patches = [{ streamId: "travel", status: "ongoing" }];
    const response = await worker.fetch(
      new Request("https://don.0000.gold/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer mcp-token",
          "content-type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "patch_streams", arguments: { patches } },
        }),
      }),
      makeEnv(stub),
    );

    expect(response.status).toBe(200);
    expect(stub.calls).toContainEqual({
      method: "patchStreams",
      value: patches,
    });
  });

  test("routes the Access-protected live stream upgrade to the Durable Object", async () => {
    const stub = makeStub({ action: "submitted" });
    const response = await worker.fetch(
      new Request("https://don.0000.gold/api/streams/live", {
        headers: { Upgrade: "websocket" },
      }),
      makeEnv(stub),
    );

    expect(response.status).toBe(101);
    const forwarded = stub.calls.find((call) => call.method === "fetch")?.value;
    expect(forwarded).toBeInstanceOf(Request);
    expect((forwarded as Request).headers.get("Upgrade")).toBe("websocket");
  });
});
