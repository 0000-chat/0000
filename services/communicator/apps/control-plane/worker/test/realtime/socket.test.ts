import {
  MAX_REALTIME_CHANGES_PER_FRAME,
  MAX_REALTIME_ATTACHMENT_JSON_BYTES,
  MAX_REALTIME_REPLAY_CHANGES,
  REALTIME_CONNECTION_TTL_MS,
  REALTIME_SUBPROTOCOL,
  type ApplyProjectionBatchInput,
  type ProjectionAuthorizationContext,
  type ProjectionConnectionBinding,
  type ProjectionEventEnvelope,
  type RealtimeProjectionChange,
} from "@communicator/contracts";
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  batchRealtimeChanges,
  broadcastRealtimeChanges,
  resetRealtimeSocketsForRebuild,
  sendRealtimeFrame,
  REALTIME_SOCKET_TAG,
} from "../../realtime/tenant-sockets";
import { RealtimeSocketTelemetryEventSchema } from "../../realtime/telemetry";
import type {
  RealtimeSocketAttachment,
  RealtimeUpgradeContext,
} from "../../realtime/contracts";
import type { TenantProjectionDO } from "../../projection/tenant-projection";
import { clearDirectory } from "../support/directory-fixtures";

const TENANT = "tenant_socket_tests";
const INTERNAL_CONTEXT_HEADER = "X-Communicator-Realtime-Context";

const now = (): Date => new Date();

const context = (
  subscriptions: string[] = ["identity_human"],
  resume: RealtimeUpgradeContext["resume"] = [],
  overrides: Partial<RealtimeUpgradeContext> = {},
): RealtimeUpgradeContext => {
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + 30_000);
  return {
    schema_version: 1,
    tenant_id: TENANT,
    principal_id: "principal_human",
    membership_id: "membership_human",
    subscriptions: subscriptions.map((identity_id) => ({
      identity_id,
      families: ["projection"],
    })),
    resume,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    ...overrides,
  };
};

const contextForTenant = (
  tenant_id: string,
  subscriptions: string[] = ["identity_human"],
  resume: RealtimeUpgradeContext["resume"] = [],
  overrides: Partial<RealtimeUpgradeContext> = {},
): RealtimeUpgradeContext =>
  context(subscriptions, resume, { tenant_id, ...overrides });

const upgradeRequest = (
  realtimeContext: RealtimeUpgradeContext,
  overrides: {
    path?: string;
    protocol?: string;
    upgrade?: string;
    header?: string;
    contextJson?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): Request =>
  new Request(
    `https://tenant-projection.internal${overrides.path ?? "/realtime"}`,
    {
      method: "GET",
      headers: {
        Upgrade: overrides.upgrade ?? "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Protocol": overrides.protocol ?? REALTIME_SUBPROTOCOL,
        [overrides.header ?? INTERNAL_CONTEXT_HEADER]:
          overrides.contextJson ?? JSON.stringify(realtimeContext),
        ...overrides.extraHeaders,
      },
    },
  );

const authorization = (
  tenant_id = TENANT,
  allowed_identity_ids: string[] = ["identity_human", "identity_agent"],
  scopes: ProjectionAuthorizationContext["scopes"] = [
    "projection.initialize",
    "projection.write",
  ],
): ProjectionAuthorizationContext => ({
  schema_version: 1,
  tenant_id,
  principal_id: "principal_human",
  allowed_identity_ids: [...allowed_identity_ids].sort(),
  scopes: [...scopes].sort() as ProjectionAuthorizationContext["scopes"],
});

const binding = (
  identity_id: string,
  _index: number,
): ProjectionConnectionBinding => ({
  account_id: `account_${identity_id}`,
  connection_id: `connection_${identity_id}`,
  identity_id,
  platform: "whatsapp",
});

const event = (
  identity_id: string,
  index: number,
  _event_type: "conversation.updated" | undefined = undefined,
  tenant_id = TENANT,
): ProjectionEventEnvelope => ({
  schema_version: 1,
  event_id: `event_${identity_id}_${String(index).padStart(3, "0")}`,
  event_type: "conversation.updated",
  event_source: "live",
  tenant_id,
  identity_id,
  platform: "whatsapp",
  account_id: `account_${identity_id}`,
  conversation_id: `conversation_${identity_id}`,
  matrix_room_id: null,
  matrix_event_id: null,
  remote_message_id: null,
  occurred_at: new Date(Date.UTC(2026, 8, 10, 1, 0, index)).toISOString(),
  observed_at: new Date(Date.UTC(2026, 8, 10, 1, 0, index + 1)).toISOString(),
  payload: {
    title: `Conversation ${index}`,
    archived: false,
    muted: false,
  },
});

const applyInput = (
  events: ProjectionEventEnvelope[],
  identities: string[] = ["identity_human", "identity_agent"],
  tenant_id = TENANT,
): ApplyProjectionBatchInput => ({
  schema_version: 1,
  tenant_id,
  authorization: authorization(tenant_id, identities, ["projection.write"]),
  mode: "live",
  rebuild_id: null,
  connections: [...identities].sort().map(binding),
  events,
  checkpoint: null,
});

const initialize = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  tenant_id = TENANT,
): Promise<void> => {
  const database = env.CONTROL_DB as D1Database;
  await clearDirectory(database);
  const timestamp = "2026-09-10T00:00:00.000Z";
  const capacityRows: D1PreparedStatement[] = [];
  if (tenant_id === "tenant_socket_tenant_capacity") {
    for (let index = 0; index <= 256; index += 1) {
      const suffix = String(index).padStart(3, "0");
      capacityRows.push(
        database
          .prepare(
            "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, 'active', ?, ?)",
          )
          .bind(
            `principal_capacity_${suffix}`,
            "https://issuer.example/",
            `capacity-${tenant_id}-${suffix}`,
            `Capacity ${suffix}`,
            timestamp,
            timestamp,
          ),
        database
          .prepare(
            "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
          )
          .bind(
            `membership_capacity_${suffix}`,
            tenant_id,
            `principal_capacity_${suffix}`,
            timestamp,
            timestamp,
          ),
        database
          .prepare(
            "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, 'identity_human', 'conversation.read', ?)",
          )
          .bind(tenant_id, `membership_capacity_${suffix}`, timestamp),
      );
    }
  }
  await database.batch([
    database
      .prepare(
        "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      )
      .bind(tenant_id, tenant_id, tenant_id, timestamp, timestamp),
    database
      .prepare(
        "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, 'active', ?, ?)",
      )
      .bind(
        "principal_human",
        "https://issuer.example/",
        `human-${tenant_id}`,
        "Human",
        timestamp,
        timestamp,
      ),
    database
      .prepare(
        "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
      )
      .bind(
        "membership_human",
        tenant_id,
        "principal_human",
        timestamp,
        timestamp,
      ),
    database
      .prepare(
        "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'human', ?, 'active', ?, ?)",
      )
      .bind("identity_human", tenant_id, "Human", timestamp, timestamp),
    database
      .prepare(
        "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'agent', ?, 'active', ?, ?)",
      )
      .bind("identity_agent", tenant_id, "Agent", timestamp, timestamp),
    database
      .prepare(
        "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'human', ?, 'active', ?, ?)",
      )
      .bind("identity_unmatched", tenant_id, "Unmatched", timestamp, timestamp),
    ...["identity_human", "identity_agent", "identity_unmatched"].map(
      (identity_id) =>
        database
          .prepare(
            "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, 'conversation.read', ?)",
          )
          .bind(tenant_id, "membership_human", identity_id, timestamp),
    ),
    ...capacityRows,
  ]);
  await stub.initialize({
    schema_version: 1,
    tenant_id,
    initialized_at: "2026-09-10T00:00:00.000Z",
    authorization: authorization(tenant_id, [], ["projection.initialize"]),
  });
};

const frameMessages = async (
  response: Response,
  expectedCount: number,
): Promise<unknown[]> => {
  const socket = response.webSocket;
  if (socket === null)
    throw new Error("upgrade did not return a client socket");
  socket.accept();
  const messages: unknown[] = [];
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as unknown);
      if (messages.length >= expectedCount) resolve(messages);
    });
  });
};

type SocketFrame = Record<string, unknown>;

const waitForSocketFrames = (
  socket: WebSocket,
  predicate: (frame: SocketFrame) => boolean,
  expectedCount: number,
): Promise<SocketFrame[]> =>
  new Promise((resolve, reject) => {
    const frames: SocketFrame[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      if (timeout !== undefined) clearTimeout(timeout);
    };
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as SocketFrame;
      if (!predicate(frame)) return;
      frames.push(frame);
      if (frames.length === expectedCount) {
        cleanup();
        resolve(frames);
      }
    };
    socket.addEventListener("message", onMessage);
    timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for ${expectedCount} realtime frames`),
      );
    }, 1_000);
  });

type SocketFrameCollector = {
  readonly frames: SocketFrame[];
  stop: () => SocketFrame[];
};

const startSocketFrameCollector = (socket: WebSocket): SocketFrameCollector => {
  const frames: SocketFrame[] = [];
  const onMessage = (event: MessageEvent) => {
    frames.push(JSON.parse(String(event.data)) as SocketFrame);
  };
  socket.addEventListener("message", onMessage);
  return {
    frames,
    stop: () => {
      socket.removeEventListener("message", onMessage);
      return frames;
    },
  };
};

const waitForSocketQuiet = async (
  collector: SocketFrameCollector,
  milliseconds = 100,
): Promise<SocketFrame[]> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  return collector.stop();
};

const connectRealtimeSocket = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  realtimeContext: RealtimeUpgradeContext,
): Promise<{ socket: WebSocket; connected: SocketFrame }> => {
  const response = await stub.fetch(upgradeRequest(realtimeContext));
  const socket = response.webSocket;
  if (socket === null)
    throw new Error("upgrade did not return a client socket");
  const connectedFrame = waitForSocketFrames(
    socket,
    (frame) => frame.type === "connected",
    1,
  );
  socket.accept();
  const [connected] = await connectedFrame;
  if (connected === undefined) throw new Error("connected frame was missing");
  return { socket, connected };
};

const waitForClosed = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => {
    socket.addEventListener(
      "close",
      (event) => {
        resolve((event as CloseEvent).code);
      },
      { once: true },
    );
  });

const closeSocket = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  socket: WebSocket | null | undefined,
): Promise<void> => {
  if (socket === null || socket === undefined || socket.readyState === 3) {
    return;
  }
  // The workerd client-side socket does not reliably emit a local close event
  // after the initiating side calls close(). Close the server-side socket and
  // observe its authoritative tagged set instead of waiting on that event.
  socket.close(1000, "test complete");
  await runInDurableObject(stub, async (_instance, state) => {
    for (const serverSocket of state.getWebSockets(REALTIME_SOCKET_TAG)) {
      serverSocket.close(1000, "test complete");
    }
  });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(state.getWebSockets(REALTIME_SOCKET_TAG)).toHaveLength(0);
  });
};

const rows = async <T extends Record<string, SqlStorageValue>>(
  stub: DurableObjectStub<TenantProjectionDO>,
  sql: string,
): Promise<T[]> =>
  runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql.exec<T>(sql).toArray(),
  );

const REALTIME_TEST_APPLY_BATCH_SIZE = 100;

const applyBatchedEvents = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  tenant_id: string,
  events: ProjectionEventEnvelope[],
): Promise<void> => {
  for (
    let offset = 0;
    offset < events.length;
    offset += REALTIME_TEST_APPLY_BATCH_SIZE
  ) {
    await stub.applyBatch(
      applyInput(
        events.slice(offset, offset + REALTIME_TEST_APPLY_BATCH_SIZE),
        ["identity_human"],
        tenant_id,
      ),
    );
  }
};

const realtimeStub = (tenant = TENANT): DurableObjectStub<TenantProjectionDO> =>
  env.TENANT_PROJECTION.getByName(tenant);

describe("TenantProjectionDO hibernatable realtime sockets", () => {
  it("returns a 101 upgrade with the exact negotiated subprotocol", async () => {
    const stub = realtimeStub("tenant_socket_upgrade");
    await initialize(stub, "tenant_socket_upgrade");

    const response = await stub.fetch(
      upgradeRequest(contextForTenant("tenant_socket_upgrade")),
    );

    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
      REALTIME_SUBPROTOCOL,
    );
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    await closeSocket(stub, response.webSocket);
  });

  it("emits an accepted outcome through the fallback without private context", async () => {
    const tenant = "tenant_socket_telemetry_fallback";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let response: Response | undefined;
    try {
      response = await stub.fetch(
        upgradeRequest(
          context(["identity_human"], [], {
            tenant_id: tenant,
            principal_id: "principal_bearer_access_token_sentinel",
            membership_id: "membership_raw_ticket_sentinel",
          }),
        ),
      );

      expect(response.status).toBe(101);
      response.webSocket?.accept();
      expect(info).toHaveBeenCalledTimes(1);
      const logged = info.mock.calls[0]?.[0];
      expect(RealtimeSocketTelemetryEventSchema.safeParse(logged).success).toBe(
        true,
      );
      expect(logged).toEqual({
        schema_version: 1,
        type: "realtime.socket",
        outcome: "accepted",
        tenant_id: tenant,
        identity_id: "identity_human",
        active_tenant_socket_count: 1,
        resumed: false,
        timestamp: expect.any(String),
      });
      const serialized = JSON.stringify(info.mock.calls);
      for (const forbidden of [
        "principal_bearer_access_token_sentinel",
        "membership_raw_ticket_sentinel",
        "raw-error-sentinel",
        "raw-ticket-sentinel",
        "digest-sentinel",
        "internal-context-sentinel",
        "Bearer access-token-sentinel",
        "message body sentinel",
        "message preview sentinel",
        "matrix-id-sentinel",
        "remote-id-sentinel",
        "arbitrary-label-sentinel",
        "caller-controlled-object-sentinel",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await closeSocket(stub, response?.webSocket);
      info.mockRestore();
    }
  });

  it("rejects an external-shaped or malformed internal request before acceptance", async () => {
    const stub = realtimeStub("tenant_socket_boundary");
    await initialize(stub, "tenant_socket_boundary");

    await expect(
      stub.fetch(new Request("https://example.test/realtime")),
    ).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      stub.fetch(
        upgradeRequest(contextForTenant("tenant_socket_boundary"), {
          path: "/api/v1/realtime",
        }),
      ),
    ).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      stub.fetch(
        upgradeRequest(contextForTenant("tenant_socket_boundary"), {
          protocol: "wrong.protocol",
        }),
      ),
    ).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      stub.fetch(
        upgradeRequest(contextForTenant("tenant_socket_boundary"), {
          header: "Authorization",
        }),
      ),
    ).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      stub.fetch(
        upgradeRequest({
          ...contextForTenant("tenant_socket_boundary"),
          tenant_id: "bad",
        }),
      ),
    ).resolves.toMatchObject({
      status: 400,
    });
  });

  it("rejects caller-controlled headers on an internal upgrade", async () => {
    const tenant = "tenant_socket_extra_header";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);

    const response = await stub.fetch(
      upgradeRequest(contextForTenant(tenant), {
        extraHeaders: { "X-Caller-Controlled": "unexpected" },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.webSocket).toBeNull();
  });

  it("rejects an oversized serialized context before JSON parsing", async () => {
    const tenant = "tenant_socket_oversized_context";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const serializedContextValue = JSON.stringify(contextForTenant(tenant));
    const serializedContext = `${serializedContextValue.slice(0, -1)}${" ".repeat(MAX_REALTIME_ATTACHMENT_JSON_BYTES)}${serializedContextValue.slice(-1)}`;

    const response = await stub.fetch(
      upgradeRequest(contextForTenant(tenant), {
        contextJson: serializedContext,
      }),
    );

    expect(response.status).toBe(400);
    expect(response.webSocket).toBeNull();
  });

  it("sends connected positions on a fresh connection without replay", async () => {
    const tenant = "tenant_socket_fresh";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    await stub.applyBatch(
      applyInput(
        [
          event("identity_human", 1, undefined, tenant),
          event("identity_agent", 1, undefined, tenant),
          event("identity_human", 2, undefined, tenant),
        ],
        ["identity_human", "identity_agent"],
        tenant,
      ),
    );

    const response = await stub.fetch(upgradeRequest(contextForTenant(tenant)));
    const messages = await frameMessages(response, 1);

    expect(messages).toEqual([
      {
        schema_version: 1,
        type: "connected",
        tenant_id: tenant,
        positions: [
          { identity_id: "identity_human", generation: 1, sequence: 2 },
        ],
        connection_expires_at: expect.any(String),
      },
    ]);
    await closeSocket(stub, response.webSocket);
  });

  it("replays only identity-local retained metadata in sequence order", async () => {
    const tenant = "tenant_socket_replay";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    await stub.applyBatch(
      applyInput(
        [
          event("identity_human", 1, undefined, tenant),
          event("identity_agent", 1, undefined, tenant),
          event("identity_human", 2, undefined, tenant),
          event("identity_agent", 2, undefined, tenant),
        ],
        ["identity_human", "identity_agent"],
        tenant,
      ),
    );

    const response = await stub.fetch(
      upgradeRequest(
        contextForTenant(
          tenant,
          ["identity_human"],
          [{ identity_id: "identity_human", generation: 1, after_sequence: 0 }],
        ),
      ),
    );
    const messages = await frameMessages(response, 2);

    expect(messages[0]).toMatchObject({
      type: "connected",
      positions: [
        { identity_id: "identity_human", generation: 1, sequence: 0 },
      ],
    });
    expect(messages[1]).toMatchObject({
      type: "projection.changes",
      identity_id: "identity_human",
      generation: 1,
      from_sequence: 1,
      to_sequence: 3,
      changes: [
        { sequence: 1, event_type: "conversation.updated" },
        { sequence: 2, event_type: "conversation.updated" },
      ],
    });
    expect(JSON.stringify(messages)).not.toContain("event_identity_agent");
    await closeSocket(stub, response.webSocket);
  });

  it("chunks replay frames at the public 100-change limit", async () => {
    const changes: RealtimeProjectionChange[] = Array.from(
      { length: 201 },
      (_, index) => ({
        sequence: index + 1,
        event_type: "conversation.updated",
        connection_id: "connection_human",
        conversation_id: "conversation_human",
        occurred_at: "2026-09-10T01:00:00.000Z",
      }),
    );
    expect(
      batchRealtimeChanges(changes, MAX_REALTIME_CHANGES_PER_FRAME).map(
        (batch) => batch.length,
      ),
    ).toEqual([100, 100, 1]);
    expect(
      batchRealtimeChanges(changes, MAX_REALTIME_CHANGES_PER_FRAME).flat()
        .length,
    ).toBe(201);
  });

  it.each([
    ["generation_changed", { generation: 2, after_sequence: 0 }],
    ["history_unavailable", { generation: 1, after_sequence: 2 }],
  ] as const)(
    "sends an exact %s reset and keeps the socket open",
    async (reason, position) => {
      const tenant = `tenant_socket_reset_${reason}`;
      const stub = realtimeStub(tenant);
      await initialize(stub, tenant);
      await stub.applyBatch(
        applyInput(
          [event("identity_human", 1, undefined, tenant)],
          ["identity_human"],
          tenant,
        ),
      );

      const response = await stub.fetch(
        upgradeRequest(
          contextForTenant(
            tenant,
            ["identity_human"],
            [
              {
                identity_id: "identity_human",
                generation: position.generation,
                after_sequence: position.after_sequence,
              },
            ],
          ),
        ),
      );
      const messages = await frameMessages(response, 2);
      const reset = messages.find(
        (message) => (message as { type?: string }).type === "reset_required",
      ) as Record<string, unknown> | undefined;

      expect(reset).toEqual({
        schema_version: 1,
        type: "reset_required",
        tenant_id: tenant,
        identity_id: "identity_human",
        generation: 1,
        latest_sequence: 1,
        reason,
      });
      expect(response.webSocket?.readyState).not.toBe(3);
      await closeSocket(stub, response.webSocket);
    },
  );

  it("sends reset_required for exactly 501 retained changes populated through applyBatch", async () => {
    const tenant = "tenant_socket_replay_too_large";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const events = Array.from(
      { length: MAX_REALTIME_REPLAY_CHANGES + 1 },
      (_, index) => event("identity_human", index + 1, undefined, tenant),
    );
    await applyBatchedEvents(stub, tenant, events);

    await expect(
      rows<{ count: number }>(
        stub,
        "SELECT COUNT(*) AS count FROM projection_changes WHERE identity_id = 'identity_human' AND generation = 1",
      ),
    ).resolves.toEqual([{ count: MAX_REALTIME_REPLAY_CHANGES + 1 }]);

    const response = await stub.fetch(
      upgradeRequest(
        contextForTenant(
          tenant,
          ["identity_human"],
          [{ identity_id: "identity_human", generation: 1, after_sequence: 0 }],
        ),
      ),
    );
    const messages = await frameMessages(response, 2);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "connected",
      positions: [
        { identity_id: "identity_human", generation: 1, sequence: 0 },
      ],
    });
    expect(messages[1]).toEqual({
      schema_version: 1,
      type: "reset_required",
      tenant_id: tenant,
      identity_id: "identity_human",
      generation: 1,
      latest_sequence: MAX_REALTIME_REPLAY_CHANGES + 1,
      reason: "replay_too_large",
    });
    await closeSocket(stub, response.webSocket);
  });

  it("chunks exactly 101 retained changes into contiguous 100-change and one-change frames", async () => {
    const tenant = "tenant_socket_replay_chunk_boundary";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const events = Array.from(
      { length: MAX_REALTIME_CHANGES_PER_FRAME + 1 },
      (_, index) => event("identity_human", index + 1, undefined, tenant),
    );
    await applyBatchedEvents(stub, tenant, events);

    await expect(
      rows<{ count: number }>(
        stub,
        "SELECT COUNT(*) AS count FROM projection_changes WHERE identity_id = 'identity_human' AND generation = 1",
      ),
    ).resolves.toEqual([{ count: MAX_REALTIME_CHANGES_PER_FRAME + 1 }]);

    const response = await stub.fetch(
      upgradeRequest(
        contextForTenant(
          tenant,
          ["identity_human"],
          [{ identity_id: "identity_human", generation: 1, after_sequence: 0 }],
        ),
      ),
    );
    const messages = await frameMessages(response, 3);
    const changeFrames = messages.slice(1) as Array<{
      type: "projection.changes";
      identity_id: string;
      generation: number;
      from_sequence: number;
      to_sequence: number;
      changes: Array<{ sequence: number }>;
    }>;

    expect(messages[0]).toMatchObject({
      type: "connected",
      positions: [
        { identity_id: "identity_human", generation: 1, sequence: 0 },
      ],
    });
    expect(changeFrames).toHaveLength(2);
    expect(changeFrames.map((frame) => frame.type)).toEqual([
      "projection.changes",
      "projection.changes",
    ]);
    expect(changeFrames.map((frame) => frame.changes)).toHaveLength(2);
    expect(changeFrames.map((frame) => frame.changes.length)).toEqual([100, 1]);
    expect(
      changeFrames.map((frame) => [frame.from_sequence, frame.to_sequence]),
    ).toEqual([
      [1, 101],
      [101, 102],
    ]);
    expect(
      changeFrames.every(
        (frame) =>
          frame.identity_id === "identity_human" && frame.generation === 1,
      ),
    ).toBe(true);
    expect(
      changeFrames.flatMap((frame) =>
        frame.changes.map((change) => change.sequence),
      ),
    ).toEqual(
      Array.from(
        { length: MAX_REALTIME_CHANGES_PER_FRAME + 1 },
        (_, index) => index + 1,
      ),
    );
    await closeSocket(stub, response.webSocket);
  });

  it("broadcasts one newly persisted live change once to a matching identity socket", async () => {
    const tenant = "tenant_socket_live_broadcast";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const { socket } = await connectRealtimeSocket(
      stub,
      contextForTenant(tenant, ["identity_human"]),
    );

    try {
      const nextFrame = waitForSocketFrames(
        socket,
        (frame) => frame.type === "projection.changes",
        1,
      );
      const applied = await stub.applyBatch(
        applyInput(
          [event("identity_human", 1, undefined, tenant)],
          ["identity_human"],
          tenant,
        ),
      );

      const persisted = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          changes: state.storage.sql
            .exec<{
              identity_sequence: number;
              event_type: string;
              connection_id: string;
              conversation_id: string;
              occurred_at: string;
            }>(
              "SELECT identity_sequence, event_type, connection_id, conversation_id, occurred_at FROM projection_changes ORDER BY sequence",
            )
            .toArray(),
          identities: state.storage.sql
            .exec<{
              identity_id: string;
              latest_sequence: number;
            }>(
              "SELECT identity_id, latest_sequence FROM projection_identity_sequences ORDER BY identity_id",
            )
            .toArray(),
        }),
      );

      expect(applied).toMatchObject({
        applied_count: 1,
        duplicate_count: 0,
        last_sequence: 1,
      });
      expect(persisted).toEqual({
        changes: [
          {
            identity_sequence: 1,
            event_type: "conversation.updated",
            connection_id: "connection_identity_human",
            conversation_id: "conversation_identity_human",
            occurred_at: "2026-09-10T01:00:01.000Z",
          },
        ],
        identities: [{ identity_id: "identity_human", latest_sequence: 1 }],
      });

      const [frame] = await nextFrame;
      expect(frame).toEqual({
        schema_version: 1,
        type: "projection.changes",
        tenant_id: tenant,
        identity_id: "identity_human",
        generation: 1,
        from_sequence: 1,
        to_sequence: 2,
        changes: [
          {
            sequence: 1,
            event_type: "conversation.updated",
            connection_id: "connection_identity_human",
            conversation_id: "conversation_identity_human",
            occurred_at: "2026-09-10T01:00:01.000Z",
          },
        ],
      });
    } finally {
      await closeSocket(stub, socket);
    }
  });

  it("closes an open socket when its current identity grant is revoked before broadcast", async () => {
    const tenant = "tenant_socket_revalidation_revoked";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const { socket } = await connectRealtimeSocket(
      stub,
      contextForTenant(tenant, ["identity_human"]),
    );
    const collector = startSocketFrameCollector(socket);
    const closed = waitForClosed(socket);

    await (env.CONTROL_DB as D1Database)
      .prepare(
        "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND operation_scope = 'conversation.read'",
      )
      .bind(tenant, "membership_human", "identity_human")
      .run();
    await stub.applyBatch(
      applyInput(
        [event("identity_human", 1, undefined, tenant)],
        ["identity_human"],
        tenant,
      ),
    );

    expect(await closed).toBe(1008);
    expect(await waitForSocketQuiet(collector)).toEqual([]);
  });

  it("does not advance an identity sequence or broadcast on a duplicate retry", async () => {
    const tenant = "tenant_socket_duplicate_live";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const { socket } = await connectRealtimeSocket(
      stub,
      contextForTenant(tenant, ["identity_human"]),
    );
    const liveEvent = event("identity_human", 1, undefined, tenant);

    try {
      const firstFrame = waitForSocketFrames(
        socket,
        (frame) => frame.type === "projection.changes",
        1,
      );
      await stub.applyBatch(
        applyInput([liveEvent], ["identity_human"], tenant),
      );
      await firstFrame;

      const duplicateFrames = startSocketFrameCollector(socket);
      const duplicate = await stub.applyBatch(
        applyInput([liveEvent], ["identity_human"], tenant),
      );
      const persisted = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          changes: state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM projection_changes WHERE identity_id = 'identity_human'",
            )
            .toArray(),
          sequence: state.storage.sql
            .exec<{ latest_sequence: number }>(
              "SELECT latest_sequence FROM projection_identity_sequences WHERE identity_id = 'identity_human'",
            )
            .toArray(),
        }),
      );
      const frames = await waitForSocketQuiet(duplicateFrames);

      expect(duplicate).toMatchObject({
        applied_count: 0,
        duplicate_count: 1,
        last_sequence: 1,
      });
      expect(persisted).toEqual({
        changes: [{ count: 1 }],
        sequence: [{ latest_sequence: 1 }],
      });
      expect(frames).toEqual([]);
    } finally {
      await closeSocket(stub, socket);
    }
  });

  it("delivers live changes only to matching identity subscriptions", async () => {
    const tenant = "tenant_socket_live_isolation";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const human = await connectRealtimeSocket(
      stub,
      contextForTenant(tenant, ["identity_human"]),
    );
    const agent = await connectRealtimeSocket(
      stub,
      contextForTenant(tenant, ["identity_agent"]),
    );
    const unmatched = await connectRealtimeSocket(
      stub,
      contextForTenant(tenant, ["identity_unmatched"]),
    );

    try {
      const humanFrames = startSocketFrameCollector(human.socket);
      const agentFrames = startSocketFrameCollector(agent.socket);
      const unmatchedFrames = startSocketFrameCollector(unmatched.socket);

      await stub.applyBatch(
        applyInput(
          [event("identity_human", 1, undefined, tenant)],
          ["identity_human"],
          tenant,
        ),
      );
      await stub.applyBatch(
        applyInput(
          [event("identity_agent", 1, undefined, tenant)],
          ["identity_agent"],
          tenant,
        ),
      );

      const [humanMessages, agentMessages, unmatchedMessages] =
        await Promise.all([
          waitForSocketQuiet(humanFrames),
          waitForSocketQuiet(agentFrames),
          waitForSocketQuiet(unmatchedFrames),
        ]);
      const projectionFrames = (frames: readonly SocketFrame[]) =>
        frames.filter((frame) => frame.type === "projection.changes");

      expect(projectionFrames(humanMessages)).toHaveLength(1);
      expect(projectionFrames(humanMessages)[0]).toMatchObject({
        identity_id: "identity_human",
        changes: [{ sequence: 1, connection_id: "connection_identity_human" }],
      });
      expect(projectionFrames(agentMessages)).toHaveLength(1);
      expect(projectionFrames(agentMessages)[0]).toMatchObject({
        identity_id: "identity_agent",
        changes: [{ sequence: 1, connection_id: "connection_identity_agent" }],
      });
      expect(projectionFrames(unmatchedMessages)).toEqual([]);
    } finally {
      await Promise.all([
        closeSocket(stub, human.socket),
        closeSocket(stub, agent.socket),
        closeSocket(stub, unmatched.socket),
      ]);
    }
  });

  it("chunks 201 newly applied live changes into 100, 100, and 1 frames", async () => {
    const tenant = "tenant_socket_live_chunking";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const { socket } = await connectRealtimeSocket(
      stub,
      contextForTenant(tenant, ["identity_human"]),
    );

    try {
      const framesPromise = waitForSocketFrames(
        socket,
        (frame) => frame.type === "projection.changes",
        3,
      );
      const events = Array.from({ length: 201 }, (_, index) =>
        event("identity_human", index + 1, undefined, tenant),
      );
      const applied = await stub.applyBatch(
        applyInput(events, ["identity_human"], tenant),
      );
      const frames = await framesPromise;

      expect(applied).toMatchObject({
        applied_count: 201,
        duplicate_count: 0,
        last_sequence: 201,
      });
      expect(
        frames.map((frame) => (frame.changes as unknown[]).length),
      ).toEqual([100, 100, 1]);
      expect(
        frames.map((frame) => [frame.from_sequence, frame.to_sequence]),
      ).toEqual([
        [1, 101],
        [101, 201],
        [201, 202],
      ]);
      expect(
        frames.every(
          (frame) =>
            frame.tenant_id === tenant &&
            frame.identity_id === "identity_human" &&
            frame.generation === 1,
        ),
      ).toBe(true);
    } finally {
      await closeSocket(stub, socket);
    }
  });

  it("keeps durable projection state and replay after an individual socket send failure", async () => {
    const tenant = "tenant_socket_send_failure";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const { socket } = await connectRealtimeSocket(
      stub,
      contextForTenant(tenant, ["identity_human"]),
    );
    const liveEvent = event("identity_human", 1, undefined, tenant);
    const closed = waitForClosed(socket);

    try {
      await runInDurableObject(stub, async (_instance, state) => {
        const serverSocket = state.getWebSockets("realtime")[0];
        if (serverSocket === undefined)
          throw new Error("server socket was missing");
        (serverSocket as unknown as { send: (message: string) => void }).send =
          () => {
            throw new Error("synthetic realtime send failure");
          };
      });

      await expect(
        stub.applyBatch(applyInput([liveEvent], ["identity_human"], tenant)),
      ).resolves.toMatchObject({
        applied_count: 1,
        duplicate_count: 0,
        last_sequence: 1,
      });
      const persisted = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          changes: state.storage.sql
            .exec<{
              identity_sequence: number;
              event_type: string;
              connection_id: string;
              conversation_id: string;
            }>(
              "SELECT identity_sequence, event_type, connection_id, conversation_id FROM projection_changes ORDER BY sequence",
            )
            .toArray(),
          latest: state.storage.sql
            .exec<{ latest_sequence: number }>(
              "SELECT latest_sequence FROM projection_identity_sequences WHERE identity_id = 'identity_human'",
            )
            .toArray(),
        }),
      );
      expect(persisted).toEqual({
        changes: [
          {
            identity_sequence: 1,
            event_type: "conversation.updated",
            connection_id: "connection_identity_human",
            conversation_id: "conversation_identity_human",
          },
        ],
        latest: [{ latest_sequence: 1 }],
      });
      expect(await closed).toBe(1011);

      const replayResponse = await stub.fetch(
        upgradeRequest(
          contextForTenant(
            tenant,
            ["identity_human"],
            [
              {
                identity_id: "identity_human",
                generation: 1,
                after_sequence: 0,
              },
            ],
          ),
        ),
      );
      const replayMessages = await frameMessages(replayResponse, 2);
      expect(replayMessages[1]).toMatchObject({
        type: "projection.changes",
        tenant_id: tenant,
        identity_id: "identity_human",
        generation: 1,
        from_sequence: 1,
        to_sequence: 2,
        changes: [{ sequence: 1, connection_id: "connection_identity_human" }],
      });
      await closeSocket(stub, replayResponse.webSocket);
    } finally {
      await closeSocket(stub, socket);
    }
  });

  it("survives DO eviction with attachment-backed ping/pong", async () => {
    const tenant = "tenant_socket_eviction";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const response = await stub.fetch(upgradeRequest(contextForTenant(tenant)));
    const socket = response.webSocket;
    if (socket === null) throw new Error("missing socket");
    socket.accept();

    await evictDurableObject(stub, { webSockets: "hibernate" });

    const pong = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        if (event.data === "pong") resolve();
      });
    });
    socket.send("ping");
    await expect(pong).resolves.toBeUndefined();
    await closeSocket(stub, socket);
  });

  it("deserializes hibernated attachments before closing only the unsupported message socket", async () => {
    const tenant = "tenant_socket_eviction_message";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const rejectedResponse = await stub.fetch(
      upgradeRequest(contextForTenant(tenant)),
    );
    const peerResponse = await stub.fetch(
      upgradeRequest(contextForTenant(tenant, ["identity_agent"])),
    );
    const rejectedSocket = rejectedResponse.webSocket;
    const peerSocket = peerResponse.webSocket;
    if (rejectedSocket === null || peerSocket === null)
      throw new Error("missing sockets");
    rejectedSocket.accept();
    peerSocket.accept();

    try {
      await evictDurableObject(stub, { webSockets: "hibernate" });

      const closed = waitForClosed(rejectedSocket);
      rejectedSocket.send("subscribe");

      expect(await closed).toBe(1008);
      expect(rejectedSocket.readyState).toBe(3);
      expect(peerSocket.readyState).not.toBe(3);
    } finally {
      await closeSocket(stub, peerSocket);
    }
  });

  it("closes other text and every binary message with policy code 1008", async () => {
    const tenant = "tenant_socket_messages";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const response = await stub.fetch(upgradeRequest(contextForTenant(tenant)));
    const socket = response.webSocket;
    if (socket === null) throw new Error("missing socket");
    socket.accept();
    const closed = waitForClosed(socket);
    socket.send("subscribe");
    expect(await closed).toBe(1008);
    expect(socket.readyState).toBe(3);

    const second = await stub.fetch(upgradeRequest(contextForTenant(tenant)));
    const secondSocket = second.webSocket;
    if (secondSocket === null) throw new Error("missing second socket");
    secondSocket.accept();
    const secondClosed = waitForClosed(secondSocket);
    secondSocket.send(new Uint8Array([1, 2, 3]));
    expect(await secondClosed).toBe(1008);
    expect(secondSocket.readyState).toBe(3);
    expect(socket).toBeDefined();
  });

  it("enforces eight sockets per principal before accepting the ninth", async () => {
    const tenant = "tenant_socket_principal_capacity";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const responses: Response[] = [];
    for (let index = 0; index < 8; index += 1) {
      responses.push(
        await stub.fetch(upgradeRequest(contextForTenant(tenant))),
      );
    }
    expect(responses.every((response) => response.status === 101)).toBe(true);
    const rejected = await stub.fetch(upgradeRequest(contextForTenant(tenant)));
    expect(rejected.status).toBe(503);
    for (const response of responses) {
      response.webSocket?.accept();
    }
    await Promise.all(
      responses.map((response) => closeSocket(stub, response.webSocket)),
    );
  });

  it("accepts 256 distinct principals and rejects the 257th tenant socket with bounded 503", async () => {
    const tenant = "tenant_socket_tenant_capacity";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const acceptedSockets: WebSocket[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      for (let index = 0; index < 256; index += 1) {
        const response = await stub.fetch(
          upgradeRequest(
            contextForTenant(tenant, ["identity_human"], [], {
              principal_id: `principal_capacity_${String(index).padStart(3, "0")}`,
              membership_id: `membership_capacity_${String(index).padStart(3, "0")}`,
            }),
          ),
        );
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null)
          throw new Error("accepted upgrade did not return a client socket");
        socket.accept();
        acceptedSockets.push(socket);
      }
      expect(acceptedSockets).toHaveLength(256);

      const rejected = await stub.fetch(
        upgradeRequest(
          contextForTenant(tenant, ["identity_human"], [], {
            principal_id: "principal_capacity_256",
            membership_id: "membership_capacity_256",
          }),
        ),
      );

      expect(rejected.status).toBe(503);
      expect(rejected.webSocket).toBeNull();
      await expect(rejected.json()).resolves.toEqual({
        error: {
          code: "service_unavailable",
          message: "Realtime service unavailable",
        },
      });
    } finally {
      await Promise.all(
        acceptedSockets.map((socket) => closeSocket(stub, socket)),
      );
      info.mockRestore();
    }
  }, 60_000);

  it("closes only a socket with a corrupt attachment", async () => {
    const tenant = "tenant_socket_corrupt_attachment";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const response = await stub.fetch(upgradeRequest(contextForTenant(tenant)));
    const socket = response.webSocket;
    if (socket === null) throw new Error("missing socket");
    socket.accept();
    await runInDurableObject(stub, async (_instance, state) => {
      const sockets = state.getWebSockets("realtime");
      sockets[0]?.serializeAttachment({ corrupt: true });
    });
    const closed = waitForClosed(socket);
    socket.send("invalid");
    expect(await closed).toBe(1008);
    expect(socket.readyState).toBe(3);
  });

  it("closes only a socket with an incomplete restored attachment", async () => {
    const tenant = "tenant_socket_incomplete_attachment";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const validResponse = await stub.fetch(
      upgradeRequest(contextForTenant(tenant)),
    );
    const incompleteResponse = await stub.fetch(
      upgradeRequest(
        contextForTenant(tenant, ["identity_human", "identity_agent"]),
      ),
    );
    const validSocket = validResponse.webSocket;
    const incompleteSocket = incompleteResponse.webSocket;
    if (validSocket === null || incompleteSocket === null) {
      throw new Error("missing sockets");
    }
    validSocket.accept();
    incompleteSocket.accept();

    await runInDurableObject(stub, async (_instance, state) => {
      for (const socket of state.getWebSockets("realtime")) {
        const attachment = socket.deserializeAttachment() as {
          subscriptions?: unknown[];
          positions?: unknown[];
        };
        if (
          attachment.subscriptions?.length === 2 &&
          attachment.positions !== undefined
        ) {
          socket.serializeAttachment({
            ...attachment,
            positions: attachment.positions.slice(0, 1),
          });
        }
      }
    });
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const closed = waitForClosed(incompleteSocket);
    await runInDurableObject(stub, async (instance, state) => {
      for (const socket of state.getWebSockets("realtime")) {
        instance.webSocketMessage(socket, "ping");
      }
    });

    expect(await closed).toBe(1008);
    expect(validSocket.readyState).not.toBe(3);
    await closeSocket(stub, validSocket);
  });

  it("closes expired sockets and reschedules the earliest remaining lease", async () => {
    const tenant = "tenant_socket_alarm";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    const expiredResponse = await stub.fetch(
      upgradeRequest(contextForTenant(tenant)),
    );
    const remainingResponse = await stub.fetch(
      upgradeRequest(contextForTenant(tenant, ["identity_agent"])),
    );
    const expiredSocket = expiredResponse.webSocket;
    const remainingSocket = remainingResponse.webSocket;
    if (expiredSocket === null || remainingSocket === null)
      throw new Error("missing sockets");
    expiredSocket.accept();
    remainingSocket.accept();
    const remainingExpiry = new Date(
      Date.now() + REALTIME_CONNECTION_TTL_MS / 2,
    ).toISOString();
    await runInDurableObject(stub, async (_instance, state) => {
      const sockets = state.getWebSockets("realtime");
      sockets[0]?.serializeAttachment({
        schema_version: 1,
        tenant_id: tenant,
        principal_id: "principal_human",
        membership_id: "membership_human",
        subscriptions: [
          { identity_id: "identity_human", families: ["projection"] },
        ],
        positions: [
          { identity_id: "identity_human", generation: 1, sequence: 0 },
        ],
        lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
        resumed: false,
      });
      sockets[1]?.serializeAttachment({
        schema_version: 1,
        tenant_id: tenant,
        principal_id: "principal_human",
        membership_id: "membership_human",
        subscriptions: [
          { identity_id: "identity_agent", families: ["projection"] },
        ],
        positions: [
          { identity_id: "identity_agent", generation: 1, sequence: 0 },
        ],
        lease_expires_at: remainingExpiry,
        resumed: false,
      });
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    expect(expiredSocket.readyState).toBe(3);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.parse(remainingExpiry));
    });
    await closeSocket(stub, remainingSocket);
  });

  it("never exposes forbidden identifiers or content in server frames", async () => {
    const tenant = "tenant_socket_privacy";
    const stub = realtimeStub(tenant);
    await initialize(stub, tenant);
    await stub.applyBatch(
      applyInput(
        [event("identity_human", 1, undefined, tenant)],
        ["identity_human"],
        tenant,
      ),
    );
    const response = await stub.fetch(
      upgradeRequest(
        contextForTenant(
          tenant,
          ["identity_human"],
          [{ identity_id: "identity_human", generation: 1, after_sequence: 0 }],
        ),
      ),
    );
    const messages = await frameMessages(response, 2);
    const serialized = JSON.stringify(messages);
    for (const forbidden of [
      "event_identity_human_001",
      "message body",
      "preview",
      "!matrix-room:example",
      "remote-id",
      "rt1_raw-ticket",
      "internal-context",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await closeSocket(stub, response.webSocket);
  });

  it("sends frames through the strict public schema", () => {
    const socket = {
      send: (message: string) =>
        expect(JSON.parse(message)).toMatchObject({ type: "connected" }),
    } as unknown as WebSocket;
    sendRealtimeFrame(socket, {
      schema_version: 1,
      type: "connected",
      tenant_id: TENANT,
      positions: [
        { identity_id: "identity_human", generation: 1, sequence: 0 },
      ],
      connection_expires_at: "2026-09-11T00:00:00.000Z",
    });
  });

  it("filters Platform live changes by account and resets across a denied sequence", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const attachment: RealtimeSocketAttachment = {
      schema_version: 1,
      tenant_id: TENANT,
      principal_id: "principal_human",
      membership_id: "membership_human",
      subscriptions: [
        { identity_id: "identity_human", families: ["projection"] },
      ],
      positions: [
        { identity_id: "identity_human", generation: 1, sequence: 0 },
      ],
      lease_expires_at: expiresAt,
      resumed: false,
      platform: {
        binding_id: "binding_platform_human",
        authority: "platform-test-authority",
        kind: "human",
        subject_id: "platform-user",
        organization_id: "platform-org",
        membership_id: "platform-membership",
        grant_id: null,
        credential_id: "credential-platform-user",
        expires_at: expiresAt,
      },
    };
    let storedAttachment: unknown = attachment;
    const messages: unknown[] = [];
    let closeCode: number | undefined;
    const socket = {
      close: (code: number) => {
        closeCode = code;
      },
      deserializeAttachment: () => storedAttachment,
      serializeAttachment: (value: unknown) => {
        storedAttachment = value;
      },
      send: (message: string) => messages.push(JSON.parse(message)),
    };
    const changes = [
      {
        identity_id: "identity_human",
        account_id: "account_allowed",
        generation: 1,
        sequence: 1,
        event_type: "conversation.updated" as const,
        connection_id: "connection_allowed",
        conversation_id: "conversation_allowed",
        occurred_at: expiresAt,
      },
      {
        identity_id: "identity_human",
        account_id: "account_denied",
        generation: 1,
        sequence: 2,
        event_type: "conversation.updated" as const,
        connection_id: "connection_denied",
        conversation_id: "conversation_denied",
        occurred_at: expiresAt,
      },
    ];

    broadcastRealtimeChanges(
      [socket],
      TENANT,
      changes,
      (_socket, _currentAttachment, change) =>
        change.account_id === "account_allowed",
    );

    expect(closeCode).toBeUndefined();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "projection.changes",
      from_sequence: 1,
      to_sequence: 2,
      changes: [{ sequence: 1, conversation_id: "conversation_allowed" }],
    });
    expect(messages[1]).toMatchObject({
      type: "reset_required",
      latest_sequence: 2,
      reason: "history_unavailable",
    });
    expect(JSON.stringify(messages)).not.toContain("account_denied");
    expect((storedAttachment as RealtimeSocketAttachment).positions).toEqual([
      { identity_id: "identity_human", generation: 1, sequence: 2 },
    ]);
  });

  it("rejects live delivery after a lease expires even before the alarm runs", () => {
    const storedAttachment: RealtimeSocketAttachment = {
      schema_version: 1,
      tenant_id: TENANT,
      principal_id: "principal_human",
      membership_id: "membership_human",
      subscriptions: [
        { identity_id: "identity_human", families: ["projection"] },
      ],
      positions: [
        { identity_id: "identity_human", generation: 1, sequence: 0 },
      ],
      lease_expires_at: new Date(Date.now() - 1).toISOString(),
      resumed: false,
    };
    let closeCode: number | undefined;
    let sends = 0;
    const socket = {
      close: (code: number) => {
        closeCode = code;
      },
      deserializeAttachment: () => storedAttachment,
      serializeAttachment: () => undefined,
      send: () => {
        sends += 1;
      },
    };
    broadcastRealtimeChanges([socket], TENANT, [
      {
        identity_id: "identity_human",
        account_id: "account_allowed",
        generation: 1,
        sequence: 1,
        event_type: "conversation.updated",
        connection_id: "connection_allowed",
        conversation_id: "conversation_allowed",
        occurred_at: new Date().toISOString(),
      },
    ]);
    expect(closeCode).toBe(1000);
    expect(sends).toBe(0);
  });

  it("does not send rebuild resets to expired or revalidation-rejected sockets", () => {
    const makeSocket = (leaseExpiresAt: string) => {
      const attachment: RealtimeSocketAttachment = {
        schema_version: 1,
        tenant_id: TENANT,
        principal_id: "principal_human",
        membership_id: "membership_human",
        subscriptions: [
          { identity_id: "identity_human", families: ["projection"] },
        ],
        positions: [
          { identity_id: "identity_human", generation: 1, sequence: 0 },
        ],
        lease_expires_at: leaseExpiresAt,
        resumed: false,
      };
      let sends = 0;
      let closeCode: number | undefined;
      return {
        socket: {
          close: (code: number) => {
            closeCode = code;
          },
          deserializeAttachment: () => attachment,
          serializeAttachment: () => undefined,
          send: () => {
            sends += 1;
          },
        },
        get sends() {
          return sends;
        },
        get closeCode() {
          return closeCode;
        },
      };
    };
    const expired = makeSocket(new Date(Date.now() - 1).toISOString());
    const rejected = makeSocket(new Date(Date.now() + 60_000).toISOString());

    resetRealtimeSocketsForRebuild(
      [expired.socket, rejected.socket],
      TENANT,
      2,
      (socket) => socket !== rejected.socket,
    );

    expect(expired.sends).toBe(0);
    expect(expired.closeCode).toBe(1000);
    expect(rejected.sends).toBe(0);
    expect(rejected.closeCode).toBe(1008);
  });
});
