import { runInDurableObject } from "cloudflare:test";
import type { CommittedArchivePointer } from "@communicator/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import {
  cleanupIngestionFixture,
  createCapturingQueue,
  deliverQueueMessages,
  env,
  expectArchivePairUnchanged,
  listTenantArchiveKeys,
  messageEvent,
  postIngestionBatch,
  requestEnvironment,
  requestForEvents,
  seedIngestionFixture,
  snapshotArchivePair,
  type IngestionFixture,
} from "./support";

let fixture: IngestionFixture;

beforeEach(async () => {
  fixture = await seedIngestionFixture("log_redaction");
});

afterEach(async () => {
  await cleanupIngestionFixture(fixture);
});

const bytesContainCanary = (
  bytes: Uint8Array,
  encodedCanaries: readonly Uint8Array[],
): boolean =>
  encodedCanaries.some((canary) => {
    if (canary.byteLength === 0 || canary.byteLength > bytes.byteLength)
      return false;
    for (
      let offset = 0;
      offset <= bytes.byteLength - canary.byteLength;
      offset += 1
    ) {
      let matches = true;
      for (let index = 0; index < canary.byteLength; index += 1) {
        if (bytes[offset + index] !== canary[index]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
    return false;
  });

const hasCanaryIn = (
  value: unknown,
  canaries: readonly string[],
  encodedCanaries: readonly Uint8Array[],
  seen: WeakSet<object>,
): boolean => {
  if (typeof value === "string")
    return canaries.some((canary) => value.includes(canary));
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (value instanceof ArrayBuffer) {
    if (bytesContainCanary(new Uint8Array(value), encodedCanaries)) return true;
  } else {
    const sharedArrayBufferConstructor = (
      globalThis as {
        SharedArrayBuffer?: typeof SharedArrayBuffer;
      }
    ).SharedArrayBuffer;
    if (
      sharedArrayBufferConstructor !== undefined &&
      value instanceof sharedArrayBufferConstructor &&
      bytesContainCanary(new Uint8Array(value), encodedCanaries)
    ) {
      return true;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      if (bytesContainCanary(bytes, encodedCanaries)) return true;
    }
  }

  if (value instanceof Map) {
    for (const [key, mapValue] of value) {
      if (
        hasCanaryIn(key, canaries, encodedCanaries, seen) ||
        hasCanaryIn(mapValue, canaries, encodedCanaries, seen)
      ) {
        return true;
      }
    }
  } else if (value instanceof Set) {
    for (const setValue of value) {
      if (hasCanaryIn(setValue, canaries, encodedCanaries, seen)) return true;
    }
  }

  for (const key of Reflect.ownKeys(value)) {
    if (
      (typeof key === "string" &&
        canaries.some((canary) => key.includes(canary))) ||
      (typeof key === "symbol" &&
        key.description !== undefined &&
        canaries.some((canary) => key.description!.includes(canary)))
    ) {
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor &&
      "value" in descriptor &&
      hasCanaryIn(descriptor.value, canaries, encodedCanaries, seen)
    ) {
      return true;
    }
  }
  return false;
};

const hasCanary = (
  value: unknown,
  canaries: readonly string[],
  seen = new WeakSet<object>(),
): boolean =>
  hasCanaryIn(
    value,
    canaries,
    canaries.map((canary) => new TextEncoder().encode(canary)),
    seen,
  );

const callableConsoleMethodNames = (): string[] => {
  const methods = new Set<string>();
  let target: object | null = console;
  while (target !== null && target !== Object.prototype) {
    for (const key of Reflect.ownKeys(target)) {
      if (typeof key !== "string" || methods.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (
        descriptor === undefined ||
        descriptor.configurable !== true ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "function"
      ) {
        continue;
      }
      const ownDescriptor = Object.getOwnPropertyDescriptor(console, key);
      if (
        (ownDescriptor !== undefined && ownDescriptor.configurable !== true) ||
        (ownDescriptor === undefined && !Object.isExtensible(console))
      ) {
        continue;
      }
      methods.add(key);
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  return [...methods].sort();
};

const statusAuthorization = (fixtureValue: IngestionFixture) => ({
  schema_version: 1 as const,
  tenant_id: fixtureValue.tenantId,
  principal_id: `principal_reader_${fixtureValue.suffix}`,
  allowed_identity_ids: [fixtureValue.identities.human],
  scopes: ["projection.status" as const],
});

const unavailableDatabase = (canary: string): D1Database =>
  ({
    prepare: () => {
      throw new Error(canary);
    },
  }) as unknown as D1Database;

const unavailableArchive = (canary: string): R2Bucket =>
  ({
    get: async (key: string) => env.EVENT_ARCHIVE.get(key),
    put: async () => {
      throw new Error(canary);
    },
  }) as unknown as R2Bucket;

describe("ingestion observability boundaries", () => {
  it("never logs request bodies, tokens, protected IDs, or raw archive content across denial, failure, conflict, and success", async () => {
    const bodyCanary = `private-message-body-${fixture.suffix}`;
    const jwtCanary = `eyJ${fixture.suffix}.jwt-canary.signature`;
    const matrixTokenCanary = `syt_${fixture.suffix}_matrix_sync_token`;
    const matrixRoomCanary = `!private-room-${fixture.suffix}:example`;
    const matrixEventCanary = `$private-event-${fixture.suffix}:example`;
    const remoteCanary = `remote-private-${fixture.suffix}`;
    const d1Canary = `d1-private-sql-${fixture.suffix}`;
    const r2Canary = `r2-private-write-${fixture.suffix}`;
    const doCanary = `do-private-transaction-${fixture.suffix}`;
    const queueCanary = `queue-private-send-${fixture.suffix}`;
    const containerCanary = `container-private-${fixture.suffix}`;
    const consoleSurfaceCanary = `console-surface-private-${fixture.suffix}`;
    const protectedCanaries = [
      jwtCanary,
      matrixTokenCanary,
      matrixRoomCanary,
      matrixEventCanary,
      remoteCanary,
      bodyCanary,
      d1Canary,
      r2Canary,
      doCanary,
      queueCanary,
      fixture.issuer,
      fixture.subject,
      fixture.tokenId,
      fixture.tenantId,
      fixture.otherTenantId,
      fixture.routes.human,
      fixture.routes.agent,
      fixture.routes.telegram,
      fixture.routes.otherTenant,
      fixture.identities.human,
      fixture.identities.agent,
      fixture.identities.otherTenantHuman,
      fixture.connections.humanWhatsapp,
      fixture.connections.agentWhatsapp,
      fixture.connections.humanTelegram,
      fixture.connections.otherTenantWhatsapp,
      fixture.accounts.humanWhatsapp,
      fixture.accounts.agentWhatsapp,
      fixture.accounts.humanTelegram,
      fixture.accounts.otherTenantWhatsapp,
      fixture.servicePrincipalId,
    ];
    const forbiddenPointerCanaries = (
      pointer: Pick<CommittedArchivePointer, "tenant_id" | "gateway_route_id">,
    ): string[] => {
      const allowedPointerValues = new Set([
        pointer.tenant_id,
        pointer.gateway_route_id,
      ]);
      return protectedCanaries.filter(
        (canary) => !allowedPointerValues.has(canary),
      );
    };

    expect(
      hasCanary(new Map([[containerCanary, "map-key"]]), [containerCanary]),
    ).toBe(true);
    expect(
      hasCanary(new Map([["map-value", containerCanary]]), [containerCanary]),
    ).toBe(true);
    expect(hasCanary(new Set([containerCanary]), [containerCanary])).toBe(true);
    const encodedContainerCanary = new TextEncoder().encode(containerCanary);
    expect(hasCanary(encodedContainerCanary, [containerCanary])).toBe(true);
    expect(hasCanary(encodedContainerCanary.buffer, [containerCanary])).toBe(
      true,
    );

    const capturedCalls: unknown[][] = [];
    const consoleSpies: Array<{ mockRestore: () => void }> = [];
    const spiedConsoleMethods: string[] = [];
    try {
      for (const method of callableConsoleMethodNames()) {
        try {
          const candidate = vi.spyOn(
            console as unknown as Record<
              string,
              (...args: unknown[]) => unknown
            >,
            method,
          );
          try {
            candidate.mockImplementation((...args: unknown[]) => {
              capturedCalls.push(args);
            });
            consoleSpies.push(candidate);
            spiedConsoleMethods.push(method);
          } catch {
            candidate.mockRestore();
          }
        } catch {
          // Some runtimes expose callable console members that cannot be spied on.
          // Successfully configured spies are restored in the finally block below.
        }
      }
      expect(spiedConsoleMethods).toEqual(
        expect.arrayContaining(["trace", "dir", "table", "assert"]),
      );
      const formerlyUncoveredMethod = spiedConsoleMethods.find((method) =>
        ["trace", "dir", "table", "assert"].includes(method),
      );
      expect(formerlyUncoveredMethod).toBeDefined();
      const emitConsoleCanary = (
        console as unknown as Record<string, (...args: unknown[]) => unknown>
      )[formerlyUncoveredMethod!];
      expect(typeof emitConsoleCanary).toBe("function");
      if (typeof emitConsoleCanary !== "function")
        throw new Error("console regression method is not callable");
      emitConsoleCanary(consoleSurfaceCanary);
      expect(
        capturedCalls.some((call) => hasCanary(call, [consoleSurfaceCanary])),
      ).toBe(true);

      const denied = await createApp({
        createIngestionTokenVerifier: () => ({
          verify: async () => ({
            issuer: fixture.issuer,
            subject: fixture.subject,
            token_id: fixture.tokenId,
          }),
        }),
      }).request(
        "https://example.test/internal/v1/ingestion/batches",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authorization: jwtCanary,
            source_checkpoint: matrixTokenCanary,
            body: bodyCanary,
            room_id: matrixRoomCanary,
          }),
        },
        requestEnvironment(),
      );
      expect(denied.status).toBe(401);

      const invalid = await createApp({
        createIngestionTokenVerifier: () => ({
          verify: async () => ({
            issuer: fixture.issuer,
            subject: fixture.subject,
            token_id: fixture.tokenId,
          }),
        }),
      }).request(
        "https://example.test/internal/v1/ingestion/batches",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwtCanary}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            source_checkpoint: matrixTokenCanary,
            body: bodyCanary,
            room_id: matrixRoomCanary,
          }),
        },
        requestEnvironment(),
      );
      expect(invalid.status).toBe(400);

      const conflictEvent = messageEvent(fixture, {
        eventId: `$redaction-conflict-${fixture.suffix}:example`,
        body: bodyCanary,
        matrixRoomId: matrixRoomCanary,
        matrixEventId: matrixEventCanary,
        remoteMessageId: remoteCanary,
      });
      const conflictRequest = await requestForEvents(fixture, [conflictEvent]);
      const conflictIngress = await postIngestionBatch(
        fixture,
        conflictRequest,
        createCapturingQueue(),
      );
      expect(conflictIngress.response.status).toBe(202);
      const conflictPointer = conflictIngress.queue.messages[0]!.body;
      const beforeConflict = await snapshotArchivePair(conflictPointer);
      const conflict = await deliverQueueMessages([
        {
          id: `queue-redaction-conflict-${fixture.suffix}`,
          body: { ...conflictPointer, canonical_sha256: "f".repeat(64) },
        },
      ]);
      expect(conflict.result).toMatchObject({
        explicitAcks: [],
        retryMessages: [
          { msgId: `queue-redaction-conflict-${fixture.suffix}` },
        ],
      });
      expect(
        conflict.retryOptions.get(`queue-redaction-conflict-${fixture.suffix}`),
      ).toEqual({ delaySeconds: 300 });
      await expectArchivePairUnchanged(conflictPointer, beforeConflict);
      const conflictProjection = env.TENANT_PROJECTION.getByName(
        fixture.tenantId,
      );
      const conflictState = await runInDurableObject(
        conflictProjection,
        async (instance) => {
          try {
            await instance.getStatus({
              schema_version: 1,
              tenant_id: fixture.tenantId,
              authorization: statusAuthorization(fixture),
            });
            return undefined;
          } catch (failure) {
            return failure;
          }
        },
      );
      expect(conflictState).toMatchObject({ code: "projection_not_found" });

      const d1FailureEvent = messageEvent(fixture, {
        eventId: `$redaction-d1-${fixture.suffix}:example`,
        body: bodyCanary,
      });
      const d1FailureRequest = await requestForEvents(fixture, [
        d1FailureEvent,
      ]);
      const d1Failure = await postIngestionBatch(
        fixture,
        d1FailureRequest,
        createCapturingQueue(),
        { CONTROL_DB: unavailableDatabase(d1Canary) },
      );
      expect(d1Failure.response.status).toBe(503);
      await expect(d1Failure.response.json()).resolves.toMatchObject({
        error: { code: "ingestion_unavailable" },
      });

      const r2FailureEvent = messageEvent(fixture, {
        eventId: `$redaction-r2-${fixture.suffix}:example`,
        body: bodyCanary,
      });
      const r2FailureRequest = await requestForEvents(fixture, [
        r2FailureEvent,
      ]);
      const r2Failure = await postIngestionBatch(
        fixture,
        r2FailureRequest,
        createCapturingQueue(),
        { EVENT_ARCHIVE: unavailableArchive(r2Canary) },
      );
      expect(r2Failure.response.status).toBe(503);
      await expect(r2Failure.response.json()).resolves.toMatchObject({
        error: { code: "ingestion_unavailable" },
      });

      const queueFailureEvent = messageEvent(fixture, {
        eventId: `$redaction-queue-${fixture.suffix}:example`,
        tenantId: fixture.otherTenantId,
        identityId: fixture.identities.otherTenantHuman,
        accountId: fixture.accounts.otherTenantWhatsapp,
        body: bodyCanary,
      });
      const queueFailureRequest = await requestForEvents(
        fixture,
        [queueFailureEvent],
        {
          tenant_id: fixture.otherTenantId,
          gateway_route_id: fixture.routes.otherTenant,
        },
      );
      let queueFailurePointer: CommittedArchivePointer | undefined;
      const queueFailureApp = createApp({
        createIngestionTokenVerifier: () => ({
          verify: async () => ({
            issuer: fixture.issuer,
            subject: fixture.subject,
            token_id: fixture.tokenId,
          }),
        }),
        sendIngestionQueue: async (pointer) => {
          queueFailurePointer = pointer;
          throw new Error(queueCanary);
        },
      });
      const queueFailureResponse = await queueFailureApp.request(
        "https://example.test/internal/v1/ingestion/batches",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwtCanary}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(queueFailureRequest),
        },
        requestEnvironment(),
      );
      expect(queueFailureResponse.status).toBe(503);
      await expect(queueFailureResponse.json()).resolves.toEqual({
        error: {
          code: "ingestion_unavailable",
          message: "Ingestion service is unavailable",
        },
      });
      expect(queueFailurePointer).toBeDefined();
      const committedQueueFailurePointer = queueFailurePointer!;
      const queueFailureArchive = await snapshotArchivePair(
        committedQueueFailurePointer,
      );
      expect(await listTenantArchiveKeys(fixture.otherTenantId)).toEqual(
        [queueFailureArchive.data.key, queueFailureArchive.manifest.key].sort(),
      );
      const queueFailureManifest = JSON.parse(
        new TextDecoder().decode(queueFailureArchive.manifest.bytes),
      ) as {
        tenant_id: string;
        batch_id: string;
        data_key: string;
        canonical_sha256: string;
        event_count: number;
      };
      expect(queueFailureManifest).toMatchObject({
        tenant_id: fixture.otherTenantId,
        batch_id: committedQueueFailurePointer.batch_id,
        data_key: queueFailureArchive.data.key,
        canonical_sha256: committedQueueFailurePointer.canonical_sha256,
        event_count: 1,
      });
      expect(
        hasCanary(
          committedQueueFailurePointer,
          forbiddenPointerCanaries(committedQueueFailurePointer),
        ),
      ).toBe(false);
      await expectArchivePairUnchanged(
        committedQueueFailurePointer,
        queueFailureArchive,
      );

      const successEvent = messageEvent(fixture, {
        eventId: `$redaction-success-${fixture.suffix}:example`,
        body: bodyCanary,
        matrixRoomId: matrixRoomCanary,
        matrixEventId: matrixEventCanary,
        remoteMessageId: remoteCanary,
      });
      const successRequest = await requestForEvents(fixture, [successEvent]);
      const successIngress = await postIngestionBatch(fixture, successRequest);
      expect(successIngress.response.status).toBe(202);
      const successPointer = successIngress.queue.messages[0]!.body;
      expect(
        hasCanary(successPointer, forbiddenPointerCanaries(successPointer)),
      ).toBe(false);
      const projected = await deliverQueueMessages([
        {
          id: `queue-redaction-success-${fixture.suffix}`,
          body: successPointer,
        },
      ]);
      expect(projected.result).toMatchObject({
        explicitAcks: [`queue-redaction-success-${fixture.suffix}`],
        retryMessages: [],
      });
      const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
      await expect(
        projection.getStatus({
          schema_version: 1,
          tenant_id: fixture.tenantId,
          authorization: statusAuthorization(fixture),
        }),
      ).resolves.toMatchObject({ applied_event_count: 1, message_count: 1 });

      const transactionEvent = messageEvent(fixture, {
        eventId: `$redaction-transaction-${fixture.suffix}:example`,
        body: doCanary,
      });
      const transactionRequest = await requestForEvents(fixture, [
        transactionEvent,
      ]);
      const transactionIngress = await postIngestionBatch(
        fixture,
        transactionRequest,
      );
      expect(transactionIngress.response.status).toBe(202);
      const transactionPointer = transactionIngress.queue.messages[0]!.body;
      const beforeTransaction = await snapshotArchivePair(transactionPointer);
      const beforeTransactionStatus = await projection.getStatus({
        schema_version: 1,
        tenant_id: fixture.tenantId,
        authorization: statusAuthorization(fixture),
      });
      await runInDurableObject(projection, async (_instance, state) => {
        state.storage.sql.exec(
          "CREATE TRIGGER ingestion_redaction_fail_projection BEFORE INSERT ON projection_changes BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END",
        );
      });
      const transactionFailure = await deliverQueueMessages([
        {
          id: `queue-redaction-transaction-${fixture.suffix}`,
          body: transactionPointer,
        },
      ]);
      expect(transactionFailure.result).toMatchObject({
        explicitAcks: [],
        retryMessages: [
          { msgId: `queue-redaction-transaction-${fixture.suffix}` },
        ],
      });
      expect(
        transactionFailure.retryOptions.get(
          `queue-redaction-transaction-${fixture.suffix}`,
        ),
      ).toEqual({ delaySeconds: 60 });
      await expectArchivePairUnchanged(transactionPointer, beforeTransaction);
      await expect(
        projection.getStatus({
          schema_version: 1,
          tenant_id: fixture.tenantId,
          authorization: statusAuthorization(fixture),
        }),
      ).resolves.toEqual(beforeTransactionStatus);
      await runInDurableObject(projection, async (_instance, state) => {
        state.storage.sql.exec(
          "DROP TRIGGER ingestion_redaction_fail_projection",
        );
      });

      const rebuildEvent = messageEvent(fixture, {
        eventId: `$redaction-rebuild-${fixture.suffix}:example`,
        body: bodyCanary,
      });
      const rebuildRequest = await requestForEvents(fixture, [rebuildEvent]);
      const rebuildIngress = await postIngestionBatch(fixture, rebuildRequest);
      expect(rebuildIngress.response.status).toBe(202);
      const rebuildPointer = rebuildIngress.queue.messages[0]!.body;
      await projection.beginRebuild({
        schema_version: 1,
        tenant_id: fixture.tenantId,
        rebuild_id: `redaction_rebuild_${fixture.suffix}`,
        expected_generation: 1,
        started_at: "2026-09-08T03:01:00.000Z",
        authorization: {
          ...statusAuthorization(fixture),
          scopes: ["projection.rebuild"],
        },
      });
      const beforeRebuild = await snapshotArchivePair(rebuildPointer);
      const rebuilding = await deliverQueueMessages([
        {
          id: `queue-redaction-rebuilding-${fixture.suffix}`,
          body: rebuildPointer,
        },
      ]);
      expect(rebuilding.result).toMatchObject({
        explicitAcks: [],
        retryMessages: [
          { msgId: `queue-redaction-rebuilding-${fixture.suffix}` },
        ],
      });
      expect(
        rebuilding.retryOptions.get(
          `queue-redaction-rebuilding-${fixture.suffix}`,
        ),
      ).toEqual({ delaySeconds: 60 });
      await expectArchivePairUnchanged(rebuildPointer, beforeRebuild);
      await expect(
        projection.getStatus({
          schema_version: 1,
          tenant_id: fixture.tenantId,
          authorization: statusAuthorization(fixture),
        }),
      ).resolves.toMatchObject({ state: "rebuilding", generation: 2 });
    } finally {
      try {
        for (const call of capturedCalls) {
          expect(hasCanary(call, protectedCanaries)).toBe(false);
        }
        expect(capturedCalls).toContainEqual([
          {
            event: "ingestion_auth_denied",
            status: 401,
            code: "ingestion_unauthenticated",
          },
        ]);
      } finally {
        for (const spy of consoleSpies) spy.mockRestore();
      }
    }
  });
});
