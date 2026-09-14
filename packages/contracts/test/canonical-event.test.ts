import { describe, expect, it } from "vitest";
import {
  CanonicalEventEnvelopeSchema,
  CanonicalEventSourceSchema,
  CanonicalEventTypeSchema,
  CanonicalJsonObjectSchema,
  CanonicalJsonValueSchema,
  CanonicalResourceIdSchema,
  CommunicatorIdSchema,
  type CanonicalEventEnvelope,
} from "../src/index";

const EVENT_TYPES = [
  "message.created",
  "message.edited",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "receipt.read",
  "receipt.delivered",
  "typing.started",
  "typing.stopped",
  "attachment.observed",
  "conversation.updated",
  "participant.updated",
  "command.updated",
  "bridge.delivery.updated",
  "replay.tombstone",
  "correction.applied",
  "deletion.tombstone",
] as const;

const EVENT_SOURCES = [
  "live",
  "backfill",
  "command_result",
  "replay",
  "correction",
  "deletion",
] as const;

const validEvent = (
  overrides: Partial<CanonicalEventEnvelope> = {},
): CanonicalEventEnvelope => ({
  schema_version: 1,
  event_id: "$opaque-event:server",
  event_type: "message.created",
  event_source: "live",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  platform: "telegram",
  account_id: "account_human_telegram",
  conversation_id: "conversation_human_one",
  matrix_room_id: "!room:communicator.0000.gold",
  matrix_event_id: "$event:communicator.0000.gold",
  remote_message_id: "remote-message-1",
  occurred_at: "2026-06-07T01:02:03.000Z",
  observed_at: "2026-09-07T01:02:03.000Z",
  payload: {
    nested: { answer: 42, enabled: true },
    sequence: ["first", null, 3.5],
  },
  ...overrides,
});

const withPayload = (payload: unknown): unknown =>
  validEvent({ payload: payload as CanonicalEventEnvelope["payload"] });

const expectRejected = (input: unknown): void => {
  expect(CanonicalEventEnvelopeSchema.safeParse(input).success).toBe(false);
};

const defineOwnKey = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

describe("CanonicalEventEnvelopeSchema", () => {
  it("accepts every locked event type and source with opaque Matrix-shaped IDs", () => {
    for (const event_type of EVENT_TYPES) {
      for (const event_source of EVENT_SOURCES) {
        const result = CanonicalEventEnvelopeSchema.safeParse(
          validEvent({ event_type, event_source }),
        );
        expect(result.success).toBe(true);
      }
    }

    expect(CanonicalEventTypeSchema.options).toEqual(EVENT_TYPES);
    expect(CanonicalEventSourceSchema.options).toEqual(EVENT_SOURCES);
  });

  it("accepts nullable aliases, nested payloads, and old backfill events", () => {
    const input = validEvent({
      event_source: "backfill",
      matrix_room_id: null,
      matrix_event_id: null,
      remote_message_id: null,
      occurred_at: "2026-06-07T01:02:03.000+00:00",
      observed_at: "2026-09-07T01:02:03.000+00:00",
      payload: {
        conversation: {
          participants: [
            { id: "participant_one", role: "human" },
            { id: "participant_two", role: "human" },
          ],
        },
        edits: [{ before: "old", after: "new" }],
      },
    });
    const before = structuredClone(input);

    const result = CanonicalEventEnvelopeSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(before);
      expect(Object.getPrototypeOf(result.data.payload)).toBe(Object.prototype);
      const conversation = result.data.payload.conversation;
      if (
        conversation !== null &&
        typeof conversation === "object" &&
        !Array.isArray(conversation)
      ) {
        expect(Object.getPrototypeOf(conversation)).toBe(Object.prototype);
        const participants = conversation.participants;
        if (Array.isArray(participants)) {
          expect(Object.getPrototypeOf(participants)).toBe(Array.prototype);
        }
      }
    }
    expect(input).toEqual(before);
  });

  it("derives a 128-character resource ID limit without changing the shared ID schema", () => {
    const longId = `tenant_${"a".repeat(200)}`;

    expect(CommunicatorIdSchema.safeParse(longId).success).toBe(true);
    expect(CanonicalResourceIdSchema.safeParse("tenant_pilot").success).toBe(
      true,
    );
    expect(CanonicalResourceIdSchema.safeParse(longId).success).toBe(false);
    expect(CanonicalResourceIdSchema.safeParse("tenant_é").success).toBe(false);
  });

  it("rejects unknown, missing, unsupported, and malformed envelope fields", () => {
    expectRejected({ ...validEvent(), unexpected: true });
    const { payload: _payload, ...missingPayload } = validEvent();
    expectRejected(missingPayload);
    expectRejected(validEvent({ schema_version: 2 as 1 }));
    expectRejected(
      validEvent({ platform: "signal" as CanonicalEventEnvelope["platform"] }),
    );
    expectRejected(
      validEvent({
        event_type: "message.sent" as CanonicalEventEnvelope["event_type"],
      }),
    );
    expectRejected(
      validEvent({
        event_source: "provider" as CanonicalEventEnvelope["event_source"],
      }),
    );
    expectRejected(validEvent({ tenant_id: "tenant" }));
    expectRejected(validEvent({ identity_id: "@identity:server" }));
    expectRejected(validEvent({ account_id: "account-telegram" }));
    expectRejected(validEvent({ conversation_id: "conversation" }));
  });

  it("rejects prototype-sensitive own keys on the envelope itself", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const input = validEvent();
      defineOwnKey(input, key, "blocked");
      expectRejected(input);
    }
  });

  it("rejects enumerable accessors without executing their getters", () => {
    const input = validEvent();
    let getterCalls = 0;
    Object.defineProperty(input, "event_id", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("getter fixture must never be exposed");
      },
    });

    let result:
      | ReturnType<typeof CanonicalEventEnvelopeSchema.safeParse>
      | undefined;
    expect(() => {
      result = CanonicalEventEnvelopeSchema.safeParse(input);
    }).not.toThrow();
    expect(result?.success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("snapshots a Proxy without invoking its get trap", () => {
    let getCalls = 0;
    const input = new Proxy(validEvent(), {
      get: () => {
        getCalls += 1;
        throw new Error("proxy get fixture must never be exposed");
      },
    });

    let result:
      | ReturnType<typeof CanonicalEventEnvelopeSchema.safeParse>
      | undefined;
    expect(() => {
      result = CanonicalEventEnvelopeSchema.safeParse(input);
    }).not.toThrow();
    expect(result?.success).toBe(true);
    expect(getCalls).toBe(0);
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"] as const)(
    "rejects a Proxy whose %s inspection trap throws without leaking the raw error",
    (trap) => {
      const input = new Proxy(validEvent(), {
        [trap]: () => {
          throw new Error(`proxy ${trap} fixture must be redacted`);
        },
      });

      let result:
        | ReturnType<typeof CanonicalEventEnvelopeSchema.safeParse>
        | undefined;
      expect(() => {
        result = CanonicalEventEnvelopeSchema.safeParse(input);
      }).not.toThrow();
      expect(result?.success).toBe(false);
      expect(
        result?.error?.issues.some((issue) => issue.code === "custom"),
      ).toBe(false);
    },
  );

  it("trims and bounds opaque IDs while preserving distinct Matrix sigils", () => {
    const trimmed = CanonicalEventEnvelopeSchema.parse(
      validEvent({
        event_id: "  opaque-id  ",
        remote_message_id: "  remote-id  ",
      }),
    );
    expect(trimmed.event_id).toBe("opaque-id");
    expect(trimmed.remote_message_id).toBe("remote-id");

    expectRejected(validEvent({ event_id: "   " }));
    expectRejected(validEvent({ event_id: "e".repeat(1025) }));
    expectRejected(validEvent({ remote_message_id: "   " }));
    expectRejected(validEvent({ matrix_room_id: "room:server" }));
    expectRejected(validEvent({ matrix_room_id: "$room:server" }));
    expectRejected(validEvent({ matrix_event_id: "event:server" }));
    expectRejected(validEvent({ matrix_event_id: "!event:server" }));
    expectRejected(validEvent({ matrix_room_id: `!${"r".repeat(1024)}` }));
    expectRejected(validEvent({ matrix_event_id: `$${"e".repeat(1024)}` }));
  });

  it("requires offset-bearing valid timestamps capped at 64 characters", () => {
    expectRejected(validEvent({ occurred_at: "2026-09-07T01:02:03.000" }));
    expectRejected(validEvent({ observed_at: "not-a-timestamp" }));
    expectRejected(validEvent({ occurred_at: "2026-02-30T01:02:03.000Z" }));
    expectRejected(validEvent({ observed_at: `${"2".repeat(65)}Z` }));
  });
});

describe("CanonicalJsonValueSchema", () => {
  it("accepts JSON-safe scalar values and rejects non-object roots in the payload variant", () => {
    for (const value of [null, true, false, "text", 0, -1, 1.5]) {
      expect(CanonicalJsonValueSchema.safeParse(value).success).toBe(true);
    }

    expect(CanonicalJsonObjectSchema.safeParse("not-an-object").success).toBe(
      false,
    );
    expect(CanonicalJsonObjectSchema.safeParse(null).success).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["bigint", BigInt(1)],
    ["date", new Date("2026-09-07T00:00:00.000Z")],
    ["map", new Map([["key", "value"]])],
    ["set", new Set(["value"])],
    ["function", () => "value"],
    ["symbol", Symbol("value")],
    [
      "class instance",
      new (class PayloadClass {
        value = 1;
      })(),
    ],
  ])("rejects %s payload values", (_name, value) => {
    expectRejected(withPayload({ bad: value }));
  });

  it("rejects sparse arrays and does not mutate payload input", () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    expectRejected(withPayload({ sparse }));

    const input = validEvent();
    const before = structuredClone(input);
    expect(CanonicalEventEnvelopeSchema.safeParse(input).success).toBe(true);
    expect(input).toEqual(before);
  });

  it("rejects direct and indirect cycles without throwing or leaking RangeError", () => {
    const direct: Record<string, unknown> = {};
    direct.self = direct;
    let directResult:
      | ReturnType<typeof CanonicalEventEnvelopeSchema.safeParse>
      | undefined;
    expect(() => {
      directResult = CanonicalEventEnvelopeSchema.safeParse(
        withPayload({ direct }),
      );
    }).not.toThrow();
    expect(directResult?.success).toBe(false);

    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = {};
    first.second = second;
    second.first = first;
    let indirectResult:
      | ReturnType<typeof CanonicalEventEnvelopeSchema.safeParse>
      | undefined;
    expect(() => {
      indirectResult = CanonicalEventEnvelopeSchema.safeParse(
        withPayload({ first }),
      );
    }).not.toThrow();
    expect(indirectResult?.success).toBe(false);
    expect(
      indirectResult?.error?.issues.some((issue) => issue.code === "custom"),
    ).toBe(true);
  });

  it("rejects prototype-sensitive own keys at every object depth", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const root = {};
      defineOwnKey(root, key, "blocked");
      expectRejected(withPayload(root));

      const nested = {};
      defineOwnKey(nested, key, "blocked");
      expectRejected(withPayload({ nested }));

      const nullPrototype = Object.create(null) as Record<string, unknown>;
      defineOwnKey(nullPrototype, key, "blocked");
      expectRejected(withPayload({ nullPrototype }));
    }
  });

  it("rejects unsupported prototypes, excessive depth, nodes, and collection entries", () => {
    expectRejected(
      withPayload({ customPrototype: Object.create({ inherited: true }) }),
    );

    let deep: unknown = "leaf";
    for (let index = 0; index < 33; index += 1) {
      deep = { child: deep };
    }
    expectRejected(withPayload(deep));

    const makeWideTree = (levels: number): unknown => {
      if (levels === 0) return 1;
      return {
        left: makeWideTree(levels - 1),
        right: makeWideTree(levels - 1),
      };
    };
    expectRejected(withPayload(makeWideTree(16)));

    const tooManyEntries: Record<string, number> = {};
    for (let index = 0; index <= 10_000; index += 1) {
      tooManyEntries[`entry_${index}`] = index;
    }
    expectRejected(withPayload(tooManyEntries));
  });

  it("rejects oversized object keys and individual strings", () => {
    const longKey: Record<string, number> = {};
    longKey["k".repeat(257)] = 1;
    expectRejected(withPayload(longKey));
    expectRejected(withPayload({ text: "x".repeat(1024 * 1024 + 1) }));
  });
});
