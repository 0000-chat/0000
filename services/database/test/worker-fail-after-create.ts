import worker from "../src/worker";
import {
  DatabaseObject,
  type DatabaseBindings,
  type DatabaseResource,
  type DurableCallOutcome,
} from "../src/database-object";
import { DatabaseRegistry } from "../src/database-registry";
import {
  MUTATION_LOGICAL_RESERVATION_BYTES,
  MUTATION_REPLAY_RESERVATION_BYTES,
  type AdmissionKind,
  type ServiceClock,
} from "../src/global-admission";
import { EXPORT_TTL_MS } from "../src/export";

type CreateDatabaseInput = Parameters<
  DatabaseRegistry["createDatabaseOutcome"]
>[0];

type ServiceClockBarrier = {
  consumed: boolean;
  entered: Promise<void>;
  release: () => void;
  released: Promise<void>;
  signalEntered: () => void;
};

function createTestClockTable(ctx: DurableObjectState): void {
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    now_ms INTEGER NOT NULL CHECK (now_ms >= 0)
  )`);
}

async function withTestClock<T>(
  ctx: DurableObjectState,
  operation: () => T | Promise<T>,
): Promise<T> {
  const clock = ctx.storage.sql
    .exec<{ now_ms: number }>(
      "SELECT now_ms FROM test_clock WHERE singleton = 1",
    )
    .toArray()[0];
  if (!clock) return await operation();

  const realNow = Date.now;
  Date.now = () => clock.now_ms;
  try {
    return await operation();
  } finally {
    Date.now = realNow;
  }
}

async function withLiveTestClock<T>(
  ctx: DurableObjectState,
  operation: () => T | Promise<T>,
): Promise<T> {
  const realNow = Date.now;
  Date.now = () => {
    const clock = ctx.storage.sql
      .exec<{ now_ms: number }>(
        "SELECT now_ms FROM test_clock WHERE singleton = 1",
      )
      .toArray()[0];
    return clock?.now_ms ?? realNow();
  };
  try {
    return await operation();
  } finally {
    Date.now = realNow;
  }
}

export class FailOnceDatabaseObject extends DatabaseObject {
  constructor(ctx: DurableObjectState, env: DatabaseBindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_creation_failures (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      failed INTEGER NOT NULL CHECK (failed IN (0, 1))
    )`);
  }

  override async ensureCreated(
    ...args: Parameters<DatabaseObject["ensureCreated"]>
  ): Promise<DurableCallOutcome<DatabaseResource>> {
    const initialized = await super.ensureCreated(...args);
    if (!initialized.ok) return initialized;
    const failThisAttempt = this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ failed: number }>(
          "SELECT failed FROM test_creation_failures WHERE singleton = 1",
        )
        .toArray()[0];
      if (existing) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO test_creation_failures (singleton, failed) VALUES (1, 1)",
      );
      return true;
    });
    if (failThisAttempt)
      throw new Error(
        "simulated lost create response after durable initialization",
      );
    return initialized;
  }
}

export class TestClockDatabaseObject extends DatabaseObject {
  constructor(ctx: DurableObjectState, env: DatabaseBindings) {
    super(ctx, env);
    createTestClockTable(this.ctx);
  }

  async __testSetClock(nowMs: number): Promise<void> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new Error("Invalid test clock value");
    this.ctx.storage.sql.exec(
      `INSERT INTO test_clock (singleton, now_ms) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET now_ms = excluded.now_ms`,
      nowMs,
    );
  }

  async __testRunAlarm(): Promise<void> {
    const clock = this.ctx.storage.sql
      .exec<{ now_ms: number }>(
        "SELECT now_ms FROM test_clock WHERE singleton = 1",
      )
      .toArray()[0];
    if (clock) await withLiveTestClock(this.ctx, () => super.alarm());
    else await super.alarm();
    createTestClockTable(this.ctx);
    if (clock) {
      this.ctx.storage.sql.exec(
        `INSERT INTO test_clock (singleton, now_ms) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET now_ms = excluded.now_ms`,
        clock.now_ms,
      );
    }
  }

  async __testLastActivityAt(): Promise<number | null> {
    const row = this.ctx.storage.sql
      .exec<{ last_activity_at: number }>(
        "SELECT last_activity_at FROM database_state WHERE singleton = 1",
      )
      .toArray()[0];
    return row?.last_activity_at ?? null;
  }

  async __testSetLastActivityAt(nowMs: number): Promise<void> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new Error("Invalid test activity timestamp");
    this.ctx.storage.sql.exec(
      "UPDATE database_state SET last_activity_at = ? WHERE singleton = 1",
      nowMs,
    );
  }

  async __testFailNextExportReconciliation(): Promise<void> {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_export_reconcile_fault (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      failed INTEGER NOT NULL CHECK (failed IN (0, 1))
    )`);
    this.ctx.storage.sql.exec(
      `INSERT INTO test_export_reconcile_fault (singleton, failed) VALUES (1, 1)
       ON CONFLICT(singleton) DO UPDATE SET failed = 1`,
    );
  }

  async __testStorageSnapshot(): Promise<{
    databaseSize: number;
    applicationTables: string[];
  }> {
    const sql = this.ctx.storage.sql;
    return {
      databaseSize: sql.databaseSize,
      applicationTables: sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'test_clock'
           ORDER BY name`,
        )
        .toArray()
        .map(({ name }) => name),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    return await withTestClock(this.ctx, () => super.fetch(request));
  }

  override async reconcileMutation(
    databaseId: string,
    operationKey: string,
  ): ReturnType<DatabaseObject["reconcileMutation"]> {
    return await withLiveTestClock(this.ctx, () =>
      super.reconcileMutation(databaseId, operationKey),
    );
  }

  override async reconcileExport(
    databaseId: string,
    exportKey: string,
  ): ReturnType<DatabaseObject["reconcileExport"]> {
    return await withLiveTestClock(this.ctx, async () => {
      const faultTable = this.ctx.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'test_export_reconcile_fault'`,
        )
        .toArray()[0];
      if (faultTable) {
        const fault = this.ctx.storage.sql
          .exec<{ failed: number }>(
            "SELECT failed FROM test_export_reconcile_fault WHERE singleton = 1",
          )
          .toArray()[0];
        if (fault?.failed) {
          this.ctx.storage.sql.exec(
            "UPDATE test_export_reconcile_fault SET failed = 0 WHERE singleton = 1",
          );
          throw new Error("simulated export reconciliation interruption");
        }
      }
      return await super.reconcileExport(databaseId, exportKey);
    });
  }

  override async deleteRetiredStorage(
    databaseId?: string,
  ): ReturnType<DatabaseObject["deleteRetiredStorage"]> {
    const clock = this.ctx.storage.sql
      .exec<{ now_ms: number }>(
        "SELECT now_ms FROM test_clock WHERE singleton = 1",
      )
      .toArray()[0];
    const result = await withTestClock(this.ctx, () =>
      super.deleteRetiredStorage(databaseId),
    );
    if (result.ok && databaseId) {
      createTestClockTable(this.ctx);
      if (clock) {
        this.ctx.storage.sql.exec(
          `INSERT INTO test_clock (singleton, now_ms) VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET now_ms = excluded.now_ms`,
          clock.now_ms,
        );
      }
    }
    return result;
  }
}

export class TestClockDatabaseRegistry extends DatabaseRegistry {
  private serviceClockBarrier: ServiceClockBarrier | undefined;
  private invalidServiceClock:
    | "missingPhysicalBytesPerDatabase"
    | "zeroPolicyRevision"
    | undefined;

  constructor(ctx: DurableObjectState, env: DatabaseBindings) {
    super(ctx, env);
    createTestClockTable(this.ctx);
  }

  async __testSetClock(nowMs: number): Promise<void> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new Error("Invalid test clock value");
    this.ctx.storage.sql.exec(
      `INSERT INTO test_clock (singleton, now_ms) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET now_ms = excluded.now_ms`,
      nowMs,
    );
  }

  async __testSetInvalidServiceClock(
    mode: "missingPhysicalBytesPerDatabase" | "zeroPolicyRevision" | null,
  ): Promise<void> {
    this.invalidServiceClock = mode ?? undefined;
  }

  async __testReservePendingMutation(
    databaseId: string,
    operationKey: string,
  ): ReturnType<DatabaseRegistry["reserveMutation"]> {
    return await withLiveTestClock(this.ctx, () =>
      super.reserveMutation({
        databaseId,
        operationKey,
        operationFingerprint: `test:${operationKey}`,
        logicalBytes: MUTATION_LOGICAL_RESERVATION_BYTES,
        replayBytes: MUTATION_REPLAY_RESERVATION_BYTES,
      }),
    );
  }

  async __testReservePendingExport(
    databaseId: string,
    exportKey: string,
  ): ReturnType<DatabaseRegistry["reserveExport"]> {
    return await withLiveTestClock(this.ctx, () =>
      super.reserveExport({
        databaseId,
        exportKey,
        exportId: crypto.randomUUID().replaceAll("-", ""),
        snapshotBytes: 1,
        expiresAt: Date.now() + EXPORT_TTL_MS,
      }),
    );
  }

  async __testFailNextExportCompletion(): Promise<void> {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS test_export_complete_fault (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      failed INTEGER NOT NULL CHECK (failed IN (0, 1))
    )`);
    this.ctx.storage.sql.exec(
      `INSERT INTO test_export_complete_fault (singleton, failed) VALUES (1, 1)
       ON CONFLICT(singleton) DO UPDATE SET failed = 1`,
    );
  }

  async __testRunAlarm(): Promise<void> {
    await withTestClock(this.ctx, () => super.alarm());
  }

  async __testArmServiceClockBarrier(): Promise<void> {
    if (this.serviceClockBarrier)
      throw new Error("A service clock barrier is already armed");
    let signalEntered = (): void => {};
    let release = (): void => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.serviceClockBarrier = {
      consumed: false,
      entered,
      release,
      released,
      signalEntered,
    };
  }

  async __testWaitForServiceClockBarrier(): Promise<void> {
    const barrier = this.serviceClockBarrier;
    if (!barrier) throw new Error("No service clock barrier is armed");
    await barrier.entered;
  }

  async __testReleaseServiceClockBarrier(): Promise<void> {
    const barrier = this.serviceClockBarrier;
    if (!barrier) throw new Error("No service clock barrier is armed");
    barrier.release();
    this.serviceClockBarrier = undefined;
  }

  async __testResetCapacityProjection(databaseId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const legacyReservation = this.ctx.storage.sql
        .exec<{ database_id: string }>(
          "SELECT database_id FROM create_reservations WHERE database_id = ? AND result_json IS NOT NULL",
          databaseId,
        )
        .toArray()[0];
      const legacySlug = this.ctx.storage.sql
        .exec<{ database_id: string }>(
          "SELECT database_id FROM database_slugs WHERE database_id = ?",
          databaseId,
        )
        .toArray()[0];
      if (!legacyReservation || !legacySlug)
        throw new Error("Legacy creation rows are not available for backfill");
      this.ctx.storage.sql.exec(
        "DELETE FROM database_capacity WHERE database_id = ?",
        databaseId,
      );
      this.ctx.storage.sql.exec("DELETE FROM capacity_meta");
    });
  }

  async __testCapacityProjection(databaseId: string): Promise<{
    capacity: {
      status: string;
      logicalBytes: number;
      replayBytes: number;
      physicalBytes: number;
      physicalReservedBytes: number;
    } | null;
    legacyBackfillDone: number | null;
    policyRevision: number | null;
  }> {
    const capacity = this.ctx.storage.sql
      .exec<{
        status: string;
        logical_bytes: number;
        replay_bytes: number;
        physical_bytes: number;
        physical_reserved_bytes: number;
      }>(
        `SELECT status, logical_bytes, replay_bytes, physical_bytes,
           physical_reserved_bytes FROM database_capacity WHERE database_id = ?`,
        databaseId,
      )
      .toArray()[0];
    const meta = this.ctx.storage.sql
      .exec<{ legacy_backfill_done: number }>(
        "SELECT legacy_backfill_done FROM capacity_meta WHERE singleton = 1",
      )
      .toArray()[0];
    const policy = this.ctx.storage.sql
      .exec<{ revision: number }>(
        "SELECT revision FROM capacity_policy WHERE singleton = 1",
      )
      .toArray()[0];
    return {
      capacity: capacity
        ? {
            status: capacity.status,
            logicalBytes: capacity.logical_bytes,
            replayBytes: capacity.replay_bytes,
            physicalBytes: capacity.physical_bytes,
            physicalReservedBytes: capacity.physical_reserved_bytes,
          }
        : null,
      legacyBackfillDone: meta?.legacy_backfill_done ?? null,
      policyRevision: policy?.revision ?? null,
    };
  }

  private async withClock<T>(operation: () => T | Promise<T>): Promise<T> {
    return await withTestClock(this.ctx, operation);
  }

  override async admitRequest(
    kind: AdmissionKind,
    requestId: string,
  ): Promise<DurableCallOutcome<ServiceClock>> {
    const result = await withTestClock(this.ctx, () =>
      super.admitRequest(kind, requestId),
    );
    if (!result.ok || !this.invalidServiceClock) return result;

    if (this.invalidServiceClock === "missingPhysicalBytesPerDatabase") {
      const malformed: Record<string, unknown> = { ...result.result };
      delete malformed.maxPhysicalBytesPerDatabase;
      return { ...result, result: malformed as unknown as ServiceClock };
    }
    return {
      ...result,
      result: { ...result.result, policyRevision: 0 },
    };
  }

  override async createDatabaseOutcome(
    input: CreateDatabaseInput,
    rawKey: string | null,
    origin: string,
  ): Promise<DurableCallOutcome<DatabaseResource>> {
    return await withTestClock(this.ctx, () =>
      super.createDatabaseOutcome(input, rawKey, origin),
    );
  }

  override async getServiceClock(): Promise<DurableCallOutcome<ServiceClock>> {
    const result = await withTestClock(this.ctx, () => super.getServiceClock());
    const barrier = this.serviceClockBarrier;
    if (barrier && !barrier.consumed) {
      barrier.consumed = true;
      barrier.signalEntered();
      await barrier.released;
    }
    return result;
  }

  override async isDatabaseServing(
    databaseId: string,
  ): ReturnType<DatabaseRegistry["isDatabaseServing"]> {
    return await this.withClock(() => super.isDatabaseServing(databaseId));
  }

  override async reserveDatabase(
    input: Parameters<DatabaseRegistry["reserveDatabase"]>[0],
  ): ReturnType<DatabaseRegistry["reserveDatabase"]> {
    return await this.withClock(() => super.reserveDatabase(input));
  }

  override async authorizeDatabaseCreation(
    input: Parameters<DatabaseRegistry["authorizeDatabaseCreation"]>[0],
  ): ReturnType<DatabaseRegistry["authorizeDatabaseCreation"]> {
    return await this.withClock(() => super.authorizeDatabaseCreation(input));
  }

  override async completeDatabase(
    databaseId: string,
    usage: Parameters<DatabaseRegistry["completeDatabase"]>[1],
    leaseToken: string,
  ): ReturnType<DatabaseRegistry["completeDatabase"]> {
    return await this.withClock(() =>
      super.completeDatabase(databaseId, usage, leaseToken),
    );
  }

  override async reportDatabaseUsage(
    databaseId: string,
    usage: Parameters<DatabaseRegistry["reportDatabaseUsage"]>[1],
  ): ReturnType<DatabaseRegistry["reportDatabaseUsage"]> {
    return await this.withClock(() =>
      super.reportDatabaseUsage(databaseId, usage),
    );
  }

  override async getDatabaseUsage(
    databaseId: string,
  ): ReturnType<DatabaseRegistry["getDatabaseUsage"]> {
    return await this.withClock(() => super.getDatabaseUsage(databaseId));
  }

  override async reserveMutation(
    reservation: Parameters<DatabaseRegistry["reserveMutation"]>[0],
  ): ReturnType<DatabaseRegistry["reserveMutation"]> {
    return await this.withClock(() => super.reserveMutation(reservation));
  }

  override async settleMutation(
    databaseId: string,
    operationKey: string,
    usage: Parameters<DatabaseRegistry["settleMutation"]>[2],
  ): ReturnType<DatabaseRegistry["settleMutation"]> {
    return await this.withClock(() =>
      super.settleMutation(databaseId, operationKey, usage),
    );
  }

  override async releaseMutation(
    databaseId: string,
    operationKey: string,
  ): ReturnType<DatabaseRegistry["releaseMutation"]> {
    return await this.withClock(() =>
      super.releaseMutation(databaseId, operationKey),
    );
  }

  override async reserveExport(
    reservation: Parameters<DatabaseRegistry["reserveExport"]>[0],
  ): ReturnType<DatabaseRegistry["reserveExport"]> {
    return await this.withClock(() => super.reserveExport(reservation));
  }

  override async completeExport(
    input: Parameters<DatabaseRegistry["completeExport"]>[0],
  ): ReturnType<DatabaseRegistry["completeExport"]> {
    const faultTable = this.ctx.storage.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'test_export_complete_fault'`,
      )
      .toArray()[0];
    if (faultTable) {
      const fault = this.ctx.storage.sql
        .exec<{ failed: number }>(
          "SELECT failed FROM test_export_complete_fault WHERE singleton = 1",
        )
        .toArray()[0];
      if (fault?.failed) {
        this.ctx.storage.sql.exec(
          "UPDATE test_export_complete_fault SET failed = 0 WHERE singleton = 1",
        );
        return {
          ok: false,
          status: 503,
          body: {
            error: {
              code: "CAPACITY_UNAVAILABLE",
              message: "Export completion temporarily unavailable",
              details: {},
            },
          },
          headers: {},
        };
      }
    }
    return await this.withClock(() => super.completeExport(input));
  }

  override async activateExport(
    databaseId: string,
    exportKey: string,
  ): ReturnType<DatabaseRegistry["activateExport"]> {
    return await this.withClock(() =>
      super.activateExport(databaseId, exportKey),
    );
  }

  override async releaseExport(
    databaseId: string,
    exportKey: string,
  ): ReturnType<DatabaseRegistry["releaseExport"]> {
    return await this.withClock(() =>
      super.releaseExport(databaseId, exportKey),
    );
  }

  override async reconcileMutation(
    databaseId: string,
    operationKey: string,
  ): ReturnType<DatabaseRegistry["reconcileMutation"]> {
    return await this.withClock(() =>
      super.reconcileMutation(databaseId, operationKey),
    );
  }

  override async reconcileExport(
    databaseId: string,
    exportKey: string,
  ): ReturnType<DatabaseRegistry["reconcileExport"]> {
    return await this.withClock(() =>
      super.reconcileExport(databaseId, exportKey),
    );
  }

  override async retireDatabase(
    databaseId: string,
  ): ReturnType<DatabaseRegistry["retireDatabase"]> {
    return await this.withClock(() => super.retireDatabase(databaseId));
  }

  override async completeRetirement(
    databaseId: string,
  ): ReturnType<DatabaseRegistry["completeRetirement"]> {
    return await this.withClock(() => super.completeRetirement(databaseId));
  }

  override async fetch(request: Request): Promise<Response> {
    return await withTestClock(this.ctx, () => super.fetch(request));
  }
}

export { DatabaseRegistry };

export default worker;
