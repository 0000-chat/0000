import { env, runInDurableObject } from "cloudflare:test";
import {
  HistoryImportDetailSchema,
  MessagePageResultSchema,
  type ProjectionEventEnvelope,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import type {
  HistoryImportProvider,
  HistoryProviderAdvanceResult,
  HistoryProviderStartResult,
} from "../../history/provider";
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
    { start_at: rangeStart, end_at: firstRangeEnd, source_cursor: "cursor-one" },
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
          return { issuer: "https://issuer.example/", subject: "human-subject" };
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
    expect(calls).toEqual([
      firstRange?.range_id,
      secondRange?.range_id,
    ]);
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
});
