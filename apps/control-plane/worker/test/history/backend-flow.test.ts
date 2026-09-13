import { env, runInDurableObject } from "cloudflare:test";
import {
  HistoryImportDetailSchema,
  MessagePageResultSchema,
  type ProjectionEventEnvelope,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import {
  decodeMessageCursor,
  encodeMessageCursor,
} from "../../projection/cursor";
import type {
  HistoryImportProvider,
  HistoryProviderAdvanceResult,
  HistoryProviderStartResult,
} from "../../history/provider";
import { HistoryProviderError } from "../../history/provider";
import { createHistoryService } from "../../history/service";
import type { HistoryRouteServices } from "../../history/routes";
import {
  auth,
  bindingFor,
  event,
  initialize,
} from "../projection/projector-test-support";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const accountId = "account_human";
const identityId = "identity_human";
const connectionId = "connection_human_whatsapp";
const rangeStart = "2026-09-01T00:00:00.000Z";
const firstRangeEnd = "2026-09-02T00:00:00.000Z";
const secondRangeStart = firstRangeEnd;
const rangeEnd = "2026-09-03T00:00:00.000Z";

const liveEvent = event(
  "live_history_coexistence",
  {
    message_id: "live_message_history",
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "Live sender",
    body: "live message remains readable",
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: true,
  },
  "message.created",
  {
    tenant_id: tenantId,
    identity_id: identityId,
    account_id: accountId,
    conversation_id: "conversation_history",
    observed_at: "2026-09-03T00:00:01.000Z",
    occurred_at: "2026-09-03T00:00:00.000Z",
  },
);

const importedEvent = event(
  "history_backfill_event",
  {
    message_id: "history_message",
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "History sender",
    body: "imported message",
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: false,
  },
  "message.created",
  {
    event_source: "backfill",
    tenant_id: tenantId,
    identity_id: identityId,
    account_id: accountId,
    conversation_id: "conversation_history",
    observed_at: "2026-09-03T00:00:02.000Z",
    occurred_at: "2026-09-02T00:00:00.000Z",
  },
);

const secondLiveEvent = event(
  "live_history_coexistence_second",
  {
    message_id: "live_message_history_second",
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "Live sender two",
    body: "second live message remains readable",
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: true,
  },
  "message.created",
  {
    tenant_id: tenantId,
    identity_id: identityId,
    account_id: accountId,
    conversation_id: "conversation_history",
    observed_at: "2026-09-03T00:00:03.000Z",
    occurred_at: "2026-09-03T00:00:02.000Z",
  },
);

const providerEvidence = {
  provider_version: "v26.08",
  proof_source: "controlled-history-test",
  summary: "Controlled private adapter response",
  observed_at: "2026-09-03T00:00:00.000Z",
};

const startResult: HistoryProviderStartResult = {
  availability: "available",
  provider_version: "v26.08",
  proof_source: "controlled-history-test",
  provider_evidence: providerEvidence,
  source_start_at: rangeStart,
  source_end_at: rangeEnd,
  ranges: [
    {
      start_at: rangeStart,
      end_at: firstRangeEnd,
      source_cursor: "cursor-one",
    },
    {
      start_at: secondRangeStart,
      end_at: rangeEnd,
      source_cursor: "cursor-two",
    },
  ],
  error_code: null,
};

const singleRangeStartResult: HistoryProviderStartResult = {
  ...startResult,
  ranges: [startResult.ranges[0]!],
};

const createProvider = (calls: string[]): HistoryImportProvider => ({
  start: async () => startResult,
  advance: async ({ range_id }): Promise<HistoryProviderAdvanceResult> => {
    calls.push(range_id);
    if (calls.length === 1) {
      return {
        status: "partial",
        events: [],
        next_cursor: "cursor-one-retry",
        gap_code: "provider_gap",
        error_code: null,
      };
    }
    return {
      status: "completed",
      events: [importedEvent],
      next_cursor: null,
      gap_code: null,
      error_code: null,
    };
  },
});

const createSinglePageProvider = (
  calls: string[],
  events: readonly ProjectionEventEnvelope[],
): HistoryImportProvider => ({
  start: async () => singleRangeStartResult,
  advance: async ({ range_id }): Promise<HistoryProviderAdvanceResult> => {
    calls.push(range_id);
    return {
      status: "completed",
      events,
      next_cursor: null,
      gap_code: null,
      error_code: null,
    };
  },
});

const createTestApp = (
  provider: HistoryImportProvider,
  applyEvents?: HistoryRouteServices["applyEvents"],
) =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token")
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        if (token === "agent-token")
          return {
            issuer: "https://issuer.example/",
            subject: "agent-subject",
            token_id: "agent-token-id",
          };
        throw new Error("invalid test token");
      },
    }),
    createHistoryImportProvider: () => provider,
    historyNow: () => new Date("2026-09-03T00:00:10.000Z"),
    ...(applyEvents === undefined ? {} : { applyHistoryEvents: applyEvents }),
  });

const request = (
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
  token = "human-token",
) =>
  app.request(
    `https://example.test${path}`,
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

const startImport = async (
  app: ReturnType<typeof createApp>,
  idempotencyKey: string,
) => {
  const response = await request(
    app,
    `/api/v1/accounts/${accountId}/history-imports`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        identity_id: identityId,
        start_at: rangeStart,
        end_at: rangeEnd,
        max_events: 50,
      }),
    },
  );
  expect(response.status).toBe(200);
  return HistoryImportDetailSchema.parse(await response.json());
};

async function seedLiveProjection(): Promise<void> {
  const stub = await initialize(tenantId);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE projection_meta SET state = 'ready'");
  });
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: auth(["projection.write"], [identityId], tenantId),
    mode: "live",
    rebuild_id: null,
    connections: [bindingFor(accountId, connectionId, identityId)],
    events: [liveEvent],
    checkpoint: null,
  });
}

async function seedSecondLiveMessage(): Promise<void> {
  const stub = workerEnv.TENANT_PROJECTION.getByName(tenantId);
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: auth(["projection.write"], [identityId], tenantId),
    mode: "live",
    rebuild_id: null,
    connections: [bindingFor(accountId, connectionId, identityId)],
    events: [secondLiveEvent],
    checkpoint: null,
  });
}

async function seedEmptyAgentConversation(): Promise<void> {
  const stub = workerEnv.TENANT_PROJECTION.getByName(tenantId);
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: auth(["projection.write"], ["identity_agent"], tenantId),
    mode: "live",
    rebuild_id: null,
    connections: [
      bindingFor(
        "account_agent",
        "connection_agent_whatsapp",
        "identity_agent",
      ),
    ],
    events: [
      event(
        "agent_empty_conversation",
        { title: "Empty agent conversation", archived: false, muted: false },
        "conversation.updated",
        {
          tenant_id: tenantId,
          identity_id: "identity_agent",
          account_id: "account_agent",
          conversation_id: "conversation_agent_empty",
          occurred_at: "2026-09-03T00:00:00.000Z",
          observed_at: "2026-09-03T00:00:01.000Z",
        },
      ),
    ],
    checkpoint: null,
  });
}

const readLiveMessages = async (app: ReturnType<typeof createApp>) => {
  const response = await request(
    app,
    "/api/v1/conversations/conversation_history/messages?identity_id=identity_human&account_id=account_human",
  );
  expect(response.status).toBe(200);
  return MessagePageResultSchema.parse(await response.json());
};

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
  await seedLiveProjection();
});

describe("history import production route", () => {
  it("keeps pending ranges active after a partial range while stored live reads continue", async () => {
    const calls: string[] = [];
    const app = createTestApp(createProvider(calls));
    const started = await request(
      app,
      `/api/v1/accounts/${accountId}/history-imports`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "history-flow-001" },
        body: JSON.stringify({
          identity_id: identityId,
          start_at: rangeStart,
          end_at: rangeEnd,
          max_events: 50,
        }),
      },
    );
    expect(started.status).toBe(200);
    const initial = HistoryImportDetailSchema.parse(await started.json());
    expect(initial.import.status).toBe("active");
    expect(initial.ranges.map((range) => range.status)).toEqual([
      "active",
      "pending",
    ]);

    const liveBefore = await readLiveMessages(app);
    expect(liveBefore.items.map((item) => item.body)).toContain(
      "live message remains readable",
    );

    const firstRange = initial.ranges[0];
    const secondRange = initial.ranges[1];
    expect(firstRange).toBeDefined();
    expect(secondRange).toBeDefined();
    const partialResponse = await request(
      app,
      `/api/v1/history-imports/${initial.import.import_id}/advance`,
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          range_id: firstRange?.range_id,
        }),
      },
    );
    expect(partialResponse.status).toBe(200);
    const partial = HistoryImportDetailSchema.parse(
      await partialResponse.json(),
    );
    expect(partial.import.status).toBe("active");
    expect(partial.ranges.map((range) => range.status)).toEqual([
      "partial",
      "pending",
    ]);

    const liveDuring = await readLiveMessages(app);
    expect(liveDuring.items.map((item) => item.body)).toContain(
      "live message remains readable",
    );

    const completedResponse = await request(
      app,
      `/api/v1/history-imports/${initial.import.import_id}/advance`,
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          range_id: secondRange?.range_id,
        }),
      },
    );
    expect(completedResponse.status).toBe(200);
    const completed = HistoryImportDetailSchema.parse(
      await completedResponse.json(),
    );
    expect(completed.import.status).toBe("partial");
    expect(completed.ranges.map((range) => range.status)).toEqual([
      "partial",
      "completed",
    ]);
    expect(calls).toEqual([firstRange?.range_id, secondRange?.range_id]);
  });

  it("keeps coverage stable when a seek page is empty after the chat has messages", async () => {
    await seedSecondLiveMessage();
    const app = createTestApp(createSinglePageProvider([], []));
    const firstResponse = await request(
      app,
      "/api/v1/conversations/conversation_history/messages?identity_id=identity_human&account_id=account_human&limit=1",
    );
    expect(firstResponse.status).toBe(200);
    const firstPage = MessagePageResultSchema.parse(await firstResponse.json());
    expect(firstPage.items).toHaveLength(1);

    const firstCursor = decodeMessageCursor(firstPage.next_cursor ?? "", {
      tenant_id: tenantId,
      identity_id: identityId,
      conversation_id: "conversation_history",
      generation: 1,
    });
    const endCursor = encodeMessageCursor({
      ...firstCursor,
      last_occurred_ms: 0,
    });
    const emptyResponse = await request(
      app,
      `/api/v1/conversations/conversation_history/messages?identity_id=identity_human&account_id=account_human&limit=1&cursor=${encodeURIComponent(endCursor)}`,
    );
    expect(emptyResponse.status).toBe(200);
    const emptyPage = MessagePageResultSchema.parse(await emptyResponse.json());
    expect(emptyPage.items).toEqual([]);
    expect(emptyPage.history?.state).toBe("available");
  });

  it("denies an agent and keeps a human identity bound to its account", async () => {
    const provider = createSinglePageProvider([], []);
    const app = createTestApp(provider);
    const agentResponse = await request(
      app,
      `/api/v1/accounts/${accountId}/history-imports`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "history-agent-001" },
        body: JSON.stringify({
          identity_id: "identity_agent",
          start_at: rangeStart,
          end_at: rangeEnd,
          max_events: 50,
        }),
      },
      "agent-token",
    );
    expect(agentResponse.status).toBe(403);

    const crossAccountResponse = await request(
      app,
      "/api/v1/accounts/account_agent/history-imports",
      {
        method: "POST",
        headers: { "Idempotency-Key": "history-cross-001" },
        body: JSON.stringify({
          identity_id: identityId,
          start_at: rangeStart,
          end_at: rangeEnd,
          max_events: 50,
        }),
      },
    );
    expect(crossAccountResponse.status).toBe(404);
  });

  it("reports not-imported coverage for an authorized empty account", async () => {
    const app = createTestApp(createSinglePageProvider([], []));
    await seedEmptyAgentConversation();
    const response = await request(
      app,
      "/api/v1/conversations/conversation_agent_empty/messages?identity_id=identity_agent&account_id=account_agent",
      {},
      "agent-token",
    );
    expect(response.status).toBe(200);
    const page = MessagePageResultSchema.parse(await response.json());
    expect(page.items).toEqual([]);
    expect(page.history).toEqual({
      state: "not_imported",
      account_id: "account_agent",
      latest_import_id: null,
      requested_start_at: null,
      requested_end_at: null,
      known_gap_count: 0,
    });
    const withoutAccount = await request(
      app,
      "/api/v1/conversations/conversation_agent_empty/messages?identity_id=identity_agent",
      {},
      "agent-token",
    );
    expect(withoutAccount.status).toBe(200);
    expect(
      MessagePageResultSchema.parse(await withoutAccount.json()).history,
    ).toEqual(page.history);
  });

  it("reports empty coverage after a provider confirms no available history", async () => {
    const app = createTestApp(createSinglePageProvider([], []));
    await seedEmptyAgentConversation();
    const service = createHistoryService({
      provider: {
        start: async () => ({
          ...singleRangeStartResult,
          ranges: [],
        }),
        advance: async () => ({
          status: "completed" as const,
          events: [],
          next_cursor: null,
          gap_code: null,
          error_code: null,
        }),
      },
      now: () => new Date("2026-09-03T00:00:10.000Z"),
    });
    await service.start({
      env: workerEnv,
      tenantId,
      accountId: "account_agent",
      identityId: "identity_agent",
      idempotencyKey: "history-empty-001",
      startAt: rangeStart,
      endAt: rangeEnd,
      maxEvents: 50,
    });
    const response = await request(
      app,
      "/api/v1/conversations/conversation_agent_empty/messages?identity_id=identity_agent&account_id=account_agent",
      {},
      "agent-token",
    );
    expect(response.status).toBe(200);
    const page = MessagePageResultSchema.parse(await response.json());
    expect(page.history?.state).toBe("empty");
    expect(page.history?.requested_start_at).toBe(rangeStart);
    expect(page.history?.requested_end_at).toBe(rangeEnd);
    const withoutAccount = await request(
      app,
      "/api/v1/conversations/conversation_agent_empty/messages?identity_id=identity_agent",
      {},
      "agent-token",
    );
    expect(withoutAccount.status).toBe(200);
    expect(
      MessagePageResultSchema.parse(await withoutAccount.json()).history?.state,
    ).toBe("empty");
  });

  it("records malformed provider ranges as a failed import", async () => {
    const calls: string[] = [];
    const app = createTestApp({
      start: async () => ({
        ...singleRangeStartResult,
        ranges: [
          {
            start_at: "2026-08-31T00:00:00.000Z",
            end_at: firstRangeEnd,
            source_cursor: "malformed-range",
          },
        ],
      }),
      advance: async ({ range_id }) => {
        calls.push(range_id);
        return {
          status: "completed" as const,
          events: [],
          next_cursor: null,
          gap_code: null,
          error_code: null,
        };
      },
    });
    const response = await request(
      app,
      `/api/v1/accounts/${accountId}/history-imports`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "history-malformed-001" },
        body: JSON.stringify({
          identity_id: identityId,
          start_at: rangeStart,
          end_at: rangeEnd,
          max_events: 50,
        }),
      },
    );
    expect(response.status).toBe(200);
    const detail = HistoryImportDetailSchema.parse(await response.json());
    expect(detail.import.status).toBe("failed");
    expect(detail.import.last_error_code).toBe("malformed_range");
    expect(detail.ranges[0]?.status).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("bounds runtime-unavailable retries and exposes terminal failure", async () => {
    const calls: string[] = [];
    const app = createTestApp({
      start: async () => singleRangeStartResult,
      advance: async ({ range_id }) => {
        calls.push(range_id);
        throw new HistoryProviderError("runtime_unavailable");
      },
    });
    const initial = await startImport(app, "history-retry-001");
    const range = initial.ranges[0];
    expect(range).toBeDefined();
    let detail = initial;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await request(
        app,
        `/api/v1/history-imports/${initial.import.import_id}/advance`,
        {
          method: "POST",
          body: JSON.stringify({
            identity_id: identityId,
            range_id: range?.range_id,
          }),
        },
      );
      expect(response.status).toBe(200);
      detail = HistoryImportDetailSchema.parse(await response.json());
      expect(detail.import.attempt_count).toBe(attempt);
    }
    expect(detail.import.status).toBe("failed");
    expect(detail.import.last_error_code).toBe("bounded_retry_exhausted");
    expect(detail.ranges[0]?.status).toBe("failed");
    expect(calls).toEqual([range?.range_id, range?.range_id, range?.range_id]);
  });

  it("keeps sibling ranges active after one range exhausts runtime retries", async () => {
    let exhaustedRangeId: string | undefined;
    const app = createTestApp({
      start: async () => startResult,
      advance: async ({ range_id }) => {
        exhaustedRangeId ??= range_id;
        if (range_id === exhaustedRangeId) {
          throw new HistoryProviderError("runtime_unavailable");
        }
        return {
          status: "completed" as const,
          events: [],
          next_cursor: null,
          gap_code: null,
          error_code: null,
        };
      },
    });
    const initial = await startImport(app, "history-retry-sibling-001");
    const firstRange = initial.ranges[0];
    const secondRange = initial.ranges[1];
    expect(firstRange).toBeDefined();
    expect(secondRange).toBeDefined();

    let detail = initial;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await request(
        app,
        `/api/v1/history-imports/${initial.import.import_id}/advance`,
        {
          method: "POST",
          body: JSON.stringify({
            identity_id: identityId,
            range_id: firstRange?.range_id,
          }),
        },
      );
      expect(response.status).toBe(200);
      detail = HistoryImportDetailSchema.parse(await response.json());
      expect(detail.import.attempt_count).toBe(attempt);
    }
    expect(detail.import.status).toBe("active");
    expect(detail.ranges.map((range) => range.status)).toEqual([
      "failed",
      "pending",
    ]);

    const completedResponse = await request(
      app,
      `/api/v1/history-imports/${initial.import.import_id}/advance`,
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          range_id: secondRange?.range_id,
        }),
      },
    );
    expect(completedResponse.status).toBe(200);
    detail = HistoryImportDetailSchema.parse(await completedResponse.json());
    expect(detail.import.status).toBe("failed");
    expect(detail.ranges.map((range) => range.status)).toEqual([
      "failed",
      "completed",
    ]);
  });

  it("keeps a failed range from stranding pending ranges", async () => {
    const calls: string[] = [];
    const app = createTestApp({
      start: async () => startResult,
      advance: async ({ range_id }): Promise<HistoryProviderAdvanceResult> => {
        calls.push(range_id);
        if (calls.length === 1) {
          return {
            status: "failed",
            events: [],
            next_cursor: null,
            gap_code: "provider_gap",
            error_code: "provider_error",
          };
        }
        return {
          status: "completed",
          events: [],
          next_cursor: null,
          gap_code: null,
          error_code: null,
        };
      },
    });
    const initial = await startImport(app, "history-failed-range-001");
    const firstRange = initial.ranges[0];
    const secondRange = initial.ranges[1];
    expect(firstRange).toBeDefined();
    expect(secondRange).toBeDefined();

    const failedResponse = await request(
      app,
      `/api/v1/history-imports/${initial.import.import_id}/advance`,
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          range_id: firstRange?.range_id,
        }),
      },
    );
    const active = HistoryImportDetailSchema.parse(await failedResponse.json());
    expect(active.import.status).toBe("active");
    expect(active.ranges.map((range) => range.status)).toEqual([
      "failed",
      "pending",
    ]);

    const completedResponse = await request(
      app,
      `/api/v1/history-imports/${initial.import.import_id}/advance`,
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          range_id: secondRange?.range_id,
        }),
      },
    );
    const terminal = HistoryImportDetailSchema.parse(
      await completedResponse.json(),
    );
    expect(terminal.import.status).toBe("failed");
    expect(terminal.ranges.map((range) => range.status)).toEqual([
      "failed",
      "completed",
    ]);
  });

  it("exposes authenticated capabilities and import progress", async () => {
    const app = createTestApp(createSinglePageProvider([], []));
    const capabilitiesResponse = await request(
      app,
      `/api/v1/accounts/${accountId}/capabilities?identity_id=${identityId}`,
    );
    expect(capabilitiesResponse.status).toBe(200);
    const capabilities = (await capabilitiesResponse.json()) as Array<{
      capability: string;
      status: string;
    }>;
    expect(capabilities).toHaveLength(5);
    expect(
      capabilities.find(
        (capability) => capability.capability === "history.import",
      )?.status,
    ).toBe("unverified");

    const initial = await startImport(app, "history-progress-001");
    const listResponse = await request(
      app,
      `/api/v1/accounts/${accountId}/history-imports?identity_id=${identityId}`,
    );
    expect(listResponse.status).toBe(200);
    expect(
      (
        (await listResponse.json()) as { items: Array<{ import_id: string }> }
      ).items.map((item) => item.import_id),
    ).toContain(initial.import.import_id);

    const detailResponse = await request(
      app,
      `/api/v1/history-imports/${initial.import.import_id}?identity_id=${identityId}`,
    );
    expect(detailResponse.status).toBe(200);
    expect(
      HistoryImportDetailSchema.parse(await detailResponse.json()).import
        .import_id,
    ).toBe(initial.import.import_id);
  });

  it("deduplicates repeated events within one provider page", async () => {
    const calls: string[] = [];
    const applied: ProjectionEventEnvelope[] = [];
    const app = createTestApp(
      createSinglePageProvider(calls, [importedEvent, importedEvent]),
      async (input) => {
        applied.push(...input.events);
      },
    );
    const initial = await startImport(app, "history-duplicate-001");
    const range = initial.ranges[0];
    expect(range).toBeDefined();
    const response = await request(
      app,
      `/api/v1/history-imports/${initial.import.import_id}/advance`,
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          range_id: range?.range_id,
        }),
      },
    );
    expect(response.status).toBe(200);
    const detail = HistoryImportDetailSchema.parse(await response.json());
    expect(detail.import.status).toBe("completed");
    expect(detail.import.event_count).toBe(1);
    expect(applied.map((event) => event.event_id)).toEqual([
      importedEvent.event_id,
    ]);
    expect(calls).toEqual([range?.range_id]);
    const hashes = await workerEnv.CONTROL_DB.prepare(
      "SELECT source_event_id FROM history_import_events WHERE import_id = ?",
    )
      .bind(initial.import.import_id)
      .all<{ source_event_id: string }>();
    expect(hashes.results).toEqual([
      { source_event_id: importedEvent.event_id },
    ]);
  });

  it("resumes after projection apply succeeds before the D1 checkpoint write", async () => {
    const calls: string[] = [];
    let applyCalls = 0;
    const app = createTestApp(
      createSinglePageProvider(calls, [importedEvent]),
      async (input) => {
        const projection = input.env.TENANT_PROJECTION.getByName(
          input.tenantId,
        );
        await projection.applyBatch({
          schema_version: 1,
          tenant_id: input.tenantId,
          authorization: auth(
            ["projection.write"],
            [input.identityId],
            input.tenantId,
          ),
          mode: "live",
          rebuild_id: null,
          connections: [
            bindingFor(input.accountId, connectionId, input.identityId),
          ],
          events: [...input.events],
          checkpoint: null,
        });
        applyCalls += 1;
        if (applyCalls === 1) throw new Error("simulated checkpoint crash");
      },
    );
    const initial = await startImport(app, "history-resume-001");
    const range = initial.ranges[0];
    expect(range).toBeDefined();

    const advance = async () =>
      request(
        app,
        `/api/v1/history-imports/${initial.import.import_id}/advance`,
        {
          method: "POST",
          body: JSON.stringify({
            identity_id: identityId,
            range_id: range?.range_id,
          }),
        },
      );
    const crashed = await advance();
    expect(crashed.status).toBe(200);
    const retryable = HistoryImportDetailSchema.parse(await crashed.json());
    expect(retryable.import.status).toBe("active");
    expect(retryable.import.last_error_code).toBe("provider_error");
    expect(retryable.import.event_count).toBe(0);

    const resumed = await advance();
    expect(resumed.status).toBe(200);
    const completed = HistoryImportDetailSchema.parse(await resumed.json());
    expect(completed.import.status).toBe("completed");
    expect(completed.import.event_count).toBe(1);
    expect(applyCalls).toBe(2);
    expect(calls).toEqual([range?.range_id, range?.range_id]);

    const hashes = await workerEnv.CONTROL_DB.prepare(
      "SELECT source_event_id FROM history_import_events WHERE import_id = ?",
    )
      .bind(initial.import.import_id)
      .all<{ source_event_id: string }>();
    expect(hashes.results).toEqual([
      { source_event_id: importedEvent.event_id },
    ]);
    const projectionRows = await runInDurableObject(
      workerEnv.TENANT_PROJECTION.getByName(tenantId),
      async (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM messages WHERE id = ?",
            "history_message",
          )
          .toArray(),
    );
    expect(projectionRows).toEqual([{ count: 1 }]);
  });

  it("accepts and checkpoints the complete 500-event provider page", async () => {
    const pageEvents = Array.from({ length: 500 }, (_, index) =>
      event(
        `history_page_event_${String(index).padStart(3, "0")}`,
        {
          message_id: `history_page_message_${String(index).padStart(3, "0")}`,
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "History sender",
          body: `history page message ${index}`,
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
        "message.created",
        {
          event_source: "backfill",
          tenant_id: tenantId,
          identity_id: identityId,
          account_id: accountId,
          conversation_id: "conversation_history",
          observed_at: "2026-09-03T00:00:02.000Z",
          occurred_at: "2026-09-02T00:00:00.000Z",
        },
      ),
    );
    const calls: string[] = [];
    const applied: ProjectionEventEnvelope[] = [];
    const app = createTestApp(
      createSinglePageProvider(calls, pageEvents),
      async (input) => {
        applied.push(...input.events);
      },
    );
    const initial = await startImport(app, "history-page-500-001");
    const range = initial.ranges[0];
    expect(range).toBeDefined();
    const response = await request(
      app,
      `/api/v1/history-imports/${initial.import.import_id}/advance`,
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          range_id: range?.range_id,
        }),
      },
    );
    expect(response.status).toBe(200);
    const detail = HistoryImportDetailSchema.parse(await response.json());
    expect(detail.import.status).toBe("completed");
    expect(detail.import.event_count).toBe(500);
    expect(applied).toHaveLength(500);
    expect(calls).toEqual([range?.range_id]);
    const hashes = await workerEnv.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM history_import_events WHERE import_id = ?",
    )
      .bind(initial.import.import_id)
      .first<{ count: number }>();
    expect(hashes?.count).toBe(500);
  });
});
