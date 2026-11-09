import {
  applyD1Migrations,
  env,
  runInDurableObject,
  evictDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  SessionResponseSchema,
  REALTIME_SUBPROTOCOL,
} from "@communicator/contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acceptTextReply,
  type OutboundAcceptanceServices,
} from "../../outbound/acceptance";
import {
  claimOutboundDispatch,
  readOutboundAcceptanceReservation,
} from "../../outbound/authority";
import {
  auth,
  bindingFor,
  event,
  initialize,
  rows,
} from "../projection/projector-test-support";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";

const workerEnv = env as typeof env & {
  CONTROL_DB: D1Database;
  TEST_OUTBOUND_PROVIDER: Fetcher;
};
const migrationEnv = env as typeof env & {
  CONTROL_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};
const tenantId = "tenant_pilot";
const conversationId = "conversation_human_one";
const accountId = "account_human";
const connectionId = "connection_human_whatsapp";
const grantId = "grant_agent_human_message_send";
const acceptedAt = new Date("2026-09-14T00:00:00.000Z");

const agentAuthorization = SessionResponseSchema.parse({
  tenant: { id: tenantId, slug: "pilot", display_name: "Pilot" },
  principal: {
    id: "principal_agent",
    type: "agent",
    display_name: "Agent",
  },
  membership: { id: "membership_agent", role: "member" },
  identities: [
    {
      identity_id: "identity_agent",
      kind: "agent",
      display_name: "Agent",
      scopes: ["conversation.read", "message.send", "connection.read"],
    },
  ],
});

const ownerAuthorization = SessionResponseSchema.parse({
  tenant: { id: tenantId, slug: "pilot", display_name: "Pilot" },
  principal: {
    id: "principal_human",
    type: "human",
    display_name: "Human",
  },
  membership: { id: "membership_human", role: "owner" },
  identities: [
    {
      identity_id: "identity_human",
      kind: "human",
      display_name: "Human",
      scopes: ["conversation.read", "message.send", "connection.read"],
    },
  ],
});

const baseRequest = (identityId: string, body: string) => ({
  identity_id: identityId,
  conversation_id: conversationId,
  account_id: accountId,
  body,
  delivery_mode: "direct" as const,
});

const accept = (
  key: string,
  authorization = agentAuthorization,
  services: OutboundAcceptanceServices = {},
) =>
  acceptTextReply(
    { env: workerEnv, authorization },
    baseRequest(
      authorization === ownerAuthorization
        ? "identity_human"
        : "identity_agent",
      `authority acceptance ${key}`,
    ),
    key,
    { now: () => acceptedAt, ...services },
  );

async function projectConversation(): Promise<void> {
  await applyD1Migrations(
    migrationEnv.CONTROL_DB,
    migrationEnv.TEST_MIGRATIONS,
  );
  const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
  await initialize(tenantId);
  await runInDurableObject(projection, (_instance, state) => {
    state.storage.sql.exec("UPDATE projection_meta SET state = 'ready'");
  });
  await projection.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: auth(["projection.write"], ["identity_human"], tenantId),
    mode: "live",
    rebuild_id: null,
    connections: [bindingFor(accountId, connectionId, "identity_human")],
    events: [
      event(
        "event_acceptance_authority_conversation",
        {
          title: "Authority acceptance conversation",
          archived: false,
          muted: false,
        },
        "conversation.updated",
        {
          tenant_id: tenantId,
          identity_id: "identity_human",
          account_id: accountId,
          conversation_id: conversationId,
        },
      ),
    ],
    checkpoint: null,
  });
}

async function insertDelegatedGrant(): Promise<void> {
  await workerEnv.CONTROL_DB.prepare(
    `INSERT INTO account_grants (
         id, tenant_id, membership_id, identity_id, account_id,
         operation_scope, chat_scope, status, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, 'message.send', 'all_chats', 'active', ?, ?, NULL)`,
  )
    .bind(
      grantId,
      tenantId,
      "membership_agent",
      "identity_agent",
      accountId,
      acceptedAt.toISOString(),
      acceptedAt.toISOString(),
    )
    .run();
}

async function reservationFor(key: string) {
  const row = await workerEnv.CONTROL_DB.prepare(
    "SELECT id FROM outbound_acceptance_intents WHERE tenant_id = ? AND idempotency_key = ?",
  )
    .bind(tenantId, key)
    .first<{ id: string }>();
  if (row === null) throw new Error(`reservation missing for ${key}`);
  const reservation = await readOutboundAcceptanceReservation(
    workerEnv.CONTROL_DB,
    tenantId,
    row.id,
  );
  if (reservation === null)
    throw new Error(`reservation unreadable for ${key}`);
  return reservation;
}

beforeAll(projectConversation);

beforeEach(async () => {
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare("DELETE FROM outbound_dispatch_claims"),
    workerEnv.CONTROL_DB.prepare("DELETE FROM outbound_acceptance_intents"),
  ]);
  const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
  await runInDurableObject(projection, (_instance, state) => {
    state.storage.transactionSync(() => {
      state.storage.sql.exec("DELETE FROM outbound_actions");
      state.storage.sql.exec("DELETE FROM outbound_evidence");
      state.storage.sql.exec("DELETE FROM outbound_command_decisions");
      state.storage.sql.exec("DELETE FROM outbound_dispatches");
      state.storage.sql.exec(
        "DELETE FROM commands WHERE operation = 'message.send'",
      );
      state.storage.sql.exec(
        "DELETE FROM messages WHERE direction = 'outbound'",
      );
    });
  });
  await projectConversation();
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
  await insertDelegatedGrant();
});

afterAll(async () => {
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare("DELETE FROM outbound_dispatch_claims"),
    workerEnv.CONTROL_DB.prepare("DELETE FROM outbound_acceptance_intents"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outbound dispatch ownership in the Worker runtime", () => {
  it("rolls back the SQL lease and asynchronous alarm write on interruption before commit", async () => {
    const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
    const accepted = await accept(`lease-rollback-${crypto.randomUUID()}`);
    const now = Date.now();
    const previousAlarm = now + 120_000;
    await runInDurableObject(projection, async (instance, state) => {
      await state.storage.setAlarm(previousAlarm);
      const setAlarm = state.storage.setAlarm.bind(state.storage);
      let registeredAlarm: number | null = null;
      const interrupted = vi
        .spyOn(state.storage, "setAlarm")
        .mockImplementation(async (...args) => {
          await setAlarm(...args);
          registeredAlarm = await state.storage.getAlarm();
          throw new Error("controlled interruption after alarm write");
        });
      try {
        await expect(
          instance.claimOutboundDispatch({
            tenant_id: tenantId,
            command_id: accepted.command.id,
            lease_id: "lease_interrupted",
            lease_expires_at: new Date(now + 30_000).toISOString(),
            now: new Date(now).toISOString(),
          }),
        ).rejects.toThrow();
      } finally {
        interrupted.mockRestore();
      }
      expect(registeredAlarm).toBe(now + 30_000);
      expect(await state.storage.getAlarm()).toBe(previousAlarm);
    });
    expect(
      await rows(
        projection,
        "SELECT status, dispatch_lease_id FROM outbound_dispatches WHERE command_id = ?",
        accepted.command.id,
      ),
    ).toEqual([{ status: "pending", dispatch_lease_id: null }]);
    await evictDurableObject(projection);
    expect(
      await rows(
        projection,
        "SELECT status, dispatch_lease_id FROM outbound_dispatches WHERE command_id = ?",
        accepted.command.id,
      ),
    ).toEqual([{ status: "pending", dispatch_lease_id: null }]);
  });

  it.each([10_000, 60_000])(
    "preserves both deadlines with a realtime expiry in %s ms",
    async (socketDelay) => {
      const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
      const now = Date.now();
      const accepted = await accept(
        `lease-realtime-${crypto.randomUUID()}`,
        agentAuthorization,
        { now: () => new Date(now) },
      );
      const response = await projection.fetch(
        new Request("https://tenant-projection.internal/realtime", {
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
            "X-Communicator-Realtime-Context": JSON.stringify({
              schema_version: 1,
              tenant_id: tenantId,
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
      const socket = response.webSocket;
      if (socket === null) throw new Error("missing realtime socket");
      socket.accept();
      try {
        await runInDurableObject(projection, (_instance, state) => {
          for (const active of state.getWebSockets("realtime")) {
            active.serializeAttachment({
              schema_version: 1,
              tenant_id: tenantId,
              principal_id: "principal_human",
              membership_id: "membership_human",
              subscriptions: [
                { identity_id: "identity_human", families: ["projection"] },
              ],
              positions: [
                { identity_id: "identity_human", generation: 1, sequence: 0 },
              ],
              lease_expires_at: new Date(now + socketDelay).toISOString(),
              resumed: false,
            });
          }
        });
        await projection.claimOutboundDispatch({
          tenant_id: tenantId,
          command_id: accepted.command.id,
          lease_id: "lease_realtime",
          now: new Date(now).toISOString(),
          lease_expires_at: new Date(now + 30_000).toISOString(),
        });
        const firstDeadline = now + Math.min(socketDelay, 30_000);
        const secondDeadline = now + Math.max(socketDelay, 30_000);
        expect(
          await runInDurableObject(projection, (_instance, state) =>
            state.storage.getAlarm(),
          ),
        ).toBe(firstDeadline);
        vi.spyOn(Date, "now").mockReturnValue(firstDeadline + 1);
        expect(await runDurableObjectAlarm(projection)).toBe(true);
        expect(
          await runInDurableObject(projection, (_instance, state) =>
            state.storage.getAlarm(),
          ),
        ).toBe(secondDeadline);
        expect(
          await rows(
            projection,
            "SELECT status FROM outbound_dispatches WHERE command_id = ?",
            accepted.command.id,
          ),
        ).toEqual([
          {
            status: socketDelay < 30_000 ? "dispatching" : "delivery_uncertain",
          },
        ]);
        vi.spyOn(Date, "now").mockReturnValue(secondDeadline + 1);
        expect(await runDurableObjectAlarm(projection)).toBe(true);
        expect(
          await rows(
            projection,
            "SELECT status, chat_paused FROM outbound_dispatches WHERE command_id = ?",
            accepted.command.id,
          ),
        ).toEqual([{ status: "delivery_uncertain", chat_paused: 1 }]);
        expect(
          await runInDurableObject(projection, (_instance, state) =>
            state.storage.getAlarm(),
          ),
        ).toBeGreaterThan(secondDeadline);
      } finally {
        socket.close();
      }
    },
  );

  it("does not execute an observed live lease after acceptance", async () => {
    const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
    const now = new Date();
    const adapter = vi.fn(async () => ({
      type: "uncertain" as const,
      reason: "controlled",
    }));
    await accept(`observed-lease-${crypto.randomUUID()}`, agentAuthorization, {
      now: () => now,
      afterCommit: async (accepted) => {
        await projection.claimOutboundDispatch({
          tenant_id: tenantId,
          command_id: accepted.command.id,
          lease_id: "lease_other_executor",
          lease_expires_at: new Date(now.getTime() + 30_000).toISOString(),
          now: now.toISOString(),
        });
      },
      dispatchOutbound: adapter,
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each([
    { confirmed: false, sent: false },
    { confirmed: false, sent: true },
    { confirmed: true, sent: false },
    { confirmed: true, sent: true },
  ])(
    "fences claims and expires abandoned ownership across eviction: %j",
    async ({ confirmed, sent }) => {
      const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
      const now = new Date();
      const key = `lease-restart-${crypto.randomUUID()}`;
      if (confirmed) {
        await workerEnv.CONTROL_DB.prepare(
          "UPDATE connections SET status = 'disconnected' WHERE id = ?",
        )
          .bind(connectionId)
          .run();
      }
      const accepted = await accept(key, agentAuthorization, {
        now: () =>
          new Date(now.getTime() - (confirmed ? 4 * 60 * 60 * 1000 + 1 : 0)),
      });
      if (confirmed) {
        await workerEnv.CONTROL_DB.prepare(
          "UPDATE connections SET status = 'connected' WHERE id = ?",
        )
          .bind(connectionId)
          .run();
        const decision = await projection.decideOutbound({
          schema_version: 1,
          tenant_id: tenantId,
          command_id: accepted.command.id,
          decision: "confirm",
          idempotency_key: `confirm-${key}`,
          actor_principal_id: "principal_human",
          actor_identity_id: "identity_human",
          decided_at: now.toISOString(),
        });
        expect(decision.dispatch).toMatchObject({
          status: "pending",
          confirmation_decision: "confirm",
        });
      }
      const expiry = now.getTime() + 30_000;
      const claimInput = {
        tenant_id: tenantId,
        command_id: accepted.command.id,
        // Identical IDs deliberately prove acquisition is not an ID comparison.
        lease_id: "lease_concurrent_same_id",
        lease_expires_at: new Date(expiry).toISOString(),
        now: now.toISOString(),
      };
      const claims = await Promise.all(
        Array.from({ length: 8 }, () =>
          projection.claimOutboundDispatch(claimInput),
        ),
      );
      expect(
        claims.filter((claim) => claim.outcome === "acquired"),
      ).toHaveLength(1);
      expect(
        claims.filter((claim) => claim.outcome === "not_acquired"),
      ).toHaveLength(7);
      expect(
        await runInDurableObject(projection, (_instance, state) =>
          state.storage.getAlarm(),
        ),
      ).toBe(expiry);
      // An early alarm does not abandon a still-live lease.
      expect(await runDurableObjectAlarm(projection)).toBe(true);
      expect(
        await runInDurableObject(projection, (_instance, state) =>
          state.storage.getAlarm(),
        ),
      ).toBe(expiry);

      const providerCalls = async () =>
        (
          await workerEnv.TEST_OUTBOUND_PROVIDER.fetch(
            `https://controlled-provider/count?command_id=${accepted.command.id}`,
          )
        ).json();
      for (const claim of claims) {
        if (claim.outcome !== "acquired" || !sent) continue;
        const payload = await projection.getOutboundDispatchPayload({
          schema_version: 1,
          tenant_id: tenantId,
          command_id: accepted.command.id,
          lease_id: claim.dispatch.dispatch_lease_id,
          now: now.toISOString(),
        });
        expect(
          (
            await workerEnv.TEST_OUTBOUND_PROVIDER.fetch(
              "https://controlled-provider/send",
              { method: "POST", body: JSON.stringify(payload) },
            )
          ).status,
        ).toBe(202);
        // Simulate a lost provider response before result persistence.
      }
      expect(await providerCalls()).toBe(sent ? 1 : 0);
      await evictDurableObject(projection);
      expect(await projection.claimOutboundDispatch(claimInput)).toMatchObject({
        outcome: "not_acquired",
        dispatch: { status: "dispatching" },
      });
      expect(
        await runInDurableObject(projection, (_instance, state) =>
          state.storage.getAlarm(),
        ),
      ).toBe(expiry);

      vi.spyOn(Date, "now").mockReturnValue(expiry + 1);
      // Restart with an already-overdue deadline; no client request expires it.
      await evictDurableObject(projection);
      expect(await runDurableObjectAlarm(projection)).toBe(true);
      expect(
        await rows(
          projection,
          "SELECT status, chat_paused, uncertainty_reason, dispatch_lease_id FROM outbound_dispatches WHERE command_id = ?",
          accepted.command.id,
        ),
      ).toEqual([
        {
          status: "delivery_uncertain",
          chat_paused: 1,
          uncertainty_reason: "expired_dispatch_lease",
          dispatch_lease_id: null,
        },
      ]);
      expect(
        await rows(
          projection,
          "SELECT status FROM commands WHERE id = ?",
          accepted.command.id,
        ),
      ).toEqual([{ status: "delivery_uncertain" }]);
      const replayAdapter = vi.fn(async () => ({
        type: "uncertain" as const,
        reason: "must_not_run",
      }));
      const replay = await accept(key, agentAuthorization, {
        now: () => new Date(expiry + 1),
        dispatchOutbound: replayAdapter,
      });
      expect(replay).toMatchObject({
        replayed: true,
        dispatch: { status: "delivery_uncertain", chat_paused: true },
      });
      expect(replayAdapter).not.toHaveBeenCalled();
      expect(await providerCalls()).toBe(sent ? 1 : 0);
      expect(
        await projection.claimOutboundDispatch({
          ...claimInput,
          now: new Date(expiry + 1).toISOString(),
        }),
      ).toMatchObject({
        outcome: "not_acquired",
        dispatch: { status: "delivery_uncertain" },
      });
      expect(
        await runInDurableObject(projection, (_instance, state) =>
          state.storage.getAlarm(),
        ),
      ).toBe(expiry + 60_001);
    },
  );
});

describe("outbound acceptance authority", () => {
  it("denies a grant revoked before reservation without entering the DO", async () => {
    let releaseReservation: () => void = () => undefined;
    let enterReservation: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enterReservation = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const key = `authority-race-${crypto.randomUUID()}`;
    const attempt = accept(key, agentAuthorization, {
      beforeAcceptanceReservation: async () => {
        enterReservation();
        await release;
      },
    });
    await entered;
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(acceptedAt.toISOString(), tenantId, grantId)
      .run();
    releaseReservation();

    await expect(attempt).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await workerEnv.CONTROL_DB.prepare(
        "SELECT id FROM outbound_acceptance_intents WHERE tenant_id = ? AND idempotency_key = ?",
      )
        .bind(tenantId, key)
        .all(),
    ).toMatchObject({ results: [] });
    const projection = workerEnv.TENANT_PROJECTION.getByName(tenantId);
    expect(
      await rows(
        projection,
        "SELECT id FROM outbound_dispatches WHERE idempotency_key = ?",
        key,
      ),
    ).toHaveLength(0);
  });

  it("keeps a committed acceptance but rejects a provider claim after revocation", async () => {
    const key = `authority-revoke-after-${crypto.randomUUID()}`;
    const accepted = await accept(key);
    expect(accepted.replayed).toBe(false);
    const reservation = await reservationFor(key);
    expect(reservation.status).toBe("committed");

    await workerEnv.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND id = ?",
    )
      .bind(acceptedAt.toISOString(), tenantId, grantId)
      .run();

    const claim = await claimOutboundDispatch(workerEnv.CONTROL_DB, {
      tenant_id: tenantId,
      membership_id: reservation.membership_id,
      identity_id: reservation.identity_id,
      account_id: reservation.account_id,
      conversation_id: reservation.conversation_id,
      connection_id: reservation.connection_id,
      grant_id: reservation.grant_id,
      capability: reservation.capability,
      reservation_id: reservation.id,
      command_id: accepted.command.id,
      dispatch_id: accepted.dispatch.id,
      transaction_id: accepted.dispatch.transaction_id,
      request_digest: reservation.request_digest,
      body_digest: reservation.body_digest,
      now: "2026-09-14T00:00:01.000Z",
      expires_at: "2026-09-14T00:00:31.000Z",
    });
    expect(claim).toMatchObject({
      status: "denied",
      reason: "authorization_revoked",
    });
    expect(
      await workerEnv.CONTROL_DB.prepare(
        "SELECT id FROM outbound_dispatch_claims WHERE tenant_id = ? AND reservation_id = ?",
      )
        .bind(tenantId, reservation.id)
        .all(),
    ).toMatchObject({ results: [] });

    const replay = await accept(key);
    expect(replay.replayed).toBe(true);
    expect(replay.command.id).toBe(accepted.command.id);
    expect(replay.message.id).toBe(accepted.message.id);
    expect(replay.dispatch.id).toBe(accepted.dispatch.id);
  });

  it("reuses a reserved intent after a pre-DO failure and finalizes exact DO ids", async () => {
    const key = `authority-recovery-${crypto.randomUUID()}`;
    await expect(
      accept(key, agentAuthorization, {
        beforeCommit: () => {
          throw new Error("controlled pre-DO failure");
        },
      }),
    ).rejects.toThrow("controlled pre-DO failure");
    const reserved = await reservationFor(key);
    expect(reserved.status).toBe("reserved");
    expect(reserved.command_id).toBeNull();

    const recovered = await accept(key);
    expect(recovered.replayed).toBe(false);
    const committed = await reservationFor(key);
    expect(committed.status).toBe("committed");
    expect(committed.command_id).toBe(recovered.command.id);
    expect(committed.message_id).toBe(recovered.message.id);
    expect(committed.dispatch_id).toBe(recovered.dispatch.id);
    expect(committed.transaction_id).toBe(recovered.dispatch.transaction_id);
  });

  it("finalizes before a post-DO failure and replays the saved triple", async () => {
    const key = `authority-post-do-${crypto.randomUUID()}`;
    await expect(
      accept(key, agentAuthorization, {
        afterCommit: () => {
          throw new Error("controlled post-DO failure");
        },
      }),
    ).rejects.toThrow("controlled post-DO failure");
    const committed = await reservationFor(key);
    expect(committed.status).toBe("committed");

    const replay = await accept(key);
    expect(replay.replayed).toBe(true);
    expect(replay.command.id).toBe(committed.command_id);
    expect(replay.message.id).toBe(committed.message_id);
    expect(replay.dispatch.id).toBe(committed.dispatch_id);
  });

  it("uses owner/admin authority without creating a grant capability", async () => {
    const key = `authority-owner-${crypto.randomUUID()}`;
    const accepted = await accept(key, ownerAuthorization);
    expect(accepted.replayed).toBe(false);
    const reservation = await reservationFor(key);
    expect(reservation.status).toBe("committed");
    expect(reservation.grant_id).toBeNull();
    expect(reservation.capability).toMatchObject({
      kind: "owner_admin",
      authority_id: "membership_human",
    });
  });
});
