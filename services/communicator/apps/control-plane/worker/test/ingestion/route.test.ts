import { env as runtimeEnv } from "cloudflare:workers";
import type {
  CommittedArchivePointer,
  IngestionBatchRequest,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import {
  CommittedArchivePointerSchema,
  MAX_INGESTION_REQUEST_BYTES,
  MAX_INGESTION_QUEUE_POINTER_BYTES,
} from "@communicator/contracts";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import {
  readBoundedRequestBody,
  type IngestionQueueSender,
} from "../../ingestion/route";
import { canonicalJsonBytes } from "../../archive/canonical-json";
import { encodeCanonicalEventBatch, sha256Hex } from "../../archive/codec";
import { deriveArchiveKeys } from "../../archive/keys";
import { clearDirectory, seedDirectory } from "../support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & {
  CONTROL_DB: D1Database;
  EVENT_ARCHIVE: R2Bucket;
};
const ISSUER = "https://ingestion.example/";
const SERVICE_SUBJECT = "service-subject";
const SERVICE_TOKEN_ID = "route-test-token";
const TIMESTAMP = "2026-08-29T00:00:00.000Z";
const TENANT_ID = "tenant_pilot";
const ROUTE_ID = "gateway_route_human";
const ACCOUNT_ID = "account_human_whatsapp";

const requestEnvironment = (overrides: Record<string, unknown> = {}) => {
  const value = Object.create(env) as Record<string, unknown>;
  Object.defineProperty(value, "COMMUNICATOR_INGRESS_ENABLED", {
    enumerable: true,
    value: "true",
  });
  for (const [key, override] of Object.entries(overrides)) {
    Object.defineProperty(value, key, { enumerable: true, value: override });
  }
  return value as unknown as Cloudflare.Env;
};

const eventFor = (
  index: number,
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  ({
    schema_version: 1,
    event_id: `$route-${index}:server`,
    event_type: "message.created",
    event_source: "live",
    tenant_id: TENANT_ID,
    identity_id: "identity_human",
    platform: "whatsapp",
    account_id: ACCOUNT_ID,
    conversation_id: `conversation_route_${index}`,
    matrix_room_id: "!route-room:server",
    matrix_event_id: `$matrix-route-${index}:server`,
    remote_message_id: `remote-route-${index}`,
    occurred_at: `2026-08-29T01:00:${String(index % 60).padStart(2, "0")}.000Z`,
    observed_at: `2026-08-29T01:00:${String(index % 60).padStart(2, "0")}.500Z`,
    payload: {
      message_id: `message_route_${index}`,
      direction: "inbound",
      sender_participant_id: null,
      sender_label: "Route test",
      body: "",
      reply_to_message_id: null,
      delivery_status: "unknown",
      unread: true,
    },
    ...overrides,
  }) as ProjectionEventEnvelope;

const batchIdFor = async (
  request: Omit<IngestionBatchRequest, "batch_id">,
  canonicalSha256: string,
): Promise<string> => {
  const identity = Object.create(null) as Record<string, unknown>;
  identity.schema_version = request.schema_version;
  identity.tenant_id = request.tenant_id;
  identity.gateway_route_id = request.gateway_route_id;
  identity.canonical_sha256 = canonicalSha256;
  identity.source_checkpoint = {
    kind: request.source_checkpoint.kind,
    value: request.source_checkpoint.value,
  };
  identity.archived_at = request.archived_at;
  identity.producer_version = request.producer_version;
  return `batch_${await sha256Hex(canonicalJsonBytes(identity))}`;
};

const requestFor = async (
  events: ProjectionEventEnvelope[],
  overrides: Partial<Omit<IngestionBatchRequest, "batch_id" | "events">> = {},
): Promise<IngestionBatchRequest> => {
  const requestWithoutBatch = {
    schema_version: 1 as const,
    gateway_route_id: ROUTE_ID,
    tenant_id: TENANT_ID,
    archived_at: "2026-08-29T02:00:00.000Z",
    producer_version: "gateway-route-test",
    source_checkpoint: {
      kind: "matrix_sync_token_sha256" as const,
      value: `sha256:${"a".repeat(64)}`,
    },
    ...overrides,
    events,
  };
  const encoded = await encodeCanonicalEventBatch({
    tenantId: requestWithoutBatch.tenant_id,
    events,
  });
  return {
    ...requestWithoutBatch,
    batch_id: await batchIdFor(requestWithoutBatch, encoded.canonicalSha256),
  };
};

const seedRouteDirectory = async () => {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "principal_route_service",
      ISSUER,
      SERVICE_SUBJECT,
      "service",
      "Route service",
      "active",
      TIMESTAMP,
      TIMESTAMP,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      ROUTE_ID,
      "principal_route_service",
      "active",
      TIMESTAMP,
      TIMESTAMP,
      null,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at, retired_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      ACCOUNT_ID,
      "connection_human_whatsapp",
      "active",
      TIMESTAMP,
      TIMESTAMP,
      null,
    ),
  ]);
};

const createTestApp = (sendIngestionQueue?: IngestionQueueSender) =>
  createApp({
    createIngestionTokenVerifier: () => ({
      verify: async () => ({
        issuer: ISSUER,
        subject: SERVICE_SUBJECT,
        token_id: SERVICE_TOKEN_ID,
      }),
    }),
    ...(sendIngestionQueue === undefined ? {} : { sendIngestionQueue }),
  });

const postBatch = async (
  request: IngestionBatchRequest,
  sendIngestionQueue?: IngestionQueueSender,
  overrides: Record<string, unknown> = {},
) =>
  createTestApp(sendIngestionQueue).request(
    "https://example.test/internal/v1/ingestion/batches",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer route-test-token",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(request),
    },
    requestEnvironment(overrides),
  );

const postRaw = async (
  body: BodyInit | null,
  sendIngestionQueue?: IngestionQueueSender,
  headers: Record<string, string> = {
    Authorization: "Bearer route-test-token",
    "Content-Type": "application/json",
  },
  overrides: Record<string, unknown> = {},
) =>
  createTestApp(sendIngestionQueue).request(
    "https://example.test/internal/v1/ingestion/batches",
    {
      method: "POST",
      headers,
      body,
    },
    requestEnvironment(overrides),
  );

const deleteArchiveTenant = async (tenantId: string) => {
  for (const prefix of [`events/${tenantId}/`, `manifests/${tenantId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await env.EVENT_ARCHIVE.list({
        prefix,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.objects.length > 0) {
        await env.EVENT_ARCHIVE.delete(
          page.objects.map((object) => object.key),
        );
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }
};

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await seedRouteDirectory();
});

afterEach(async () => {
  await Promise.all([
    deleteArchiveTenant(TENANT_ID),
    deleteArchiveTenant("tenant_other"),
  ]);
});

describe("bounded ingestion request body", () => {
  it("cancels a chunked stream as soon as observed bytes exceed 32 MiB", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_INGESTION_REQUEST_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readBoundedRequestBody(
        new Request("https://example.test/internal/v1/ingestion/batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      ),
    ).rejects.toMatchObject({ code: "ingestion_too_large" });
    expect(cancelled).toBe(true);
  });

  it("accepts exactly 32 MiB and rejects an over-ceiling declared length before reading", async () => {
    const exact = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_INGESTION_REQUEST_BYTES));
        controller.close();
      },
    });
    await expect(
      readBoundedRequestBody(
        new Request("https://example.test/internal/v1/ingestion/batches", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(MAX_INGESTION_REQUEST_BYTES),
          },
          body: exact,
        }),
      ),
    ).resolves.toHaveLength(MAX_INGESTION_REQUEST_BYTES);

    const overDeclared = new ReadableStream<Uint8Array>({
      pull() {},
    });
    await expect(
      readBoundedRequestBody(
        new Request("https://example.test/internal/v1/ingestion/batches", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(MAX_INGESTION_REQUEST_BYTES + 1),
          },
          body: overDeclared,
        }),
      ),
    ).rejects.toMatchObject({ code: "ingestion_too_large" });

    let declaredCancelled = false;
    const declaredBody = new ReadableStream<Uint8Array>({
      cancel() {
        declaredCancelled = true;
      },
    });
    await expect(
      readBoundedRequestBody(
        new Request("https://example.test/internal/v1/ingestion/batches", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(MAX_INGESTION_REQUEST_BYTES + 1),
          },
          body: declaredBody,
        }),
      ),
    ).rejects.toMatchObject({ code: "ingestion_too_large" });
    expect(declaredCancelled).toBe(true);
  });

  it("accepts only JSON with optional UTF-8 and identity encoding", async () => {
    for (const headers of [
      {},
      { "Content-Type": "text/plain" },
      { "Content-Type": "application/json; charset=latin1" },
      {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
    ]) {
      const response = new Request(
        "https://example.test/internal/v1/ingestion/batches",
        {
          method: "POST",
          headers,
          body: "{}",
        },
      );
      await expect(readBoundedRequestBody(response)).rejects.toMatchObject({
        code: "ingestion_invalid",
      });
    }
  });

  it("accepts only a single exact UTF-8 charset parameter", async () => {
    for (const contentType of [
      'application/json; charset="utf-8',
      'application/json; charset=utf-8"',
      "application/json; charset=utf-8; profile=extra",
      'application/json; charset="utf-8"; profile=extra',
    ]) {
      await expect(
        readBoundedRequestBody(
          new Request("https://example.test/internal/v1/ingestion/batches", {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: "{}",
          }),
        ),
      ).rejects.toMatchObject({ code: "ingestion_invalid" });
    }

    for (const contentType of [
      "APPLICATION/JSON",
      "application/json ; CHARSET = utf-8",
      'Application/Json; charset = "UTF-8"',
    ]) {
      await expect(
        readBoundedRequestBody(
          new Request("https://example.test/internal/v1/ingestion/batches", {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: "{}",
          }),
        ),
      ).resolves.toEqual(new TextEncoder().encode("{}"));
    }
  });

  it("writes fragmented chunks directly into bounded storage", async () => {
    const chunks = [
      new TextEncoder().encode('{"fragmented":'),
      new TextEncoder().encode("true"),
      new TextEncoder().encode("}"),
    ];
    for (const chunk of chunks) {
      Object.defineProperty(chunk, "slice", {
        configurable: true,
        value: () => {
          throw new Error("per-chunk copy should not be required");
        },
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    await expect(
      readBoundedRequestBody(
        new Request("https://example.test/internal/v1/ingestion/batches", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(
              chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
            ),
          },
          body,
        }),
      ),
    ).resolves.toEqual(new TextEncoder().encode('{"fragmented":true}'));
  });

  it("returns an exact-sized buffer for a small unknown-length fragmented body", async () => {
    const chunks = [
      new TextEncoder().encode('{"unknown":'),
      new TextEncoder().encode("true}"),
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const result = await readBoundedRequestBody(
      new Request("https://example.test/internal/v1/ingestion/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );

    expect(result).toEqual(new TextEncoder().encode('{"unknown":true}'));
    expect(result.buffer.byteLength).toBe(result.byteLength);
  });
});

describe("POST /internal/v1/ingestion/batches", () => {
  it("archives first, sends the exact verified pointer, then returns 202", async () => {
    const sent: Array<{ pointer: unknown; options: unknown }> = [];
    const request = await requestFor([eventFor(1)]);
    const response = await postBatch(request, async (pointer, options) => {
      sent.push({ pointer, options });
    });

    expect(response.status).toBe(202);
    const accepted = await response.json();
    expect(accepted).toMatchObject({
      schema_version: 1,
      tenant_id: TENANT_ID,
      batch_id: request.batch_id,
      status: "accepted",
      archive_status: "created",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({ contentType: "json" });
    expect(sent[0]?.pointer).toMatchObject({
      schema_version: 1,
      kind: "archive.batch.committed",
      tenant_id: TENANT_ID,
      batch_id: request.batch_id,
      gateway_route_id: ROUTE_ID,
    });

    const pointer = CommittedArchivePointerSchema.parse(
      sent[0]!.pointer,
    ) as CommittedArchivePointer;
    expect(canonicalJsonBytes(pointer).byteLength).toBeLessThanOrEqual(
      MAX_INGESTION_QUEUE_POINTER_BYTES,
    );
    const pointerText = JSON.stringify(pointer);
    expect(pointerText).not.toContain("message");
    expect(pointerText).not.toContain("matrix");
    expect(pointerText).not.toContain("source_checkpoint");
    expect(await env.EVENT_ARCHIVE.get(pointer.manifest_key)).not.toBeNull();
    const acceptedText = JSON.stringify(accepted);
    expect(acceptedText).not.toContain("manifest_key");
    expect(acceptedText).not.toContain("canonical_sha256");
  });

  it("defaults to the environment Queue binding with JSON content type", async () => {
    const sends: Array<{ pointer: unknown; options: unknown }> = [];
    const queue = {
      send: async (pointer: unknown, options: unknown) => {
        sends.push({ pointer, options });
      },
    } as unknown as Queue;
    const request = await requestFor([eventFor(14)]);
    const response = await postBatch(request, undefined, {
      INGESTION_QUEUE: queue,
    });
    expect(response.status).toBe(202);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options).toEqual({ contentType: "json" });
    expect(
      CommittedArchivePointerSchema.safeParse(sends[0]?.pointer).success,
    ).toBe(true);
  });

  it("accepts escaped Unicode and control-heavy JSON through the UTF-8 boundary", async () => {
    const request = await requestFor([
      eventFor(8, {
        payload: {
          message_id: "message_route_escaped",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "\u0000\u001f é 😀",
          body: "line\n\t\u0000 é 😀",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: true,
        },
      }),
    ]);
    const response = await postBatch(request, async () => undefined);
    expect(response.status).toBe(202);
  });

  it.each([
    [{}, 400],
    [{ "Content-Type": "text/plain" }, 400],
    [{ "Content-Type": "application/json; charset=iso-8859-1" }, 400],
    [{ "Content-Type": "application/json", "Content-Encoding": "gzip" }, 400],
    [
      {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_INGESTION_REQUEST_BYTES + 1),
      },
      413,
    ],
  ] as const)(
    "rejects an invalid transport header before archive or Queue I/O",
    async (headers, status) => {
      const request = await requestFor([eventFor(9)]);
      const send = async () => {
        throw new Error("Queue should not be called");
      };
      const response = await postRaw(JSON.stringify(request), send, {
        Authorization: "Bearer route-test-token",
        ...headers,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        error: {
          code: status === 413 ? "ingestion_too_large" : "ingestion_invalid",
        },
      });
      expect(
        (await env.EVENT_ARCHIVE.list({ prefix: `events/${TENANT_ID}/` }))
          .objects,
      ).toHaveLength(0);
      expect(
        (await env.EVENT_ARCHIVE.list({ prefix: "events/tenant_other/" }))
          .objects,
      ).toHaveLength(0);
    },
  );

  it("maps canonical archive overflow to 413 before any R2 or Queue write", async () => {
    const oversizedEvents = Array.from({ length: 500 }, (_, index) =>
      eventFor(index, {
        payload: {
          message_id: `message_route_large_${index}`,
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Route test",
          body: "x".repeat(20_000),
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: true,
        },
      }),
    );
    const request: IngestionBatchRequest = {
      schema_version: 1,
      gateway_route_id: ROUTE_ID,
      tenant_id: TENANT_ID,
      batch_id: `batch_${"a".repeat(64)}`,
      archived_at: "2026-08-29T02:00:00.000Z",
      producer_version: "gateway-route-test",
      source_checkpoint: {
        kind: "matrix_sync_token_sha256",
        value: `sha256:${"a".repeat(64)}`,
      },
      events: oversizedEvents,
    };
    const send = async () => {
      throw new Error("Queue should not be called");
    };
    const response = await postBatch(request, send);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "ingestion_too_large" },
    });
    expect(
      (await env.EVENT_ARCHIVE.list({ prefix: `events/${TENANT_ID}/` }))
        .objects,
    ).toHaveLength(0);
    expect(
      (await env.EVENT_ARCHIVE.list({ prefix: "events/tenant_other/" }))
        .objects,
    ).toHaveLength(0);
  });

  it("returns 409 and does not overwrite a conflicting immutable data object", async () => {
    const request = await requestFor([eventFor(11)]);
    const encoded = await encodeCanonicalEventBatch({
      tenantId: TENANT_ID,
      events: request.events,
    });
    const keys = deriveArchiveKeys(
      TENANT_ID,
      request.batch_id,
      request.events[0]!.observed_at,
    );
    await env.EVENT_ARCHIVE.put(keys.dataKey, new Uint8Array([0, 1, 2]), {
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      customMetadata: {
        "schema-version": "1",
        "tenant-id": TENANT_ID,
        "batch-id": request.batch_id,
        "canonical-sha256": encoded.canonicalSha256,
      },
    });
    const send = async () => {
      throw new Error("Queue should not be called");
    };
    const response = await postBatch(request, send);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "ingestion_conflict" },
    });
    expect(await env.EVENT_ARCHIVE.get(keys.dataKey)).not.toBeNull();
    expect(
      (await env.EVENT_ARCHIVE.list({ prefix: `manifests/${TENANT_ID}/` }))
        .objects,
    ).toHaveLength(0);
  });

  it("rejects an identity mismatch before any archive or Queue write", async () => {
    const send = async () => {
      throw new Error("Queue should not be called");
    };
    const request = await requestFor([
      eventFor(1, { identity_id: "identity_agent" }),
    ]);
    const response = await postBatch(request, send);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "ingestion_not_found",
        message: "Ingestion resource not found",
      },
    });
    expect(
      (await env.EVENT_ARCHIVE.list({ prefix: `events/${TENANT_ID}/` }))
        .objects,
    ).toHaveLength(0);
  });

  it.each([
    ["malformed JSON", "{", "ingestion_invalid"],
    [
      "unknown request field",
      JSON.stringify({ unexpected: true }),
      "ingestion_invalid",
    ],
  ] as const)(
    "rejects %s before archive or Queue I/O",
    async (_name, body, code) => {
      const send = async () => {
        throw new Error("Queue should not be called");
      };
      const response = await postRaw(body, send);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(
        (await env.EVENT_ARCHIVE.list({ prefix: `events/${TENANT_ID}/` }))
          .objects,
      ).toHaveLength(0);
    },
  );

  it("rejects a mismatched caller batch ID before any archive or Queue write", async () => {
    const request = await requestFor([eventFor(4)]);
    const send = async () => {
      throw new Error("Queue should not be called");
    };
    const response = await postRaw(
      JSON.stringify({ ...request, batch_id: `batch_${"f".repeat(64)}` }),
      send,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "ingestion_invalid",
        message: "Invalid ingestion request",
      },
    });
    expect(
      (await env.EVENT_ARCHIVE.list({ prefix: `events/${TENANT_ID}/` }))
        .objects,
    ).toHaveLength(0);
  });

  it.each([
    ["cross tenant", { tenant_id: "tenant_other" }],
    ["unknown account", { account_id: "account_other" }],
    ["platform mismatch", { platform: "telegram" }],
  ] as const)(
    "denies %s before archive or Queue I/O",
    async (_name, eventChange) => {
      const changedTenant =
        "tenant_id" in eventChange ? eventChange.tenant_id : undefined;
      const request = await requestFor(
        [eventFor(5, eventChange as Partial<ProjectionEventEnvelope>)],
        changedTenant === undefined ? {} : { tenant_id: changedTenant },
      );
      const send = async () => {
        throw new Error("Queue should not be called");
      };
      const response = await postBatch(request, send);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "ingestion_not_found" },
      });
      expect(
        (await env.EVENT_ARCHIVE.list({ prefix: `events/${TENANT_ID}/` }))
          .objects,
      ).toHaveLength(0);
      if (changedTenant !== undefined) {
        expect(
          (await env.EVENT_ARCHIVE.list({ prefix: `events/${changedTenant}/` }))
            .objects,
        ).toHaveLength(0);
      }
    },
  );

  it("returns 503 after a Queue failure and retries the exact committed archive", async () => {
    const request = await requestFor([eventFor(2)]);
    let firstPointer: unknown;
    const first = await postBatch(request, async (pointer) => {
      firstPointer = pointer;
      throw new Error("Queue outage canary");
    });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: {
        code: "ingestion_unavailable",
        message: "Ingestion service is unavailable",
      },
    });

    let retryPointer: unknown;
    const retry = await postBatch(request, async (pointer) => {
      retryPointer = pointer;
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      archive_status: "already_committed",
    });
    expect(retryPointer).toBeDefined();
    expect(retryPointer).toEqual(firstPointer);
    expect(retryPointer).toMatchObject({
      tenant_id: TENANT_ID,
      batch_id: request.batch_id,
      gateway_route_id: ROUTE_ID,
    });
  });

  it("keeps an exact duplicate ingress to one immutable R2 pair while resending a pointer", async () => {
    const request = await requestFor([eventFor(12)]);
    const pointers: CommittedArchivePointer[] = [];
    const send = async (pointer: CommittedArchivePointer) => {
      pointers.push(pointer);
    };
    const first = await postBatch(request, send);
    const second = await postBatch(request, send);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      archive_status: "already_committed",
    });
    expect(pointers).toHaveLength(2);
    expect(pointers[1]).toEqual(pointers[0]);
    const keys = [
      ...(await env.EVENT_ARCHIVE.list({ prefix: `events/${TENANT_ID}/` }))
        .objects,
      ...(await env.EVENT_ARCHIVE.list({ prefix: `manifests/${TENANT_ID}/` }))
        .objects,
    ];
    expect(keys).toHaveLength(2);
  });

  it("denies an inactive route before any R2 or Queue work", async () => {
    await env.CONTROL_DB.prepare(
      "UPDATE gateway_routes SET status = 'disabled' WHERE id = ?",
    )
      .bind(ROUTE_ID)
      .run();
    const request = await requestFor([eventFor(13)]);
    const send = async () => {
      throw new Error("Queue should not be called");
    };
    const response = await postBatch(request, send);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "ingestion_not_found" },
    });
    expect(
      (await env.EVENT_ARCHIVE.list({ prefix: `events/${TENANT_ID}/` }))
        .objects,
    ).toHaveLength(0);
  });

  it("does not return 202 until the injected Queue sender fulfills", async () => {
    const request = await requestFor([eventFor(6)]);
    let resolveSend!: () => void;
    let sendStarted = false;
    const send = async () => {
      sendStarted = true;
      await new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
    };
    const pending = postBatch(request, send);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendStarted).toBe(true);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    resolveSend();
    const response = await pending;
    expect(response.status).toBe(202);
  });

  it.each(["data-put", "data-read", "manifest-put", "manifest-read"] as const)(
    "maps %s archive-stage failure to 503 without Queue send",
    async (stage) => {
      const original = env.EVENT_ARCHIVE;
      const failingBucket = {
        put: async (key: string, value: unknown, options?: R2PutOptions) => {
          if (
            (stage === "data-put" && key.startsWith("events/")) ||
            (stage === "manifest-put" && key.startsWith("manifests/"))
          ) {
            throw new Error(`archive ${stage} canary`);
          }
          return original.put(key, value as ArrayBufferView, options);
        },
        get: async (key: string) => {
          if (
            (stage === "data-read" && key.startsWith("events/")) ||
            (stage === "manifest-read" && key.startsWith("manifests/"))
          ) {
            throw new Error(`archive ${stage} canary`);
          }
          return original.get(key);
        },
      } as unknown as R2Bucket;
      const send = async () => {
        throw new Error("Queue should not be called");
      };
      const request = await requestFor([eventFor(3)]);
      const response = await postBatch(request, send, {
        EVENT_ARCHIVE: failingBucket,
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "ingestion_unavailable" },
      });
    },
  );
});
