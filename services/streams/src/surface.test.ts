import { describe, expect, test } from "bun:test";
import { authorizeMcp } from "./auth";
import { toolDefinitions } from "./mcp";
import {
  getStreamCardContent,
  groupStreamsForDisplay,
  html,
  applyLiveStreams,
  liveReconnectDelay,
  manifest,
  serviceWorker,
  timelineDisclosureState,
} from "./ui";
import * as uiModule from "./ui";
import { handleMcpRequest, parseMcpEnvelope, validateToolInput } from "./mcp";
import { readFileSync } from "node:fs";

const workerSource = readFileSync(
  new URL("./worker.ts", import.meta.url),
  "utf8",
);
const wranglerConfig = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);

const fixedNow = new Date("2026-09-06T00:00:00.000Z");
const stream = (overrides: Record<string, unknown> = {}) => ({
  streamId: "stream",
  title: "Stream",
  ownerBot: "helm",
  status: "needs_decision",
  needsDon: true,
  priority: 0,
  updatedAt: "2026-09-05T00:00:00.000Z",
  ...overrides,
});

describe("Helm Streams surface", () => {
  test("requires the exact MCP bearer secret", () => {
    const env = { MCP_AUTH_TOKEN: "test-token" } as Env;
    expect(authorizeMcp(new Request("https://don.0000.gold/mcp"), env)).toBe(
      false,
    );
    expect(
      authorizeMcp(
        new Request("https://don.0000.gold/mcp", {
          headers: { authorization: "Bearer test-token" },
        }),
        env,
      ),
    ).toBe(true);
  });

  test("publishes the approved stream management tools", () => {
    expect(toolDefinitions.map((tool) => tool.name)).toEqual([
      "upsert_stream",
      "reprioritize_stream",
      "archive_stream",
      "set_stream_choices",
      "patch_streams",
      "list_streams",
    ]);
  });

  test("contains an installable manifest and offline shell worker", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(serviceWorker).toContain("caches.open");
    expect(html).toContain('{id:"custom",value:"custom"}');
    expect(html).toContain("Manila · UTC+8");
    expect(html).toContain('timeZone:"Asia/Manila"');
    expect(html).toContain("Needs you");
    expect(html).toContain("Elsewhere");
    expect(html).toContain("recommended");
    expect(html).toContain("Change my answer");
    expect(html).toContain("/api/streams/live");
    expect(html).toContain("scheduleLiveReconnect");
    expect(html).toContain("LIVE_POLL_INTERVAL_MS");
    expect(html).toContain("window.setInterval");
  });

  test("accepts authoritative live snapshots and ignores unrelated frames", () => {
    const next = stream({
      streamId: "next",
      status: "ongoing",
      needsDon: false,
    });
    expect(
      applyLiveStreams({ type: "streams.snapshot", streams: [next] }),
    ).toEqual([next]);
    expect(
      applyLiveStreams({
        type: "streams.updated",
        streams: [next],
        changedStreamIds: ["next"],
      }),
    ).toEqual([next]);
    expect(applyLiveStreams({ type: "heartbeat" })).toBeNull();
    expect(
      applyLiveStreams({ type: "streams.updated", streams: "invalid" }),
    ).toBeNull();
  });

  test("caps live reconnect backoff while preserving exponential retries", () => {
    expect(liveReconnectDelay(0)).toBe(1_000);
    expect(liveReconnectDelay(1)).toBe(2_000);
    expect(liveReconnectDelay(4)).toBe(16_000);
    expect(liveReconnectDelay(5)).toBe(30_000);
    expect(liveReconnectDelay(99)).toBe(30_000);
  });

  test("moves a locked needs-decision stream from Needs you to Recent decisions", () => {
    const unlocked = stream({ streamId: "approval", decisionLock: null });
    expect(
      groupStreamsForDisplay([unlocked], fixedNow).needsYou.map(
        (item) => item.streamId,
      ),
    ).toEqual(["approval"]);

    const submitted = stream({
      streamId: "approval",
      decisionLock: {
        status: "submitted",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    });
    const grouped = groupStreamsForDisplay([submitted], fixedNow);
    expect(grouped.needsYou).toHaveLength(0);
    expect(grouped.recentDecisions.map((item) => item.streamId)).toEqual([
      "approval",
    ]);
  });

  test("keeps a submitted decision on the exact seven-day boundary in Recent decisions", () => {
    const boundary = stream({
      streamId: "boundary",
      decisionLock: {
        status: "submitted",
        createdAt: "2026-08-30T00:00:00.000Z",
      },
    });
    const old = stream({
      streamId: "old",
      decisionLock: {
        status: "submitted",
        createdAt: "2026-08-29T23:59:59.999Z",
      },
    });
    const grouped = groupStreamsForDisplay([boundary, old], fixedNow);
    expect(grouped.recentDecisions.map((item) => item.streamId)).toEqual([
      "boundary",
    ]);
    // Stale submitted lock must not hide a stream that still needs a decision.
    expect(grouped.needsYou.map((item) => item.streamId)).toEqual(["old"]);
    expect(grouped.elsewhere.map((item) => item.streamId)).toEqual([]);
  });

  test("pins pending and failed locks regardless of age and ranks delivery status", () => {
    const submitted = stream({
      streamId: "submitted",
      decisionLock: {
        status: "submitted",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    });
    const pending = stream({
      streamId: "pending",
      decisionLock: {
        status: "pending",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    });
    const failed = stream({
      streamId: "failed",
      decisionLock: { status: "failed", createdAt: "not-a-date" },
    });
    const grouped = groupStreamsForDisplay(
      [submitted, pending, failed],
      fixedNow,
    );
    expect(grouped.recentDecisions.map((item) => item.streamId)).toEqual([
      "failed",
      "pending",
      "submitted",
    ]);
  });

  test("uses lock creation time, priority, and stream ID for Recent decisions", () => {
    const later = stream({
      streamId: "later",
      priority: 1,
      updatedAt: "2026-09-06T00:00:00.000Z",
      decisionLock: {
        status: "submitted",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    });
    const earlier = stream({
      streamId: "earlier",
      priority: 1,
      updatedAt: "2026-09-01T00:00:00.000Z",
      decisionLock: {
        status: "submitted",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    });
    const higherPriority = stream({
      streamId: "higher",
      priority: 9,
      updatedAt: "2026-09-01T00:00:00.000Z",
      decisionLock: {
        status: "submitted",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    });
    const oldest = stream({
      streamId: "oldest",
      priority: 99,
      decisionLock: {
        status: "submitted",
        createdAt: "2026-09-04T00:00:00.000Z",
      },
    });
    expect(
      groupStreamsForDisplay(
        [later, oldest, earlier, higherPriority],
        fixedNow,
      ).recentDecisions.map((item) => item.streamId),
    ).toEqual(["higher", "earlier", "later", "oldest"]);
  });

  test("orders section ties and omits archived streams", () => {
    const needsHigh = stream({
      streamId: "needs-high",
      priority: 2,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
    const needsTie = stream({
      streamId: "needs-tie",
      priority: 2,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
    const ongoing = stream({
      streamId: "ongoing",
      status: "ongoing",
      needsDon: false,
      priority: 1,
    });
    const noAction = stream({
      streamId: "no-action",
      status: "no_action",
      needsDon: false,
      priority: 9,
    });
    const archived = stream({
      streamId: "archived",
      status: "no_action",
      archived: true,
    });
    const grouped = groupStreamsForDisplay(
      [needsTie, noAction, archived, ongoing, needsHigh],
      fixedNow,
    );
    expect(grouped.needsYou.map((item) => item.streamId)).toEqual([
      "needs-high",
      "needs-tie",
    ]);
    expect(grouped.elsewhere.map((item) => item.streamId)).toEqual([
      "ongoing",
      "no-action",
    ]);
    expect(
      Object.values(grouped)
        .flat()
        .some((item) => item.streamId === "archived"),
    ).toBe(false);
  });

  test("keeps needs_decision streams with invalid submitted locks in Needs you; pending/failed stay Recent", () => {
    const submitted = stream({
      streamId: "invalid-submitted",
      decisionLock: { status: "submitted", createdAt: "not-a-date" },
    });
    const pending = stream({
      streamId: "invalid-pending",
      decisionLock: { status: "pending", createdAt: "not-a-date" },
    });
    const failed = stream({
      streamId: "invalid-failed",
      decisionLock: { status: "failed", createdAt: "not-a-date" },
    });
    const grouped = groupStreamsForDisplay(
      [submitted, pending, failed],
      fixedNow,
    );
    expect(grouped.needsYou.map((item) => item.streamId)).toEqual([
      "invalid-submitted",
    ]);
    expect(grouped.recentDecisions.map((item) => item.streamId)).toEqual([
      "invalid-failed",
      "invalid-pending",
    ]);
    expect(grouped.elsewhere.map((item) => item.streamId)).toEqual([]);
  });

  test("puts needs_decision streams in Needs you even when needsDon is false", () => {
    const unlocked = stream({
      streamId: "cos-canary-1905",
      status: "needs_decision",
      needsDon: false,
      decisionLock: null,
    });
    const staleLock = stream({
      streamId: "sor-stale",
      status: "needs_decision",
      needsDon: false,
      decisionLock: {
        status: "submitted",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    });
    const grouped = groupStreamsForDisplay([unlocked, staleLock], fixedNow);
    expect(grouped.needsYou.map((item) => item.streamId)).toEqual([
      "cos-canary-1905",
      "sor-stale",
    ]);
    expect(grouped.recentDecisions.map((item) => item.streamId)).toEqual([]);
    expect(grouped.elsewhere.map((item) => item.streamId)).toEqual([]);
  });

  test("uses a collapsed disclosure with a Manila count and no timeline in list cards", () => {
    expect(html).toContain('<details id="timelineDisclosure">');
    expect(html).toContain('<summary id="timelineSummary">');
    expect(html).toContain("Timeline");
    expect(html).toContain("Manila/UTC+8");
    expect(html).not.toContain("card-timeline");
    expect(html).not.toContain("No timeline entries yet");
    expect(html).toContain("function transitionTimeline(action)");
    expect(html).toContain('transitionTimeline("new-stream")');
    expect(html).toContain('transitionTimeline("same-stream-refresh")');
    expect(html).toContain('transitionTimeline("close-dialog")');
    expect(html).not.toContain("timelineDisclosure.open=false");
  });

  test("executes disclosure transitions for open, same-stream refresh, close, and another stream", () => {
    expect(timelineDisclosureState(true, "new-stream")).toBe(false);
    expect(timelineDisclosureState(false, "new-stream")).toBe(false);
    expect(timelineDisclosureState(true, "same-stream-refresh")).toBe(true);
    expect(timelineDisclosureState(false, "same-stream-refresh")).toBe(false);
    expect(timelineDisclosureState(true, "close-dialog")).toBe(false);
    expect(timelineDisclosureState(true, "new-stream")).toBe(false);
  });

  test("executes list-card content without timeline entries or empty-timeline text", () => {
    const card = getStreamCardContent(
      stream({
        timeline: [{ at: "2026-09-05T00:00:00.000Z", text: "Timeline fact" }],
        history: ["Legacy timeline fact"],
      }),
    );
    expect(card).toMatchObject({
      title: "Stream",
      about: "",
      status: "needs_decision",
      deliveryStatus: null,
    });
    expect(card).not.toHaveProperty("timeline");
    expect(JSON.stringify(card)).not.toContain("Timeline fact");
    expect(JSON.stringify(card)).not.toContain("No timeline");
  });

  test("renders three display sections with counts and delivery labels", () => {
    expect(html).toContain("Recent decisions");
    expect(html).toContain("streams.length)");
    expect(html).toContain("Delivery pending");
    expect(html).toContain("Delivery submitted");
    expect(html).toContain("Delivery failed");
  });

  test("marks focus, tap targets, scrolling, and safe-area affordances", () => {
    expect(html).toContain(":focus-visible");
    expect(html).toContain("min-width:44px");
    expect(html).toContain("min-height:44px");
    expect(html).toContain("min-height:52px");
    expect(html).toContain("overflow-y:auto");
    expect(html).toContain("safe-area-inset-bottom");
  });

  test("renders authoritative timeline and decision-lock controls", () => {
    expect(html).toContain("decisionLock");
    expect(html).toContain("timeline");
    expect(html).toContain("/api/decisions/unlock");
    expect(html).toContain("Retry decision");
    expect(html).toContain("Recorded answer");
    expect(html).toContain("Delivery failed");
    expect(html).toContain("correction");
  });

  test("gates active decision controls to streams that need a decision", () => {
    expect(html).toContain("function canDecide(stream)");
    expect(html).toContain("No decision needed for this stream.");
    expect(html).toContain("decisionPanel.hidden");
    expect(html).toContain("!canDecide(stream)");
  });

  test("exposes retry for pending locks without enabling answer changes", () => {
    expect(html).toContain("Retry pending delivery");
    expect(html).toContain("isRetryableDecisionStatus(lock.status)");
    expect(html).toContain(
      'changeButton.hidden=!lock||lock.status==="pending"',
    );
  });

  test("recognizes only pending and failed decisions as retryable", () => {
    const retryable = (
      uiModule as unknown as {
        isRetryableDecisionStatus?: (status: string) => boolean;
      }
    ).isRetryableDecisionStatus;
    expect(typeof retryable).toBe("function");
    if (typeof retryable !== "function") return;
    expect(retryable("pending")).toBe(true);
    expect(retryable("failed")).toBe(true);
    expect(retryable("submitted")).toBe(false);
    expect(retryable("unlocked")).toBe(false);
  });

  test("validates JSON-RPC requests, notifications, and tool arguments", () => {
    expect(
      parseMcpEnvelope({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toEqual({
      kind: "notification",
      method: "notifications/initialized",
    });
    expect(() => parseMcpEnvelope({ method: "tools/list" })).toThrow(
      "Invalid Request",
    );
    expect(() =>
      validateToolInput("reprioritize_stream", { streamId: "one" }),
    ).toThrow("priority");
    expect(validateToolInput("archive_stream", { streamId: "one" })).toEqual({
      streamId: "one",
    });
    expect(() =>
      validateToolInput("upsert_stream", {
        streamId: "one",
        title: "One",
        ownerBot: "helm",
        summary: 4,
      }),
    ).toThrow("summary");
    expect(() =>
      validateToolInput("set_stream_choices", {
        streamId: "one",
        choices: [{ id: "a", label: "A", value: "a", extra: true }],
      }),
    ).toThrow("unexpected");
  });

  test("accepts modern context, status, and recommended choices through MCP", () => {
    expect(
      validateToolInput("upsert_stream", {
        streamId: "one",
        title: "One",
        ownerBot: "helm",
        about: "About one",
        timeline: [{ at: "2026-09-06T00:00:00Z", text: "Started" }],
        status: "needs_decision",
      }),
    ).toEqual({
      streamId: "one",
      title: "One",
      ownerBot: "helm",
      about: "About one",
      timeline: [{ at: "2026-09-06T00:00:00Z", text: "Started" }],
      status: "needs_decision",
    });
    expect(
      validateToolInput("set_stream_choices", {
        streamId: "one",
        choices: [{ id: "a", label: "A", value: "a", recommended: true }],
      }),
    ).toEqual({
      streamId: "one",
      choices: [{ id: "a", label: "A", value: "a", recommended: true }],
    });
  });

  test("validates patch_streams as a unique nonempty atomic patch batch", () => {
    expect(
      validateToolInput("patch_streams", {
        patches: [
          { streamId: "one", status: "ongoing" },
          { streamId: "two", priority: 3 },
        ],
      }),
    ).toEqual({
      patches: [
        { streamId: "one", status: "ongoing" },
        { streamId: "two", priority: 3 },
      ],
    });
    expect(() => validateToolInput("patch_streams", { patches: [] })).toThrow(
      "nonempty",
    );
    expect(() =>
      validateToolInput("patch_streams", {
        patches: [
          { streamId: "one", status: "ongoing" },
          { streamId: "one", priority: 2 },
        ],
      }),
    ).toThrow("unique");
    expect(() =>
      validateToolInput("patch_streams", { patches: [{ streamId: "one" }] }),
    ).toThrow("mutable");
    expect(() =>
      validateToolInput("patch_streams", {
        patches: [{ streamId: "one", needsDon: true }],
      }),
    ).toThrow("unexpected");
  });

  test("enforces Streamable HTTP status, origin, and version rules", async () => {
    const execute = async () => ({ ok: true });
    const get = await handleMcpRequest(
      new Request("https://don.0000.gold/mcp", {
        headers: { authorization: "Bearer token" },
      }),
      "token",
      execute,
    );
    expect(get.status).toBe(405);
    const notification = await handleMcpRequest(
      new Request("https://don.0000.gold/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }),
      "token",
      execute,
    );
    expect(notification.status).toBe(202);
    const foreign = await handleMcpRequest(
      new Request("https://don.0000.gold/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
      "token",
      execute,
    );
    expect(foreign.status).toBe(403);
    const missingVersion = await handleMcpRequest(
      new Request("https://don.0000.gold/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
      "token",
      execute,
    );
    expect(missingVersion.status).toBe(400);
  });

  test("sends the configured bearer token to the Grok webhook", () => {
    expect(workerSource).toContain(
      "`Bearer ${env.GROK_WEBHOOK_AUTHORIZATION}`",
    );
    expect(wranglerConfig).toContain('"GROK_WEBHOOK_AUTHORIZATION"');
  });

  test("does not configure a future Worker compatibility date", () => {
    const config = JSON.parse(wranglerConfig) as { compatibility_date: string };
    expect(
      config.compatibility_date <= new Date().toISOString().slice(0, 10),
    ).toBe(true);
  });
});
