import { describe, expect, it } from "vitest";
import {
  MAX_REALTIME_ATTACHMENT_JSON_BYTES,
  MAX_REALTIME_CHANGES_PER_FRAME,
  MAX_REALTIME_ID_LENGTH,
  MAX_REALTIME_IDENTITIES,
  MAX_REALTIME_REPLAY_CHANGES,
  MAX_REALTIME_SOCKETS_PER_PRINCIPAL,
  MAX_REALTIME_SOCKETS_PER_TENANT,
  REALTIME_CONNECTION_TTL_MS,
  REALTIME_SUBPROTOCOL,
  REALTIME_TICKET_TTL_MS,
  RealtimeConnectedFrameSchema,
  RealtimeProjectionChangesFrameSchema,
  RealtimeResetRequiredFrameSchema,
  RealtimeServerFrameSchema,
  RealtimeTicketRequestSchema,
  RealtimeTicketResponseSchema,
} from "../src/index";

const tenant = "tenant_pilot";
const identity = "identity_human";
const ticket = `rt1_${"A".repeat(43)}`;
const expiresAt = "2026-09-10T10:00:30.000Z";
const connectionExpiresAt = "2026-09-10T10:15:00.000Z";

const subscription = {
  identity_id: identity,
  families: ["projection"],
} as const;

const resume = {
  identity_id: identity,
  generation: 1,
  after_sequence: 42,
} as const;

const request = {
  schema_version: 1,
  subscriptions: [subscription],
  resume: [resume],
};

const response = {
  schema_version: 1,
  ticket,
  expires_at: expiresAt,
  websocket_url: `wss://communicator.example/api/v1/realtime?ticket=${ticket}`,
};

const connected = {
  schema_version: 1,
  type: "connected",
  tenant_id: tenant,
  positions: [{ identity_id: identity, generation: 1, sequence: 42 }],
  connection_expires_at: connectionExpiresAt,
};

const change = {
  sequence: 43,
  event_type: "message.created",
  connection_id: "connection_human_whatsapp",
  conversation_id: "conversation_family",
  occurred_at: "2026-09-10T10:00:01.000Z",
};

const changes = {
  schema_version: 1,
  type: "projection.changes",
  tenant_id: tenant,
  identity_id: identity,
  generation: 1,
  from_sequence: 43,
  to_sequence: 44,
  changes: [change],
};

const reset = {
  schema_version: 1,
  type: "reset_required",
  tenant_id: tenant,
  identity_id: identity,
  generation: 2,
  latest_sequence: 7,
  reason: "generation_changed",
};

describe("realtime public contracts", () => {
  it("exposes the locked v1 constants", () => {
    expect(REALTIME_SUBPROTOCOL).toBe("communicator.realtime.v1");
    expect(REALTIME_TICKET_TTL_MS).toBe(30_000);
    expect(REALTIME_CONNECTION_TTL_MS).toBe(15 * 60_000);
    expect(MAX_REALTIME_IDENTITIES).toBe(16);
    expect(MAX_REALTIME_CHANGES_PER_FRAME).toBe(100);
    expect(MAX_REALTIME_REPLAY_CHANGES).toBe(500);
    expect(MAX_REALTIME_SOCKETS_PER_TENANT).toBe(256);
    expect(MAX_REALTIME_SOCKETS_PER_PRINCIPAL).toBe(8);
    expect(MAX_REALTIME_ID_LENGTH).toBe(255);
    expect(MAX_REALTIME_ATTACHMENT_JSON_BYTES).toBe(12_000);
  });

  it("accepts the locked ticket request, response, and server frame examples", () => {
    expect(RealtimeTicketRequestSchema.parse(request)).toEqual(request);
    expect(RealtimeTicketResponseSchema.parse(response)).toEqual(response);
    expect(RealtimeConnectedFrameSchema.parse(connected)).toEqual(connected);
    expect(RealtimeProjectionChangesFrameSchema.parse(changes)).toEqual(
      changes,
    );
    expect(RealtimeResetRequiredFrameSchema.parse(reset)).toEqual(reset);
    expect(RealtimeServerFrameSchema.parse(connected)).toEqual(connected);
    expect(RealtimeServerFrameSchema.parse(changes)).toEqual(changes);
    expect(RealtimeServerFrameSchema.parse(reset)).toEqual(reset);
  });

  it("rejects duplicate, empty, oversized, and unknown subscriptions", () => {
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        subscriptions: [subscription, subscription],
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        subscriptions: [],
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        subscriptions: Array.from(
          { length: MAX_REALTIME_IDENTITIES + 1 },
          (_, index) => ({
            identity_id: `identity_${String(index).padStart(2, "0")}`,
            families: ["projection"],
          }),
        ),
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        subscriptions: [{ identity_id: identity, families: ["messages"] }],
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        subscriptions: [
          { identity_id: identity, families: ["projection", "projection"] },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects resume positions that are absent, duplicated, negative, unsafe, or generation zero", () => {
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        resume: [{ ...resume, identity_id: "identity_other" }],
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        resume: [resume, resume],
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        resume: [{ ...resume, after_sequence: -1 }],
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        resume: [{ ...resume, after_sequence: Number.MAX_SAFE_INTEGER + 1 }],
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        resume: [{ ...resume, generation: 0 }],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed tickets, extra keys, oversized IDs, and oversized change frames", () => {
    expect(
      RealtimeTicketResponseSchema.safeParse({
        ...response,
        ticket: "raw-ticket-value",
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({ ...request, extra: true })
        .success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        subscriptions: [{ ...subscription, extra: true }],
      }).success,
    ).toBe(false);
    expect(
      RealtimeTicketRequestSchema.safeParse({
        ...request,
        subscriptions: [
          {
            identity_id: `identity_${"x".repeat(247)}`,
            families: ["projection"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RealtimeProjectionChangesFrameSchema.safeParse({
        ...changes,
        changes: Array.from(
          { length: MAX_REALTIME_CHANGES_PER_FRAME + 1 },
          (_, index) => ({
            ...change,
            sequence: index + 1,
          }),
        ),
        from_sequence: 1,
        to_sequence: MAX_REALTIME_CHANGES_PER_FRAME + 2,
      }).success,
    ).toBe(false);
    expect(
      RealtimeProjectionChangesFrameSchema.safeParse({
        ...changes,
        changes: [{ ...change, event_id: "$secret:event" }],
      }).success,
    ).toBe(false);
  });

  it("enforces frame sequence bounds and reset reasons", () => {
    expect(
      RealtimeConnectedFrameSchema.safeParse({
        ...connected,
        positions: [connected.positions[0], connected.positions[0]],
      }).success,
    ).toBe(false);
    expect(
      RealtimeConnectedFrameSchema.safeParse({
        ...connected,
        positions: [{ identity_id: identity, generation: 0, sequence: 0 }],
      }).success,
    ).toBe(false);
    expect(
      RealtimeConnectedFrameSchema.safeParse({
        ...connected,
        positions: [{ identity_id: identity, generation: 1, sequence: -1 }],
      }).success,
    ).toBe(false);
    expect(
      RealtimeProjectionChangesFrameSchema.safeParse({
        ...changes,
        from_sequence: 44,
      }).success,
    ).toBe(false);
    expect(
      RealtimeProjectionChangesFrameSchema.safeParse({
        ...changes,
        changes: [{ ...change, sequence: 0 }],
        from_sequence: 0,
      }).success,
    ).toBe(false);
    expect(
      RealtimeResetRequiredFrameSchema.safeParse({
        ...reset,
        reason: "not-a-reset-reason",
      }).success,
    ).toBe(false);
    expect(
      RealtimeResetRequiredFrameSchema.safeParse({ ...reset, extra: true })
        .success,
    ).toBe(false);
  });

  it("returns detached structured-clone-safe results and does not invoke accessors", () => {
    const parsed = RealtimeTicketRequestSchema.parse(request);
    expect(() => structuredClone(parsed)).not.toThrow();
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);

    const getterInput = { ...request };
    let getterCalls = 0;
    Object.defineProperty(getterInput, "schema_version", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("must not run");
      },
    });
    expect(RealtimeTicketRequestSchema.safeParse(getterInput).success).toBe(
      false,
    );
    expect(getterCalls).toBe(0);

    const proxied = new Proxy(request, {
      ownKeys: () => {
        throw new Error("proxy ownKeys must not run");
      },
    });
    expect(() => RealtimeTicketRequestSchema.safeParse(proxied)).not.toThrow();
    expect(RealtimeTicketRequestSchema.safeParse(proxied).success).toBe(false);
  });
});
