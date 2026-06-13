import { describe, expect, test } from "bun:test";

import {
  createSessionLivenessRecord,
  evaluateSessionLiveness,
  reduceSessionLiveness,
} from "./session-liveness";

describe("session liveness", () => {
  test("active tool progress renews liveness without assistant text", () => {
    let record = createSessionLivenessRecord({
      bridgeProfileId: "codex",
      now: 1_000,
      queueItemId: "queue-1",
      sessionKey: "session-1",
    });
    record = reduceSessionLiveness(record, {
      at: 20_000,
      type: "tool_progress",
    });

    expect(
      evaluateSessionLiveness({
        now: 70_000,
        record,
        timeoutMs: 60_000,
      }),
    ).toEqual({ ok: true });
  });

  test("silent live sessions remain live after timeout", () => {
    const record = createSessionLivenessRecord({
      now: 1_000,
      queueItemId: "queue-1",
      sessionKey: "session-1",
    });

    expect(
      evaluateSessionLiveness({
        now: 62_000,
        record,
        timeoutMs: 60_000,
      }),
    ).toEqual({ ok: true });
  });

  test("quiet sessions recover to active after provider progress", () => {
    let record = reduceSessionLiveness(
      createSessionLivenessRecord({
        now: 1_000,
        queueItemId: "queue-1",
        sessionKey: "session-1",
      }),
      { at: 62_000, type: "provider_quiet" },
    );

    expect(record).toMatchObject({
      providerActivitySeen: false,
      quietSince: 62_000,
      silenceMs: 61_000,
      state: "quiet",
    });

    record = reduceSessionLiveness(record, {
      at: 70_000,
      type: "tool_progress",
    });

    expect(record).toMatchObject({
      lastMeaningfulEventAt: 70_000,
      providerActivitySeen: true,
      state: "active",
    });
    expect(record.quietSince).toBeUndefined();
    expect(record.silenceMs).toBeUndefined();
  });

  test("process exit during a live session fails terminal immediately", () => {
    const record = reduceSessionLiveness(
      createSessionLivenessRecord({
        now: 1_000,
        queueItemId: "queue-1",
        sessionKey: "session-1",
      }),
      { at: 2_000, type: "process_exited" },
    );

    expect(
      evaluateSessionLiveness({
        now: 2_000,
        record,
        timeoutMs: 60_000,
      }),
    ).toMatchObject({
      action: "fail_terminal",
      ok: false,
      reasonCode: "runtime_process_exited",
    });
  });
});
