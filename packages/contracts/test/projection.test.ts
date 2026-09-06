import { describe, expect, it } from "vitest";
import {
  AbortRebuildInputSchema,
  ApplyProjectionBatchInputSchema,
  ApplyProjectionBatchResultSchema,
  ApplyReplayPageInputSchema,
  BeginRebuildInputSchema,
  CompleteRebuildInputSchema,
  ConversationCursorSchema,
  DEFAULT_PROJECTION_PAGE_SIZE,
  MAX_PROJECTION_BATCH_BYTES,
  MAX_PROJECTION_BATCH_EVENTS,
  MAX_PROJECTION_CHANGES,
  MAX_PROJECTION_CHECKPOINT_VALUE_CHARS,
  MAX_PROJECTION_CURSOR_CHARS,
  MAX_PROJECTION_PAGE_SIZE,
  InitializeProjectionInputSchema,
  ListProjectionChangesInputSchema,
  ListProjectionConversationsInputSchema,
  ListProjectionMessagesInputSchema,
  MessageCursorSchema,
  MessagePageResultSchema,
  OpaqueEventIdSchema,
  ProjectionAuthorizationContextSchema,
  ProjectionChangePageSchema,
  ProjectionConnectionBindingSchema,
  ProjectionConnectionBindingsSchema,
  ProjectionErrorCodeSchema,
  ProjectionEventEnvelopeSchema,
  ProjectionPayloadSchemaByType,
  ProjectionScopeSchema,
  ProjectionStateSchema,
  ProjectionStatusInputSchema,
  ProjectionStatusSchema,
  ProjectionStatusCheckpointSchema,
  ProjectionCheckpointInputSchema,
  ProjectionEventEnvelope,
  RebuildFailureCodeSchema,
  compareOpaqueEventIds,
  parseProjectionEvent,
  type ProjectionAuthorizationContext,
  type ProjectionConnectionBinding,
} from "../src/index";

const tenant = "tenant_pilot";
const identity = "identity_human";
const account = "account_human_telegram";
const connection = "connection_human_telegram";
const conversation = "conversation_human_one";
const participant = "participant_human";
const message = "message_human_one";
const eventId = "$opaque-event:server";
const timestamp = "2026-09-07T01:02:03.000Z";

const baseEnvelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  event_id: eventId,
  event_type: "message.created",
  event_source: "live",
  tenant_id: tenant,
  identity_id: identity,
  platform: "telegram",
  account_id: account,
  conversation_id: conversation,
  matrix_room_id: null,
  matrix_event_id: null,
  remote_message_id: null,
  occurred_at: timestamp,
  observed_at: timestamp,
  payload: {
    message_id: message,
    direction: "inbound",
    sender_participant_id: participant,
    sender_label: "Human",
    body: "hello",
    reply_to_message_id: null,
    delivery_status: "accepted",
    unread: true,
  },
  ...overrides,
});

const validPayloads: Record<string, Record<string, unknown>> = {
  "message.created": {
    message_id: message,
    direction: "inbound",
    sender_participant_id: participant,
    sender_label: "Human",
    body: "hello",
    reply_to_message_id: null,
    delivery_status: "accepted",
    unread: true,
  },
  "message.edited": {
    message_id: message,
    body: "edited",
    editor_participant_id: participant,
  },
  "message.deleted": { message_id: message, reason_code: null },
  "reaction.added": {
    reaction_id: "reaction_human_one",
    message_id: message,
    participant_id: participant,
    emoji: "👍",
  },
  "reaction.removed": {
    reaction_id: "reaction_human_one",
    message_id: message,
  },
  "receipt.read": {
    message_id: message,
    participant_id: participant,
    local_identity: true,
  },
  "receipt.delivered": {
    message_id: message,
    participant_id: participant,
    local_identity: false,
  },
  "typing.started": { participant_id: participant, expires_at: timestamp },
  "typing.stopped": { participant_id: participant },
  "attachment.observed": {
    attachment_id: "attachment_human_one",
    message_id: message,
    file_name: "photo.jpg",
    mime_type: "image/jpeg",
    size_bytes: 10,
    sha256: "a".repeat(64),
    r2_key: null,
  },
  "conversation.updated": { title: "A conversation", archived: false, muted: false },
  "participant.updated": {
    participant_id: participant,
    display_name: "Human",
    remote_id: "remote-1",
    avatar_url: "https://example.test/avatar.png",
  },
  "command.updated": {
    command_id: "command_human_one",
    operation: "message.send",
    delivery_mode: "direct",
    status: "accepted",
    failure_code: null,
  },
  "bridge.delivery.updated": { message_id: message, delivery_status: "delivered", failure_code: null },
  "replay.tombstone": { target_event_id: "$target:event", reason_code: "replayed" },
  "correction.applied": { target_event_id: "$target:event", reason_code: "corrected" },
  "deletion.tombstone": {
    resource_type: "message",
    resource_id: message,
    reason_code: "retention",
  },
};

const validProjectionEvent = (
  event_type: string,
  payload: Record<string, unknown> = validPayloads[event_type]!,
): Record<string, unknown> => baseEnvelope({ event_type, payload });

const binding = (overrides: Partial<ProjectionConnectionBinding> = {}): ProjectionConnectionBinding => ({
  account_id: account,
  connection_id: connection,
  identity_id: identity,
  platform: "telegram",
  ...overrides,
});

const authorization = (
  overrides: Partial<ProjectionAuthorizationContext> = {},
): ProjectionAuthorizationContext => ({
  schema_version: 1,
  tenant_id: tenant,
  principal_id: "principal_human",
  allowed_identity_ids: [identity],
  scopes: ["projection.read"],
  ...overrides,
});

const replayPage = {
  schema_version: 1,
  replay_mode: "projection_only",
  tenant_id: tenant,
  manifests: [],
  events: [],
  next_cursor: null,
};

describe("projection payload contracts", () => {
  it.each(Object.keys(validPayloads))("accepts the exact %s payload", (event_type) => {
    const result = ProjectionEventEnvelopeSchema.safeParse(validProjectionEvent(event_type));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_type).toBe(event_type);
      expect(result.data.payload).toEqual(validPayloads[event_type]);
    }
  });

  it("rejects wrong payload/event pairings and unknown payload keys", () => {
    expect(ProjectionEventEnvelopeSchema.safeParse(validProjectionEvent("message.edited", validPayloads["message.created"]!)).success).toBe(false);
    expect(ProjectionEventEnvelopeSchema.safeParse(validProjectionEvent("message.created", {
      ...validPayloads["message.created"],
      extra: true,
    })).success).toBe(false);
  });

  it.each([
    ["resource id", { event_type: "message.edited", payload: { ...validPayloads["message.edited"], message_id: "opaque-event" } }],
    ["sender label", { event_type: "message.created", payload: { ...validPayloads["message.created"], sender_label: "x".repeat(101) } }],
    ["body", { event_type: "message.created", payload: { ...validPayloads["message.created"], body: "x".repeat(20_001) } }],
    ["emoji", { event_type: "reaction.added", payload: { ...validPayloads["reaction.added"], emoji: "x".repeat(65) } }],
    ["R2 key", { event_type: "attachment.observed", payload: { ...validPayloads["attachment.observed"], r2_key: "x".repeat(513) } }],
    ["negative size", { event_type: "attachment.observed", payload: { ...validPayloads["attachment.observed"], size_bytes: -1 } }],
    ["unsafe size", { event_type: "attachment.observed", payload: { ...validPayloads["attachment.observed"], size_bytes: Number.MAX_SAFE_INTEGER + 1 } }],
    ["malformed SHA", { event_type: "attachment.observed", payload: { ...validPayloads["attachment.observed"], sha256: "A".repeat(64) } }],
    ["invalid timestamp", { observed_at: "not-a-timestamp" }],
  ])("rejects %s", (_name, overrides) => {
    expect(ProjectionEventEnvelopeSchema.safeParse(baseEnvelope(overrides)).success).toBe(false);
  });

  it("keeps opaque event IDs distinct from canonical resource IDs", () => {
    expect(OpaqueEventIdSchema.parse("$event:remote")).toBe("$event:remote");
    expect(ProjectionEventEnvelopeSchema.safeParse(validProjectionEvent("replay.tombstone")).success).toBe(true);
    expect(ProjectionEventEnvelopeSchema.safeParse(validProjectionEvent("replay.tombstone", {
      target_event_id: "message_human_one",
      reason_code: "replayed",
    })).success).toBe(true);
  });

  it("does not invoke hostile getters, symbols, proxies, or custom prototypes", () => {
    const getterInput = validProjectionEvent("message.created");
    let getterCalls = 0;
    Object.defineProperty(getterInput, "event_id", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("must not run");
      },
    });
    expect(() => ProjectionEventEnvelopeSchema.safeParse(getterInput)).not.toThrow();
    expect(getterCalls).toBe(0);

    const symbolInput = validProjectionEvent("message.created");
    Object.defineProperty(symbolInput, Symbol("hidden"), { enumerable: true, value: true });
    expect(ProjectionEventEnvelopeSchema.safeParse(symbolInput).success).toBe(false);

    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(customPrototype, validProjectionEvent("message.created"));
    expect(ProjectionEventEnvelopeSchema.safeParse(customPrototype).success).toBe(false);

    let proxyGetCalls = 0;
    const proxied = new Proxy(validProjectionEvent("message.created"), {
      get: () => {
        proxyGetCalls += 1;
        throw new Error("proxy get must not run");
      },
    });
    expect(() => ProjectionEventEnvelopeSchema.safeParse(proxied)).not.toThrow();
    expect(proxyGetCalls).toBe(0);
  });

  it("returns a detached structured-clone-safe projection event", () => {
    const input = validProjectionEvent("message.created");
    const parsed = parseProjectionEvent(input) as ProjectionEventEnvelope;
    (input.payload as Record<string, unknown>).body = "mutated after parse";
    expect((parsed.payload as Record<string, unknown>).body).toBe("hello");
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.payload)).toBe(Object.prototype);
    expect(() => structuredClone(parsed)).not.toThrow();
  });

  it("compares opaque IDs by UTF-8 bytes, including prefixes and non-ASCII", () => {
    expect(compareOpaqueEventIds("$a", "$a")).toBe(0);
    expect(compareOpaqueEventIds("$a", "$aa")).toBeLessThan(0);
    expect(compareOpaqueEventIds("$é", "$z")).toBeGreaterThan(0);
  });
});

describe("projection authorization and bindings", () => {
  it("enforces sorted, unique authorization identities/scopes and their bounds", () => {
    expect(ProjectionAuthorizationContextSchema.parse(authorization({
      allowed_identity_ids: [],
      scopes: ["projection.initialize", "projection.read", "projection.status"],
    }))).toMatchObject({ allowed_identity_ids: [], scopes: ["projection.initialize", "projection.read", "projection.status"] });
    expect(ProjectionAuthorizationContextSchema.safeParse(authorization({ allowed_identity_ids: ["identity_z", "identity_a"] })).success).toBe(false);
    expect(ProjectionAuthorizationContextSchema.safeParse(authorization({ allowed_identity_ids: [identity, identity] })).success).toBe(false);
    expect(ProjectionAuthorizationContextSchema.safeParse(authorization({ scopes: ["projection.write", "projection.read"] })).success).toBe(false);
    expect(ProjectionAuthorizationContextSchema.safeParse(authorization({ scopes: ["projection.read", "projection.read"] })).success).toBe(false);
    expect(ProjectionAuthorizationContextSchema.safeParse(authorization({ scopes: [] })).success).toBe(false);
    expect(ProjectionAuthorizationContextSchema.safeParse(authorization({ allowed_identity_ids: Array.from({ length: 501 }, (_, i) => `identity_${String(i).padStart(3, "0")}`) })).success).toBe(false);
  });

  it("enforces connection binding shape, account sorting, uniqueness, and 0/500 bounds", () => {
    expect(ProjectionConnectionBindingsSchema.parse([])).toEqual([]);
    expect(ProjectionConnectionBindingsSchema.parse(Array.from({ length: 500 }, (_, i) => binding({
      account_id: `account_${String(i).padStart(3, "0")}`,
      connection_id: `connection_${String(i).padStart(3, "0")}`,
    }))).length).toBe(500);
    expect(ProjectionConnectionBindingsSchema.safeParse([binding({ account_id: "account_z" }), binding({ account_id: "account_a" })]).success).toBe(false);
    expect(ProjectionConnectionBindingsSchema.safeParse([binding(), binding()]).success).toBe(false);
    expect(ProjectionConnectionBindingsSchema.safeParse(Array.from({ length: 501 }, (_, i) => binding({
      account_id: `account_${String(i).padStart(3, "0")}`,
      connection_id: `connection_${String(i).padStart(3, "0")}`,
    }))).success).toBe(false);
    expect(ProjectionConnectionBindingSchema.safeParse({ ...binding(), extra: true }).success).toBe(false);
  });

  it("exposes only the locked scope, state, rebuild-failure, and error enums", () => {
    expect(ProjectionScopeSchema.options).toEqual([
      "projection.initialize",
      "projection.write",
      "projection.read",
      "projection.rebuild",
      "projection.status",
    ]);
    expect(ProjectionStateSchema.options).toEqual(["ready", "rebuilding", "rebuild_failed"]);
    for (const state of ["ready", "rebuilding", "rebuild_failed"] as const) {
      expect(ProjectionStateSchema.safeParse(state).success).toBe(true);
    }
    expect(RebuildFailureCodeSchema.options).toEqual([
      "operator_abort",
      "unsupported_archive",
      "archive_gap",
      "binding_conflict",
      "validation_failed",
    ]);
    for (const code of RebuildFailureCodeSchema.options) {
      expect(RebuildFailureCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(ProjectionErrorCodeSchema.options).toEqual([
      "projection_invalid",
      "projection_forbidden",
      "projection_tenant_mismatch",
      "projection_conflict",
      "projection_rebuilding",
      "projection_rebuild_failed",
      "projection_rebuild_mismatch",
      "projection_not_found",
      "projection_too_large",
      "projection_unavailable",
    ]);
  });
});

describe("projection RPC contracts and exact bounds", () => {
  const common = { schema_version: 1, tenant_id: tenant, authorization: authorization() };

  it("exports the seven locked product bounds", () => {
    expect(MAX_PROJECTION_BATCH_EVENTS).toBe(500);
    expect(MAX_PROJECTION_BATCH_BYTES).toBe(4 * 1024 * 1024);
    expect(DEFAULT_PROJECTION_PAGE_SIZE).toBe(50);
    expect(MAX_PROJECTION_PAGE_SIZE).toBe(100);
    expect(MAX_PROJECTION_CURSOR_CHARS).toBe(2_048);
    expect(MAX_PROJECTION_CHECKPOINT_VALUE_CHARS).toBe(4_096);
    expect(MAX_PROJECTION_CHANGES).toBe(10_000);
  });

  it("accepts strict lifecycle/status and batch inputs/results", () => {
    expect(InitializeProjectionInputSchema.safeParse({ ...common, initialized_at: timestamp }).success).toBe(true);
    expect(ProjectionStatusInputSchema.safeParse(common).success).toBe(true);
    expect(ApplyProjectionBatchInputSchema.safeParse({
      ...common,
      mode: "live",
      rebuild_id: null,
      connections: [],
      events: [validProjectionEvent("message.created")],
      checkpoint: null,
    }).success).toBe(true);
    expect(ApplyProjectionBatchResultSchema.safeParse({
      schema_version: 1,
      tenant_id: tenant,
      generation: 1,
      applied_count: 0,
      duplicate_count: 0,
      last_sequence: 0,
    }).success).toBe(true);
    for (const schema of [InitializeProjectionInputSchema, ProjectionStatusInputSchema, ApplyProjectionBatchInputSchema]) {
      expect(schema.safeParse({ ...common, unexpected: true }).success).toBe(false);
    }
  });

  it("enforces exact batch event and binding counts without aggregate-byte checks", () => {
    const event = validProjectionEvent("message.created");
    const fiveHundredEvents = Array.from({ length: 500 }, () => event);
    expect(ApplyProjectionBatchInputSchema.safeParse({
      ...common,
      mode: "live",
      rebuild_id: null,
      connections: [],
      events: fiveHundredEvents,
      checkpoint: null,
    }).success).toBe(true);
    expect(ApplyProjectionBatchInputSchema.safeParse({
      ...common,
      mode: "live",
      rebuild_id: null,
      connections: [],
      events: [...fiveHundredEvents, event],
      checkpoint: null,
    }).success).toBe(false);
  });

  it("accepts and bounds checkpoints and all rebuild RPC inputs, including abort", () => {
    const checkpoint = {
      kind: "generic",
      value: "v".repeat(4_096),
      last_observed_at: timestamp,
      last_event_id: eventId,
    };
    expect(ProjectionCheckpointInputSchema.safeParse(checkpoint).success).toBe(true);
    expect(ProjectionCheckpointInputSchema.safeParse({ ...checkpoint, value: "v".repeat(4_097) }).success).toBe(false);
    expect(BeginRebuildInputSchema.safeParse({ ...common, rebuild_id: "rebuild_one", expected_generation: 1, started_at: timestamp }).success).toBe(true);
    expect(CompleteRebuildInputSchema.safeParse({ ...common, rebuild_id: "rebuild_one", terminal_cursor: null, completed_at: timestamp }).success).toBe(true);
    expect(AbortRebuildInputSchema.safeParse({ ...common, rebuild_id: "rebuild_one", failed_at: timestamp, failure_code: "operator_abort" }).success).toBe(true);
    expect(AbortRebuildInputSchema.safeParse({ ...common, rebuild_id: "rebuild_one", failed_at: timestamp, failure_code: "not_a_failure" }).success).toBe(false);
    for (const schema of [BeginRebuildInputSchema, CompleteRebuildInputSchema, AbortRebuildInputSchema]) {
      expect(schema.safeParse({ ...common, rebuild_id: "rebuild_one", unexpected: true }).success).toBe(false);
    }
  });

  it("accepts replay and query inputs with strict cursor/page limits", () => {
    expect(ApplyReplayPageInputSchema.safeParse({
      ...common,
      rebuild_id: "rebuild_one",
      source_cursor: "s".repeat(4_096),
      connections: [],
      page: replayPage,
    }).success).toBe(true);
    expect(ApplyReplayPageInputSchema.safeParse({
      ...common,
      rebuild_id: "rebuild_one",
      source_cursor: "s".repeat(4_097),
      connections: [],
      page: replayPage,
    }).success).toBe(false);
    expect(ListProjectionConversationsInputSchema.safeParse({
      ...common,
      identity_id: identity,
      connection_id: null,
      page_size: 100,
      cursor: "c".repeat(2_048),
    }).success).toBe(true);
    expect(ListProjectionConversationsInputSchema.safeParse({
      ...common,
      identity_id: identity,
      connection_id: null,
      page_size: 101,
    }).success).toBe(false);
    expect(ListProjectionConversationsInputSchema.safeParse({
      ...common,
      identity_id: identity,
      connection_id: null,
      cursor: "c".repeat(2_049),
    }).success).toBe(false);
    expect(ListProjectionMessagesInputSchema.safeParse({ ...common, identity_id: identity, conversation_id: conversation }).success).toBe(true);
    expect(ListProjectionChangesInputSchema.safeParse({ ...common, identity_id: identity, generation: 1, after_sequence: 0, limit: 100 }).success).toBe(true);
    expect(ListProjectionChangesInputSchema.safeParse({ ...common, identity_id: identity, generation: 1, after_sequence: -1 }).success).toBe(false);
  });

  it("validates the two exact generation-bound cursor payloads", () => {
    expect(ConversationCursorSchema.safeParse({
      schema_version: 1,
      query_kind: "projection.conversations",
      tenant_id: tenant,
      identity_id: identity,
      connection_id: null,
      generation: 1,
      last_activity_ms: 1,
      last_id: conversation,
    }).success).toBe(true);
    expect(MessageCursorSchema.safeParse({
      schema_version: 1,
      query_kind: "projection.messages",
      tenant_id: tenant,
      identity_id: identity,
      conversation_id: conversation,
      generation: 1,
      last_occurred_ms: 1,
      last_id: message,
    }).success).toBe(true);
    expect(ConversationCursorSchema.safeParse({
      schema_version: 1,
      query_kind: "projection.messages",
      tenant_id: tenant,
      identity_id: identity,
      connection_id: null,
      generation: 1,
      last_activity_ms: 1,
      last_id: conversation,
    }).success).toBe(false);
    expect(MessageCursorSchema.safeParse({
      schema_version: 1,
      query_kind: "projection.messages",
      tenant_id: tenant,
      identity_id: identity,
      conversation_id: conversation,
      generation: 1,
      last_occurred_ms: Number.MAX_SAFE_INTEGER + 1,
      last_id: message,
    }).success).toBe(false);
  });

  it("keeps status/change/page outputs strict and structured-clone-safe", () => {
    const status = {
      schema_version: 1,
      tenant_id: tenant,
      schema_generation: 1,
      state: "ready",
      generation: 1,
      rebuild_id: null,
      last_completed_rebuild_id: null,
      last_failed_rebuild_id: null,
      last_rebuild_failure_code: null,
      applied_event_count: 0,
      conversation_count: 0,
      message_count: 0,
      latest_change_sequence: 0,
      checkpoints: [],
    };
    expect(ProjectionStatusSchema.safeParse(status).success).toBe(true);
    expect(ProjectionStatusSchema.safeParse({ ...status, extra: true }).success).toBe(false);
    expect(ProjectionStatusCheckpointSchema.safeParse({
      kind: "generic",
      value: "value",
      generation: 1,
      updated_at: timestamp,
      last_observed_at: null,
      last_event_id: null,
      source_cursor: null,
      page_digest: null,
    }).success).toBe(true);
    const changePage = {
      schema_version: 1,
      tenant_id: tenant,
      identity_id: identity,
      generation: 1,
      items: [],
      latest_sequence: 0,
      reset_required: false,
    };
    const parsed = ProjectionChangePageSchema.parse(changePage);
    expect(() => structuredClone(parsed)).not.toThrow();
    expect(MessagePageResultSchema.parse({ items: [], next_cursor: null })).toEqual({ items: [], next_cursor: null });
  });

  it("exposes the complete event map without allowing unsupported event names", () => {
    expect(Object.keys(ProjectionPayloadSchemaByType).sort()).toEqual(Object.keys(validPayloads).sort());
    expect(ProjectionPayloadSchemaByType["message.created"].safeParse(validPayloads["message.created"]).success).toBe(true);
    expect((ProjectionPayloadSchemaByType as Record<string, unknown>)["message.unsupported"]).toBeUndefined();
  });
});
