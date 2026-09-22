import { describe, expect, test } from "bun:test";
import {
  appendTimeline,
  buildWebhookPayload,
  groupStreams,
  normalizeStream,
  sortStreams,
  validateDecision,
} from "./domain";

describe("Helm stream domain", () => {
  test("orders Don decisions before ordinary work", () => {
    const streams = [
      normalizeStream({
        streamId: "later",
        title: "Later",
        ownerBot: "helm",
        priority: 9,
        needsDon: false,
      }),
      normalizeStream({
        streamId: "don",
        title: "Don",
        ownerBot: "helm",
        priority: 2,
        needsDon: true,
      }),
    ];
    expect(sortStreams(streams).map((stream) => stream.streamId)).toEqual([
      "don",
      "later",
    ]);
  });

  test("requires stable identifiers and a title", () => {
    expect(() =>
      normalizeStream({ streamId: "", title: "No", ownerBot: "helm" }),
    ).toThrow("streamId");
    expect(() =>
      normalizeStream({ streamId: "ok", title: "", ownerBot: "helm" }),
    ).toThrow("title");
  });

  test("builds the approved Manila webhook contract", () => {
    const payload = buildWebhookPayload({
      streamId: "travel",
      choiceId: "defer",
      value: "Defer",
      freeText: "Tomorrow",
      decisionId: "decision-1",
      now: new Date("2026-09-06T00:00:00.000Z"),
    });
    expect(payload).toEqual({
      stream_id: "travel",
      choice_id: "defer",
      value: "Defer",
      free_text: "Tomorrow",
      timestamp_manila: "2026-09-06T08:00:00+08:00",
      decision_id: "decision-1",
      kind: "decision",
    });
  });

  test("includes correction metadata only for a correction payload", () => {
    expect(
      buildWebhookPayload({
        streamId: "travel",
        choiceId: "send",
        value: "send_draft",
        freeText: "Updated",
        decisionId: "decision-2",
        kind: "correction",
        correctionOf: "decision-1",
        now: new Date("2026-09-06T00:00:00.000Z"),
      }),
    ).toEqual({
      stream_id: "travel",
      choice_id: "send",
      value: "send_draft",
      free_text: "Updated",
      timestamp_manila: "2026-09-06T08:00:00+08:00",
      decision_id: "decision-2",
      kind: "correction",
      correctionOf: "decision-1",
    });
  });

  test("accepts only current choices or nonempty custom text on active streams", () => {
    const stream = normalizeStream({
      streamId: "one",
      title: "One",
      ownerBot: "helm",
    });
    expect(
      validateDecision(stream, {
        choiceId: "send",
        value: "send_draft",
        freeText: "",
      }),
    ).toBeUndefined();
    expect(
      validateDecision(stream, {
        choiceId: "custom",
        value: "custom",
        freeText: "Ask tomorrow",
      }),
    ).toBeUndefined();
    expect(() =>
      validateDecision(stream, {
        choiceId: "send",
        value: "changed",
        freeText: "",
      }),
    ).toThrow("choice");
    expect(() =>
      validateDecision(
        { ...stream, status: "archived" },
        { choiceId: "send", value: "send_draft", freeText: "" },
      ),
    ).toThrow("active");
  });

  test("normalizes context and legacy fields without losing the modern shape", () => {
    const stream = normalizeStream({
      streamId: "context",
      title: "Context",
      ownerBot: "helm",
      about: "Current context",
      timeline: [{ at: "2026-09-05T10:00:00+08:00", text: "Started" }],
      summary: "Distinct summary for list cards",
      history: ["Legacy event"],
      updatedAt: "2026-09-06T01:00:00.000Z",
    });
    expect(stream.about).toBe("Current context");
    expect(stream.summary).toBe("Distinct summary for list cards");
    expect(stream.timeline).toEqual([
      { at: "2026-09-05T10:00:00+08:00", text: "Started" },
      { at: "2026-09-06T01:00:00.000Z", text: "Legacy event" },
    ]);
    expect(stream.history).toEqual(["Started", "Legacy event"]);
  });

  test("keeps about and summary distinct when both are provided", () => {
    const stream = normalizeStream({
      streamId: "split",
      title: "Split",
      ownerBot: "helm",
      about: "Long about body",
      summary: "Short summary",
    });
    expect(stream.about).toBe("Long about body");
    expect(stream.summary).toBe("Short summary");
  });

  test("maps old status values to the visible status hierarchy", () => {
    expect(
      normalizeStream({
        streamId: "attention",
        title: "Attention",
        ownerBot: "helm",
        status: "active",
        needsDon: true,
      }).status,
    ).toBe("needs_decision");
    expect(
      normalizeStream({
        streamId: "work",
        title: "Work",
        ownerBot: "helm",
        status: "active",
        needsDon: false,
      }).status,
    ).toBe("ongoing");
    expect(
      normalizeStream({
        streamId: "later",
        title: "Later",
        ownerBot: "helm",
        status: "deferred",
      }).status,
    ).toBe("no_action");
    expect(
      normalizeStream({
        streamId: "old",
        title: "Old",
        ownerBot: "helm",
        status: "archived",
      }).status,
    ).toBe("no_action");
    expect(
      normalizeStream({
        streamId: "old",
        title: "Old",
        ownerBot: "helm",
        status: "archived",
      }).archived,
    ).toBe(true);
    expect(
      normalizeStream({
        streamId: "hidden",
        title: "Hidden",
        ownerBot: "helm",
        status: "active",
        needsDon: true,
        archived: true,
      }),
    ).toMatchObject({ status: "no_action", needsDon: false, archived: true });
  });

  test("appends timeline entries and exact-dedupes without removing prior events", () => {
    const prior = [{ at: "2026-09-06T00:00:00Z", text: "One" }];
    expect(
      appendTimeline(prior, [
        { at: "2026-09-06T00:00:00Z", text: "One" },
        { at: "2026-09-06T00:01:00Z", text: "Two" },
      ]),
    ).toEqual([
      { at: "2026-09-06T00:00:00Z", text: "One" },
      { at: "2026-09-06T00:01:00Z", text: "Two" },
    ]);
  });

  test("allows one recommended choice and rejects multiple recommendations", () => {
    const stream = normalizeStream({
      streamId: "recommend",
      title: "Recommend",
      ownerBot: "helm",
      choices: [
        { id: "a", label: "A", value: "a", recommended: true },
        { id: "b", label: "B", value: "b" },
      ],
    });
    expect(stream.choices[0]?.recommended).toBe(true);
    expect(() =>
      normalizeStream({
        streamId: "bad-recommend",
        title: "Bad",
        ownerBot: "helm",
        choices: [
          { id: "a", label: "A", value: "a", recommended: true },
          { id: "b", label: "B", value: "b", recommended: true },
        ],
      }),
    ).toThrow("recommended");
  });

  test("groups needs-you streams before elsewhere while preserving priority order", () => {
    const streams = [
      normalizeStream({
        streamId: "later",
        title: "Later",
        ownerBot: "helm",
        status: "ongoing",
        priority: 9,
      }),
      normalizeStream({
        streamId: "need-low",
        title: "Need low",
        ownerBot: "helm",
        status: "needs_decision",
        priority: 1,
      }),
      normalizeStream({
        streamId: "need-high",
        title: "Need high",
        ownerBot: "helm",
        status: "needs_decision",
        priority: 8,
      }),
      normalizeStream({
        streamId: "none",
        title: "None",
        ownerBot: "helm",
        status: "no_action",
        priority: 4,
      }),
    ];
    const grouped = groupStreams(streams);
    expect(grouped.needsYou.map((stream) => stream.streamId)).toEqual([
      "need-high",
      "need-low",
    ]);
    expect(grouped.elsewhere.map((stream) => stream.streamId)).toEqual([
      "later",
      "none",
    ]);
    expect(sortStreams(streams).map((stream) => stream.streamId)).toEqual([
      "need-high",
      "need-low",
      "later",
      "none",
    ]);
  });
});
