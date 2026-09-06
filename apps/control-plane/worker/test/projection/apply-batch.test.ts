import { env, runInDurableObject } from "cloudflare:test";
import type {
  ApplyProjectionBatchInput,
  ProjectionAuthorizationContext,
  ProjectionConnectionBinding,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import { archiveError } from "../../archive/errors";
import { describe, expect, it } from "vitest";
import type { TenantProjectionDO } from "../../projection/tenant-projection";
import { canonicalJsonLineBytes } from "../../archive/canonical-json";
import {
  mapArchiveFailure,
  prepareProjectionBatch,
} from "../../projection/projector";

const tenantId = "tenant_apply_batch";

const auth = (
  tenant: string,
  scopes: ProjectionAuthorizationContext["scopes"],
  allowedIdentityIds: string[] = ["identity_a"],
): ProjectionAuthorizationContext => ({
  schema_version: 1,
  tenant_id: tenant,
  principal_id: "principal_apply",
  allowed_identity_ids: allowedIdentityIds,
  scopes,
});

const binding = (
  accountId = "account_a",
  connectionId = "connection_a",
  identityId = "identity_a",
  platform: ProjectionConnectionBinding["platform"] = "whatsapp",
): ProjectionConnectionBinding => ({
  account_id: accountId,
  connection_id: connectionId,
  identity_id: identityId,
  platform,
});

const event = (
  eventId: string,
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope => ({
  schema_version: 1,
  event_id: eventId,
  event_type: "message.created",
  event_source: "live",
  tenant_id: tenantId,
  identity_id: "identity_a",
  platform: "whatsapp",
  account_id: "account_a",
  conversation_id: "conversation_a",
  matrix_room_id: null,
  matrix_event_id: null,
  remote_message_id: null,
  occurred_at: "2026-09-07T01:00:00.000Z",
  observed_at: "2026-09-07T01:00:01.000Z",
  payload: {
    message_id: `message_${eventId.replace(/[^a-z0-9_]/g, "_")}`,
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "Alice",
    body: "hello",
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: true,
  },
  ...overrides,
} as ProjectionEventEnvelope);

const applyInput = (
  tenant: string,
  events: ProjectionEventEnvelope[],
  options: Partial<ApplyProjectionBatchInput> = {},
): ApplyProjectionBatchInput => ({
  schema_version: 1,
  tenant_id: tenant,
  authorization: auth(tenant, ["projection.write"]),
  mode: "live",
  rebuild_id: null,
  connections: [binding()],
  events,
  checkpoint: null,
  ...options,
} as ApplyProjectionBatchInput);

const initialize = async (stub: DurableObjectStub<TenantProjectionDO>, tenant = tenantId) => {
  await stub.initialize({
    schema_version: 1,
    tenant_id: tenant,
    initialized_at: "2026-09-07T00:00:00.000Z",
    authorization: auth(tenant, ["projection.initialize"], []),
  });
};

const expectCode = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  input: unknown,
  code: string,
) => {
  const failure = await runInDurableObject(stub, async (instance) => {
    try {
      await instance.applyBatch(input as ApplyProjectionBatchInput);
      return undefined;
    } catch (error) {
      return error;
    }
  });
  expect(failure).toMatchObject({ code, message: code });
};

const rows = async <T extends Record<string, SqlStorageValue>>(
  stub: DurableObjectStub<TenantProjectionDO>,
  sql: string,
): Promise<T[]> =>
  runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql.exec<T>(sql).toArray(),
  );

const INTERNAL_HELPER_NAMES = [
  "applyPreparedBatch",
  "requireReadyState",
  "ensurePersistentBindings",
  "readAppliedEvents",
  "assertStoredEventMatches",
  "readLastSequence",
  "trimProjectionChanges",
  "applyLiveCheckpoint",
  "requireAuthorization",
  "requireStoredTenant",
  "readProjectionMeta",
  "readStatusForMeta",
] as const;

describe("tenant projection applyBatch", () => {
  it("accepts one event and returns one newly applied audit marker", async () => {
    const stub = env.TENANT_PROJECTION.getByName(tenantId);
    await initialize(stub);

    await expect(stub.applyBatch(applyInput(tenantId, [event("event_one")])))
      .resolves.toMatchObject({
        schema_version: 1,
        tenant_id: tenantId,
        generation: 1,
        applied_count: 1,
        duplicate_count: 0,
        last_sequence: 1,
      });

    await expect(rows<{ event_id: string; event_hash: string }>(
      stub,
      "SELECT event_id, event_hash FROM applied_events",
    )).resolves.toHaveLength(1);
  });

  it("accepts the 500-event boundary but rejects 501 before any SQL mutation", async () => {
    const acceptedTenant = "tenant_apply_500";
    const acceptedStub = env.TENANT_PROJECTION.getByName(acceptedTenant);
    await initialize(acceptedStub, acceptedTenant);
    const acceptedEvents = Array.from({ length: 500 }, (_, index) =>
      event(`event_${String(index).padStart(3, "0")}`, {
        tenant_id: acceptedTenant,
        payload: {
          ...(event("event_payload").payload as object),
          message_id: `message_${String(index).padStart(3, "0")}`,
        },
      } as Partial<ProjectionEventEnvelope>),
    );
    await expect(
      acceptedStub.applyBatch(applyInput(acceptedTenant, acceptedEvents)),
    ).resolves.toMatchObject({ applied_count: 500, duplicate_count: 0 });

    const rejectedTenant = "tenant_apply_501";
    const rejectedStub = env.TENANT_PROJECTION.getByName(rejectedTenant);
    await initialize(rejectedStub, rejectedTenant);
    const rejectedEvents = Array.from({ length: 501 }, (_, index) =>
      event(`event_${String(index).padStart(3, "0")}`, {
        tenant_id: rejectedTenant,
        payload: {
          ...(event("event_payload").payload as object),
          message_id: `message_${String(index).padStart(3, "0")}`,
        },
      } as Partial<ProjectionEventEnvelope>),
    );
    await expectCode(
      rejectedStub,
      applyInput(rejectedTenant, rejectedEvents),
      "projection_too_large",
    );
    await expect(rows(rejectedStub, "SELECT * FROM applied_events")).resolves.toEqual([]);
    await expect(rows(rejectedStub, "SELECT * FROM connection_bindings")).resolves.toEqual([]);
  });

  it("counts one UTF-8 newline-delimited canonical line per input event at the 4 MiB boundary", async () => {
    const tenant = "tenant_apply_bytes";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const target = 4 * 1024 * 1024;
    const count = 220;
    const sizedEvents = Array.from({ length: count }, (_, index) =>
      event(`event_bytes_${String(index).padStart(3, "0")}`, {
        tenant_id: tenant,
        payload: {
          ...(event("event_payload").payload as object),
          message_id: `message_bytes_${String(index).padStart(3, "0")}`,
          body: "",
        },
      } as Partial<ProjectionEventEnvelope>),
    );
    const baseBytes = sizedEvents.reduce(
      (total, current) => total + canonicalJsonLineBytes(current).byteLength,
      0,
    );
    let remaining = target - baseBytes;
    for (const current of sizedEvents) {
      const length = Math.min(20_000, remaining);
      current.payload = {
        ...(current.payload as Record<string, unknown>),
        body: "x".repeat(length),
      } as never;
      remaining -= length;
    }
    expect(remaining).toBe(0);
    const exactBytes = sizedEvents.reduce(
      (total, current) => total + canonicalJsonLineBytes(current).byteLength,
      0,
    );
    expect(exactBytes).toBe(target);
    await expect(stub.applyBatch(applyInput(tenant, sizedEvents)))
      .resolves.toMatchObject({ applied_count: count, duplicate_count: 0 });

    const overflow = structuredClone(sizedEvents);
    const last = overflow.at(-1)!;
    last.payload = {
      ...(last.payload as Record<string, unknown>),
      body: `${(last.payload as { body: string }).body}x`,
    } as never;
    await expectCode(stub, applyInput(tenant, overflow), "projection_too_large");
  });

  it("resolves and persists 500 distinct account bindings without an oversized SQL IN query", async () => {
    const tenant = "tenant_apply_500_bindings";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const bindings = Array.from({ length: 500 }, (_, index) =>
      binding(
        `account_${String(index).padStart(3, "0")}`,
        `connection_${String(index).padStart(3, "0")}`,
      ),
    );
    const events = bindings.map((current, index) =>
      event(`event_binding_${String(index).padStart(3, "0")}`, {
        tenant_id: tenant,
        account_id: current.account_id,
        payload: {
          ...(event("event_payload").payload as object),
          message_id: `message_binding_${String(index).padStart(3, "0")}`,
        },
      } as Partial<ProjectionEventEnvelope>),
    );
    await expect(stub.applyBatch(applyInput(tenant, events, { connections: bindings })))
      .resolves.toMatchObject({ applied_count: 500, duplicate_count: 0 });
    await expect(rows(stub, "SELECT COUNT(*) AS count FROM connection_bindings")).resolves.toEqual([{ count: 500 }]);
    await expect(rows(stub, "SELECT COUNT(*) AS count FROM applied_events")).resolves.toEqual([{ count: 500 }]);
  });

  it("collapses exact duplicate IDs in one input and across calls", async () => {
    const tenant = "tenant_apply_duplicates";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const duplicate = event("event_duplicate", { tenant_id: tenant });

    await expect(stub.applyBatch(applyInput(tenant, [duplicate, structuredClone(duplicate)])))
      .resolves.toMatchObject({ applied_count: 1, duplicate_count: 1, last_sequence: 1 });
    await expect(stub.applyBatch(applyInput(tenant, [structuredClone(duplicate)])))
      .resolves.toMatchObject({ applied_count: 0, duplicate_count: 1, last_sequence: 1 });
    await expect(rows(stub, "SELECT * FROM applied_events")).resolves.toHaveLength(1);
    await expect(rows(stub, "SELECT * FROM projection_changes")).resolves.toHaveLength(1);
  });

  it("rejects an exact event retry when its resolved connection binding changes", async () => {
    const tenant = "tenant_apply_same_hash_binding_conflict";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const original = event("event_same_hash_binding", { tenant_id: tenant });

    await expect(
      stub.applyBatch(
        applyInput(tenant, [original], {
          connections: [binding("account_a", "connection_original")],
        }),
      ),
    ).resolves.toMatchObject({ applied_count: 1, duplicate_count: 0 });

    await expectCode(
      stub,
      applyInput(tenant, [structuredClone(original)], {
        connections: [binding("account_a", "connection_changed")],
      }),
      "projection_conflict",
    );

    await expect(rows(stub, "SELECT * FROM connection_bindings")).resolves.toEqual([
      {
        account_id: "account_a",
        connection_id: "connection_original",
        identity_id: "identity_a",
        platform: "whatsapp",
      },
    ]);
    await expect(rows(stub, "SELECT event_id FROM applied_events")).resolves.toEqual([
      { event_id: original.event_id },
    ]);
    await expect(rows(stub, "SELECT event_id FROM projection_changes")).resolves.toEqual([
      { event_id: original.event_id },
    ]);
  });

  it("detaches prepared events before asynchronous hashing can observe caller mutation", async () => {
    const tenant = "tenant_apply_detached";
    const input = applyInput(tenant, [event("event_detached", { tenant_id: tenant })]);
    const preparedPromise = prepareProjectionBatch(input);
    (input.events[0]!.payload as { body: string }).body = "mutated after snapshot";
    const prepared = await preparedPromise;
    expect((prepared.events[0]!.event.payload as { body: string }).body).toBe("hello");
  });

  it("keeps every projection helper runtime-private and blocks forged prepared application", async () => {
    const tenant = "tenant_apply_private_helpers";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const forgedPreparedEvent = {
      event: event("event_forged", { tenant_id: tenant }),
      connection: binding(),
      eventHash: "0".repeat(64),
      canonicalLineBytes: 1,
      observedMs: Date.parse("2026-09-07T01:00:01.000Z"),
      occurredMs: Date.parse("2026-09-07T01:00:00.000Z"),
    };

    const reflection = await runInDurableObject(stub, async (instance) => {
      const prototype = Object.getPrototypeOf(instance);
      const visibleHelpers = INTERNAL_HELPER_NAMES.filter(
        (name) => Reflect.get(prototype, name) !== undefined || Reflect.get(instance, name) !== undefined,
      );
      const forged = Reflect.get(instance, "applyPreparedBatch");
      if (typeof forged === "function") {
        try {
          await forged.call(instance, {
            tenantId: tenant,
            mode: "live",
            rebuildId: null,
            preparedEvents: [forgedPreparedEvent],
            checkpointMutation: null,
            inputEventCount: 1,
            connections: [binding()],
          });
        } catch {
          // The visibility assertion below is the security boundary. Any
          // legacy reflective invocation is intentionally not trusted.
        }
      }
      return { visibleHelpers, forgedCallable: typeof forged === "function" };
    });

    expect(reflection.visibleHelpers).toEqual([]);
    expect(reflection.forgedCallable).toBe(false);
    await expect(rows(stub, "SELECT * FROM connection_bindings")).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM applied_events")).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM projection_changes")).resolves.toEqual([]);
  });

  it.each([
    ["archive_invalid", "projection_invalid"],
    ["archive_corrupt", "projection_invalid"],
    ["archive_not_found", "projection_invalid"],
    ["archive_tenant_mismatch", "projection_tenant_mismatch"],
    ["archive_too_large", "projection_too_large"],
    ["archive_conflict", "projection_conflict"],
    ["archive_unavailable", "projection_unavailable"],
  ] as const)("maps %s to %s without leaking a malicious sentinel", (archiveCode, projectionCode) => {
    const sentinel = "payload=malicious sentinel SQL=secret";
    const mapped = mapArchiveFailure(archiveError(archiveCode, sentinel));

    expect(mapped.code).toBe(projectionCode);
    expect(mapped.message).toBe(projectionCode);
    expect(Object.keys(mapped)).toEqual(["code"]);
    expect(JSON.stringify(mapped)).not.toContain(sentinel);
    expect(Object.values(mapped)).not.toContain(sentinel);
    expect(Object.getOwnPropertyNames(mapped)).not.toContain("cause");
  });

  it("maps unknown canonicalization failures to unavailable without leaking the cause", () => {
    const sentinel = "payload=unknown canonicalization sentinel";
    const mapped = mapArchiveFailure(new Error(sentinel));

    expect(mapped.code).toBe("projection_unavailable");
    expect(mapped.message).toBe("projection_unavailable");
    expect(Object.keys(mapped)).toEqual(["code"]);
    expect(JSON.stringify(mapped)).not.toContain(sentinel);
    expect(Object.values(mapped)).not.toContain(sentinel);
    expect(Object.getOwnPropertyNames(mapped)).not.toContain("cause");
  });

  it("rejects same event ID with a different canonical hash and rolls back the batch", async () => {
    const tenant = "tenant_apply_hash_conflict";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const original = event("event_conflict", { tenant_id: tenant });
    await stub.applyBatch(applyInput(tenant, [original]));
    const changed = event("event_conflict", {
      tenant_id: tenant,
      payload: { ...(original.payload as Record<string, unknown>), body: "changed" } as never,
    } as Partial<ProjectionEventEnvelope>);
    await expectCode(stub, applyInput(tenant, [changed, event("event_new", { tenant_id: tenant })]), "projection_conflict");
    await expect(rows(stub, "SELECT event_id FROM applied_events ORDER BY event_id")).resolves.toEqual([
      { event_id: "event_conflict" },
    ]);
  });

  it("requires exact account bindings and rejects remaps or unused rows", async () => {
    const tenant = "tenant_apply_bindings";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    await stub.applyBatch(applyInput(tenant, [event("event_binding", { tenant_id: tenant })], {
      connections: [binding("account_a", "connection_other")],
    }));
    await expectCode(
      stub,
      applyInput(tenant, [event("event_binding_2", { tenant_id: tenant })], {
        connections: [binding("account_a", "connection_a")],
      }),
      "projection_conflict",
    );
    await expectCode(
      stub,
      applyInput(tenant, [event("event_binding", { tenant_id: tenant })], {
        connections: [binding(), binding("account_b", "connection_b")],
      }),
      "projection_conflict",
    );
    await expect(rows(stub, "SELECT * FROM connection_bindings")).resolves.toEqual([
      {
        account_id: "account_a",
        connection_id: "connection_other",
        identity_id: "identity_a",
        platform: "whatsapp",
      },
    ]);
  });

  it("rejects tenant, identity, state, mode, scope, and attachment cross-field failures before SQL", async () => {
    const tenant = "tenant_apply_preflight";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const valid = event("event_preflight", { tenant_id: tenant });
    await expectCode(stub, {
      ...applyInput(tenant, [valid]),
      authorization: auth(tenant, ["projection.read"], ["identity_a"]),
    }, "projection_forbidden");
    await expectCode(stub, {
      ...applyInput(tenant, [valid]),
      events: [event("event_wrong_tenant", { tenant_id: "tenant_other" })],
    }, "projection_tenant_mismatch");
    await expectCode(stub, {
      ...applyInput(tenant, [valid]),
      mode: "replay",
    }, "projection_invalid");
    await expectCode(stub, {
      ...applyInput(tenant, [valid]),
      events: [event("event_missing_grant", { tenant_id: tenant, identity_id: "identity_b" })],
    }, "projection_forbidden");
    await expectCode(stub, {
      ...applyInput(tenant, [event("event_bad_media", { tenant_id: tenant, event_type: "attachment.observed", payload: {
        attachment_id: "attachment_a", message_id: "message_a", file_name: null, mime_type: null,
        size_bytes: null, sha256: null, r2_key: "media/tenant_apply_preflight/not-null",
      } })]),
      connections: [binding()],
    }, "projection_invalid");
    await expect(rows(stub, "SELECT * FROM applied_events")).resolves.toEqual([]);
    await expect(rows(stub, "SELECT * FROM connection_bindings")).resolves.toEqual([]);
  });

  it("uses observed timestamp and UTF-8 opaque ID order for deterministic changes", async () => {
    const tenant = "tenant_apply_order";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const events = [
      event("event_prefix_long", { tenant_id: tenant, observed_at: "2026-09-07T01:00:00.000Z" }),
      event("event_prefix", { tenant_id: tenant, observed_at: "2026-09-07T01:00:00.000Z" }),
      event("event_😀", { tenant_id: tenant, observed_at: "2026-09-07T01:00:00.000Z" }),
      event("event_é", { tenant_id: tenant, observed_at: "2026-09-07T01:00:00.000Z" }),
    ];
    await stub.applyBatch(applyInput(tenant, events));
    const changes = await rows<{ event_id: string; sequence: number }>(
      stub,
      "SELECT event_id, sequence FROM projection_changes ORDER BY sequence",
    );
    expect(changes.map((row) => row.event_id)).toEqual([
      "event_prefix",
      "event_prefix_long",
      "event_é",
      "event_😀",
    ]);
  });

  it("applies generic live checkpoints only under the exact tuple rules", async () => {
    const tenant = "tenant_apply_checkpoint";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const first = event("event_checkpoint_1", {
      tenant_id: tenant,
      observed_at: "2026-09-07T01:00:00.000Z",
    });
    await stub.applyBatch(applyInput(tenant, [first], {
      checkpoint: {
        kind: "source_cursor",
        value: "cursor-1",
        last_observed_at: first.observed_at,
        last_event_id: first.event_id,
      },
    }));
    await expect(rows(stub, "SELECT kind,value,last_observed_at,last_event_id,last_sequence FROM projection_checkpoints")).resolves.toEqual([
      { kind: "source_cursor", value: "cursor-1", last_observed_at: first.observed_at, last_event_id: first.event_id, last_sequence: 1 },
    ]);
    await expect(stub.applyBatch(applyInput(tenant, [structuredClone(first)], {
      checkpoint: {
        kind: "source_cursor",
        value: "cursor-1",
        last_observed_at: first.observed_at,
        last_event_id: first.event_id,
      },
    }))).resolves.toMatchObject({ applied_count: 0, duplicate_count: 1, last_sequence: 1 });
    await expectCode(stub, applyInput(tenant, [structuredClone(first)], {
      checkpoint: {
        kind: "source_cursor",
        value: "different",
        last_observed_at: first.observed_at,
        last_event_id: first.event_id,
      },
    }), "projection_conflict");
    await expectCode(stub, applyInput(tenant, [structuredClone(first)], {
      checkpoint: {
        kind: "r2_manifest_cursor",
        value: "cursor-1",
        last_observed_at: first.observed_at,
        last_event_id: first.event_id,
      },
    }), "projection_invalid");
  });

  it("advances only newer live checkpoint tuples and still applies duplicate-only batches", async () => {
    const tenant = "tenant_apply_checkpoint_order";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    const first = event("event_checkpoint_old", {
      tenant_id: tenant,
      observed_at: "2026-09-07T01:00:00.000Z",
    });
    await stub.applyBatch(applyInput(tenant, [first], {
      checkpoint: {
        kind: "source_cursor",
        value: "cursor-old",
        last_observed_at: first.observed_at,
        last_event_id: first.event_id,
      },
    }));
    const newer = event("event_checkpoint_new", {
      tenant_id: tenant,
      observed_at: "2026-09-07T02:00:00.000Z",
    });
    await stub.applyBatch(applyInput(tenant, [newer], {
      checkpoint: {
        kind: "source_cursor",
        value: "cursor-new",
        last_observed_at: newer.observed_at,
        last_event_id: newer.event_id,
      },
    }));
    await stub.applyBatch(applyInput(tenant, [structuredClone(first)], {
      checkpoint: {
        kind: "source_cursor",
        value: "cursor-older-repeat",
        last_observed_at: first.observed_at,
        last_event_id: first.event_id,
      },
    }));
    await expect(rows(stub, "SELECT value,last_observed_at,last_event_id,last_sequence,source_cursor,page_digest,last_applied_count,last_duplicate_count FROM projection_checkpoints")).resolves.toEqual([
      {
        value: "cursor-new",
        last_observed_at: newer.observed_at,
        last_event_id: newer.event_id,
        last_sequence: 2,
        source_cursor: null,
        page_digest: null,
        last_applied_count: null,
        last_duplicate_count: null,
      },
    ]);
  });

  it("rejects live application while rebuilding or rebuild_failed", async () => {
    const tenant = "tenant_apply_state_guard";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    for (const [state, code] of [
      ["rebuilding", "projection_rebuilding"],
      ["rebuild_failed", "projection_rebuild_failed"],
    ] as const) {
      await runInDurableObject(stub, async (_instance, context) => {
        context.storage.sql.exec("UPDATE projection_meta SET state = ?", state);
      });
      await expectCode(stub, applyInput(tenant, [event(`event_${state}`, { tenant_id: tenant })]), code);
    }
  });

  it("sanitizes a SQL failure and rolls back bindings, events, changes, checkpoints, and floors", async () => {
    const tenant = "tenant_apply_rollback";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(stub, tenant);
    let triggerIsTemporary = true;
    await runInDurableObject(stub, async (_instance, state) => {
      try {
        state.storage.sql.exec(
          "CREATE TEMP TRIGGER fail_projection_change BEFORE INSERT ON main.projection_changes BEGIN SELECT RAISE(ABORT,'synthetic'); END",
        );
      } catch (error) {
        // The current workerd test authorizer rejects TEMP schema objects
        // (`SQLITE_AUTH`), so retain the same failure seam with a temporary
        // persistent trigger and surface the runtime limitation in the test.
        triggerIsTemporary = false;
        expect(String(error)).toContain("SQLITE_AUTH");
        state.storage.sql.exec(
          "CREATE TRIGGER fail_projection_change BEFORE INSERT ON projection_changes BEGIN SELECT RAISE(ABORT,'synthetic'); END",
        );
      }
    });
    try {
      const pending = event("event_rollback", { tenant_id: tenant });
      await expectCode(stub, applyInput(tenant, [pending], {
        checkpoint: {
          kind: "source_cursor",
          value: "cursor-rollback",
          last_observed_at: pending.observed_at,
          last_event_id: pending.event_id,
        },
      }), "projection_unavailable");
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_projection_change");
      });
    }
    expect(triggerIsTemporary).toBe(false);
    for (const table of ["connection_bindings", "applied_events", "projection_changes", "projection_change_floors", "projection_checkpoints"]) {
      await expect(rows(stub, `SELECT * FROM ${table}`)).resolves.toEqual([]);
    }
  });
});
