import {
  env,
  runInDurableObject,
  evictDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REALTIME_SUBPROTOCOL,
  type AcceptTextReplyInput,
} from "@communicator/contracts";
import {
  clearDirectory,
  seedDirectory,
  seedAccountAccess,
} from "../support/directory-fixtures";
import {
  auth,
  bindingFor,
  event,
  initialize,
  rows,
} from "../projection/projector-test-support";

afterEach(() => vi.restoreAllMocks());

async function fixture(
  tenant = `tenant_schedule_${crypto.randomUUID().replaceAll("-", "")}`,
) {
  const stub = await initialize(tenant);
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenant,
    authorization: auth(["projection.write"], ["identity_a"], tenant),
    mode: "live",
    rebuild_id: null,
    connections: [bindingFor("account_a", "connection_a")],
    events: [
      event(
        "event_conversation",
        { title: "Scheduling", archived: false, muted: false },
        "conversation.updated",
        { tenant_id: tenant },
      ),
    ],
    checkpoint: null,
  });
  // Keep runtime wall-clock delivery separate from deliberately stepped alarms.
  const now = Date.now() + 86_400_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const request = (key: string, acceptedAt = now): AcceptTextReplyInput => ({
    schema_version: 1,
    tenant_id: tenant,
    actor_principal_id: "principal_a",
    actor_identity_id: "identity_a",
    conversation_id: "conversation_a",
    body: "Local scheduling fixture",
    delivery_mode: "direct",
    idempotency_key: key,
    accepted_at: new Date(acceptedAt).toISOString(),
  });
  const alarm = () =>
    runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  return { tenant, stub, now, request, alarm };
}

describe("durable combined scheduling in workerd", () => {
  it("repairs a warm tenant's missing alarm without rebuilding or executing its ledger", async () => {
    const { stub, tenant, request, now, alarm } = await fixture();
    const accepted = await stub.acceptTextReply(
      request("bootstrap-live-lease"),
    );
    await stub.claimOutboundDispatch({
      tenant_id: tenant,
      command_id: accepted.command.id,
      lease_id: "bootstrap_existing_lease",
      lease_expires_at: new Date(now + 30_000).toISOString(),
      now: new Date(now).toISOString(),
    });
    const ledger = await rows(stub, "SELECT * FROM outbound_dispatches");
    const commands = await rows(stub, "SELECT * FROM commands");
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.deleteAlarm(),
    );
    await stub.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: auth(["projection.status"], [], tenant),
    });
    expect(await alarm()).toBeNull();
    const network = vi.spyOn(globalThis, "fetch");
    await stub.repairOutboundWakeup({ schema_version: 1, tenant_id: tenant });
    expect(await alarm()).toBe(now + 30_000);
    expect(await rows(stub, "SELECT * FROM outbound_dispatches")).toEqual(
      ledger,
    );
    expect(await rows(stub, "SELECT * FROM commands")).toEqual(commands);
    expect(network).not.toHaveBeenCalled();
    await evictDurableObject(stub);
    expect(await alarm()).toBe(now + 30_000);
  });

  it.each(["before", "after"] as const)(
    "rolls acceptance and registration back when interrupted %s the real alarm write",
    async (boundary) => {
      const { stub, request, now, alarm } = await fixture();
      await runInDurableObject(stub, async (instance, state) => {
        await state.storage.setAlarm(now + 120_000);
        const setAlarm = state.storage.setAlarm.bind(state.storage);
        const interrupted = vi
          .spyOn(state.storage, "setAlarm")
          .mockImplementation(async (...args) => {
            expect(
              state.storage.sql.exec("SELECT id FROM commands").toArray(),
            ).toHaveLength(1);
            expect(
              state.storage.sql
                .exec("SELECT next_wakeup_at_ms FROM outbound_dispatches")
                .toArray(),
            ).toEqual([{ next_wakeup_at_ms: now }]);
            if (boundary === "after") {
              await setAlarm(...args);
              expect(await state.storage.getAlarm()).toBe(now);
            }
            throw new Error("controlled registration interruption");
          });
        try {
          await expect(
            instance.acceptTextReply(request("interrupted")),
          ).rejects.toThrow();
        } finally {
          interrupted.mockRestore();
        }
        expect(
          state.storage.sql.exec("SELECT id FROM commands").toArray(),
        ).toEqual([]);
        expect(await state.storage.getAlarm()).toBe(now + 120_000);
      });
      await evictDurableObject(stub);
      expect(await rows(stub, "SELECT id FROM commands")).toEqual([]);
      const accepted = await stub.acceptTextReply(request("interrupted"));
      expect(accepted.replayed).toBe(false);
      expect(await alarm()).toBe(now);
    },
  );

  it("retains committed due work after loss of the response, eviction and replay", async () => {
    const { stub, request, now, alarm } = await fixture();
    await expect(
      runInDurableObject(stub, async (instance) => {
        await instance.acceptTextReply(request("lost-response"));
        throw new Error("response lost after commit");
      }),
    ).rejects.toThrow("response lost after commit");
    await evictDurableObject(stub);
    expect(await alarm()).toBe(now);
    expect(
      (await stub.acceptTextReply(request("lost-response"))).replayed,
    ).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarm()).toBe(now + 60_000);
    expect(await rows(stub, "SELECT status FROM outbound_dispatches")).toEqual([
      { status: "pending" },
    ]);
  });

  it("rolls cancellation and cursor removal back after a real alarm deletion, then registers concurrent new work", async () => {
    const { stub, tenant, request, now, alarm } = await fixture();
    const accepted = await stub.acceptTextReply(request("cancel"));
    const decision = {
      schema_version: 1 as const,
      tenant_id: tenant,
      command_id: accepted.command.id,
      decision: "cancel" as const,
      idempotency_key: "cancel-decision",
      actor_principal_id: "principal_a",
      actor_identity_id: "identity_a",
      decided_at: new Date(now).toISOString(),
      connection_available: false,
    };
    await runInDurableObject(stub, async (instance, state) => {
      const deleteAlarm = state.storage.deleteAlarm.bind(state.storage);
      const interrupted = vi
        .spyOn(state.storage, "deleteAlarm")
        .mockImplementation(async (...args) => {
          await deleteAlarm(...args);
          expect(await state.storage.getAlarm()).toBeNull();
          throw new Error("controlled deletion interruption");
        });
      try {
        await expect(instance.decideOutbound(decision)).rejects.toThrow();
      } finally {
        interrupted.mockRestore();
      }
      expect(await state.storage.getAlarm()).toBe(now);
    });
    await evictDurableObject(stub);
    expect(
      await rows(
        stub,
        "SELECT status, next_wakeup_at_ms FROM outbound_dispatches",
      ),
    ).toEqual([{ status: "pending", next_wakeup_at_ms: now }]);
    expect(
      await rows(stub, "SELECT command_id FROM outbound_command_decisions"),
    ).toEqual([]);
    await Promise.all([
      stub.decideOutbound(decision),
      stub.acceptTextReply(request("replacement")),
    ]);
    await evictDurableObject(stub);
    expect(await alarm()).toBe(now);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await rows(
        stub,
        "SELECT status, next_wakeup_at_ms FROM outbound_dispatches ORDER BY idempotency_key",
      ),
    ).toEqual([
      { status: "cancelled", next_wakeup_at_ms: null },
      { status: "pending", next_wakeup_at_ms: now + 60_000 },
    ]);
  });

  it("uses the due index and durably drains more than three batches despite new arrivals and restart", async () => {
    const { stub, request, now, alarm } = await fixture();
    for (let i = 0; i < 101; i++) {
      await stub.acceptTextReply(request(`backlog-${i}`, now - 100_000 + i));
    }
    const queryPlans = await rows<{ detail: string }>(
      stub,
      "EXPLAIN QUERY PLAN SELECT id FROM outbound_dispatches WHERE next_wakeup_at_ms IS NOT NULL AND next_wakeup_at_ms <= ? ORDER BY next_wakeup_at_ms, id LIMIT 32",
      now,
    );
    expect(
      queryPlans.some((plan) =>
        plan.detail.includes("idx_outbound_dispatches_wakeup"),
      ),
    ).toBe(true);
    expect(
      queryPlans.some((plan) =>
        /SCAN outbound_dispatches|TEMP B-TREE/.test(plan.detail),
      ),
    ).toBe(false);
    for (const processed of [32, 64, 96, 101]) {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(
        await rows(
          stub,
          "SELECT COUNT(*) AS count FROM outbound_dispatches WHERE idempotency_key LIKE 'backlog-%' AND next_wakeup_at_ms > ?",
          now,
        ),
      ).toEqual([{ count: processed }]);
      if (processed < 101) {
        expect(await alarm()).toBe(now);
        for (let i = 0; i < 3; i++)
          await stub.acceptTextReply(request(`arrival-${processed}-${i}`));
      } else {
        expect(await alarm()).toBe(now + 60_000);
      }
      await evictDurableObject(stub);
    }
    expect(
      await rows(stub, "SELECT DISTINCT status FROM outbound_dispatches"),
    ).toEqual([{ status: "pending" }]);
    const provider = env as typeof env & { TEST_OUTBOUND_PROVIDER: Fetcher };
    const commands = await rows<{ command_id: string }>(
      stub,
      "SELECT command_id FROM outbound_dispatches",
    );
    for (const command of commands) {
      expect(
        await (
          await provider.TEST_OUTBOUND_PROVIDER.fetch(
            `https://controlled-provider/count?command_id=${command.command_id}`,
          )
        ).json(),
      ).toBe(0);
    }
  });

  it("bounds stalled reads across passes and ignores their late results without changing durable state", async () => {
    const { stub, request, now, alarm } = await fixture();
    for (const key of ["stalled-one", "stalled-two"]) {
      await stub.acceptTextReply({
        ...request(key, now - 120_000),
        initial_dispatch_status: "waiting_for_connection",
      });
    }
    vi.restoreAllMocks();
    const wallNow = Date.now;
    const started = wallNow();
    vi.spyOn(Date, "now").mockImplementation(() => now + wallNow() - started);
    const database = env as typeof env & { CONTROL_DB: D1Database };
    const statement =
      database.CONTROL_DB.withSession("first-primary").prepare("SELECT 1");
    let lookups = 0;
    let finishRead: (value: { status: string }) => void = () => {
      throw new Error("availability read has not started");
    };
    const stalled = vi
      .spyOn(Object.getPrototypeOf(statement), "first")
      .mockImplementation(() => {
        lookups++;
        return new Promise<{ status: string }>((resolve) => {
          finishRead = resolve;
        });
      });
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(lookups).toBe(1);
      expect(
        await rows(
          stub,
          "SELECT COUNT(*) AS count FROM outbound_dispatches WHERE status = 'waiting_for_connection' AND next_wakeup_at_ms > ?",
          now,
        ),
      ).toEqual([{ count: 1 }]);
      expect(
        await rows(
          stub,
          "SELECT COUNT(*) AS count FROM outbound_dispatches WHERE status = 'waiting_for_connection' AND next_wakeup_at_ms <= ?",
          now,
        ),
      ).toEqual([{ count: 1 }]);
      expect(await alarm()).not.toBeNull();
      for (const pass of [1, 2, 3]) {
        vi.spyOn(Date, "now").mockReturnValue(now + pass * 60_000 + 2_000);
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect(lookups).toBe(1);
        expect(
          await rows(
            stub,
            "SELECT COUNT(*) AS count FROM outbound_dispatches WHERE status = 'waiting_for_connection' AND next_wakeup_at_ms > ?",
            Date.now(),
          ),
        ).toEqual([{ count: 2 }]);
      }
      const beforeLateResult = await rows(
        stub,
        "SELECT * FROM outbound_dispatches ORDER BY id",
      );
      const commandsBeforeLateResult = await rows(
        stub,
        "SELECT * FROM commands ORDER BY id",
      );
      const alarmBeforeLateResult = await alarm();
      finishRead({ status: "ready" });
      await Promise.resolve();
      await Promise.resolve();
      expect(
        await rows(stub, "SELECT * FROM outbound_dispatches ORDER BY id"),
      ).toEqual(beforeLateResult);
      expect(await rows(stub, "SELECT * FROM commands ORDER BY id")).toEqual(
        commandsBeforeLateResult,
      );
      expect(await alarm()).toBe(alarmBeforeLateResult);
    } finally {
      stalled.mockRestore();
    }
    vi.spyOn(Date, "now").mockReturnValue(now + 300_000);
    const resumed = vi.spyOn(Object.getPrototypeOf(statement), "first");
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(resumed).toHaveBeenCalledTimes(2);
    } finally {
      resumed.mockRestore();
    }
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await rows(
        stub,
        "SELECT COUNT(*) AS count FROM outbound_dispatches WHERE next_wakeup_at_ms <= ?",
        Date.now(),
      ),
    ).toEqual([{ count: 0 }]);
  });

  it.each(["entry", "selection", "cursor_commit"] as const)(
    "retains a continuation across interruption at %s and eviction",
    async (boundary) => {
      const { stub, request, now, alarm } = await fixture();
      await stub.acceptTextReply(request("continuation"));
      await runInDurableObject(stub, async (instance, state) => {
        // Match the runtime's consumed-alarm entry: no previous alarm may
        // accidentally make the interrupted handler look recoverable.
        await state.storage.deleteAlarm();
        if (boundary === "selection") {
          const exec = state.storage.sql.exec.bind(state.storage.sql);
          const interrupted = vi
            .spyOn(state.storage.sql, "exec")
            .mockImplementation((sql, ...args) => {
              if (sql.includes("next_wakeup_at_ms <="))
                throw new Error("interrupted before selection");
              return exec(sql, ...args);
            });
          try {
            await expect(instance.alarm()).rejects.toThrow();
          } finally {
            interrupted.mockRestore();
          }
        } else {
          const setAlarm = state.storage.setAlarm.bind(state.storage);
          const interrupted = vi
            .spyOn(state.storage, "setAlarm")
            .mockImplementation(async (...args) => {
              await setAlarm(...args);
              if (boundary === "entry" || args[0] === now + 60_000) {
                expect(await state.storage.getAlarm()).toBe(args[0]);
                throw new Error("interrupted after continuation write");
              }
            });
          try {
            await expect(instance.alarm()).rejects.toThrow();
          } finally {
            interrupted.mockRestore();
          }
        }
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(
          state.storage.sql
            .exec("SELECT status, next_wakeup_at_ms FROM outbound_dispatches")
            .toArray(),
        ).toEqual([{ status: "pending", next_wakeup_at_ms: now }]);
      });
      await evictDurableObject(stub);
      expect(await alarm()).toBe(now);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await alarm()).toBe(now + 60_000);
    },
  );

  it("backfills overdue work on migration and restarts without a client recovery request", async () => {
    const { stub, request, now, alarm } = await fixture();
    await stub.acceptTextReply({
      ...request("legacy", now - 15_000_000),
      initial_dispatch_status: "waiting_for_connection",
      confirmation_due_at: new Date(now - 600_000).toISOString(),
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER outbound_wakeup_insert");
      state.storage.sql.exec("DROP TRIGGER outbound_wakeup_update");
      state.storage.sql.exec("DROP INDEX idx_outbound_dispatches_wakeup");
      state.storage.sql.exec(
        "ALTER TABLE outbound_dispatches DROP COLUMN next_wakeup_at_ms",
      );
      state.storage.sql.exec(
        "ALTER TABLE projection_meta DROP COLUMN realtime_revalidation_due_at_ms",
      );
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE version = 8",
      );
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await rows(
        stub,
        "SELECT status, next_wakeup_at_ms FROM outbound_dispatches",
      ),
    ).toEqual([{ status: "confirmation_required", next_wakeup_at_ms: null }]);
    expect(await alarm()).toBeNull();
  });

  it("delivers a wall-clock alarm after eviction without manually invoking a handler", async () => {
    const { stub, request, alarm } = await fixture();
    vi.restoreAllMocks();
    const due = Date.now() + 500;
    await stub.acceptTextReply(request("native-delivery", due));
    await evictDurableObject(stub);
    // No DO request or alarm test helper occurs during this delivery window.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const work = await rows<{ status: string; next_wakeup_at_ms: number }>(
      stub,
      "SELECT status, next_wakeup_at_ms FROM outbound_dispatches",
    );
    expect(work).toHaveLength(1);
    expect(work[0]?.status).toBe("pending");
    expect(work[0]?.next_wakeup_at_ms).toBeGreaterThan(due + 59_000);
    expect(await alarm()).toBe(work[0]?.next_wakeup_at_ms);
  });

  it("retries a native alarm interrupted before its first continuation write", async () => {
    const { stub, request, alarm } = await fixture();
    vi.restoreAllMocks();
    const due = Date.now() + 500;
    await stub.acceptTextReply(request("native-entry-interruption", due));
    let attempts = 0;
    let registered: number | null = null;
    let restore = () => {};
    await runInDurableObject(stub, (_instance, state) => {
      const setAlarm = state.storage.setAlarm.bind(state.storage);
      const interrupted = vi
        .spyOn(state.storage, "setAlarm")
        .mockImplementation(async (...args) => {
          attempts++;
          if (attempts === 1)
            throw new Error("controlled native alarm entry interruption");
          await setAlarm(...args);
          registered = await state.storage.getAlarm();
        });
      restore = () => interrupted.mockRestore();
    });
    try {
      // Observe real workerd delivery/retry, not runDurableObjectAlarm(), whose
      // installed implementation manually deletes the alarm and calls alarm().
      await vi.waitFor(() => expect(registered).toBeGreaterThan(due + 59_000), {
        timeout: 10_000,
        interval: 50,
      });
      expect(attempts).toBeGreaterThan(1);
      restore();
      const work = await rows<{ next_wakeup_at_ms: number }>(
        stub,
        "SELECT next_wakeup_at_ms FROM outbound_dispatches",
      );
      expect(work[0]?.next_wakeup_at_ms).toBeGreaterThan(due + 59_000);
      await evictDurableObject(stub);
      expect(await alarm()).toBe(work[0]?.next_wakeup_at_ms);
    } finally {
      restore();
    }
  }, 15_000);

  it("does not slide Platform revalidation under repeated outbound replacements and services revocation before outbound selection", async () => {
    const { stub, tenant, request, now, alarm } = await fixture("tenant_pilot");
    const database = env as typeof env & { CONTROL_DB: D1Database };
    await clearDirectory(database.CONTROL_DB);
    await seedDirectory(database.CONTROL_DB);
    await seedAccountAccess(database.CONTROL_DB);
    const response = await stub.fetch(
      new Request("https://tenant-projection.internal/realtime", {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
          "X-Communicator-Realtime-Context": JSON.stringify({
            schema_version: 1,
            tenant_id: tenant,
            principal_id: "principal_human",
            membership_id: "membership_human",
            subscriptions: [
              { identity_id: "identity_human", families: ["projection"] },
            ],
            resume: [],
            issued_at: new Date(now).toISOString(),
            expires_at: new Date(now + 30_000).toISOString(),
          }),
        },
      }),
    );
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (client === null) throw new Error("missing realtime socket");
    client.accept();
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets("realtime")[0];
      if (socket === undefined) throw new Error("missing server socket");
      socket.serializeAttachment({
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
        lease_expires_at: new Date(now + 600_000).toISOString(),
        resumed: false,
        platform: {
          binding_id: "binding_a",
          authority: "local-test",
          kind: "human",
          subject_id: "subject_a",
          organization_id: "organization_a",
          membership_id: "membership_a",
          grant_id: null,
          credential_id: "credential_a",
          expires_at: new Date(now + 600_000).toISOString(),
        },
      });
    });
    try {
      await stub.acceptTextReply(request("start-revalidation"));
      for (let i = 1; i <= 12; i++) {
        vi.spyOn(Date, "now").mockReturnValue(now + i * 5_000);
        await Promise.all([
          stub.acceptTextReply(request(`replacement-${i}`, now + i * 5_000)),
          stub.repairOutboundWakeup({ schema_version: 1, tenant_id: tenant }),
        ]);
        const deadline = await alarm();
        await runInDurableObject(stub, (_instance, state) =>
          state.storage.deleteAlarm(),
        );
        await stub.repairOutboundWakeup({
          schema_version: 1,
          tenant_id: tenant,
        });
        expect(await alarm()).toBe(deadline);
        expect(
          await rows(
            stub,
            "SELECT realtime_revalidation_due_at_ms FROM projection_meta",
          ),
        ).toEqual([{ realtime_revalidation_due_at_ms: now + 60_000 }]);
      }
      await evictDurableObject(stub);
      expect(
        await rows(
          stub,
          "SELECT realtime_revalidation_due_at_ms FROM projection_meta",
        ),
      ).toEqual([{ realtime_revalidation_due_at_ms: now + 60_000 }]);
      await runInDurableObject(stub, async (instance, state) => {
        const exec = state.storage.sql.exec.bind(state.storage.sql);
        const sockets = state.getWebSockets("realtime");
        expect(sockets).toHaveLength(1);
        let checked = false;
        const interrupted = vi
          .spyOn(state.storage.sql, "exec")
          .mockImplementation((sql, ...args) => {
            if (sql.includes("next_wakeup_at_ms <=")) {
              checked = true;
              expect(
                sockets.every((socket) => socket.readyState !== WebSocket.OPEN),
              ).toBe(true);
              throw new Error("interrupt outbound after realtime revocation");
            }
            return exec(sql, ...args);
          });
        try {
          await expect(instance.alarm()).rejects.toThrow(
            "interrupt outbound after realtime revocation",
          );
        } finally {
          interrupted.mockRestore();
        }
        expect(checked).toBe(true);
      });
      expect(await alarm()).not.toBeNull();
      await evictDurableObject(stub);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await alarm()).toBe(now + 120_000);
    } finally {
      client.close();
      await runInDurableObject(stub, (_instance, state) => {
        for (const socket of state.getWebSockets("realtime")) socket.close();
      });
    }
  });
});
