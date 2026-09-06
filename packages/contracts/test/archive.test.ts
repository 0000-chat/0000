import { describe, expect, it } from "vitest";
import {
  ArchiveBatchManifestSchema,
  ArchiveDataKeySchema,
  ArchiveManifestKeySchema,
  ArchiveReplayCursorPayloadSchema,
  ArchiveReplayPageSchema,
  CanonicalEventEnvelopeSchema,
  DEFAULT_REPLAY_PAGE_SIZE,
  DEFAULT_MANIFEST_PAGE_SIZE,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_ARCHIVE_EVENTS,
  MAX_ARCHIVE_KEY_CHARS,
  MAX_ARCHIVE_MANIFEST_BYTES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_CHECKPOINT_KIND_CHARS,
  MAX_CHECKPOINT_VALUE_CHARS,
  MAX_MANIFEST_PAGE_SIZE,
  MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES,
  MAX_REPLAY_PAGE_EVENTS,
  MAX_PRODUCER_VERSION_CHARS,
  type ArchiveBatchManifest,
  type ArchiveReplayCursorPayload,
  type ArchiveReplayPage,
  type CanonicalEventEnvelope,
} from "../src/index";

const DATA_KEY = "events/tenant_pilot/2026/09/07/01/batch_01abc.jsonl.gz";
const MANIFEST_KEY = "manifests/tenant_pilot/2026/09/07/01/batch_01abc.json";

const validEvent = (
  overrides: Partial<CanonicalEventEnvelope> = {},
): CanonicalEventEnvelope => ({
  schema_version: 1,
  event_id: "$event-1:server",
  event_type: "message.created",
  event_source: "live",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  platform: "telegram",
  account_id: "account_human_telegram",
  conversation_id: "conversation_human_one",
  matrix_room_id: "!room:server",
  matrix_event_id: "$event:server",
  remote_message_id: "remote-message-1",
  occurred_at: "2026-09-07T01:02:02.000Z",
  observed_at: "2026-09-07T01:02:03.000Z",
  payload: { body: "hello", position: 1 },
  ...overrides,
});

const validManifest = (
  overrides: Partial<ArchiveBatchManifest> = {},
): ArchiveBatchManifest => ({
  schema_version: 1,
  tenant_id: "tenant_pilot",
  batch_id: "batch_01abc",
  data_key: DATA_KEY,
  compression: "gzip",
  content_type: "application/x-ndjson",
  event_count: 1,
  uncompressed_bytes: 512,
  compressed_bytes: 256,
  canonical_sha256: "a".repeat(64),
  data_etag: "etag-123",
  first_event_id: "$event-1:server",
  last_event_id: "$event-1:server",
  first_observed_at: "2026-09-07T01:02:03.000Z",
  last_observed_at: "2026-09-07T01:02:03.000Z",
  archived_at: "2026-09-07T01:03:03.000Z",
  producer: {
    service: "communicator-control-plane",
    version: "2026.09.07",
  },
  source_checkpoint: {
    kind: "telegram-update",
    value: "cursor-001",
  },
  ...overrides,
});

const validCursor = (
  overrides: Partial<ArchiveReplayCursorPayload> = {},
): ArchiveReplayCursorPayload => ({
  schema_version: 1,
  tenant_id: "tenant_pilot",
  manifest_prefix: "manifests/tenant_pilot/",
  r2_cursor: "r2-opaque-cursor",
  ...overrides,
});

const validPage = (
  overrides: Partial<ArchiveReplayPage> = {},
): ArchiveReplayPage => ({
  schema_version: 1,
  replay_mode: "projection_only",
  tenant_id: "tenant_pilot",
  manifests: [validManifest()],
  events: [validEvent()],
  next_cursor: null,
  ...overrides,
});

const expectRejected = (
  schema: { safeParse: (input: unknown) => { success: boolean } },
  input: unknown,
): void => {
  expect(schema.safeParse(input).success).toBe(false);
};

const defineOwnKey = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

describe("archive contract bounds", () => {
  it("exports the locked product bounds", () => {
    expect(MAX_ARCHIVE_EVENTS).toBe(500);
    expect(MAX_ARCHIVE_UNCOMPRESSED_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_ARCHIVE_COMPRESSED_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ARCHIVE_MANIFEST_BYTES).toBe(64 * 1024);
    expect(MAX_ARCHIVE_KEY_CHARS).toBe(512);
    expect(MAX_PRODUCER_VERSION_CHARS).toBe(128);
    expect(MAX_CHECKPOINT_KIND_CHARS).toBe(64);
    expect(MAX_CHECKPOINT_VALUE_CHARS).toBe(512);
    expect(DEFAULT_MANIFEST_PAGE_SIZE).toBe(50);
    expect(MAX_MANIFEST_PAGE_SIZE).toBe(100);
    expect(DEFAULT_REPLAY_PAGE_SIZE).toBe(1);
    expect(MAX_REPLAY_PAGE_EVENTS).toBe(2_000);
    expect(MAX_REPLAY_PAGE_EVENTS).toBe(4 * MAX_ARCHIVE_EVENTS);
    expect(MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES).toBe(8 * 1024 * 1024);
  });

  it("accepts the exact derived data and manifest key shapes", () => {
    expect(ArchiveDataKeySchema.parse(DATA_KEY)).toBe(DATA_KEY);
    expect(ArchiveManifestKeySchema.parse(MANIFEST_KEY)).toBe(MANIFEST_KEY);

    for (const key of [
      "events/tenant_pilot/2026/9/07/01/batch_01abc.jsonl.gz",
      "events/tenant_pilot/2026/09/07/01/batch_01abc.json",
      "events/tenant_pilot/2026/09/07/01/batch_01abc/../other.jsonl.gz",
      "events/tenant_pilot/2026/09/07/01/batch_%2e%2e.jsonl.gz",
      "exports/tenant_pilot/2026-09-07T01:02:03.000Z.jsonl.gz",
      "media/tenant_pilot/content-hash",
      "events/tenant_pilot/2026/13/07/01/batch_01abc.jsonl.gz",
    ]) {
      expectRejected(ArchiveDataKeySchema, key);
      expectRejected(ArchiveManifestKeySchema, key);
    }

    expectRejected(ArchiveDataKeySchema, `x${"a".repeat(MAX_ARCHIVE_KEY_CHARS)}`);
    expectRejected(ArchiveManifestKeySchema, `x${"a".repeat(MAX_ARCHIVE_KEY_CHARS)}`);
  });
});

describe("ArchiveBatchManifestSchema", () => {
  it("accepts the exact valid manifest shape", () => {
    expect(ArchiveBatchManifestSchema.parse(validManifest())).toEqual(validManifest());
  });

  it("rejects unknown fields and wrong version, compression, or content type", () => {
    expectRejected(ArchiveBatchManifestSchema, { ...validManifest(), unexpected: true });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      schema_version: 2,
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      compression: "br",
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      content_type: "application/json",
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      producer: { ...validManifest().producer, unexpected: true },
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      source_checkpoint: {
        ...validManifest().source_checkpoint,
        unexpected: true,
      },
    });
  });

  it("rejects prototype-sensitive own keys in every strict archive object", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const manifest = validManifest();
      defineOwnKey(manifest, key, "blocked");
      expectRejected(ArchiveBatchManifestSchema, manifest);

      const producer = validManifest().producer;
      defineOwnKey(producer, key, "blocked");
      expectRejected(ArchiveBatchManifestSchema, {
        ...validManifest(),
        producer,
      });

      const cursor = validCursor();
      defineOwnKey(cursor, key, "blocked");
      expectRejected(ArchiveReplayCursorPayloadSchema, cursor);

      const page = validPage();
      defineOwnKey(page, key, "blocked");
      expectRejected(ArchiveReplayPageSchema, page);
    }
  });

  it("rejects malformed resource IDs, batch IDs, derived keys, and hashes", () => {
    expectRejected(ArchiveBatchManifestSchema, { ...validManifest(), tenant_id: "tenant" });
    expectRejected(ArchiveBatchManifestSchema, { ...validManifest(), batch_id: "batch" });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      batch_id: "tenant_01abc",
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      data_key: "events/tenant_other/2026/09/07/01/batch_01abc.jsonl.gz",
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      data_key: "events/tenant_pilot/2026/09/07/01/batch_01def.jsonl.gz",
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      canonical_sha256: "A".repeat(64),
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      canonical_sha256: "a".repeat(63),
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      data_key: "events/tenant_pilot/2026/09/07/01/batch_01abc.jsonl.gz\u0000",
    });
  });

  it("enforces event count and positive safe byte bounds", () => {
    for (const event_count of [0, MAX_ARCHIVE_EVENTS + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectRejected(ArchiveBatchManifestSchema, { ...validManifest(), event_count });
    }
    for (const uncompressed_bytes of [
      0,
      MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expectRejected(ArchiveBatchManifestSchema, {
        ...validManifest(),
        uncompressed_bytes,
      });
    }
    for (const compressed_bytes of [
      0,
      MAX_ARCHIVE_COMPRESSED_BYTES + 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expectRejected(ArchiveBatchManifestSchema, {
        ...validManifest(),
        compressed_bytes,
      });
    }
  });

  it("trims and bounds ETags, event IDs, and timestamps", () => {
    const parsed = ArchiveBatchManifestSchema.parse({
      ...validManifest(),
      data_etag: "  etag-123  ",
      first_event_id: "  first  ",
      last_event_id: "  last  ",
    });
    expect(parsed.data_etag).toBe("etag-123");
    expect(parsed.first_event_id).toBe("first");
    expect(parsed.last_event_id).toBe("last");

    expectRejected(ArchiveBatchManifestSchema, { ...validManifest(), data_etag: "   " });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      data_etag: "e".repeat(257),
    });
    expectRejected(ArchiveBatchManifestSchema, { ...validManifest(), first_event_id: "  " });
    expectRejected(ArchiveBatchManifestSchema, { ...validManifest(), last_event_id: "" });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      first_observed_at: "2026-09-07T01:02:03.000",
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      last_observed_at: "not-a-timestamp",
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      archived_at: "2026-09-07T01:03:03.000",
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      archived_at: `${"2".repeat(65)}Z`,
    });
  });

  it("orders observed timestamps by instant, accepting mixed offsets and equality", () => {
    expect(
      ArchiveBatchManifestSchema.safeParse({
        ...validManifest(),
        first_observed_at: "2026-09-07T01:02:03.000Z",
        last_observed_at: "2026-09-07T03:02:03.000+01:00",
      }).success,
    ).toBe(true);
    expect(
      ArchiveBatchManifestSchema.safeParse({
        ...validManifest(),
        first_observed_at: "2026-09-07T02:02:03.000+01:00",
        last_observed_at: "2026-09-07T01:02:03.000Z",
      }).success,
    ).toBe(true);
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      first_observed_at: "2026-09-07T01:02:04.000Z",
      last_observed_at: "2026-09-07T01:02:03.000+00:00",
    });
  });

  it("bounds producer and optional checkpoint values", () => {
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      producer: { service: "other", version: "2026.09.07" },
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      producer: { service: "communicator-control-plane", version: "   " },
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      producer: {
        service: "communicator-control-plane",
        version: "v".repeat(MAX_PRODUCER_VERSION_CHARS + 1),
      },
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      source_checkpoint: { kind: "", value: "cursor-001" },
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      source_checkpoint: {
        kind: "k".repeat(MAX_CHECKPOINT_KIND_CHARS + 1),
        value: "cursor-001",
      },
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      source_checkpoint: { kind: "telegram-update", value: "   " },
    });
    expectRejected(ArchiveBatchManifestSchema, {
      ...validManifest(),
      source_checkpoint: {
        kind: "telegram-update",
        value: "v".repeat(MAX_CHECKPOINT_VALUE_CHARS + 1),
      },
    });
    expect(ArchiveBatchManifestSchema.parse({ ...validManifest(), source_checkpoint: null }).source_checkpoint).toBeNull();
  });
});

describe("ArchiveReplayCursorPayloadSchema", () => {
  it("accepts the tenant-bound cursor payload and rejects unknown fields", () => {
    expect(ArchiveReplayCursorPayloadSchema.parse(validCursor())).toEqual(validCursor());
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      unexpected: true,
    });
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      schema_version: 2,
    });
  });

  it("requires the canonical tenant prefix and bounded opaque R2 cursor", () => {
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      tenant_id: "tenant",
    });
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      manifest_prefix: "manifests/tenant_other/",
    });
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      manifest_prefix: "manifests/tenant_pilot",
    });
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      manifest_prefix: `manifests/tenant_pilot/${"x".repeat(256)}`,
    });
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      manifest_prefix: "manifests/tenant_pilot/%2e%2e/",
    });
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      r2_cursor: "",
    });
    expectRejected(ArchiveReplayCursorPayloadSchema, {
      ...validCursor(),
      r2_cursor: "x".repeat(2049),
    });
  });
});

describe("ArchiveReplayPageSchema", () => {
  it("accepts the projection-only replay page shape", () => {
    expect(ArchiveReplayPageSchema.parse(validPage())).toEqual(validPage());
    expect(ArchiveReplayPageSchema.parse({ ...validPage(), next_cursor: "opaque-next" }).next_cursor).toBe(
      "opaque-next",
    );
  });

  it("rejects unknown fields, wrong versions/mode, and oversized cursors", () => {
    expectRejected(ArchiveReplayPageSchema, { ...validPage(), unexpected: true });
    expectRejected(ArchiveReplayPageSchema, { ...validPage(), schema_version: 2 });
    expectRejected(ArchiveReplayPageSchema, {
      ...validPage(),
      replay_mode: "commands",
    });
    expectRejected(ArchiveReplayPageSchema, {
      ...validPage(),
      next_cursor: "x".repeat(4097),
    });
    expectRejected(ArchiveReplayPageSchema, { ...validPage(), next_cursor: "" });
  });

  it("bounds manifest and event arrays at their locked replay limits", () => {
    const manifest = validManifest();
    const event = validEvent();
    expect(
      ArchiveReplayPageSchema.safeParse({
        ...validPage(),
        manifests: Array(MAX_MANIFEST_PAGE_SIZE).fill(manifest),
      }).success,
    ).toBe(true);
    expectRejected(ArchiveReplayPageSchema, {
      ...validPage(),
      manifests: Array(MAX_MANIFEST_PAGE_SIZE + 1).fill(manifest),
    });

    expect(
      ArchiveReplayPageSchema.safeParse({
        ...validPage(),
        events: Array(2_000).fill(event),
      }).success,
    ).toBe(true);
    expectRejected(ArchiveReplayPageSchema, {
      ...validPage(),
      events: Array(2_001).fill(event),
    });
  });

  it("snapshots replay arrays without invoking getters or Proxy get traps", () => {
    const getterEvents = [validEvent()];
    let getterCalls = 0;
    Object.defineProperty(getterEvents, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("replay array getter fixture must never be exposed");
      },
    });
    let getterResult: ReturnType<typeof ArchiveReplayPageSchema.safeParse> | undefined;
    expect(() => {
      getterResult = ArchiveReplayPageSchema.safeParse({
        ...validPage(),
        events: getterEvents,
      });
    }).not.toThrow();
    expect(getterResult?.success).toBe(false);
    expect(getterCalls).toBe(0);

    let getCalls = 0;
    const proxyEvents = new Proxy([validEvent()], {
      get: () => {
        getCalls += 1;
        throw new Error("replay array Proxy get fixture must never be exposed");
      },
    });
    let proxyResult: ReturnType<typeof ArchiveReplayPageSchema.safeParse> | undefined;
    expect(() => {
      proxyResult = ArchiveReplayPageSchema.safeParse({
        ...validPage(),
        events: proxyEvents,
      });
    }).not.toThrow();
    expect(proxyResult?.success).toBe(true);
    expect(getCalls).toBe(0);
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"] as const)(
    "rejects replay arrays when the %s inspection trap throws",
    (trap) => {
      const proxyEvents = new Proxy([validEvent()], {
        [trap]: () => {
          throw new Error(`replay array ${trap} fixture must be redacted`);
        },
      });
      let result: ReturnType<typeof ArchiveReplayPageSchema.safeParse> | undefined;
      expect(() => {
        result = ArchiveReplayPageSchema.safeParse({
          ...validPage(),
          events: proxyEvents,
        });
      }).not.toThrow();
      expect(result?.success).toBe(false);
    },
  );

  it("rejects manifests and events belonging to another tenant", () => {
    expectRejected(ArchiveReplayPageSchema, {
      ...validPage(),
      manifests: [
        validManifest({
          tenant_id: "tenant_other",
          data_key: "events/tenant_other/2026/09/07/01/batch_01abc.jsonl.gz",
        }),
      ],
    });
    expectRejected(ArchiveReplayPageSchema, {
      ...validPage(),
      events: [validEvent({ tenant_id: "tenant_other" })],
    });
    expectRejected(ArchiveReplayPageSchema, {
      ...validPage(),
      tenant_id: "tenant_other",
    });
  });

  it("reuses strict envelope validation for replay events", () => {
    const event = validEvent();
    expect(CanonicalEventEnvelopeSchema.safeParse(event).success).toBe(true);
    expectRejected(ArchiveReplayPageSchema, {
      ...validPage(),
      events: [{ ...event, unexpected: true }],
    });
  });
});
