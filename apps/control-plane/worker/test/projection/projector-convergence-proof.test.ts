import { runInDurableObject } from "cloudflare:test";
import type { ProjectionEventEnvelope } from "@communicator/contracts";
import { canonicalJsonLineBytes } from "../../archive/canonical-json";
import { sha256Hex } from "../../archive/codec";
import projectorSource from "../../projection/projector.ts?raw";
import projectorCommonSource from "../../projection/projector-common.ts?raw";
import projectorControlSource from "../../projection/projector-control.ts?raw";
import projectorConversationSource from "../../projection/projector-conversation.ts?raw";
import projectorDeletionSource from "../../projection/projector-deletion.ts?raw";
import projectorDomainsSource from "../../projection/projector-domains.ts?raw";
import projectorMessagesSource from "../../projection/projector-messages.ts?raw";
import projectorSocialSource from "../../projection/projector-social.ts?raw";
import projectorTypesSource from "../../projection/projector-types.ts?raw";
import tenantProjectionSource from "../../projection/tenant-projection.ts?raw";
import { describe, expect, it } from "vitest";
import {
  auth,
  bindingFor,
  created,
  event,
  initialize,
  input,
  rows,
} from "./projector-test-support";

const FULL_ACCOUNT = "full_domain_account";
const FULL_CONNECTION = "full_domain_connection";
const FULL_CONVERSATION = "full_domain_conversation";
const FULL_MESSAGE = "full_domain_message";
const FULL_PARTICIPANT = "full_domain_participant";
const FULL_ATTACHMENT = "full_domain_attachment";
const FULL_ATTACHMENT_SHA256 = "a".repeat(64);
const SOURCE_FIXTURE_TENANT = "tenant_projector";
const TENANT_PLACEHOLDER = "__tenant__";

const mediaKeyFor = (tenant: string): string =>
  "media/" + tenant + "/" + FULL_ATTACHMENT_SHA256;

const occurredAt = (minute: number): string =>
  "2026-09-07T01:" + String(minute).padStart(2, "0") + ":00.000Z";
const observedAt = (minute: number): string =>
  "2026-09-07T01:" + String(minute).padStart(2, "0") + ":01.000Z";

const fullEvent = (
  eventId: string,
  payload: Record<string, unknown>,
  eventType: ProjectionEventEnvelope["event_type"],
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(eventId, payload, eventType, {
    account_id: FULL_ACCOUNT,
    conversation_id: FULL_CONVERSATION,
    occurred_at: occurredAt(Number(eventId.match(/(\d+)$/)?.[1] ?? "0")),
    observed_at: observedAt(Number(eventId.match(/(\d+)$/)?.[1] ?? "0")),
    ...overrides,
  });

const fullDomainEvents = (): ProjectionEventEnvelope[] => [
  fullEvent(
    "full_domain_00",
    { title: "Full-domain conversation", archived: false, muted: true },
    "conversation.updated",
  ),
  fullEvent(
    "full_domain_01",
    {
      reaction_id: "full_domain_reaction",
      message_id: FULL_MESSAGE,
      participant_id: FULL_PARTICIPANT,
      emoji: "👍",
    },
    "reaction.added",
  ),
  fullEvent(
    "full_domain_01_remove",
    { reaction_id: "full_domain_reaction", message_id: FULL_MESSAGE },
    "reaction.removed",
    { occurred_at: occurredAt(1), observed_at: observedAt(1) },
  ),
  fullEvent(
    "full_domain_02",
    {
      message_id: FULL_MESSAGE,
      participant_id: FULL_PARTICIPANT,
      local_identity: true,
    },
    "receipt.read",
  ),
  fullEvent(
    "full_domain_03",
    {
      message_id: FULL_MESSAGE,
      participant_id: "full_domain_remote_participant",
      local_identity: false,
    },
    "receipt.delivered",
  ),
  fullEvent(
    "full_domain_04",
    {
      participant_id: FULL_PARTICIPANT,
      expires_at: "2020-01-01T00:00:00.000Z",
    },
    "typing.started",
  ),
  fullEvent(
    "full_domain_05",
    {
      attachment_id: FULL_ATTACHMENT,
      message_id: FULL_MESSAGE,
      file_name: "full-domain.txt",
      mime_type: "text/plain",
      size_bytes: 42,
      sha256: FULL_ATTACHMENT_SHA256,
      r2_key: mediaKeyFor(SOURCE_FIXTURE_TENANT),
    },
    "attachment.observed",
  ),
  fullEvent(
    "full_domain_06",
    {
      message_id: FULL_MESSAGE,
      delivery_status: "failed",
      failure_code: "bridge_failure",
    },
    "bridge.delivery.updated",
  ),
  fullEvent(
    "full_domain_07",
    {
      participant_id: FULL_PARTICIPANT,
      display_name: "Full-domain participant",
      remote_id: "remote-full-domain",
      avatar_url: "https://example.test/full-domain.png",
    },
    "participant.updated",
  ),
  fullEvent(
    "full_domain_08",
    {
      message_id: FULL_MESSAGE,
      direction: "inbound",
      sender_participant_id: FULL_PARTICIPANT,
      sender_label: "Full-domain sender",
      body: "full-domain initial body",
      reply_to_message_id: null,
      delivery_status: "unknown",
      unread: true,
    },
    "message.created",
  ),
  fullEvent(
    "full_domain_09",
    {
      message_id: FULL_MESSAGE,
      body: "full-domain edited body",
      editor_participant_id: FULL_PARTICIPANT,
    },
    "message.edited",
  ),
  fullEvent(
    "full_domain_10",
    {
      message_id: "full_domain_deleted_message",
      reason_code: "message-retention",
    },
    "message.deleted",
    { conversation_id: "full_domain_deleted_conversation" },
  ),
  fullEvent(
    "full_domain_11",
    { target_event_id: "full_domain_08", reason_code: "replay-review" },
    "replay.tombstone",
  ),
  fullEvent(
    "full_domain_12",
    { target_event_id: "full_domain_09", reason_code: "correction-review" },
    "correction.applied",
  ),
  fullEvent(
    "full_domain_13",
    {
      command_id: "full_domain_command",
      operation: "message.send",
      delivery_mode: "paced",
      status: "failed",
      failure_code: "command_failure",
    },
    "command.updated",
    { conversation_id: "full_domain_control_conversation" },
  ),
  fullEvent(
    "full_domain_14",
    { participant_id: FULL_PARTICIPANT },
    "typing.stopped",
  ),
  fullEvent(
    "full_domain_15",
    {
      resource_type: "conversation",
      resource_id: "full_domain_deleted_conversation",
      reason_code: "conversation-retention",
    },
    "deletion.tombstone",
    { conversation_id: "full_domain_deleted_conversation" },
  ),
];

const tenantEvents = (
  tenant: string,
  events: readonly ProjectionEventEnvelope[],
): ProjectionEventEnvelope[] =>
  events.map<ProjectionEventEnvelope>((nextEvent) => {
    if (nextEvent.event_type === "attachment.observed") {
      return {
        ...nextEvent,
        tenant_id: tenant,
        payload: { ...nextEvent.payload, r2_key: mediaKeyFor(tenant) },
      };
    }
    return { ...nextEvent, tenant_id: tenant };
  });

const fullBindings = () => [bindingFor(FULL_ACCOUNT, FULL_CONNECTION)];

const applyBatches = async (
  stub: DurableObjectStub<
    import("../../projection/tenant-projection").TenantProjectionDO
  >,
  tenant: string,
  batches: readonly (readonly ProjectionEventEnvelope[])[],
): Promise<void> => {
  for (const batch of batches) {
    await stub.applyBatch(
      input(tenantEvents(tenant, batch), {
        tenant_id: tenant,
        connections: fullBindings(),
      }),
    );
  }
};

const batchesOfSize = (
  events: readonly ProjectionEventEnvelope[],
  size: number,
): ProjectionEventEnvelope[][] => {
  const batches: ProjectionEventEnvelope[][] = [];
  for (let offset = 0; offset < events.length; offset += size) {
    batches.push(events.slice(offset, offset + size));
  }
  return batches;
};

const batchesFromRanges = (
  events: readonly ProjectionEventEnvelope[],
  ranges: readonly (readonly [number, number])[],
): ProjectionEventEnvelope[][] =>
  ranges.map(([start, end]) => events.slice(start, end));

const projectionTableNames = [
  "_sql_schema_migrations",
  "conversations",
  "participants",
  "messages",
  "message_versions",
  "reactions",
  "receipts",
  "typing_states",
  "attachments",
  "commands",
  "message_delivery_updates",
  "event_tombstones",
  "resource_tombstones",
  "connection_bindings",
  "completed_rebuilds",
  "failed_rebuilds",
  "projection_meta",
  "projection_checkpoints",
  "projection_change_floors",
  "projection_identity_sequences",
  "applied_events",
  "projection_changes",
] as const;
type ProjectionTableName = (typeof projectionTableNames)[number];
type SnapshotRow = Record<string, SqlStorageValue>;
type ProjectionSnapshot = Record<ProjectionTableName, SnapshotRow[]>;

const snapshot = async (
  stub: DurableObjectStub<
    import("../../projection/tenant-projection").TenantProjectionDO
  >,
): Promise<ProjectionSnapshot> =>
  runInDurableObject(stub, async (_instance, state) => {
    const orderBy: Record<ProjectionTableName, string> = {
      _sql_schema_migrations: "version",
      conversations: "id",
      participants: "id",
      messages: "id",
      message_versions: "event_id",
      reactions: "id",
      receipts: "message_id, participant_id, receipt_type",
      typing_states: "conversation_id, participant_id",
      attachments: "id",
      commands: "id",
      message_delivery_updates: "message_id",
      event_tombstones: "target_event_id",
      resource_tombstones: "resource_type, resource_id",
      connection_bindings: "account_id",
      completed_rebuilds: "rebuild_id",
      failed_rebuilds: "rebuild_id",
      projection_meta: "singleton",
      projection_checkpoints: "kind",
      projection_change_floors: "identity_id",
      projection_identity_sequences: "identity_id",
      applied_events: "event_id",
      projection_changes: "event_id",
    };
    const result = {} as ProjectionSnapshot;
    for (const table of projectionTableNames) {
      result[table] = state.storage.sql
        .exec<SnapshotRow>(
          "SELECT * FROM " + table + " ORDER BY " + orderBy[table],
        )
        .toArray();
    }
    return result;
  });

const normalize = (
  source: ProjectionSnapshot,
  tenantIndependentHashes: ReadonlyMap<string, string>,
): ProjectionSnapshot => {
  const normalized = {} as ProjectionSnapshot;
  for (const table of projectionTableNames) {
    normalized[table] = source[table].map((row) => {
      const copy = { ...row };
      if (table === "projection_meta") delete copy.tenant_id;
      if (table === "projection_changes") {
        delete copy.sequence;
        delete copy.identity_sequence;
      }
      if (table === "attachments" && typeof copy.r2_key === "string") {
        const mediaKey = /^media\/[^/]+\/([0-9a-f]{64})$/.exec(copy.r2_key);
        if (mediaKey !== null)
          copy.r2_key = "media/" + TENANT_PLACEHOLDER + "/" + mediaKey[1];
      }
      if (table === "applied_events") {
        const hash = tenantIndependentHashes.get(String(copy.event_id));
        if (hash !== undefined) copy.event_hash = hash;
      }
      return copy;
    });
  }
  return normalized;
};

const row = (
  source: ProjectionSnapshot,
  table: ProjectionTableName,
  predicate: (candidate: SnapshotRow) => boolean,
): SnapshotRow | undefined => source[table].find(predicate);

describe("tenant projection full-domain convergence proof", () => {
  it("converges all 17 event families across single, reverse, and mixed batch orderings", async () => {
    const events = fullDomainEvents();
    expect(events).toHaveLength(17);
    expect(new Set(events.map((nextEvent) => nextEvent.event_type))).toEqual(
      new Set([
        "conversation.updated",
        "participant.updated",
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
        "command.updated",
        "bridge.delivery.updated",
        "replay.tombstone",
        "correction.applied",
        "deletion.tombstone",
      ]),
    );

    const chronologicalTenant = "tenant_full_domain_chronological";
    const reverseTenant = "tenant_full_domain_reverse";
    const mixedTenantA = "tenant_full_domain_mixed_a";
    const mixedTenantB = "tenant_full_domain_mixed_b";
    const mixedTenantC = "tenant_full_domain_mixed_c";

    const chronologicalStub = await initialize(chronologicalTenant);
    await applyBatches(
      chronologicalStub,
      chronologicalTenant,
      batchesOfSize(events, 1),
    );
    const chronological = await snapshot(chronologicalStub);

    const reverseStub = await initialize(reverseTenant);
    await applyBatches(
      reverseStub,
      reverseTenant,
      [...events].reverse().map((nextEvent) => [nextEvent]),
    );
    const reverse = await snapshot(reverseStub);

    const mixedStubA = await initialize(mixedTenantA);
    await applyBatches(
      mixedStubA,
      mixedTenantA,
      batchesFromRanges(events, [
        [0, 4],
        [4, 8],
        [8, 13],
        [13, 17],
      ]),
    );
    const mixedA = await snapshot(mixedStubA);

    const mixedStubB = await initialize(mixedTenantB);
    await applyBatches(
      mixedStubB,
      mixedTenantB,
      batchesFromRanges(events, [
        [0, 1],
        [1, 6],
        [6, 10],
        [10, 12],
        [12, 17],
      ]),
    );
    const mixedB = await snapshot(mixedStubB);

    const mixedStubC = await initialize(mixedTenantC);
    await applyBatches(
      mixedStubC,
      mixedTenantC,
      batchesFromRanges(events, [
        [0, 3],
        [3, 9],
        [9, 11],
        [11, 14],
        [14, 17],
      ]),
    );
    const mixedC = await snapshot(mixedStubC);

    const tenantIndependentHashes = new Map<string, string>();
    for (const nextEvent of events) {
      const normalizedEvent = tenantEvents(TENANT_PLACEHOLDER, [nextEvent])[0];
      if (normalizedEvent === undefined)
        throw new Error("fixture event is missing");
      tenantIndependentHashes.set(
        nextEvent.event_id,
        await sha256Hex(canonicalJsonLineBytes(normalizedEvent)),
      );
    }
    const expected = normalize(chronological, tenantIndependentHashes);
    expect(normalize(reverse, tenantIndependentHashes)).toEqual(expected);
    expect(normalize(mixedA, tenantIndependentHashes)).toEqual(expected);
    expect(normalize(mixedB, tenantIndependentHashes)).toEqual(expected);
    expect(normalize(mixedC, tenantIndependentHashes)).toEqual(expected);

    const mainConversation = row(
      chronological,
      "conversations",
      (candidate) => candidate.id === FULL_CONVERSATION,
    );
    expect(mainConversation).toMatchObject({
      title: "Full-domain conversation",
      muted: 1,
      archived: 0,
      last_message_preview: "full-domain edited body",
      unread_count: 0,
      message_count: 1,
      attachment_count: 1,
    });

    const mainMessage = row(
      chronological,
      "messages",
      (candidate) => candidate.id === FULL_MESSAGE,
    );
    expect(mainMessage).toMatchObject({
      body: "full-domain edited body",
      sender_participant_id: FULL_PARTICIPANT,
      sender_label: "Full-domain sender",
      delivery_status: "failed",
      unread: 0,
      local_read_at: occurredAt(2),
      attachment_count: 1,
      delivery_failure_code: "bridge_failure",
      current_event_id: "full_domain_09",
    });

    expect(
      row(
        chronological,
        "reactions",
        (candidate) => candidate.id === "full_domain_reaction",
      ),
    ).toMatchObject({
      participant_id: null,
      emoji: null,
      removed_at: occurredAt(1),
    });
    expect(chronological.receipts).toHaveLength(2);
    expect(
      row(
        chronological,
        "typing_states",
        (candidate) => candidate.participant_id === FULL_PARTICIPANT,
      ),
    ).toMatchObject({ is_typing: 0, expires_at: null });
    expect(
      row(
        chronological,
        "attachments",
        (candidate) => candidate.id === FULL_ATTACHMENT,
      ),
    ).toMatchObject({
      file_name: "full-domain.txt",
      mime_type: "text/plain",
      size_bytes: 42,
      sha256: FULL_ATTACHMENT_SHA256,
      r2_key: mediaKeyFor(chronologicalTenant),
      deleted_at: null,
    });
    expect(
      row(
        chronological,
        "resource_tombstones",
        (candidate) =>
          candidate.resource_type === "attachment" &&
          candidate.resource_id === FULL_ATTACHMENT,
      ),
    ).toBeUndefined();
    expect(
      row(
        chronological,
        "commands",
        (candidate) => candidate.id === "full_domain_command",
      ),
    ).toMatchObject({
      status: "failed",
      failure_code: "command_failure",
    });
    expect(chronological.event_tombstones).toHaveLength(2);
    for (const markerEventId of ["full_domain_11", "full_domain_12"]) {
      expect(
        row(
          chronological,
          "applied_events",
          (candidate) => candidate.event_id === markerEventId,
        ),
      ).toMatchObject({ event_id: markerEventId });
      expect(
        row(
          chronological,
          "projection_changes",
          (candidate) => candidate.event_id === markerEventId,
        ),
      ).toMatchObject({ event_id: markerEventId });
    }
    expect(chronological.resource_tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource_type: "message",
          resource_id: "full_domain_deleted_message",
        }),
        expect.objectContaining({
          resource_type: "conversation",
          resource_id: "full_domain_deleted_conversation",
        }),
      ]),
    );
    expect(
      row(
        chronological,
        "conversations",
        (candidate) => candidate.id === "full_domain_deleted_conversation",
      ),
    ).toMatchObject({
      title: "Deleted conversation",
      last_message_preview: "",
      unread_count: 0,
      message_count: 0,
      attachment_count: 0,
    });
    expect(
      row(
        chronological,
        "messages",
        (candidate) => candidate.id === "full_domain_deleted_message",
      ),
    ).toBeUndefined();
    expect(chronological.applied_events).toHaveLength(17);
    expect(chronological.projection_changes).toHaveLength(17);
    expect(chronological.projection_checkpoints).toEqual([]);
    expect(chronological.projection_change_floors).toEqual([]);
    expect(chronological._sql_schema_migrations).toEqual([
      {
        version: 1,
        name: "initial_tenant_projection",
        applied_at: "2026-09-07T00:00:00.000Z",
      },
      {
        version: 2,
        name: "identity_local_projection_sequences",
        applied_at: "2026-09-10T00:00:00.000Z",
      },
      {
        version: 3,
        name: "durable_outbound_acceptance",
        applied_at: "2026-09-13T00:00:00.000Z",
      },
      {
        version: 4,
        name: "offline_outbound_confirmation",
        applied_at: "2026-09-14T00:00:00.000Z",
      },
      {
        version: 5,
        name: "attachment_expiry",
        applied_at: "2026-09-14T00:00:00.000Z",
      },
    ]);
    expect(chronological.completed_rebuilds).toEqual([]);
    expect(chronological.failed_rebuilds).toEqual([]);
    expect(chronological.connection_bindings).toEqual([
      {
        account_id: FULL_ACCOUNT,
        connection_id: FULL_CONNECTION,
        identity_id: "identity_a",
        platform: "whatsapp",
      },
    ]);

    const appliedIds = chronological.applied_events.map((candidate) =>
      String(candidate.event_id),
    );
    const changedIds = chronological.projection_changes.map((candidate) =>
      String(candidate.event_id),
    );
    expect(new Set(appliedIds)).toEqual(
      new Set(events.map((nextEvent) => nextEvent.event_id)),
    );
    expect(new Set(changedIds)).toEqual(
      new Set(events.map((nextEvent) => nextEvent.event_id)),
    );
    expect(appliedIds).toHaveLength(events.length);
    expect(changedIds).toHaveLength(events.length);
  }, 60_000);

  it("keeps interleaved identity sequences gap-free and deterministic across batch partitions", async () => {
    const events: ProjectionEventEnvelope[] = [
      created("event_convergence_human_one", {
        tenant_id: "tenant_convergence_local_a",
        identity_id: "identity_human",
        account_id: "account_human",
        conversation_id: "conversation_human_one",
        payload: {
          message_id: "message_human_one",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Human sender",
          body: "human one",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
      created("event_convergence_agent_one", {
        tenant_id: "tenant_convergence_local_a",
        identity_id: "identity_agent",
        account_id: "account_agent",
        conversation_id: "conversation_agent_one",
        payload: {
          message_id: "message_agent_one",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Agent sender",
          body: "agent one",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
      created("event_convergence_human_two", {
        tenant_id: "tenant_convergence_local_a",
        identity_id: "identity_human",
        account_id: "account_human",
        conversation_id: "conversation_human_two",
        payload: {
          message_id: "message_human_two",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Human sender",
          body: "human two",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
      created("event_convergence_agent_two", {
        tenant_id: "tenant_convergence_local_a",
        identity_id: "identity_agent",
        account_id: "account_agent",
        conversation_id: "conversation_agent_two",
        payload: {
          message_id: "message_agent_two",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Agent sender",
          body: "agent two",
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      }),
    ];
    const connections = [
      bindingFor("account_agent", "connection_agent", "identity_agent"),
      bindingFor("account_human", "connection_human", "identity_human"),
    ];
    const write = (tenant: string, batch: ProjectionEventEnvelope[]) =>
      input(
        batch.map((nextEvent) => ({ ...nextEvent, tenant_id: tenant })),
        {
          tenant_id: tenant,
          authorization: auth(
            ["projection.write"],
            ["identity_agent", "identity_human"],
            tenant,
          ),
          connections,
        },
      );

    const wholeTenant = "tenant_convergence_local_a";
    const partitionedTenant = "tenant_convergence_local_b";
    const wholeStub = await initialize(wholeTenant);
    const partitionedStub = await initialize(partitionedTenant);
    await wholeStub.applyBatch(write(wholeTenant, events));
    await partitionedStub.applyBatch(
      write(partitionedTenant, events.slice(0, 2)),
    );
    await partitionedStub.applyBatch(write(partitionedTenant, events.slice(2)));

    const sequenceRows = async (
      stub: DurableObjectStub<
        import("../../projection/tenant-projection").TenantProjectionDO
      >,
    ) =>
      rows(
        stub,
        "SELECT event_id, identity_id, identity_sequence FROM projection_changes ORDER BY identity_id, identity_sequence",
      );
    const expected = [
      {
        event_id: "event_convergence_agent_one",
        identity_id: "identity_agent",
        identity_sequence: 1,
      },
      {
        event_id: "event_convergence_agent_two",
        identity_id: "identity_agent",
        identity_sequence: 2,
      },
      {
        event_id: "event_convergence_human_one",
        identity_id: "identity_human",
        identity_sequence: 1,
      },
      {
        event_id: "event_convergence_human_two",
        identity_id: "identity_human",
        identity_sequence: 2,
      },
    ];
    await expect(sequenceRows(wholeStub)).resolves.toEqual(expected);
    await expect(sequenceRows(partitionedStub)).resolves.toEqual(expected);

    await expect(
      wholeStub.applyBatch(write(wholeTenant, [events[1]!, events[0]!])),
    ).resolves.toMatchObject({
      applied_count: 0,
      duplicate_count: 2,
      last_sequence: 4,
    });
    await expect(sequenceRows(wholeStub)).resolves.toEqual(expected);
    await expect(
      rows(
        wholeStub,
        "SELECT identity_id, latest_sequence FROM projection_identity_sequences ORDER BY identity_id",
      ),
    ).resolves.toEqual([
      { identity_id: "identity_agent", latest_sequence: 2 },
      { identity_id: "identity_human", latest_sequence: 2 },
    ]);

    for (const [tenant, stub] of [
      [wholeTenant, wholeStub],
      [partitionedTenant, partitionedStub],
    ] as const) {
      await expect(
        stub.listChanges({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_human",
          generation: 1,
          after_sequence: 0,
          authorization: auth(["projection.read"], ["identity_human"], tenant),
        }),
      ).resolves.toMatchObject({
        latest_sequence: 2,
        items: [{ sequence: 1 }, { sequence: 2 }],
      });
      await expect(
        stub.listChanges({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_agent",
          generation: 1,
          after_sequence: 0,
          authorization: auth(["projection.read"], ["identity_agent"], tenant),
        }),
      ).resolves.toMatchObject({
        latest_sequence: 2,
        items: [{ sequence: 1 }, { sequence: 2 }],
      });
    }
  });

  it("keeps duplicate batches domain-idempotent while retaining an older LWW loser in audit", async () => {
    const tenant = "tenant_full_domain_duplicates";
    const events = fullDomainEvents();
    const stub = await initialize(tenant);
    await applyBatches(stub, tenant, batchesOfSize(events, 1));

    const beforeLoser = await snapshot(stub);
    const winnerBefore = row(
      beforeLoser,
      "messages",
      (candidate) => candidate.id === FULL_MESSAGE,
    );
    const loser = fullEvent(
      "full_domain_older_loser",
      {
        message_id: FULL_MESSAGE,
        body: "older loser body",
        editor_participant_id: FULL_PARTICIPANT,
      },
      "message.edited",
      {
        occurred_at: occurredAt(0),
        observed_at: observedAt(0),
      },
    );
    await expect(
      stub.applyBatch(
        input(tenantEvents(tenant, [loser]), {
          tenant_id: tenant,
          connections: fullBindings(),
        }),
      ),
    ).resolves.toMatchObject({
      applied_count: 1,
      duplicate_count: 0,
      last_sequence: 18,
    });

    const afterLoser = await snapshot(stub);
    expect(
      row(afterLoser, "messages", (candidate) => candidate.id === FULL_MESSAGE),
    ).toEqual(winnerBefore);
    expect(
      row(
        afterLoser,
        "message_versions",
        (candidate) => candidate.event_id === "full_domain_older_loser",
      ),
    ).toMatchObject({
      body: "older loser body",
      version_kind: "edited",
    });
    expect(
      row(
        afterLoser,
        "applied_events",
        (candidate) => candidate.event_id === "full_domain_older_loser",
      ),
    ).toMatchObject({ event_type: "message.edited" });
    expect(
      row(
        afterLoser,
        "projection_changes",
        (candidate) => candidate.event_id === "full_domain_older_loser",
      ),
    ).toMatchObject({ event_type: "message.edited" });
    expect(afterLoser.applied_events).toHaveLength(18);
    expect(afterLoser.projection_changes).toHaveLength(18);

    const beforeDuplicates = await snapshot(stub);
    const duplicateResults: Array<{
      applied_count: number;
      duplicate_count: number;
      last_sequence: number;
    }> = [];
    for (const nextEvent of events) {
      duplicateResults.push(
        await stub.applyBatch(
          input(tenantEvents(tenant, [nextEvent]), {
            tenant_id: tenant,
            connections: fullBindings(),
          }),
        ),
      );
    }
    expect(duplicateResults).toHaveLength(events.length);
    expect(
      duplicateResults.every(
        (result) =>
          result.applied_count === 0 &&
          result.duplicate_count === 1 &&
          result.last_sequence === 18,
      ),
    ).toBe(true);
    await expect(snapshot(stub)).resolves.toEqual(beforeDuplicates);
  }, 60_000);

  it("keeps equal and older duplicate checkpoints unchanged while mixing duplicates with new events", async () => {
    const tenant = "tenant_full_domain_checkpoint_matrix";
    const stub = await initialize(tenant);
    const makeMessage = (eventId: string, messageId: string, minute: number) =>
      created(eventId, {
        tenant_id: tenant,
        occurred_at: occurredAt(minute),
        observed_at: observedAt(minute),
        payload: {
          message_id: messageId,
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "checkpoint sender",
          body: messageId,
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: false,
        },
      });
    const first = makeMessage(
      "checkpoint_matrix_first",
      "checkpoint_message_first",
      0,
    );
    const firstCheckpoint = {
      kind: "matrix_cursor",
      value: "cursor-first",
      last_observed_at: first.observed_at,
      last_event_id: first.event_id,
    };
    await expect(
      stub.applyBatch(
        input([first], {
          tenant_id: tenant,
          connections: [bindingFor("account_a", "connection_a")],
          checkpoint: firstCheckpoint,
        }),
      ),
    ).resolves.toMatchObject({
      applied_count: 1,
      duplicate_count: 0,
      last_sequence: 1,
    });

    const beforeEqual = await snapshot(stub);
    await expect(
      stub.applyBatch(
        input([structuredClone(first)], {
          tenant_id: tenant,
          connections: [bindingFor("account_a", "connection_a")],
          checkpoint: firstCheckpoint,
        }),
      ),
    ).resolves.toMatchObject({
      applied_count: 0,
      duplicate_count: 1,
      last_sequence: 1,
    });
    await expect(snapshot(stub)).resolves.toEqual(beforeEqual);

    const second = makeMessage(
      "checkpoint_matrix_second",
      "checkpoint_message_second",
      1,
    );
    const secondCheckpoint = {
      kind: "matrix_cursor",
      value: "cursor-second",
      last_observed_at: second.observed_at,
      last_event_id: second.event_id,
    };
    await expect(
      stub.applyBatch(
        input([second], {
          tenant_id: tenant,
          connections: [bindingFor("account_a", "connection_a")],
          checkpoint: secondCheckpoint,
        }),
      ),
    ).resolves.toMatchObject({
      applied_count: 1,
      duplicate_count: 0,
      last_sequence: 2,
    });
    const beforeOlder = await snapshot(stub);
    await expect(
      stub.applyBatch(
        input([structuredClone(first)], {
          tenant_id: tenant,
          connections: [bindingFor("account_a", "connection_a")],
          checkpoint: {
            ...firstCheckpoint,
            value: "cursor-older-repeat",
          },
        }),
      ),
    ).resolves.toMatchObject({
      applied_count: 0,
      duplicate_count: 1,
      last_sequence: 2,
    });
    await expect(snapshot(stub)).resolves.toEqual(beforeOlder);

    const third = makeMessage(
      "checkpoint_matrix_third",
      "checkpoint_message_third",
      2,
    );
    const thirdCheckpoint = {
      kind: "matrix_cursor",
      value: "cursor-third",
      last_observed_at: third.observed_at,
      last_event_id: third.event_id,
    };
    await expect(
      stub.applyBatch(
        input([structuredClone(first), third], {
          tenant_id: tenant,
          connections: [bindingFor("account_a", "connection_a")],
          checkpoint: thirdCheckpoint,
        }),
      ),
    ).resolves.toMatchObject({
      applied_count: 1,
      duplicate_count: 1,
      last_sequence: 3,
    });
    await expect(
      rows(
        stub,
        "SELECT value,last_observed_at,last_event_id,last_sequence FROM projection_checkpoints",
      ),
    ).resolves.toEqual([
      {
        value: "cursor-third",
        last_observed_at: third.observed_at,
        last_event_id: third.event_id,
        last_sequence: 3,
      },
    ]);
    await expect(
      rows(stub, "SELECT event_id FROM applied_events ORDER BY event_id"),
    ).resolves.toEqual([
      { event_id: "checkpoint_matrix_first" },
      { event_id: "checkpoint_matrix_second" },
      { event_id: "checkpoint_matrix_third" },
    ]);
  }, 60_000);

  it("rolls back all state on a mixed hash conflict, including the checkpoint and summaries", async () => {
    const tenant = "tenant_full_domain_hash_rollback";
    const stub = await initialize(tenant);
    const original = created("hash_rollback_original", {
      tenant_id: tenant,
      occurred_at: occurredAt(1),
      observed_at: observedAt(1),
    });
    const originalCheckpoint = {
      kind: "hash_cursor",
      value: "cursor-original",
      last_observed_at: original.observed_at,
      last_event_id: original.event_id,
    };
    await stub.applyBatch(
      input([original], {
        tenant_id: tenant,
        connections: [bindingFor("account_a", "connection_a")],
        checkpoint: originalCheckpoint,
      }),
    );
    const before = await snapshot(stub);
    const sentinel = "hash conflict payload must not escape";
    const changed = created("hash_rollback_original", {
      tenant_id: tenant,
      occurred_at: occurredAt(1),
      observed_at: observedAt(1),
      payload: {
        message_id: "message_hash_rollback_changed",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "changed sender",
        body: sentinel,
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });
    const newEvent = created("hash_rollback_new", {
      tenant_id: tenant,
      occurred_at: occurredAt(0),
      observed_at: observedAt(0),
      payload: {
        message_id: "message_hash_rollback_new",
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "new sender",
        body: "must roll back",
        reply_to_message_id: null,
        delivery_status: "unknown",
        unread: false,
      },
    });
    const failure = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.applyBatch(
          input([newEvent, changed], {
            tenant_id: tenant,
            connections: [bindingFor("account_a", "connection_a")],
            checkpoint: {
              ...originalCheckpoint,
              value: "cursor-conflicting",
            },
          }),
        );
        return undefined;
      } catch (error) {
        return {
          error,
          serialized: JSON.stringify(error),
          values: Object.values(error as Record<string, unknown>),
        };
      }
    });
    expect(failure?.error).toMatchObject({
      code: "projection_conflict",
      message: "projection_conflict",
    });
    expect(failure?.serialized).not.toContain(sentinel);
    expect(failure?.values).not.toContain(sentinel);
    await expect(snapshot(stub)).resolves.toEqual(before);
  });

  it("rolls back every table and redacts a malicious forced-failure payload", async () => {
    const tenant = "tenant_full_domain_rollback";
    const stub = await initialize(tenant);
    const before = await snapshot(stub);
    const sentinel =
      "malicious payload must never cross the projection error boundary";

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_projection_change BEFORE INSERT ON projection_changes BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
      );
    });
    try {
      const failedEvent = fullEvent(
        "full_domain_rollback",
        {
          message_id: "full_domain_rollback_message",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "sentinel sender",
          body: sentinel,
          reply_to_message_id: null,
          delivery_status: "unknown",
          unread: true,
        },
        "message.created",
        {
          occurred_at: occurredAt(20),
          observed_at: observedAt(20),
        },
      );
      const failure = await runInDurableObject(stub, async (instance) => {
        try {
          await instance.applyBatch(
            input(tenantEvents(tenant, [failedEvent]), {
              tenant_id: tenant,
              connections: fullBindings(),
              checkpoint: {
                kind: "rollback_cursor",
                value: "rollback-value",
                last_observed_at: failedEvent.observed_at,
                last_event_id: failedEvent.event_id,
              },
            }),
          );
          return undefined;
        } catch (error) {
          return {
            error,
            enumerable: Object.keys(error as object),
            serialized: JSON.stringify(error),
            values: Object.values(error as Record<string, unknown>),
            ownNames: Object.getOwnPropertyNames(error as object),
          };
        }
      });
      expect(failure).toBeDefined();
      expect(failure?.error).toMatchObject({
        code: "projection_unavailable",
        message: "projection_unavailable",
      });
      expect(JSON.stringify(failure?.enumerable)).not.toContain(sentinel);
      expect(failure?.serialized).not.toContain(sentinel);
      expect(failure?.values).not.toContain(sentinel);
      expect(failure?.ownNames).not.toContain("cause");
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_projection_change");
      });
    }
    await expect(snapshot(stub)).resolves.toEqual(before);
  });

  it("accepts exactly 500 distinct conversations and reapplies them without new audit rows", async () => {
    const tenant = "tenant_full_domain_capacity";
    const stub = await initialize(tenant);
    const capacityBinding = bindingFor(
      "capacity_account",
      "capacity_connection",
    );
    const capacityEvents: ProjectionEventEnvelope[] = Array.from(
      { length: 500 },
      (_unused, index) =>
        fullEvent(
          "capacity_event_" + String(index).padStart(3, "0"),
          {
            message_id: "capacity_message_" + String(index).padStart(3, "0"),
            direction: "inbound",
            sender_participant_id: null,
            sender_label: "Capacity sender",
            body: "capacity body " + String(index),
            reply_to_message_id: null,
            delivery_status: "unknown",
            unread: false,
          },
          "message.created",
          {
            account_id: capacityBinding.account_id,
            conversation_id:
              "capacity_conversation_" + String(index).padStart(3, "0"),
            occurred_at: "2026-09-07T03:00:00.000Z",
            observed_at: "2026-09-07T03:00:01.000Z",
          },
        ),
    );
    const request = input(tenantEvents(tenant, capacityEvents), {
      tenant_id: tenant,
      connections: [capacityBinding],
    });
    await expect(stub.applyBatch(request)).resolves.toMatchObject({
      applied_count: 500,
      duplicate_count: 0,
      last_sequence: 500,
    });

    const summaries = await rows<{
      id: string;
      last_message_preview: string;
      message_count: number;
      unread_count: number;
      attachment_count: number;
    }>(
      stub,
      "SELECT id, last_message_preview, message_count, unread_count, attachment_count FROM conversations ORDER BY id",
    );
    expect(summaries).toHaveLength(500);
    for (let index = 0; index < summaries.length; index += 1) {
      const summary = summaries[index];
      const suffix = String(index).padStart(3, "0");
      expect(summary).toEqual({
        id: "capacity_conversation_" + suffix,
        last_message_preview: "capacity body " + String(index),
        message_count: 1,
        unread_count: 0,
        attachment_count: 0,
      });
    }
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM messages"),
    ).resolves.toEqual([{ count: 500 }]);
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM applied_events"),
    ).resolves.toEqual([{ count: 500 }]);
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM projection_changes"),
    ).resolves.toEqual([{ count: 500 }]);
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM connection_bindings"),
    ).resolves.toEqual([{ count: 1 }]);

    const beforeDuplicate = await rows(
      stub,
      "SELECT * FROM conversations ORDER BY id",
    );
    await expect(
      stub.applyBatch(structuredClone(request)),
    ).resolves.toMatchObject({
      applied_count: 0,
      duplicate_count: 500,
      last_sequence: 500,
    });
    await expect(
      rows(stub, "SELECT * FROM conversations ORDER BY id"),
    ).resolves.toEqual(beforeDuplicate);
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM applied_events"),
    ).resolves.toEqual([{ count: 500 }]);
    await expect(
      rows(stub, "SELECT COUNT(*) AS count FROM projection_changes"),
    ).resolves.toEqual([{ count: 500 }]);
  }, 60_000);

  it("guards deterministic projector dispatch and one-set sorted summary recomputation", async () => {
    const projectionSources = [
      projectorSource,
      projectorCommonSource,
      projectorControlSource,
      projectorConversationSource,
      projectorDeletionSource,
      projectorDomainsSource,
      projectorMessagesSource,
      projectorSocialSource,
      projectorTypesSource,
    ];
    const source = projectionSources.join("\n");
    expect(source).not.toMatch(/\bDate\.now\s*\(/);
    expect(source).not.toMatch(/\bnew Date\s*\(\s*\)/);
    expect(source).not.toMatch(/\bMath\.(?:random|floor|ceil)\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(
      /\b(?:console|logger)\.(?:log|debug|info|warn|error)\s*\(/,
    );
    expect(source).not.toMatch(/\b(?:R2|Queue|TENANT_PROJECTION|getByName)\b/);
    expect(source).not.toMatch(
      /\basync\s+(?:function\s+)?(?:project|recompute)/,
    );
    expect(source).not.toMatch(
      /\b(?:projectEvent|recomputeConversationSummaries)\s*=\s*async\b/,
    );

    const dispatch = projectorDomainsSource;
    const eventTypes = [
      "conversation.updated",
      "participant.updated",
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
      "command.updated",
      "bridge.delivery.updated",
      "replay.tombstone",
      "correction.applied",
      "deletion.tombstone",
    ];
    for (const eventType of eventTypes) {
      expect(dispatch).toContain('case "' + eventType + '"');
    }
    expect(dispatch).toContain("assertNeverEventType");

    const domainsSource = projectorDomainsSource;
    const applyPreparedBatchSource = tenantProjectionSource.slice(
      tenantProjectionSource.indexOf("  async #applyPreparedBatch("),
      tenantProjectionSource.indexOf("  #writeReplayCheckpoint("),
    );
    expect(
      applyPreparedBatchSource.match(/new Set<string>\(\)/g) ?? [],
    ).toHaveLength(1);
    expect(tenantProjectionSource).toContain(
      "const touchedConversations = new Set<string>();",
    );
    expect(domainsSource).toContain(
      "const conversationIds = [...touchedConversations].sort();",
    );
    expect(
      domainsSource.match(/\[\.\.\.touchedConversations\]\.sort\(\)/g) ?? [],
    ).toHaveLength(1);
  });
});
