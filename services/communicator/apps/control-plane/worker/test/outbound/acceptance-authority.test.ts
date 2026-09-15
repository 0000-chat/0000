import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { SessionResponseSchema } from "@communicator/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
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
