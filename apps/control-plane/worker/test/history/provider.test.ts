import { describe, expect, it } from "vitest";
import { HttpHistoryImportProvider } from "../../history/provider";

const owner = {
  tenant_id: "tenant_pilot",
  account_id: "account_human",
  connection_id: "connection_human_whatsapp",
  identity_id: "identity_human",
  provider: "whatsapp" as const,
  import_id: "import_history_provider",
  start_at: "2026-09-01T00:00:00.000Z",
  end_at: "2026-09-03T00:00:00.000Z",
  max_events: 50,
};

const startResponse = {
  availability: "available",
  provider_version: "v26.08",
  proof_source: "controlled-gateway",
  provider_evidence: {
    provider_version: "v26.08",
    proof_source: "controlled-gateway",
    summary: "Controlled gateway response",
    observed_at: "2026-09-03T00:00:00.000Z",
  },
  source_start_at: owner.start_at,
  source_end_at: owner.end_at,
  ranges: [
    {
      start_at: owner.start_at,
      end_at: owner.end_at,
      source_cursor: "opaque-initial",
    },
  ],
  error_code: null,
};

const advanceResponse = {
  status: "active",
  events: [],
  next_cursor: "opaque-next",
  gap_code: null,
  error_code: null,
};

const idempotencyKey = (init: RequestInit | undefined): string => {
  const value = new Headers(init?.headers).get("idempotency-key");
  if (value === null) throw new Error("missing idempotency key");
  return value;
};

describe("private history provider adapter", () => {
  it("binds gateway idempotency to each opaque cursor page", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = new HttpHistoryImportProvider(
      "https://history-gateway.example",
      "history-shared-secret-123",
      async (input, init) => {
        requests.push({ url: String(input), init });
        const body = String(input).endsWith("/start")
          ? startResponse
          : advanceResponse;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    await provider.start(owner);
    await provider.advance({
      owner,
      range_id: "range_history_provider",
      source_cursor: "opaque-page-a",
    });
    await provider.advance({
      owner,
      range_id: "range_history_provider",
      source_cursor: "opaque-page-a",
    });
    await provider.advance({
      owner,
      range_id: "range_history_provider",
      source_cursor: "opaque-page-b",
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://history-gateway.example/v1/history-imports/start",
      "https://history-gateway.example/v1/history-imports/advance",
      "https://history-gateway.example/v1/history-imports/advance",
      "https://history-gateway.example/v1/history-imports/advance",
    ]);
    expect(idempotencyKey(requests[0]?.init)).not.toBe(
      idempotencyKey(requests[1]?.init),
    );
    expect(idempotencyKey(requests[1]?.init)).toBe(
      idempotencyKey(requests[2]?.init),
    );
    expect(idempotencyKey(requests[2]?.init)).not.toBe(
      idempotencyKey(requests[3]?.init),
    );
    const advanceBody = JSON.parse(String(requests[1]?.init?.body)) as {
      source_cursor: string;
    };
    expect(advanceBody.source_cursor).toBe("opaque-page-a");
  });

  it("rejects an advance response that omits its required cursor field", async () => {
    const provider = new HttpHistoryImportProvider(
      "https://history-gateway.example",
      "history-shared-secret-123",
      async () =>
        new Response(
          JSON.stringify({ status: "active", events: [], gap_code: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      provider.advance({
        owner,
        range_id: "range_history_provider",
        source_cursor: "opaque-page-a",
      }),
    ).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});
