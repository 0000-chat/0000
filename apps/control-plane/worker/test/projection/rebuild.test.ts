import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import type {
  ArchiveReplayPage,
  BeginRebuildInput,
  CompleteRebuildInput,
  AbortRebuildInput,
  ApplyReplayPageInput,
  ProjectionAuthorizationContext,
  ProjectionConnectionBinding,
  ProjectionEventEnvelope,
  ProjectionStatus,
} from "@communicator/contracts";
import { REALTIME_SUBPROTOCOL } from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import { TenantProjectionDO } from "../../projection/tenant-projection";
import { deriveManifestPrefix } from "../../archive/keys";
import { encodeReplayCursor } from "../../archive/reader";
import { canonicalJsonStringify } from "../../archive/canonical-json";
import { sha256Hex } from "../../archive/codec";

const DERIVED_TABLES = [
  "resource_tombstones",
  "event_tombstones",
  "reactions",
  "receipts",
  "typing_states",
  "attachments",
  "message_delivery_updates",
  "commands",
  "message_versions",
  "messages",
  "participants",
  "conversations",
  "applied_events",
  "projection_changes",
  "projection_change_floors",
  "projection_checkpoints",
  "projection_identity_sequences",
] as const;

type RebuildRpc = {
  beginRebuild(input: BeginRebuildInput): Promise<ProjectionStatus>;
  completeRebuild(input: CompleteRebuildInput): Promise<ProjectionStatus>;
  abortRebuild(input: AbortRebuildInput): Promise<ProjectionStatus>;
  applyReplayPage(input: ApplyReplayPageInput): Promise<{
    schema_version: 1;
    tenant_id: string;
    generation: number;
    applied_count: number;
    duplicate_count: number;
    last_sequence: number;
  }>;
};

type RebuildStub = DurableObjectStub<TenantProjectionDO> & RebuildRpc;

const asRebuildStub = (
  stub: DurableObjectStub<TenantProjectionDO>,
): RebuildStub => stub as RebuildStub;

const auth = (
  tenant: string,
  scopes: ProjectionAuthorizationContext["scopes"],
  identities: string[] = [],
): ProjectionAuthorizationContext => ({
  schema_version: 1,
  tenant_id: tenant,
  principal_id: "principal_rebuild",
  allowed_identity_ids: [...identities].sort(),
  scopes: [...scopes].sort(),
});

const binding = (
  accountId: string,
  connectionId: string,
  identityId: string,
  platform: ProjectionConnectionBinding["platform"] = "whatsapp",
): ProjectionConnectionBinding => ({
  account_id: accountId,
  connection_id: connectionId,
  identity_id: identityId,
  platform,
});

const tenantCounter = { value: 0 };
const newTenant = (): string => {
  tenantCounter.value += 1;
  return `tenant_rebuild_${tenantCounter.value}`;
};

const eventFor = ({
  tenant,
  eventId,
  identityId = "identity_a",
  accountId = "account_a",
  conversationId = "conversation_a",
  messageId = `message_${eventId.replace(/[^a-z0-9_]/gi, "_")}`,
  observedAt = "2026-09-07T01:00:01.000Z",
  occurredAt = "2026-09-07T01:00:00.000Z",
  body = "replay body",
  eventSource = "replay",
}: {
  tenant: string;
  eventId: string;
  identityId?: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  observedAt?: string;
  occurredAt?: string;
  body?: string;
  eventSource?: ProjectionEventEnvelope["event_source"];
}): ProjectionEventEnvelope => ({
  schema_version: 1,
  event_id: eventId,
  event_type: "message.created",
  event_source: eventSource,
  tenant_id: tenant,
  identity_id: identityId,
  platform: "whatsapp",
  account_id: accountId,
  conversation_id: conversationId,
  matrix_room_id: null,
  matrix_event_id: null,
  remote_message_id: null,
  occurred_at: occurredAt,
  observed_at: observedAt,
  payload: {
    message_id: messageId,
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "Replay sender",
    body,
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: true,
  },
});

const manifestFor = (
  tenant: string,
  batchId: string,
  event: ProjectionEventEnvelope,
  eventCount = 1,
  uncompressedBytes = 1,
) => ({
  schema_version: 1 as const,
  tenant_id: tenant,
  batch_id: batchId,
  data_key: `events/${tenant}/2026/09/07/01/${batchId}.jsonl.gz`,
  compression: "gzip" as const,
  content_type: "application/x-ndjson" as const,
  event_count: eventCount,
  uncompressed_bytes: uncompressedBytes,
  compressed_bytes: 1,
  canonical_sha256: "0".repeat(64),
  data_etag: `etag-${batchId}`,
  first_event_id: event.event_id,
  last_event_id: event.event_id,
  first_observed_at: event.observed_at,
  last_observed_at: event.observed_at,
  archived_at: "2026-09-07T02:00:00.000Z",
  producer: {
    service: "communicator-control-plane" as const,
    version: "rebuild-test/1",
  },
  source_checkpoint: null,
});

const pageFor = (
  tenant: string,
  events: ProjectionEventEnvelope[],
  nextCursor: string | null = null,
  manifests = events.length === 0
    ? []
    : [manifestFor(tenant, "batch_rebuild_page", events[0]!, events.length)],
): ArchiveReplayPage => ({
  schema_version: 1,
  replay_mode: "projection_only",
  tenant_id: tenant,
  manifests,
  events,
  next_cursor: nextCursor,
});

const cursorFor = (tenant: string, r2Cursor: string): string =>
  encodeReplayCursor({
    schema_version: 1,
    tenant_id: tenant,
    manifest_prefix: deriveManifestPrefix(tenant),
    r2_cursor: r2Cursor,
  });

const initialize = async (tenant: string): Promise<RebuildStub> => {
  const stub = asRebuildStub(env.TENANT_PROJECTION.getByName(tenant));
  await stub.initialize({
    schema_version: 1,
    tenant_id: tenant,
    initialized_at: "2026-09-07T00:00:00.000Z",
    authorization: auth(tenant, ["projection.initialize"]),
  });
  return stub;
};

const rows = async <T extends Record<string, SqlStorageValue>>(
  stub: RebuildStub,
  sql: string,
  ...bindings: SqlStorageValue[]
): Promise<T[]> =>
  runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql.exec<T>(sql, ...bindings).toArray(),
  );

const replayState = async (
  stub: RebuildStub,
): Promise<Record<string, Record<string, SqlStorageValue>[]>> =>
  runInDurableObject(stub, async (_instance, state) => {
    const snapshot: Record<string, Record<string, SqlStorageValue>[]> = {};
    for (const table of DERIVED_TABLES) {
      snapshot[table] = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT * FROM ${table} ORDER BY rowid`,
        )
        .toArray();
    }
    snapshot.connection_bindings = state.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM connection_bindings ORDER BY rowid",
      )
      .toArray();
    snapshot.projection_meta = state.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM projection_meta ORDER BY rowid",
      )
      .toArray();
    snapshot.sqlite_sequence = state.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM sqlite_sequence ORDER BY name",
      )
      .toArray();
    return snapshot;
  });

const expectCode = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  operation: (instance: TenantProjectionDO) => Promise<unknown>,
  code: string,
): Promise<void> => {
  const failure = await runInDurableObject(stub, async (instance) => {
    try {
      await operation(instance);
      return undefined;
    } catch (error) {
      return error;
    }
  });
  expect(failure).toMatchObject({ code, message: code });
};

const begin = async (
  stub: RebuildRpc,
  tenant: string,
  rebuildId: string,
  expectedGeneration: number,
  startedAt = "2026-09-07T03:00:00.000Z",
) =>
  stub.beginRebuild({
    schema_version: 1,
    tenant_id: tenant,
    rebuild_id: rebuildId,
    expected_generation: expectedGeneration,
    started_at: startedAt,
    authorization: auth(tenant, ["projection.rebuild"]),
  });

const replay = async (
  stub: RebuildRpc,
  tenant: string,
  rebuildId: string,
  page: ArchiveReplayPage,
  sourceCursor: string | null,
  connections: ProjectionConnectionBinding[],
) =>
  stub.applyReplayPage({
    schema_version: 1,
    tenant_id: tenant,
    rebuild_id: rebuildId,
    source_cursor: sourceCursor,
    connections,
    page,
    authorization: auth(tenant, ["projection.rebuild"]),
  });

const nextSocketFrame = (
  socket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!predicate(frame)) return;
      cleanup();
      resolve(frame);
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      clearTimeout(timeout);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for realtime frame"));
    }, 1_000);
    socket.addEventListener("message", onMessage);
  });

const nextSocketClose = (socket: WebSocket): Promise<number> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for realtime socket close"));
    }, 1_000);
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve((event as CloseEvent).code);
      },
      { once: true },
    );
  });

describe("TenantProjectionDO resumable rebuilds", () => {
  it("sends the next-generation reset before closing sockets and never broadcasts replay pages", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    const issuedAt = new Date(Date.now() - 1_000);
    const realtimeContext = {
      schema_version: 1 as const,
      tenant_id: tenant,
      principal_id: "principal_rebuild",
      membership_id: "membership_rebuild",
      subscriptions: [
        { identity_id: "identity_a", families: ["projection"] as const },
      ],
      resume: [],
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + 30_000).toISOString(),
    };
    const response = await stub.fetch(
      new Request("https://tenant-projection.internal/realtime", {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
          "X-Communicator-Realtime-Context": JSON.stringify(realtimeContext),
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) throw new Error("missing realtime socket");
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    const connected = nextSocketFrame(
      socket,
      (frame) => frame.type === "connected",
    );
    socket.accept();
    await connected;
    const reset = nextSocketFrame(
      socket,
      (frame) => frame.type === "reset_required",
    );
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener(
        "close",
        (event) => resolve((event as CloseEvent).code),
        { once: true },
      );
    });

    try {
      await expect(
        begin(stub, tenant, "rebuild_socket_reset", 1),
      ).resolves.toMatchObject({
        state: "rebuilding",
        generation: 2,
      });
      await expect(reset).resolves.toEqual({
        schema_version: 1,
        type: "reset_required",
        tenant_id: tenant,
        identity_id: "identity_a",
        generation: 2,
        latest_sequence: 0,
        reason: "generation_changed",
      });
      await expect(closed).resolves.toBe(1012);

      await replay(
        stub,
        tenant,
        "rebuild_socket_reset",
        pageFor(tenant, [
          eventFor({
            tenant,
            eventId: "historical_replay_should_not_broadcast",
          }),
        ]),
        null,
        [binding("account_a", "connection_a", "identity_a")],
      );

      expect(frames.map((frame) => frame.type)).toEqual([
        "connected",
        "reset_required",
      ]);
    } finally {
      if (socket.readyState !== 3) socket.close(1000, "test complete");
    }
  });

  it("does not reset or close sockets when the rebuild transaction fails", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    const issuedAt = new Date(Date.now() - 1_000);
    const realtimeContext = {
      schema_version: 1 as const,
      tenant_id: tenant,
      principal_id: "principal_rebuild",
      membership_id: "membership_rebuild",
      subscriptions: [
        { identity_id: "identity_a", families: ["projection"] as const },
      ],
      resume: [],
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + 30_000).toISOString(),
    };
    const response = await stub.fetch(
      new Request("https://tenant-projection.internal/realtime", {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
          "X-Communicator-Realtime-Context": JSON.stringify(realtimeContext),
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) throw new Error("missing realtime socket");
    const connected = nextSocketFrame(
      socket,
      (frame) => frame.type === "connected",
    );
    socket.accept();
    await connected;
    const reset = nextSocketFrame(
      socket,
      (frame) => frame.type === "reset_required",
    );
    const closed = nextSocketClose(socket);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_rebuild_socket_reset BEFORE UPDATE OF state ON projection_meta BEGIN SELECT RAISE(ABORT, 'synthetic begin failure'); END",
      );
    });
    try {
      await expectCode(
        stub,
        (instance) => begin(instance, tenant, "rebuild_socket_reset_failed", 1),
        "projection_unavailable",
      );
      await expect(reset).rejects.toThrow(
        "Timed out waiting for realtime frame",
      );
      await expect(closed).rejects.toThrow(
        "Timed out waiting for realtime socket close",
      );
      expect(socket.readyState).not.toBe(3);
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_rebuild_socket_reset");
      });
      if (socket.readyState !== 3) socket.close(1000, "test complete");
    }
  });

  it("begins a generation, clears only derived state, and makes the same begin retry idempotent", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    const liveEvent = eventFor({
      tenant,
      eventId: "event_before_rebuild",
      eventSource: "live",
      messageId: "message_before_rebuild",
    });

    await stub.applyBatch({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.write"], ["identity_a"]),
      mode: "live",
      rebuild_id: null,
      connections: [binding("account_a", "connection_a", "identity_a")],
      events: [liveEvent],
      checkpoint: {
        kind: "source_cursor",
        value: "live-1",
        last_observed_at: liveEvent.observed_at,
        last_event_id: liveEvent.event_id,
      },
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO projection_change_floors (identity_id, discarded_through_sequence) VALUES (?, ?)",
        "identity_a",
        1,
      );
    });

    const before = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    expect(before).toMatchObject({ state: "ready", generation: 1 });
    expect(before.checkpoints).toHaveLength(1);

    const first = await begin(stub, tenant, "rebuild_one", 1);
    expect(first).toMatchObject({
      state: "rebuilding",
      generation: 2,
      rebuild_id: "rebuild_one",
      last_completed_rebuild_id: null,
      last_failed_rebuild_id: null,
      last_rebuild_failure_code: null,
      applied_event_count: 0,
      conversation_count: 0,
      message_count: 0,
      latest_change_sequence: 0,
      checkpoints: [],
    });

    await expect(
      rows(stub, "SELECT * FROM connection_bindings"),
    ).resolves.toEqual([
      {
        account_id: "account_a",
        connection_id: "connection_a",
        identity_id: "identity_a",
        platform: "whatsapp",
      },
    ]);
    await expect(rows(stub, "SELECT * FROM applied_events")).resolves.toEqual(
      [],
    );
    await expect(rows(stub, "SELECT * FROM conversations")).resolves.toEqual(
      [],
    );
    await expect(rows(stub, "SELECT * FROM messages")).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM projection_changes"),
    ).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM projection_change_floors"),
    ).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM projection_checkpoints"),
    ).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM completed_rebuilds"),
    ).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM failed_rebuilds")).resolves.toEqual(
      [],
    );
    for (const table of DERIVED_TABLES) {
      await expect(
        rows(stub, `SELECT COUNT(*) AS count FROM ${table}`),
      ).resolves.toEqual([{ count: 0 }]);
    }
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM _sql_schema_migrations"),
    ).resolves.toEqual([{ count: 5 }]);
    await expect(
      rows(
        stub,
        "SELECT tenant_id, state, generation, rebuild_id, rebuild_started_at FROM projection_meta",
      ),
    ).resolves.toEqual([
      {
        tenant_id: tenant,
        state: "rebuilding",
        generation: 2,
        rebuild_id: "rebuild_one",
        rebuild_started_at: "2026-09-07T03:00:00.000Z",
      },
    ]);

    await expect(begin(stub, tenant, "rebuild_one", 1)).resolves.toEqual(first);
    await expectCode(
      stub,
      (instance) =>
        begin(instance, tenant, "rebuild_one", 1, "2026-09-07T03:00:01.000Z"),
      "projection_rebuild_mismatch",
    );
    await expectCode(
      stub,
      (instance) => begin(instance, tenant, "rebuild_one", 2),
      "projection_rebuild_mismatch",
    );
    await expectCode(
      stub,
      (instance) => begin(instance, tenant, "rebuild_other", 1),
      "projection_rebuild_mismatch",
    );
  });

  it("restarts identity-local sequences in the new rebuild generation", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    const liveEvents = [
      eventFor({
        tenant,
        eventId: "event_local_sequence_human",
        identityId: "identity_human",
        accountId: "account_human",
        conversationId: "conversation_human",
        messageId: "message_human",
        eventSource: "live",
      }),
      eventFor({
        tenant,
        eventId: "event_local_sequence_agent",
        identityId: "identity_agent",
        accountId: "account_agent",
        conversationId: "conversation_agent",
        messageId: "message_agent",
        eventSource: "live",
      }),
    ];
    await stub.applyBatch({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(
        tenant,
        ["projection.write"],
        ["identity_agent", "identity_human"],
      ),
      mode: "live",
      rebuild_id: null,
      connections: [
        binding("account_agent", "connection_agent", "identity_agent"),
        binding("account_human", "connection_human", "identity_human"),
      ],
      events: liveEvents,
      checkpoint: null,
    });
    await expect(
      rows(
        stub,
        "SELECT identity_id, latest_sequence FROM projection_identity_sequences ORDER BY identity_id",
      ),
    ).resolves.toEqual([
      { identity_id: "identity_agent", latest_sequence: 1 },
      { identity_id: "identity_human", latest_sequence: 1 },
    ]);

    await begin(stub, tenant, "rebuild_local_sequences", 1);
    await expect(
      rows(stub, "SELECT * FROM projection_identity_sequences"),
    ).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM projection_changes"),
    ).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM projection_change_floors"),
    ).resolves.toEqual([]);

    const replayEvents = liveEvents.map((nextEvent) => ({
      ...nextEvent,
      event_source: "replay" as const,
    }));
    await replay(
      stub,
      tenant,
      "rebuild_local_sequences",
      pageFor(tenant, replayEvents),
      null,
      [
        binding("account_agent", "connection_agent", "identity_agent"),
        binding("account_human", "connection_human", "identity_human"),
      ],
    );
    await stub.completeRebuild({
      schema_version: 1,
      tenant_id: tenant,
      rebuild_id: "rebuild_local_sequences",
      terminal_cursor: null,
      completed_at: "2026-09-07T03:30:00.000Z",
      authorization: auth(tenant, ["projection.rebuild"]),
    });

    await expect(
      rows(
        stub,
        "SELECT identity_id, latest_sequence FROM projection_identity_sequences ORDER BY identity_id",
      ),
    ).resolves.toEqual([
      { identity_id: "identity_agent", latest_sequence: 1 },
      { identity_id: "identity_human", latest_sequence: 1 },
    ]);
    await expect(
      rows(
        stub,
        "SELECT identity_id, sequence, identity_sequence FROM projection_changes ORDER BY sequence",
      ),
    ).resolves.toEqual([
      { identity_id: "identity_agent", sequence: 1, identity_sequence: 1 },
      { identity_id: "identity_human", sequence: 2, identity_sequence: 1 },
    ]);
    await expect(
      stub.listChanges({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_human",
        generation: 2,
        after_sequence: 0,
        authorization: auth(tenant, ["projection.read"], ["identity_human"]),
      }),
    ).resolves.toMatchObject({ latest_sequence: 1, items: [{ sequence: 1 }] });
    await expect(
      stub.listChanges({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_agent",
        generation: 2,
        after_sequence: 0,
        authorization: auth(tenant, ["projection.read"], ["identity_agent"]),
      }),
    ).resolves.toMatchObject({ latest_sequence: 1, items: [{ sequence: 1 }] });
  });

  it("requires rebuild scope and the exact tenant on every rebuild RPC", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    const forbidden = auth(tenant, ["projection.status"]);
    const foreignTenant = newTenant();
    const foreign = auth(foreignTenant, ["projection.rebuild"]);
    const terminalPage = pageFor(tenant, []);
    const storedTenantInput = newTenant();
    const storedTenantAuth = auth(storedTenantInput, ["projection.rebuild"]);
    const storedTenantPage = pageFor(storedTenantInput, []);

    await expectCode(
      stub,
      (instance) =>
        instance.beginRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_auth_begin",
          expected_generation: 1,
          started_at: "2026-09-07T03:10:00.000Z",
          authorization: forbidden,
        }),
      "projection_forbidden",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.completeRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_auth_complete",
          terminal_cursor: null,
          completed_at: "2026-09-07T03:10:01.000Z",
          authorization: forbidden,
        }),
      "projection_forbidden",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.abortRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_auth_abort",
          failed_at: "2026-09-07T03:10:02.000Z",
          failure_code: "operator_abort",
          authorization: forbidden,
        }),
      "projection_forbidden",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.applyReplayPage({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_auth_replay",
          source_cursor: null,
          connections: [],
          page: terminalPage,
          authorization: forbidden,
        }),
      "projection_forbidden",
    );

    await expectCode(
      stub,
      (instance) =>
        instance.beginRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_tenant_begin",
          expected_generation: 1,
          started_at: "2026-09-07T03:11:00.000Z",
          authorization: foreign,
        }),
      "projection_tenant_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.completeRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_tenant_complete",
          terminal_cursor: null,
          completed_at: "2026-09-07T03:11:01.000Z",
          authorization: foreign,
        }),
      "projection_tenant_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.abortRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_tenant_abort",
          failed_at: "2026-09-07T03:11:02.000Z",
          failure_code: "operator_abort",
          authorization: foreign,
        }),
      "projection_tenant_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.applyReplayPage({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_tenant_replay",
          source_cursor: null,
          connections: [],
          page: terminalPage,
          authorization: foreign,
        }),
      "projection_tenant_mismatch",
    );

    await expectCode(
      stub,
      (instance) =>
        instance.beginRebuild({
          schema_version: 1,
          tenant_id: storedTenantInput,
          rebuild_id: "rebuild_stored_tenant_begin",
          expected_generation: 1,
          started_at: "2026-09-07T03:12:00.000Z",
          authorization: storedTenantAuth,
        }),
      "projection_tenant_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.completeRebuild({
          schema_version: 1,
          tenant_id: storedTenantInput,
          rebuild_id: "rebuild_stored_tenant_complete",
          terminal_cursor: null,
          completed_at: "2026-09-07T03:12:01.000Z",
          authorization: storedTenantAuth,
        }),
      "projection_tenant_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.abortRebuild({
          schema_version: 1,
          tenant_id: storedTenantInput,
          rebuild_id: "rebuild_stored_tenant_abort",
          failed_at: "2026-09-07T03:12:02.000Z",
          failure_code: "operator_abort",
          authorization: storedTenantAuth,
        }),
      "projection_tenant_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.applyReplayPage({
          schema_version: 1,
          tenant_id: storedTenantInput,
          rebuild_id: "rebuild_stored_tenant_replay",
          source_cursor: null,
          connections: [],
          page: storedTenantPage,
          authorization: storedTenantAuth,
        }),
      "projection_tenant_mismatch",
    );
  });

  it("allows tenant-wide multi-identity replay with no identity grants and preserves bindings across generations", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    const first = await begin(stub, tenant, "rebuild_multi", 1);
    const eventA = eventFor({
      tenant,
      eventId: "event_identity_a",
      identityId: "identity_a",
      accountId: "account_a",
      conversationId: "conversation_a",
      messageId: "message_identity_a",
    });
    const eventB = eventFor({
      tenant,
      eventId: "event_identity_b",
      identityId: "identity_b",
      accountId: "account_b",
      conversationId: "conversation_b",
      messageId: "message_identity_b",
    });
    const page = pageFor(tenant, [eventB, eventA]);
    await expect(
      replay(stub, tenant, "rebuild_multi", page, null, [
        binding("account_a", "connection_a", "identity_a"),
        binding("account_b", "connection_b", "identity_b"),
      ]),
    ).resolves.toMatchObject({
      applied_count: 2,
      duplicate_count: 0,
      generation: 2,
    });

    const status = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    expect(status).toMatchObject({ state: "rebuilding", generation: 2 });
    expect(status.checkpoints).toHaveLength(1);
    expect(status.checkpoints[0]).toMatchObject({
      kind: "r2_manifest_cursor",
      value: "terminal",
      source_cursor: null,
    });
    await expect(
      rows(
        stub,
        "SELECT account_id,connection_id,identity_id FROM connection_bindings ORDER BY account_id",
      ),
    ).resolves.toEqual([
      {
        account_id: "account_a",
        connection_id: "connection_a",
        identity_id: "identity_a",
      },
      {
        account_id: "account_b",
        connection_id: "connection_b",
        identity_id: "identity_b",
      },
    ]);
    await expectCode(
      stub,
      (instance) =>
        replay(instance, tenant, "rebuild_multi", page, null, [
          binding("account_a", "connection_changed", "identity_a"),
          binding("account_b", "connection_b", "identity_b"),
        ]),
      "projection_conflict",
    );
    await expect(
      begin(stub, tenant, "rebuild_multi", 1),
    ).resolves.toMatchObject({
      state: "rebuilding",
      generation: 2,
      rebuild_id: "rebuild_multi",
    });
    expect(first.generation).toBe(2);
  });

  it("gates live apply and ordinary queries while rebuilding, requires the active replay ID, and rolls back failed transitions", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    const event = eventFor({
      tenant,
      eventId: "event_gated",
      eventSource: "live",
    });
    await begin(stub, tenant, "rebuild_gate", 1);

    await expectCode(
      stub,
      (instance) =>
        instance.applyBatch({
          schema_version: 1,
          tenant_id: tenant,
          authorization: auth(tenant, ["projection.write"], ["identity_a"]),
          mode: "live",
          rebuild_id: null,
          connections: [binding("account_a", "connection_a", "identity_a")],
          events: [event],
          checkpoint: null,
        }),
      "projection_rebuilding",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.listConversations({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          connection_id: null,
          authorization: auth(tenant, ["projection.read"], ["identity_a"]),
        }),
      "projection_rebuilding",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.listMessages({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          conversation_id: "conversation_gated",
          authorization: auth(tenant, ["projection.read"], ["identity_a"]),
        }),
      "projection_rebuilding",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.listChanges({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          generation: 2,
          after_sequence: 0,
          authorization: auth(tenant, ["projection.read"], ["identity_a"]),
        }),
      "projection_rebuilding",
    );
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "not_active",
          pageFor(tenant, [
            eventFor({ tenant, eventId: "event_wrong_rebuild" }),
          ]),
          null,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_rebuild_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.completeRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "not_active",
          terminal_cursor: null,
          completed_at: "2026-09-07T04:00:00.000Z",
          authorization: auth(tenant, ["projection.rebuild"]),
        }),
      "projection_rebuild_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.abortRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "not_active",
          failed_at: "2026-09-07T04:00:00.000Z",
          failure_code: "operator_abort",
          authorization: auth(tenant, ["projection.rebuild"]),
        }),
      "projection_rebuild_mismatch",
    );

    const stillRebuilding = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    expect(stillRebuilding).toMatchObject({
      state: "rebuilding",
      generation: 2,
      rebuild_id: "rebuild_gate",
    });
    expect(stillRebuilding.checkpoints).toEqual([]);
  });

  it("rolls back begin, replay, abort, and complete SQL failures without leaking partial state", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    const baseline = eventFor({
      tenant,
      eventId: "event_transition_baseline",
      eventSource: "live",
      messageId: "message_transition_baseline",
    });
    await stub.applyBatch({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.write"], ["identity_a"]),
      mode: "live",
      rebuild_id: null,
      connections: [binding("account_a", "connection_a", "identity_a")],
      events: [baseline],
      checkpoint: null,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_rebuild_meta BEFORE UPDATE OF state ON projection_meta BEGIN SELECT RAISE(ABORT, 'synthetic begin failure'); END",
      );
    });
    try {
      await expectCode(
        stub,
        (instance) => begin(instance, tenant, "rebuild_transition", 1),
        "projection_unavailable",
      );
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_rebuild_meta");
      });
    }
    await expect(
      stub.getStatus({
        schema_version: 1,
        tenant_id: tenant,
        authorization: auth(tenant, ["projection.status"]),
      }),
    ).resolves.toMatchObject({
      state: "ready",
      generation: 1,
      applied_event_count: 1,
    });
    await expect(
      rows(stub, "SELECT event_id FROM applied_events"),
    ).resolves.toEqual([{ event_id: baseline.event_id }]);

    await begin(stub, tenant, "rebuild_transition", 1);
    const partialEvent = eventFor({
      tenant,
      eventId: "event_transition_partial",
      messageId: "message_transition_partial",
    });
    const nextCursor = cursorFor(tenant, "transition-next");
    const partialPage = pageFor(tenant, [partialEvent], nextCursor);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_rebuild_projection BEFORE INSERT ON projection_changes BEGIN SELECT RAISE(ABORT, 'synthetic replay failure'); END",
      );
    });
    try {
      await expectCode(
        stub,
        (instance) =>
          replay(instance, tenant, "rebuild_transition", partialPage, null, [
            binding("account_a", "connection_a", "identity_a"),
          ]),
        "projection_unavailable",
      );
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_rebuild_projection");
      });
    }
    await expect(
      stub.getStatus({
        schema_version: 1,
        tenant_id: tenant,
        authorization: auth(tenant, ["projection.status"]),
      }),
    ).resolves.toMatchObject({
      state: "rebuilding",
      applied_event_count: 0,
      checkpoints: [],
    });
    await expect(
      rows(stub, "SELECT event_id FROM applied_events"),
    ).resolves.toEqual([]);
    await expect(rows(stub, "SELECT id FROM messages")).resolves.toEqual([]);

    await replay(stub, tenant, "rebuild_transition", partialPage, null, [
      binding("account_a", "connection_a", "identity_a"),
    ]);
    const beforeAbortFailure = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_rebuild_abort BEFORE INSERT ON failed_rebuilds BEGIN SELECT RAISE(ABORT, 'synthetic abort failure'); END",
      );
    });
    try {
      await expectCode(
        stub,
        (instance) =>
          instance.abortRebuild({
            schema_version: 1,
            tenant_id: tenant,
            rebuild_id: "rebuild_transition",
            failed_at: "2026-09-07T05:30:00.000Z",
            failure_code: "operator_abort",
            authorization: auth(tenant, ["projection.rebuild"]),
          }),
        "projection_unavailable",
      );
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_rebuild_abort");
      });
    }
    await expect(
      stub.getStatus({
        schema_version: 1,
        tenant_id: tenant,
        authorization: auth(tenant, ["projection.status"]),
      }),
    ).resolves.toEqual(beforeAbortFailure);
    await expect(
      rows(stub, "SELECT event_id FROM applied_events"),
    ).resolves.toEqual([{ event_id: partialEvent.event_id }]);
    await expect(
      rows(stub, "SELECT value FROM projection_checkpoints"),
    ).resolves.toEqual([{ value: nextCursor }]);
    await expect(rows(stub, "SELECT * FROM failed_rebuilds")).resolves.toEqual(
      [],
    );

    await replay(
      stub,
      tenant,
      "rebuild_transition",
      pageFor(tenant, [], null),
      nextCursor,
      [],
    );
    const beforeCompleteFailure = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_rebuild_complete BEFORE INSERT ON completed_rebuilds BEGIN SELECT RAISE(ABORT, 'synthetic complete failure'); END",
      );
    });
    try {
      await expectCode(
        stub,
        (instance) =>
          instance.completeRebuild({
            schema_version: 1,
            tenant_id: tenant,
            rebuild_id: "rebuild_transition",
            terminal_cursor: null,
            completed_at: "2026-09-07T05:31:00.000Z",
            authorization: auth(tenant, ["projection.rebuild"]),
          }),
        "projection_unavailable",
      );
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_rebuild_complete");
      });
    }
    await expect(
      stub.getStatus({
        schema_version: 1,
        tenant_id: tenant,
        authorization: auth(tenant, ["projection.status"]),
      }),
    ).resolves.toEqual(beforeCompleteFailure);
    await expect(
      rows(stub, "SELECT value FROM projection_checkpoints"),
    ).resolves.toEqual([{ value: "terminal" }]);
    await expect(
      rows(stub, "SELECT * FROM completed_rebuilds"),
    ).resolves.toEqual([]);
  });

  it("aborts invalid partial replay atomically into bounded failed metadata and permits only a fresh corrected rebuild", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    await begin(stub, tenant, "rebuild_recover", 1);
    const validEvent = eventFor({
      tenant,
      eventId: "event_partial_valid",
      messageId: "message_partial_valid",
    });
    const partialPage = pageFor(
      tenant,
      [validEvent],
      cursorFor(tenant, "r2-next"),
    );
    await expect(
      replay(stub, tenant, "rebuild_recover", partialPage, null, [
        binding("account_a", "connection_a", "identity_a"),
      ]),
    ).resolves.toMatchObject({ applied_count: 1 });
    const beforeInvalid = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });

    const ownerConflictEvent = eventFor({
      tenant,
      eventId: "event_partial_owner_conflict",
      identityId: "identity_b",
      accountId: "account_b",
      conversationId: "conversation_b",
      messageId: "message_partial_owner_conflict",
    });
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_recover",
          pageFor(tenant, [ownerConflictEvent], null),
          cursorFor(tenant, "r2-next"),
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_conflict",
    );
    await expect(
      stub.getStatus({
        schema_version: 1,
        tenant_id: tenant,
        authorization: auth(tenant, ["projection.status"]),
      }),
    ).resolves.toEqual(beforeInvalid);

    const unsupportedEvent = {
      ...eventFor({ tenant, eventId: "event_unsupported" }),
      payload: { body: "legacy archive payload" },
    } as ProjectionEventEnvelope;
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_recover",
          pageFor(tenant, [unsupportedEvent], null),
          cursorFor(tenant, "r2-next"),
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_invalid",
    );
    const afterInvalid = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    expect(afterInvalid).toEqual(beforeInvalid);
    await expect(
      rows(stub, "SELECT event_id FROM applied_events"),
    ).resolves.toEqual([{ event_id: "event_partial_valid" }]);
    await expect(rows(stub, "SELECT body FROM messages")).resolves.toEqual([
      { body: "replay body" },
    ]);

    const aborted = await stub.abortRebuild({
      schema_version: 1,
      tenant_id: tenant,
      rebuild_id: "rebuild_recover",
      failed_at: "2026-09-07T05:00:00.000Z",
      failure_code: "unsupported_archive",
      authorization: auth(tenant, ["projection.rebuild"]),
    });
    expect(aborted).toMatchObject({
      state: "rebuild_failed",
      generation: 2,
      rebuild_id: null,
      last_failed_rebuild_id: "rebuild_recover",
      last_rebuild_failure_code: "unsupported_archive",
      applied_event_count: 0,
      conversation_count: 0,
      message_count: 0,
      latest_change_sequence: 0,
      checkpoints: [],
    });
    const failedStatus = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    expect(failedStatus).toEqual(aborted);
    expect(Object.keys(failedStatus)).toEqual([
      "schema_version",
      "tenant_id",
      "schema_generation",
      "state",
      "generation",
      "rebuild_id",
      "last_completed_rebuild_id",
      "last_failed_rebuild_id",
      "last_rebuild_failure_code",
      "applied_event_count",
      "conversation_count",
      "message_count",
      "latest_change_sequence",
      "checkpoints",
    ]);
    await expect(rows(stub, "SELECT * FROM applied_events")).resolves.toEqual(
      [],
    );
    await expect(rows(stub, "SELECT * FROM conversations")).resolves.toEqual(
      [],
    );
    await expect(rows(stub, "SELECT * FROM messages")).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM projection_changes"),
    ).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM projection_checkpoints"),
    ).resolves.toEqual([]);
    await expect(
      rows(stub, "SELECT * FROM projection_change_floors"),
    ).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM failed_rebuilds")).resolves.toEqual([
      {
        rebuild_id: "rebuild_recover",
        generation: 2,
        failed_at: "2026-09-07T05:00:00.000Z",
        failure_code: "unsupported_archive",
      },
    ]);

    await expect(
      stub.abortRebuild({
        schema_version: 1,
        tenant_id: tenant,
        rebuild_id: "rebuild_recover",
        failed_at: "2026-09-07T05:00:00.000Z",
        failure_code: "unsupported_archive",
        authorization: auth(tenant, ["projection.rebuild"]),
      }),
    ).resolves.toEqual(aborted);
    await expectCode(
      stub,
      (instance) =>
        instance.abortRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_recover",
          failed_at: "2026-09-07T05:00:00.000Z",
          failure_code: "operator_abort",
          authorization: auth(tenant, ["projection.rebuild"]),
        }),
      "projection_rebuild_mismatch",
    );
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_recover",
          pageFor(tenant, [validEvent]),
          null,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_rebuild_failed",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.listConversations({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          connection_id: null,
          authorization: auth(tenant, ["projection.read"], ["identity_a"]),
        }),
      "projection_rebuild_failed",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.listMessages({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          conversation_id: "conversation_failed",
          authorization: auth(tenant, ["projection.read"], ["identity_a"]),
        }),
      "projection_rebuild_failed",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.listChanges({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          generation: 2,
          after_sequence: 0,
          authorization: auth(tenant, ["projection.read"], ["identity_a"]),
        }),
      "projection_rebuild_failed",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.applyBatch({
          schema_version: 1,
          tenant_id: tenant,
          authorization: auth(tenant, ["projection.write"], ["identity_a"]),
          mode: "live",
          rebuild_id: null,
          connections: [binding("account_a", "connection_a", "identity_a")],
          events: [validEvent],
          checkpoint: null,
        }),
      "projection_rebuild_failed",
    );

    await expectCode(
      stub,
      (instance) => begin(instance, tenant, "rebuild_recover", 2),
      "projection_rebuild_mismatch",
    );
    await begin(stub, tenant, "rebuild_corrected", 2);
    await expect(
      replay(
        stub,
        tenant,
        "rebuild_corrected",
        pageFor(tenant, [
          eventFor({
            tenant,
            eventId: "event_corrected",
            messageId: "message_corrected",
            body: "corrected archive payload",
          }),
        ]),
        null,
        [binding("account_a", "connection_a", "identity_a")],
      ),
    ).resolves.toMatchObject({ applied_count: 1, generation: 3 });
    await expect(
      stub.completeRebuild({
        schema_version: 1,
        tenant_id: tenant,
        rebuild_id: "rebuild_corrected",
        terminal_cursor: null,
        completed_at: "2026-09-07T06:00:00.000Z",
        authorization: auth(tenant, ["projection.rebuild"]),
      }),
    ).resolves.toMatchObject({
      state: "ready",
      generation: 3,
      last_completed_rebuild_id: "rebuild_corrected",
      last_failed_rebuild_id: "rebuild_recover",
      last_rebuild_failure_code: null,
    });
    await expect(
      rows(stub, "SELECT account_id,connection_id FROM connection_bindings"),
    ).resolves.toEqual([
      { account_id: "account_a", connection_id: "connection_a" },
    ]);
  });

  it("enforces adjacent replay cursors, canonical tenant binding, digest retries, and terminal completion", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    await begin(stub, tenant, "rebuild_cursor", 1);
    const firstEvent = eventFor({
      tenant,
      eventId: "event_cursor_first",
      observedAt: "2026-09-07T01:00:10.000Z",
      occurredAt: "2026-09-07T01:00:09.000Z",
      messageId: "message_cursor_first",
    });
    const firstCursor = cursorFor(tenant, "r2-page-2");
    const firstPage = pageFor(tenant, [firstEvent], firstCursor);
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_cursor",
          pageFor(tenant, [
            eventFor({ tenant, eventId: "event_cursor_nonfirst" }),
          ]),
          firstCursor,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_conflict",
    );
    const firstResult = await replay(
      stub,
      tenant,
      "rebuild_cursor",
      firstPage,
      null,
      [binding("account_a", "connection_a", "identity_a")],
    );
    expect(firstResult).toMatchObject({
      applied_count: 1,
      duplicate_count: 0,
      last_sequence: 1,
    });
    const beforeSamePageRetry = await replayState(stub);
    await expect(
      replay(stub, tenant, "rebuild_cursor", firstPage, null, [
        binding("account_a", "connection_a", "identity_a"),
      ]),
    ).resolves.toEqual(firstResult);
    const afterSamePageRetry = await replayState(stub);
    expect(afterSamePageRetry).toEqual(beforeSamePageRetry);

    const changedFirstPage = pageFor(
      tenant,
      [
        eventFor({
          tenant,
          eventId: "event_cursor_different",
          observedAt: firstEvent.observed_at,
          occurredAt: firstEvent.occurred_at,
          messageId: "message_cursor_different",
        }),
      ],
      firstCursor,
    );
    await expectCode(
      stub,
      (instance) =>
        replay(instance, tenant, "rebuild_cursor", changedFirstPage, null, [
          binding("account_a", "connection_a", "identity_a"),
        ]),
      "projection_conflict",
    );
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_cursor",
          pageFor(tenant, [eventFor({ tenant, eventId: "event_gap" })], null),
          cursorFor(tenant, "r2-not-expected"),
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_conflict",
    );
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_cursor",
          pageFor(tenant, [
            eventFor({ tenant, eventId: "event_wrong_tenant_cursor" }),
          ]),
          cursorFor("tenant_rebuild_cursor_other", "r2-page-2"),
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_tenant_mismatch",
    );
    const foreignPageTenant = newTenant();
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_cursor",
          pageFor(foreignPageTenant, [
            eventFor({
              tenant: foreignPageTenant,
              eventId: "event_wrong_page_tenant",
            }),
          ]),
          null,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_tenant_mismatch",
    );
    const nonCanonical = firstCursor + "=";
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_cursor",
          pageFor(
            tenant,
            [eventFor({ tenant, eventId: "event_noncanonical" })],
            null,
          ),
          nonCanonical,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_invalid",
    );
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_cursor",
          pageFor(
            tenant,
            [eventFor({ tenant, eventId: "event_self_loop" })],
            firstCursor,
          ),
          firstCursor,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_conflict",
    );

    const olderEvent = eventFor({
      tenant,
      eventId: "event_cursor_older",
      observedAt: "2026-09-07T01:00:05.000Z",
      occurredAt: "2026-09-07T01:00:04.000Z",
      messageId: "message_cursor_older",
    });
    const terminalPage = pageFor(tenant, [olderEvent], null);
    await expectCode(
      stub,
      (instance) =>
        instance.completeRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "rebuild_cursor",
          terminal_cursor: null,
          completed_at: "2026-09-07T06:30:00.000Z",
          authorization: auth(tenant, ["projection.rebuild"]),
        }),
      "projection_rebuild_mismatch",
    );
    const terminalResult = await replay(
      stub,
      tenant,
      "rebuild_cursor",
      terminalPage,
      firstCursor,
      [binding("account_a", "connection_a", "identity_a")],
    );
    expect(terminalResult).toMatchObject({
      applied_count: 1,
      duplicate_count: 0,
      last_sequence: 2,
    });
    const status = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    expect(status.checkpoints[0]).toMatchObject({
      value: "terminal",
      source_cursor: firstCursor,
      last_observed_at: firstEvent.observed_at,
      last_event_id: firstEvent.event_id,
    });
    await expect(
      sha256Hex(
        new TextEncoder().encode(
          canonicalJsonStringify({
            source_cursor: firstCursor,
            connections: [binding("account_a", "connection_a", "identity_a")],
            page: terminalPage,
          }),
        ),
      ),
    ).resolves.toBe(status.checkpoints[0]?.page_digest);
    await expect(
      replay(stub, tenant, "rebuild_cursor", terminalPage, firstCursor, [
        binding("account_a", "connection_a", "identity_a"),
      ]),
    ).resolves.toEqual(terminalResult);
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_cursor",
          pageFor(tenant, [
            eventFor({ tenant, eventId: "event_post_terminal" }),
          ]),
          null,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_conflict",
    );

    const completed = await stub.completeRebuild({
      schema_version: 1,
      tenant_id: tenant,
      rebuild_id: "rebuild_cursor",
      terminal_cursor: null,
      completed_at: "2026-09-07T07:00:00.000Z",
      authorization: auth(tenant, ["projection.rebuild"]),
    });
    expect(completed).toMatchObject({
      state: "ready",
      last_completed_rebuild_id: "rebuild_cursor",
    });
    const completedHistoryBeforeRetry = await rows(
      stub,
      "SELECT rebuild_id, generation, completed_at FROM completed_rebuilds WHERE rebuild_id = ?",
      "rebuild_cursor",
    );
    expect(completedHistoryBeforeRetry).toEqual([
      {
        rebuild_id: "rebuild_cursor",
        generation: 2,
        completed_at: "2026-09-07T07:00:00.000Z",
      },
    ]);
    await expect(
      stub.completeRebuild({
        schema_version: 1,
        tenant_id: tenant,
        rebuild_id: "rebuild_cursor",
        terminal_cursor: null,
        completed_at: "2026-09-07T08:00:00.000Z",
        authorization: auth(tenant, ["projection.rebuild"]),
      }),
    ).resolves.toEqual(completed);
    await expect(
      rows(
        stub,
        "SELECT rebuild_id, generation, completed_at FROM completed_rebuilds WHERE rebuild_id = ?",
        "rebuild_cursor",
      ),
    ).resolves.toEqual(completedHistoryBeforeRetry);
    await expectCode(
      stub,
      (instance) =>
        instance.completeRebuild({
          schema_version: 1,
          tenant_id: tenant,
          rebuild_id: "another_rebuild",
          terminal_cursor: null,
          completed_at: "2026-09-07T08:00:00.000Z",
          authorization: auth(tenant, ["projection.rebuild"]),
        }),
      "projection_rebuild_mismatch",
    );
    await expect(
      stub.applyBatch({
        schema_version: 1,
        tenant_id: tenant,
        authorization: auth(tenant, ["projection.write"], ["identity_a"]),
        mode: "live",
        rebuild_id: null,
        connections: [binding("account_a", "connection_a", "identity_a")],
        events: [
          eventFor({
            tenant,
            eventId: "event_after_rebuild",
            eventSource: "live",
          }),
        ],
        checkpoint: null,
      }),
    ).resolves.toMatchObject({ generation: 2, applied_count: 1 });
  });

  it("accepts an empty terminal archive, rejects empty/nonterminal and malformed pages before SQL, and exposes no skip escape hatch", async () => {
    const tenant = newTenant();
    const stub = await initialize(tenant);
    await begin(stub, tenant, "rebuild_empty", 1, "2026-09-07T09:00:00.000Z");

    const emptyTerminal = pageFor(tenant, []);
    await expect(
      replay(stub, tenant, "rebuild_empty", emptyTerminal, null, []),
    ).resolves.toMatchObject({
      applied_count: 0,
      duplicate_count: 0,
      last_sequence: 0,
    });
    const status = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    expect(status.checkpoints[0]).toMatchObject({
      value: "terminal",
      source_cursor: null,
      last_observed_at: null,
      last_event_id: null,
      updated_at: "2026-09-07T09:00:00.000Z",
    });
    await expect(
      stub.completeRebuild({
        schema_version: 1,
        tenant_id: tenant,
        rebuild_id: "rebuild_empty",
        terminal_cursor: null,
        completed_at: "2026-09-07T10:00:00.000Z",
        authorization: auth(tenant, ["projection.rebuild"]),
      }),
    ).resolves.toMatchObject({ state: "ready", generation: 2 });

    const nonterminalTenant = newTenant();
    const nonterminalStub = await initialize(nonterminalTenant);
    await begin(nonterminalStub, nonterminalTenant, "rebuild_invalid_pages", 1);
    const nonterminalCursor = cursorFor(nonterminalTenant, "nonterminal");
    await expectCode(
      nonterminalStub,
      (instance) =>
        replay(
          instance,
          nonterminalTenant,
          "rebuild_invalid_pages",
          pageFor(nonterminalTenant, [], nonterminalCursor),
          null,
          [],
        ),
      "projection_invalid",
    );
    const manifestOnlyEvent = eventFor({
      tenant: nonterminalTenant,
      eventId: "event_manifest_without_events",
    });
    await expectCode(
      nonterminalStub,
      (instance) =>
        replay(
          instance,
          nonterminalTenant,
          "rebuild_invalid_pages",
          {
            schema_version: 1,
            replay_mode: "projection_only",
            tenant_id: nonterminalTenant,
            manifests: [
              manifestFor(
                nonterminalTenant,
                "batch_manifest_without_events",
                manifestOnlyEvent,
              ),
            ],
            events: [],
            next_cursor: null,
          },
          null,
          [],
        ),
      "projection_invalid",
    );
    const event = eventFor({
      tenant: nonterminalTenant,
      eventId: "event_missing_manifest",
    });
    await expectCode(
      nonterminalStub,
      (instance) =>
        replay(
          instance,
          nonterminalTenant,
          "rebuild_invalid_pages",
          pageFor(nonterminalTenant, [event], null, []),
          null,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_invalid",
    );
    const afterInvalid = await nonterminalStub.getStatus({
      schema_version: 1,
      tenant_id: nonterminalTenant,
      authorization: auth(nonterminalTenant, ["projection.status"]),
    });
    expect(afterInvalid).toMatchObject({ state: "rebuilding", generation: 2 });
    expect(afterInvalid.checkpoints).toEqual([]);
    const methods = await runInDurableObject(
      nonterminalStub,
      async (instance) =>
        Object.getOwnPropertyNames(Object.getPrototypeOf(instance)),
    );
    expect(methods).not.toContain("skipReplayEvent");
    expect(methods).not.toContain("skipRebuildEvent");
  });

  it("rejects oversized replay pages before transaction and preserves the rebuilding state", async () => {
    const acceptedTenant = newTenant();
    const acceptedStub = await initialize(acceptedTenant);
    await begin(acceptedStub, acceptedTenant, "rebuild_limits_500", 1);
    const acceptedEvents = Array.from({ length: 500 }, (_, index) =>
      eventFor({
        tenant: acceptedTenant,
        eventId: `event_replay_500_${String(index).padStart(3, "0")}`,
        messageId: `message_replay_500_${String(index).padStart(3, "0")}`,
      }),
    );
    await expect(
      replay(
        acceptedStub,
        acceptedTenant,
        "rebuild_limits_500",
        pageFor(acceptedTenant, acceptedEvents, null, [
          manifestFor(
            acceptedTenant,
            "batch_replay_500",
            acceptedEvents[0]!,
            500,
          ),
        ]),
        null,
        [binding("account_a", "connection_a", "identity_a")],
      ),
    ).resolves.toMatchObject({
      applied_count: 500,
      duplicate_count: 0,
      generation: 2,
    });

    const tenant = newTenant();
    const stub = await initialize(tenant);
    await begin(stub, tenant, "rebuild_limits", 1);
    const events = Array.from({ length: 501 }, (_, index) =>
      eventFor({
        tenant,
        eventId: `event_limit_${String(index).padStart(3, "0")}`,
        messageId: `message_limit_${String(index).padStart(3, "0")}`,
      }),
    );
    const manifests = [
      manifestFor(tenant, "batch_limits_a", events[0]!, 250),
      manifestFor(tenant, "batch_limits_b", events[250]!, 251),
    ];
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_limits",
          pageFor(tenant, events, null, manifests),
          null,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_too_large",
    );
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM applied_events"),
    ).resolves.toEqual([{ count: 0 }]);

    const oversizedEvents = Array.from({ length: 220 }, (_, index) =>
      eventFor({
        tenant,
        eventId: `event_bytes_${String(index).padStart(3, "0")}`,
        messageId: `message_bytes_${String(index).padStart(3, "0")}`,
        body: "x".repeat(20_000),
      }),
    );
    const byteManifests = [
      manifestFor(tenant, "batch_bytes_a", oversizedEvents[0]!, 110, 2_000_000),
      manifestFor(
        tenant,
        "batch_bytes_b",
        oversizedEvents[110]!,
        110,
        2_000_000,
      ),
    ];
    await expectCode(
      stub,
      (instance) =>
        replay(
          instance,
          tenant,
          "rebuild_limits",
          pageFor(tenant, oversizedEvents, null, byteManifests),
          null,
          [binding("account_a", "connection_a", "identity_a")],
        ),
      "projection_too_large",
    );
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM applied_events"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      stub.getStatus({
        schema_version: 1,
        tenant_id: tenant,
        authorization: auth(tenant, ["projection.status"]),
      }),
    ).resolves.toMatchObject({ state: "rebuilding", checkpoints: [] });
  });

  it("sanitizes a failed getStatus RPC to its exact bounded public error key", async () => {
    const projection = Object.create(
      TenantProjectionDO.prototype,
    ) as TenantProjectionDO;
    const sensitive = "message=secret payload=private SQL=SELECT-secret";
    const rawCause = new Error(sensitive);
    (projection as unknown as { ctx: DurableObjectState }).ctx = {
      storage: {
        sql: {
          exec() {
            throw rawCause;
          },
        },
      },
    } as unknown as DurableObjectState;

    let failure: unknown;
    try {
      await projection.getStatus({
        schema_version: 1,
        tenant_id: "tenant_status_failure",
        authorization: auth("tenant_status_failure", ["projection.status"]),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "projection_unavailable",
      message: "projection_unavailable",
    });
    expect(Object.keys(failure as object)).toEqual(["code"]);
    expect(JSON.stringify(failure)).not.toContain(sensitive);
    expect(String((failure as Error).message)).not.toContain(sensitive);
    expect(Object.getOwnPropertyNames(failure as object)).not.toContain(
      "cause",
    );
  });

  it("preserves deterministic query state when the same archive is rebuilt twice and persists lifecycle state through a fresh stub lookup", async () => {
    const tenant = newTenant();
    let stub = await initialize(tenant);
    const firstEvents = [
      eventFor({
        tenant,
        eventId: "event_equality_a",
        conversationId: "conversation_equality",
        messageId: "message_equality_a",
        body: "first",
      }),
      eventFor({
        tenant,
        eventId: "event_equality_b",
        conversationId: "conversation_equality",
        messageId: "message_equality_b",
        body: "second",
        observedAt: "2026-09-07T01:00:02.000Z",
        occurredAt: "2026-09-07T01:00:01.000Z",
      }),
    ];
    const connections = [binding("account_a", "connection_a", "identity_a")];
    const firstPageCursor = cursorFor(tenant, "equality-page-2");
    const firstPage = pageFor(tenant, [firstEvents[0]!], firstPageCursor);
    const secondPage = pageFor(tenant, [firstEvents[1]!], null);
    await begin(stub, tenant, "rebuild_equal_one", 1);
    await replay(
      stub,
      tenant,
      "rebuild_equal_one",
      firstPage,
      null,
      connections,
    );
    await evictDurableObject(stub);
    stub = asRebuildStub(env.TENANT_PROJECTION.getByName(tenant));
    await expect(
      stub.getStatus({
        schema_version: 1,
        tenant_id: tenant,
        authorization: auth(tenant, ["projection.status"]),
      }),
    ).resolves.toMatchObject({
      state: "rebuilding",
      generation: 2,
      rebuild_id: "rebuild_equal_one",
      checkpoints: [{ value: firstPageCursor, source_cursor: null }],
    });
    await replay(
      stub,
      tenant,
      "rebuild_equal_one",
      secondPage,
      firstPageCursor,
      connections,
    );
    await stub.completeRebuild({
      schema_version: 1,
      tenant_id: tenant,
      rebuild_id: "rebuild_equal_one",
      terminal_cursor: null,
      completed_at: "2026-09-07T11:00:00.000Z",
      authorization: auth(tenant, ["projection.rebuild"]),
    });
    const firstDomain = await rows(
      stub,
      "SELECT id,identity_id,account_id,connection_id,conversation_id,body,occurred_at,current_observed_ms,current_event_id FROM messages ORDER BY id",
    );
    const firstSummary = await rows(
      stub,
      "SELECT id,identity_id,account_id,connection_id,title,last_message_preview,last_activity_at,unread_count,message_count,attachment_count FROM conversations ORDER BY id",
    );
    const firstQueries = {
      conversations: await stub.listConversations({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        connection_id: null,
        authorization: auth(tenant, ["projection.read"], ["identity_a"]),
      }),
      messages: await stub.listMessages({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        conversation_id: "conversation_equality",
        authorization: auth(tenant, ["projection.read"], ["identity_a"]),
      }),
      changes: await stub.listChanges({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        generation: 2,
        after_sequence: 0,
        authorization: auth(tenant, ["projection.read"], ["identity_a"]),
      }),
    };

    stub = asRebuildStub(env.TENANT_PROJECTION.getByName(tenant));
    const persisted = await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(tenant, ["projection.status"]),
    });
    expect(persisted).toMatchObject({
      state: "ready",
      generation: 2,
      last_completed_rebuild_id: "rebuild_equal_one",
    });

    await begin(stub, tenant, "rebuild_equal_two", 2);
    await expectCode(
      stub,
      (instance) =>
        replay(instance, tenant, "rebuild_equal_two", firstPage, null, [
          binding("account_a", "connection_changed", "identity_a"),
        ]),
      "projection_conflict",
    );
    await replay(
      stub,
      tenant,
      "rebuild_equal_two",
      firstPage,
      null,
      connections,
    );
    await replay(
      stub,
      tenant,
      "rebuild_equal_two",
      secondPage,
      firstPageCursor,
      connections,
    );
    await stub.completeRebuild({
      schema_version: 1,
      tenant_id: tenant,
      rebuild_id: "rebuild_equal_two",
      terminal_cursor: null,
      completed_at: "2026-09-07T12:00:00.000Z",
      authorization: auth(tenant, ["projection.rebuild"]),
    });
    const secondDomain = await rows(
      stub,
      "SELECT id,identity_id,account_id,connection_id,conversation_id,body,occurred_at,current_observed_ms,current_event_id FROM messages ORDER BY id",
    );
    const secondSummary = await rows(
      stub,
      "SELECT id,identity_id,account_id,connection_id,title,last_message_preview,last_activity_at,unread_count,message_count,attachment_count FROM conversations ORDER BY id",
    );
    expect(secondDomain).toEqual(firstDomain);
    expect(secondSummary).toEqual(firstSummary);
    const secondQueries = {
      conversations: await stub.listConversations({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        connection_id: null,
        authorization: auth(tenant, ["projection.read"], ["identity_a"]),
      }),
      messages: await stub.listMessages({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        conversation_id: "conversation_equality",
        authorization: auth(tenant, ["projection.read"], ["identity_a"]),
      }),
      changes: await stub.listChanges({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        generation: 3,
        after_sequence: 0,
        authorization: auth(tenant, ["projection.read"], ["identity_a"]),
      }),
    };
    expect(secondQueries.conversations).toEqual(firstQueries.conversations);
    expect(secondQueries.messages).toEqual(firstQueries.messages);
    expect(secondQueries.changes).toEqual({
      ...firstQueries.changes,
      generation: 3,
      items: firstQueries.changes.items.map((item) => ({
        ...item,
        generation: 3,
      })),
    });
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM completed_rebuilds"),
    ).resolves.toEqual([{ count: 2 }]);
    await expectCode(
      stub,
      (instance) => begin(instance, tenant, "rebuild_equal_one", 3),
      "projection_rebuild_mismatch",
    );
    await expectCode(
      stub,
      (instance) => begin(instance, tenant, "rebuild_equal_two", 3),
      "projection_rebuild_mismatch",
    );
  });
});
