import { describe, expect, it } from "vitest";
import {
  ArchiveError,
  decodeCanonicalJsonl,
  encodeCanonicalEventBatch,
  gunzipBytes,
  gzipBytes,
  sha256Hex,
} from "../../archive/codec";
import {
  cloneEvents,
  makeEvent,
  makeEvents,
  nestedPayload,
  OTHER_TENANT_ID,
  TENANT_ID,
} from "./support";
import {
  CanonicalEventEnvelopeSchema,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_CANONICAL_JSON_DEPTH,
} from "@communicator/contracts";

const getError = async (operation: Promise<unknown>): Promise<ArchiveError> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return error as ArchiveError;
  }
  throw new Error("operation unexpectedly succeeded");
};

describe("archive codec", () => {
  it("serializes and decodes an event at the exact payload depth boundary", async () => {
    const event = makeEvent({ payload: nestedPayload(MAX_CANONICAL_JSON_DEPTH) });
    expect(CanonicalEventEnvelopeSchema.safeParse(event).success).toBe(true);

    const encoded = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: [event] });
    await expect(
      decodeCanonicalJsonl(encoded.canonicalJsonl, { tenantId: TENANT_ID }),
    ).resolves.toHaveLength(1);

    const tooDeep = makeEvent({ payload: nestedPayload(MAX_CANONICAL_JSON_DEPTH + 1) });
    expect(CanonicalEventEnvelopeSchema.safeParse(tooDeep).success).toBe(false);
    await expect(encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: [tooDeep] })).rejects.toMatchObject({
      code: "archive_invalid",
    });
  });

  it("sorts by observed instant, occurred instant, then event ID and terminates JSONL with one newline", async () => {
    const events = [
      makeEvent({
        event_id: "$z:server",
        occurred_at: "2026-09-07T00:00:02.000Z",
        observed_at: "2026-09-07T01:00:00.000+01:00",
      }),
      makeEvent({
        event_id: "$a:server",
        occurred_at: "2026-09-07T00:00:01.000Z",
        observed_at: "2026-09-07T00:00:00.000Z",
      }),
      makeEvent({
        event_id: "$b:server",
        occurred_at: "2026-09-07T00:00:01.000Z",
        observed_at: "2026-09-07T00:00:00.000Z",
      }),
    ];
    const before = cloneEvents(events);

    const encoded = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events });

    expect(encoded.events.map((event) => event.event_id)).toEqual([
      "$a:server",
      "$b:server",
      "$z:server",
    ]);
    expect(encoded.canonicalJsonl.at(-1)).toBe(0x0a);
    expect(new TextDecoder().decode(encoded.canonicalJsonl).split("\n").at(-1)).toBe("");
    expect(events).toEqual(before);
    expect(encoded.uncompressedBytes).toBe(encoded.canonicalJsonl.byteLength);
    expect(encoded.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalizes payload insertion order and hashes uncompressed bytes", async () => {
    const first = makeEvent({ payload: { z: 2, a: { y: 1, x: 0 } } });
    const second = makeEvent({ payload: { a: { x: 0, y: 1 }, z: 2 } });
    const firstEncoded = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: [first] });
    const secondEncoded = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: [second] });

    expect(firstEncoded.canonicalJsonl).toEqual(secondEncoded.canonicalJsonl);
    expect(firstEncoded.canonicalSha256).toBe(secondEncoded.canonicalSha256);
    expect(firstEncoded.canonicalSha256).toBe(await sha256Hex(firstEncoded.canonicalJsonl));
  });

  it("rejects cross-tenant events and duplicate IDs before any storage exists", async () => {
    const crossTenant = await getError(
      encodeCanonicalEventBatch({
        tenantId: TENANT_ID,
        events: [makeEvent({ tenant_id: OTHER_TENANT_ID })],
      }),
    );
    expect(crossTenant.code).toBe("archive_tenant_mismatch");

    const duplicate = await getError(
      encodeCanonicalEventBatch({
        tenantId: TENANT_ID,
        events: [makeEvent(), makeEvent({ payload: { body: "different fixture" } })],
      }),
    );
    expect(duplicate.code).toBe("archive_invalid");
  });

  it("rejects empty and excessive batches with safe bounds", async () => {
    expect((await getError(encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: [] }))).code)
      .toBe("archive_invalid");
    expect(
      (await getError(encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: makeEvents(501) }))).code,
    ).toBe("archive_too_large");
  });

  it("rejects a canonical event over 1 MiB and cumulative JSONL over 4 MiB", async () => {
    const oversizedEvent = await getError(
      encodeCanonicalEventBatch({
        tenantId: TENANT_ID,
        events: [makeEvent({ payload: { body: "x".repeat(1024 * 1024) } })],
      }),
    );
    expect(oversizedEvent.code).toBe("archive_too_large");

    const largeEvents = makeEvents(5).map((event, index) =>
      makeEvent({
        ...event,
        event_id: `$large-${index}:server`,
        payload: { body: "x".repeat(900_000) },
      }),
    );
    const totalOverflow = await getError(
      encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: largeEvents }),
    );
    expect(totalOverflow.code).toBe("archive_too_large");
  });

  it("round-trips gzip bytes exactly and computes lowercase SHA-256", async () => {
    const encoded = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: makeEvents(2) });
    const compressed = await gzipBytes(encoded.canonicalJsonl);
    const uncompressed = await gunzipBytes(compressed);

    expect(uncompressed).toEqual(encoded.canonicalJsonl);
    expect(compressed.byteLength).toBeGreaterThan(0);
    expect(encoded.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(encoded.canonicalSha256).not.toMatch(/[A-F]/);

    const corrupted = compressed.slice();
    corrupted[Math.floor(corrupted.byteLength / 2)]! ^= 0x01;
    expect((await getError(gunzipBytes(corrupted))).code).toBe("archive_corrupt");
  });

  it("enforces the uncompressed gzip bound before creating a stream", async () => {
    await expect(gzipBytes(new Uint8Array(MAX_ARCHIVE_UNCOMPRESSED_BYTES))).resolves.toBeInstanceOf(
      Uint8Array,
    );
    await expect(gzipBytes(new Uint8Array(MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1))).rejects.toMatchObject({
      code: "archive_too_large",
    });
  });

  it("rejects malformed gzip and invalid UTF-8 as archive_corrupt", async () => {
    const gzipError = await getError(gunzipBytes(new Uint8Array([0x1f, 0x8b, 0x00])));
    expect(gzipError.code).toBe("archive_corrupt");

    const invalidUtf8 = await getError(
      Promise.resolve().then(() => decodeCanonicalJsonl(new Uint8Array([0xff, 0x0a]))),
    );
    expect(invalidUtf8.code).toBe("archive_corrupt");
  });

  it.each([
    ["blank interior line", '{"x":1}\n\n{"x":2}\n'],
    ["absent final newline", '{"x":1}'],
    ["malformed JSON", '{not-json}\n'],
  ])("rejects %s JSONL without leaking body", async (_name, body) => {
    const fixtureBody = `${body}fixture message body`;
    const error = await getError(
      Promise.resolve().then(() => decodeCanonicalJsonl(new TextEncoder().encode(fixtureBody))),
    );
    expect(error.code).toBe("archive_corrupt");
    expect(error.message).not.toContain("fixture message body");
  });

  it("rejects reordered, duplicate, invalid, and wrong-tenant decoded rows", async () => {
    const encoded = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: makeEvents(2) });
    const rows = new TextDecoder().decode(encoded.canonicalJsonl).trimEnd().split("\n");
    const reordered = new TextEncoder().encode(`${rows[1]!}\n${rows[0]!}\n`);
    expect((await getError(Promise.resolve().then(() => decodeCanonicalJsonl(reordered, { tenantId: TENANT_ID })))).code)
      .toBe("archive_corrupt");

    const duplicate = new TextEncoder().encode(`${rows[0]}\n${rows[0]}\n`);
    expect((await getError(Promise.resolve().then(() => decodeCanonicalJsonl(duplicate, { tenantId: TENANT_ID })))).code)
      .toBe("archive_corrupt");

    const wrongTenant = rows[0]!.replace('"tenant_id":"tenant_pilot"', '"tenant_id":"tenant_other"');
    expect(
      (await getError(
        Promise.resolve().then(() =>
          decodeCanonicalJsonl(new TextEncoder().encode(`${wrongTenant}\n`), { tenantId: TENANT_ID }),
        ),
      )).code,
    ).toBe("archive_corrupt");
  });

  it("rejects decoded size overflow while consuming a stream incrementally", async () => {
    const encoded = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: [makeEvent()] });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.canonicalJsonl);
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });
    const error = await getError(
      decodeCanonicalJsonl(stream, { tenantId: TENANT_ID, maxDecodedBytes: encoded.canonicalJsonl.byteLength }),
    );
    expect(error.code).toBe("archive_too_large");
  });

  it("maps locked input streams to safe archive errors", async () => {
    const decodeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x0a]));
        controller.close();
      },
    });
    decodeStream.getReader();
    await expect(decodeCanonicalJsonl(decodeStream)).rejects.toMatchObject({
      code: "archive_corrupt",
    });

    const gzipStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x1f, 0x8b]));
        controller.close();
      },
    });
    gzipStream.getReader();
    await expect(gunzipBytes(gzipStream)).rejects.toMatchObject({
      code: "archive_corrupt",
    });
  });

  it("maps cyclic/prototype-sensitive event inputs to safe archive_invalid errors", async () => {
    const cyclic = makeEvent() as unknown as Record<string, unknown>;
    cyclic.payload = { body: "fixture message body" };
    (cyclic.payload as Record<string, unknown>).self = cyclic.payload;
    const cyclicError = await getError(
      encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: [cyclic] }),
    );
    expect(cyclicError.code).toBe("archive_invalid");
    expect(cyclicError.message).not.toContain("fixture message body");

    const sensitive = makeEvent();
    Object.defineProperty(sensitive.payload, "constructor", {
      configurable: true,
      enumerable: true,
      value: "fixture message body",
    });
    const sensitiveError = await getError(
      encodeCanonicalEventBatch({ tenantId: TENANT_ID, events: [sensitive] }),
    );
    expect(sensitiveError.code).toBe("archive_invalid");
    expect(sensitiveError.message).not.toContain("fixture message body");
  });
});
