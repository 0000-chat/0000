import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readDormantTenantBootstrapReport,
  runDormantTenantBootstrapTick,
} from "../../tenant-wakeup-bootstrap";
import { getTenantProjection } from "../../projection/routing";
import { clearDirectory } from "../support/directory-fixtures";
import { created, initialize, input, rows } from "./projector-test-support";

const database = env as typeof env & { CONTROL_DB: D1Database };
const db = database.CONTROL_DB;

beforeEach(async () => {
  await clearDirectory(db);
});
afterEach(() => vi.restoreAllMocks());

async function addTenant(id: string, status = "active") {
  await db
    .prepare(`INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at)
    VALUES (?, ?, 'Bootstrap fixture', ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`)
    .bind(id, id, status)
    .run();
}

describe("dormant tenant bootstrap in real D1 and SQLite DOs", () => {
  it("acknowledges a pristine tenant without initializing it and stays ready after normal ingestion", async () => {
    const tenant = "tenant_bootstrap_empty";
    await addTenant(tenant);
    const stub = getTenantProjection(database, tenant);
    expect(
      await stub.repairOutboundWakeup({
        schema_version: 1,
        tenant_id: "tenant_wrong_empty",
      }),
    ).toEqual({ kind: "gap", reason: "tenant_mismatch" });
    expect(
      await stub.repairOutboundWakeup({ schema_version: 1, tenant_id: tenant }),
    ).toEqual({ kind: "idle" });
    expect(await rows(stub, "SELECT * FROM projection_meta")).toEqual([]);
    expect(await rows(stub, "SELECT * FROM outbound_dispatches")).toEqual([]);
    await runDormantTenantBootstrapTick(database);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 100 }),
    ).toMatchObject({
      gate: "ready",
      targets: [{ state: "idle", attempts: 1 }],
    });
    await initialize(tenant);
    await stub.applyBatch(
      input([created("event_empty", { tenant_id: tenant })], {
        tenant_id: tenant,
      }),
    );
    await evictDurableObject(stub);
    await runDormantTenantBootstrapTick(database);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 100 }),
    ).toMatchObject({ gate: "ready" });
    expect(await rows(stub, "SELECT id FROM messages")).toEqual([
      { id: "message_a" },
    ]);
  });

  it("does not bless or rewrite an accepted ledger after metadata loss", async () => {
    const tenant = "tenant_bootstrap_lost_meta";
    await addTenant(tenant);
    const stub = await initialize(tenant);
    await stub.applyBatch(
      input([created("event_before_meta_loss", { tenant_id: tenant })], {
        tenant_id: tenant,
      }),
    );
    const now = Date.now() + 86_400_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await stub.acceptTextReply({
      schema_version: 1,
      tenant_id: tenant,
      actor_principal_id: "principal_a",
      actor_identity_id: "identity_a",
      conversation_id: "conversation_a",
      body: "Retained command",
      delivery_mode: "direct",
      idempotency_key: "before_meta_loss",
      accepted_at: new Date(now).toISOString(),
    });
    const ledger = await rows(stub, "SELECT * FROM outbound_dispatches");
    const commands = await rows(stub, "SELECT * FROM commands");
    expect(ledger).toHaveLength(1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM projection_meta");
    });
    expect(
      await stub.repairOutboundWakeup({ schema_version: 1, tenant_id: tenant }),
    ).toEqual({ kind: "gap", reason: "uninitialized" });
    await runDormantTenantBootstrapTick(database);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 100 }),
    ).toMatchObject({
      gate: "blocked",
      targets: [{ state: "gap", outcome: "uninitialized_retained_state" }],
    });
    expect(await rows(stub, "SELECT * FROM projection_meta")).toEqual([]);
    expect(await rows(stub, "SELECT * FROM outbound_dispatches")).toEqual(
      ledger,
    );
    expect(await rows(stub, "SELECT * FROM commands")).toEqual(commands);
  });

  it("rechecks legacy uninitialized gaps once, with bounded claims even at the old attempt limit", async () => {
    for (let i = 0; i < 10; i++) {
      const tenant = `tenant_legacy_${i}`;
      await addTenant(tenant);
    }
    await db
      .prepare(
        "UPDATE tenant_wakeup_targets SET state = 'gap', outcome = 'uninitialized', attempts = 3",
      )
      .run();
    await initialize("tenant_legacy_0");
    await runDormantTenantBootstrapTick(database);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM tenant_wakeup_targets WHERE state = 'idle'",
        )
        .first("count"),
    ).toBe(8);
    await Promise.all([
      runDormantTenantBootstrapTick(database),
      runDormantTenantBootstrapTick(database),
    ]);
    await runDormantTenantBootstrapTick(database);
    const report = await readDormantTenantBootstrapReport(db, {
      after: "",
      limit: 100,
    });
    expect(report).toMatchObject({
      gate: "ready",
      blocking_reason: null,
      counts: [{ state: "idle", count: 10 }],
    });
    expect(
      await db
        .prepare(
          "SELECT state, attempts, outcome, claim_token FROM tenant_wakeup_targets WHERE tenant_id = 'tenant_legacy_9'",
        )
        .first(),
    ).toEqual({
      state: "idle",
      attempts: 3,
      outcome: "idle",
      claim_token: null,
    });
    await runDormantTenantBootstrapTick(database);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 100 }),
    ).toEqual(report);
    expect(
      await rows(
        getTenantProjection(database, "tenant_legacy_1"),
        "SELECT * FROM projection_meta",
      ),
    ).toEqual([]);
  });

  it("fences a legacy recheck acknowledgement after claim replacement and bounds crash recovery", async () => {
    const tenant = "tenant_legacy_fenced";
    await addTenant(tenant);
    const stub = await initialize(tenant);
    await db
      .prepare(
        "UPDATE tenant_wakeup_targets SET state = 'gap', outcome = 'uninitialized', attempts = 3",
      )
      .run();
    const now = Date.now() + 86_400_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await runInDurableObject(stub, (_instance, state) => {
      const remove = state.storage.deleteAlarm.bind(state.storage);
      vi.spyOn(state.storage, "deleteAlarm").mockImplementation(async () => {
        await db
          .prepare(
            "UPDATE tenant_wakeup_targets SET claim_token = 'replacement', lease_until_ms = ? WHERE tenant_id = ?",
          )
          .bind(now + 30_000, tenant)
          .run();
        await remove();
      });
    });
    await runDormantTenantBootstrapTick(database);
    expect(
      await db
        .prepare(
          "SELECT state, outcome, claim_token FROM tenant_wakeup_targets WHERE tenant_id = ?",
        )
        .bind(tenant)
        .first(),
    ).toEqual({
      state: "running",
      outcome: "uninitialized_recheck",
      claim_token: "replacement",
    });
    vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
    await runDormantTenantBootstrapTick(database);
    const report = await readDormantTenantBootstrapReport(db, {
      after: "",
      limit: 100,
    });
    expect(report).toMatchObject({
      gate: "blocked",
      targets: [{ state: "gap", attempts: 3, outcome: "claim_expired" }],
    });
    await runDormantTenantBootstrapTick(database);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 100 }),
    ).toEqual(report);
  });

  it.each([
    [
      "binding",
      "INSERT INTO connection_bindings VALUES ('account', 'connection', 'identity', 'whatsapp')",
    ],
    [
      "rebuild",
      "INSERT INTO completed_rebuilds VALUES ('rebuild', 2, '2026-09-01T00:00:00Z')",
    ],
    [
      "sequence",
      "INSERT INTO projection_identity_sequences VALUES ('identity', 1)",
    ],
    [
      "autoincrement",
      "INSERT INTO sqlite_sequence (name, seq) VALUES ('projection_changes', 1)",
    ],
    [
      "future",
      "CREATE TABLE future_retained_state (id TEXT); INSERT INTO future_retained_state VALUES ('retained')",
    ],
    [
      "evidence",
      "INSERT INTO outbound_evidence (id, tenant_id, command_id, dispatch_id, source, evidence_id, transaction_id, request_digest, account_id, conversation_id, generation, status, observed_at, created_at) VALUES ('evidence', 'tenant', 'command', 'dispatch', 'provider', 'event', 'transaction', printf('%064d', 0), 'account', 'conversation', 1, 'accepted', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
    ],
    [
      "action",
      "INSERT INTO outbound_actions (id, tenant_id, original_command_id, action, idempotency_key, actor_principal_id, actor_identity_id, action_at, created_at) VALUES ('action', 'tenant', 'command', 'cancel', 'key', 'principal', 'identity', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
    ],
  ])(
    "keeps missing metadata with retained %s state blocking",
    async (kind, sql) => {
      const tenant = `tenant_retained_${kind}`;
      await addTenant(tenant);
      const stub = getTenantProjection(database, tenant);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(sql);
      });
      await db
        .prepare(
          "UPDATE tenant_wakeup_targets SET state = 'gap', outcome = 'uninitialized', attempts = 1",
        )
        .run();
      expect(
        await stub.repairOutboundWakeup({
          schema_version: 1,
          tenant_id: tenant,
        }),
      ).toEqual({ kind: "gap", reason: "uninitialized" });
      await runDormantTenantBootstrapTick(database);
      const report = await readDormantTenantBootstrapReport(db, {
        after: "",
        limit: 100,
      });
      expect(report).toMatchObject({
        gate: "blocked",
        blocking_reason: "target_gaps",
        targets: [{ state: "gap", outcome: "uninitialized_retained_state" }],
      });
      await runDormantTenantBootstrapTick(database);
      expect(
        await readDormantTenantBootstrapReport(db, { after: "", limit: 100 }),
      ).toEqual(report);
      expect(await rows(stub, "SELECT * FROM projection_meta")).toEqual([]);
    },
  );

  it("resumes multiple directory pages across evictions and becomes ready after all-status and supplemental targets complete", async () => {
    const names = Array.from(
      { length: 40 },
      (_, i) => `tenant_bootstrap_${String(i).padStart(2, "0")}`,
    );
    for (const [i, tenant] of names.entries()) {
      await addTenant(
        tenant,
        i % 3 === 0 ? "disabled" : i % 3 === 1 ? "revoked" : "active",
      );
      const stub = await initialize(tenant);
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.deleteAlarm(),
      );
      await evictDurableObject(stub);
    }
    // Model tenants predating installation of the admission registry.
    await db.prepare("DELETE FROM tenant_wakeup_targets").run();
    // Operationally reconciled supplemental names need not create membership.
    await initialize("tenant_imported_orphan");
    await db
      .prepare(
        "INSERT INTO tenant_wakeup_targets (tenant_id, source) VALUES ('tenant_imported_orphan', 'historical')",
      )
      .run();
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({
      gate: "blocked",
      blocking_reason: "directory_scan_incomplete",
    });
    await runDormantTenantBootstrapTick(database);
    expect(
      await db
        .prepare("SELECT directory_cursor FROM tenant_wakeup_bootstrap")
        .first("directory_cursor"),
    ).toBe(names[31]);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM tenant_wakeup_targets")
        .first("count"),
    ).toBe(33);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({
      gate: "blocked",
      blocking_reason: "directory_scan_incomplete",
    });
    await addTenant("tenant_aaa_late", "disabled");
    await initialize("tenant_aaa_late");
    for (let tick = 0; tick < 6; tick++) {
      const restarted = getTenantProjection(database, names[0]);
      await runInDurableObject(restarted, (_instance, state) =>
        state.storage.getAlarm(),
      );
      await evictDurableObject(restarted);
      await runDormantTenantBootstrapTick(database);
      if (tick === 0) {
        expect(
          await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
        ).toMatchObject({
          gate: "blocked",
          blocking_reason: "targets_pending",
        });
      }
    }
    const report = await readDormantTenantBootstrapReport(db, {
      after: "",
      limit: 100,
    });
    expect(report.discovery).toEqual([
      { directory_cursor: names[39], discovery_complete: 1 },
    ]);
    expect(report.counts).toEqual([{ state: "idle", count: 42 }]);
    expect(report.undiscovered_directory).toEqual([{ count: 0 }]);
    expect(report.gate).toBe("ready");
    expect(report.blocking_reason).toBeNull();
    const first = await readDormantTenantBootstrapReport(db, {
      after: "",
      limit: 7,
    });
    expect(first.targets).toHaveLength(7);
    expect(first.gate).toBe("ready");
    expect(
      await rows(
        getTenantProjection(database, names[0]),
        "SELECT * FROM commands",
      ),
    ).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("Bootstrap fixture");
  }, 30_000);

  it("blocks missing directory targets after discovery, and new admissions behind the completed cursor until repaired", async () => {
    await addTenant("tenant_bootstrap_z");
    await initialize("tenant_bootstrap_z");
    await runDormantTenantBootstrapTick(database);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({ gate: "ready", blocking_reason: null });
    await addTenant("tenant_bootstrap_a", "revoked");
    await initialize("tenant_bootstrap_a");
    // Page selection cannot hide a queued target from the aggregate gate.
    expect(
      await readDormantTenantBootstrapReport(db, {
        after: "tenant_bootstrap_z",
        limit: 1,
      }),
    ).toMatchObject({
      gate: "blocked",
      blocking_reason: "targets_pending",
      targets: [],
    });
    await runDormantTenantBootstrapTick(database);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({ gate: "ready", blocking_reason: null });
    // Model an out-of-band loss of registry rows, not a supported tenant delete.
    await db.prepare("DELETE FROM tenant_wakeup_targets").run();
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({
      gate: "blocked",
      blocking_reason: "directory_targets_missing",
    });
  });

  it("blocks running and expired claims until recovery finishes, and accepts scheduled outcomes", async () => {
    const tenant = "tenant_bootstrap_claim";
    await addTenant(tenant);
    const stub = await initialize(tenant);
    await runDormantTenantBootstrapTick(database);
    const now = Date.now();
    await db
      .prepare(`UPDATE tenant_wakeup_targets SET state = 'running',
      claim_token = 'bootstrap_claim', lease_until_ms = ? WHERE tenant_id = ?`)
      .bind(now + 30_000, tenant)
      .run();
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({ gate: "blocked", blocking_reason: "targets_pending" });
    vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({ gate: "blocked", blocking_reason: "targets_pending" });
    await runDormantTenantBootstrapTick(database);
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({ gate: "ready", blocking_reason: null });
    // The report consumes persisted acknowledgements; scheduler behavior is
    // exercised independently in outbound/scheduling.test.ts with real ledgers.
    await db
      .prepare(`UPDATE tenant_wakeup_targets SET state = 'scheduled',
      outcome = 'scheduled', alarm_at_ms = ? WHERE tenant_id = ?`)
      .bind(now + 60_000, tenant)
      .run();
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({ gate: "ready", blocking_reason: null });
    expect(await rows(stub, "SELECT * FROM commands")).toEqual([]);
  });

  it("does not skip later tenants after a failed repair, and bounds retries while recording missing and mismatched storage", async () => {
    const names = [
      "tenant_bootstrap_failure",
      "tenant_bootstrap_later",
      "tenant_bootstrap_missing",
      "tenant_bootstrap_wrong",
    ];
    for (const tenant of names) await addTenant(tenant);
    const failed = await initialize(names[0]);
    await initialize(names[1]);
    await runInDurableObject(
      getTenantProjection(database, names[2]),
      (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO projection_identity_sequences VALUES ('identity_retained', 1)",
        );
      },
    );
    const wrong = await initialize(names[3]);
    await runInDurableObject(wrong, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE projection_meta SET tenant_id = 'tenant_different'",
      );
    });
    await runInDurableObject(failed, (_instance, state) => {
      vi.spyOn(state.storage, "deleteAlarm").mockRejectedValue(
        new Error("controlled repair failure"),
      );
    });
    const now = Date.now() + 86_400_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await Promise.all([
      runDormantTenantBootstrapTick(database),
      runDormantTenantBootstrapTick(database),
    ]);
    expect(
      await db
        .prepare(
          "SELECT attempts FROM tenant_wakeup_targets WHERE tenant_id = ?",
        )
        .bind(names[0])
        .first("attempts"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT state, outcome FROM tenant_wakeup_targets WHERE tenant_id = ?",
        )
        .bind(names[1])
        .first(),
    ).toEqual({ state: "idle", outcome: "idle" });
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({ gate: "blocked", blocking_reason: "target_gaps" });
    for (const step of [10_000, 20_000]) {
      vi.spyOn(Date, "now").mockReturnValue(now + step);
      await runDormantTenantBootstrapTick(database);
    }
    expect(
      await db
        .prepare(
          "SELECT state, attempts, outcome FROM tenant_wakeup_targets WHERE tenant_id = ?",
        )
        .bind(names[0])
        .first(),
    ).toEqual({ state: "gap", attempts: 3, outcome: "repair_unavailable" });
    expect(
      await db
        .prepare(
          "SELECT outcome FROM tenant_wakeup_targets WHERE tenant_id = ?",
        )
        .bind(names[2])
        .first("outcome"),
    ).toBe("uninitialized_retained_state");
    expect(
      await db
        .prepare(
          "SELECT outcome FROM tenant_wakeup_targets WHERE tenant_id = ?",
        )
        .bind(names[3])
        .first("outcome"),
    ).toBe("tenant_mismatch");
    expect(
      await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
    ).toMatchObject({ gate: "blocked", blocking_reason: "target_gaps" });
  });

  it("times out one stalled tenant without blocking another, and ignores the late repair outcome", async () => {
    await addTenant("tenant_bootstrap_hung");
    await addTenant("tenant_bootstrap_progress");
    const hung = await initialize("tenant_bootstrap_hung");
    await initialize("tenant_bootstrap_progress");
    let resume: (() => void) | undefined;
    const suspended = new Promise<void>((resolve) => {
      resume = resolve;
    });
    await runInDurableObject(hung, (_instance, state) => {
      const remove = state.storage.deleteAlarm.bind(state.storage);
      vi.spyOn(state.storage, "deleteAlarm").mockImplementation(async () => {
        await suspended;
        await remove();
      });
    });
    try {
      await runDormantTenantBootstrapTick(database);
      expect(
        await db
          .prepare(
            "SELECT state FROM tenant_wakeup_targets WHERE tenant_id = 'tenant_bootstrap_progress'",
          )
          .first("state"),
      ).toBe("idle");
      expect(
        await db
          .prepare(
            "SELECT state, outcome FROM tenant_wakeup_targets WHERE tenant_id = 'tenant_bootstrap_hung'",
          )
          .first(),
      ).toEqual({ state: "retry", outcome: "repair_unavailable" });
      expect(
        await readDormantTenantBootstrapReport(db, { after: "", limit: 1 }),
      ).toMatchObject({ gate: "blocked", blocking_reason: "targets_pending" });
    } finally {
      resume?.();
    }
    await hung.repairOutboundWakeup({
      schema_version: 1,
      tenant_id: "tenant_bootstrap_hung",
    });
    expect(
      await db
        .prepare(
          "SELECT state FROM tenant_wakeup_targets WHERE tenant_id = 'tenant_bootstrap_hung'",
        )
        .first("state"),
    ).toBe("retry");
  }, 10_000);

  it("reclaims abandoned claims and repeats repair safely after a lost acknowledgement", async () => {
    const tenant = "tenant_bootstrap_abandoned";
    await addTenant(tenant);
    const stub = await initialize(tenant);
    await runDormantTenantBootstrapTick(database);
    const now = Date.now() + 86_400_000;
    // Persist the state at a crash after DO commit, before D1 acknowledgement.
    await db
      .prepare(`UPDATE tenant_wakeup_targets SET state = 'running', attempts = 1,
      claim_token = 'lost_ack', lease_until_ms = ?, outcome = NULL WHERE tenant_id = ?`)
      .bind(now - 1, tenant)
      .run();
    await evictDurableObject(stub);
    vi.spyOn(Date, "now").mockReturnValue(now);
    await runDormantTenantBootstrapTick(database);
    expect(
      await db
        .prepare(
          "SELECT state, attempts, claim_token FROM tenant_wakeup_targets WHERE tenant_id = ?",
        )
        .bind(tenant)
        .first(),
    ).toEqual({ state: "idle", attempts: 2, claim_token: null });
    expect(await rows(stub, "SELECT * FROM commands")).toEqual([]);
    expect(
      await stub.repairOutboundWakeup({
        schema_version: 1,
        tenant_id: "tenant_another",
      }),
    ).toEqual({ kind: "gap", reason: "tenant_mismatch" });
  });
});
