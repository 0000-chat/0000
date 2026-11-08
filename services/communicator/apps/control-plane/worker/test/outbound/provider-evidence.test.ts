import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import {
  auth,
  bindingFor,
  event,
  initialize,
  rows,
} from "../projection/projector-test-support";
import {
  clearDirectory,
  seedDirectory,
  seedAccountAccess,
} from "../support/directory-fixtures";
import { z } from "zod";
import { OidcVerificationError } from "../../auth/oidc";
import { recordRemovalWithSuppression } from "../../removals/service";
import { evidenceOutboundHandler } from "../../routes/outbound";
import { Hono } from "hono";

const tenant = "tenant_pilot";
const timestamp = "2026-08-29T00:00:00.000Z";
const saved = {
  platform: {
    id: "saved_evidence",
    authority: "fixture",
    subjectId: "subject",
    organizationId: "org",
    audience: "test",
    operationId: "send",
    capability: "message.send" as const,
  },
  binding_id: "binding_evidence",
  session_generation: timestamp,
  route_generation: timestamp,
  route: {
    gateway_route_id: "gateway_route_human",
    bridge_instance_id: "bridge-human",
    matrix_user_id: "route-user-human",
    matrix_room_namespace: "route-room-human",
  },
};
const requestSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: z.string(),
    account_id: z.string(),
    connection_id: z.string(),
    identity_id: z.string(),
    conversation_id: z.string(),
    transaction_id: z.string(),
    request_digest: z.string(),
    projection_generation: z.number(),
    session_generation: z.string(),
    observation_event_id: z.string(),
  })
  .strict();
let calls = 0;
let mutate: ((value: Record<string, unknown>) => void) | undefined;
let during: (() => Promise<void>) | undefined;
let redirectStatus: number | undefined;
let redirectBodyCancelled = false;

const gateway = {
  fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
    // Service bindings construct a native workerd Request before dispatch.
    // In particular, workerd rejects redirect:error rather than implementing it.
    const request = new Request(url, init);
    calls++;
    const input = requestSchema.parse(await request.json());
    expect(request.headers.get("authorization")).toBe(
      "Bearer fixture-gateway-evidence-token",
    );
    if (redirectStatus !== undefined) {
      expect(request.redirect).toBe("manual");
      return new Response(
        new ReadableStream({
          cancel: () => {
            redirectBodyCancelled = true;
          },
        }),
        {
          status: redirectStatus,
          headers: { Location: "https://untrusted.invalid/evidence" },
        },
      );
    }
    if (during) await during();
    const delivered = input.observation_event_id.includes("delivery");
    const failed = input.observation_event_id.includes("failure");
    const value: Record<string, unknown> = {
      ...input,
      evidence_id: input.observation_event_id,
      source: delivered ? "provider" : "bridge",
      status: delivered ? "delivered" : failed ? "uncertain" : "accepted",
      reason: delivered
        ? "bridge_reported_dm_delivery"
        : failed
          ? "bridge_fail_permanent"
          : "bridge_reported_success",
      observed_at: "2026-11-07T00:00:00.000Z",
      remote_echo_id: "$saved-matrix-send",
      provider_read: "unsupported",
    };
    delete value.identity_id;
    delete value.observation_event_id;
    mutate?.(value);
    return Response.json(value);
  },
};

const environment = () => ({
  ...env,
  COMMUNICATOR_INGRESS_ENABLED: "true",
  CONNECTION_GATEWAY_URL: "https://gateway.invalid",
  CONNECTION_GATEWAY_TOKEN: "fixture-gateway-evidence-token",
  CONNECTION_GATEWAY_VPC: gateway,
});

const app = () =>
  createApp({
    createIngestionTokenVerifier: () => ({
      verify: async (token) => {
        if (token !== "service-evidence-token")
          throw new OidcVerificationError("invalid");
        return {
          issuer: "https://evidence.fixture/",
          subject: "gateway",
          token_id: "service-evidence-token",
        };
      },
    }),
  });
const post = (
  command: string,
  observation = "$delivery",
  extra = {},
  token = "service-evidence-token",
) =>
  app().request(
    "https://worker.invalid/internal/v1/outbound/provider-evidence",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        tenant_id: tenant,
        command_id: command,
        observation_event_id: observation,
        ...extra,
      }),
    },
    environment(),
  );

async function fixture() {
  const stub = await initialize(tenant);
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenant,
    authorization: auth(["projection.write"], ["identity_human"], tenant),
    mode: "live",
    rebuild_id: null,
    connections: [
      bindingFor(
        "account_human",
        "connection_human_whatsapp",
        "identity_human",
      ),
    ],
    events: [
      event(
        "event_evidence_conversation",
        { title: "Evidence", archived: false, muted: false },
        "conversation.updated",
        {
          tenant_id: tenant,
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_evidence",
        },
      ),
    ],
    checkpoint: null,
  });
  const accepted = await stub.acceptTextReply({
    schema_version: 1,
    tenant_id: tenant,
    actor_principal_id: "principal_human",
    actor_identity_id: "identity_human",
    conversation_id: "conversation_evidence",
    body: "Local controlled evidence text",
    delivery_mode: "direct",
    idempotency_key: crypto.randomUUID(),
    accepted_at: new Date().toISOString(),
    authority: {
      reservation_id: "reservation_evidence",
      membership_id: "membership_human",
      identity_id: "identity_human",
      capability: {
        kind: "owner_admin",
        authority_id: "authority_evidence",
        authority_epoch: 1,
      },
      saved,
    },
  });
  await stub.claimOutboundDispatch({
    tenant_id: tenant,
    command_id: accepted.command.id,
    lease_id: "lease_evidence",
    lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
    now: new Date().toISOString(),
  });
  await stub.reconcileOutbound({
    schema_version: 1,
    tenant_id: tenant,
    command_id: accepted.command.id,
    connection_available: true,
    now: new Date().toISOString(),
    evidence: {
      schema_version: 1,
      tenant_id: tenant,
      command_id: accepted.command.id,
      account_id: "account_human",
      conversation_id: "conversation_evidence",
      transaction_id: accepted.dispatch.transaction_id,
      request_digest: accepted.dispatch.request_digest,
      generation: 1,
      source: "refresh",
      status: "uncertain",
      evidence_id: "lost-response",
      observed_at: new Date().toISOString(),
    },
  });
  return { stub, accepted };
}

beforeEach(async () => {
  calls = 0;
  redirectStatus = undefined;
  redirectBodyCancelled = false;
  mutate = undefined;
  during = undefined;
  const previous = await initialize(tenant);
  await runInDurableObject(previous, async (_instance, state) => {
    await state.storage.deleteAlarm();
    state.storage.sql.exec("DELETE FROM outbound_evidence");
    state.storage.sql.exec("DELETE FROM outbound_actions");
    state.storage.sql.exec("DELETE FROM outbound_command_decisions");
    state.storage.sql.exec("DELETE FROM outbound_dispatches");
    state.storage.sql.exec("DELETE FROM commands");
    state.storage.sql.exec("DELETE FROM messages");
  });
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await env.CONTROL_DB.prepare(
    "INSERT INTO principals (id,issuer,subject,principal_type,display_name,status,created_at,updated_at) VALUES ('principal_evidence','https://evidence.fixture/','gateway','service','Fixture','active',?,?)",
  )
    .bind(timestamp, timestamp)
    .run();
  await seedAccountAccess(env.CONTROL_DB, "principal_evidence");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runInDurableObject(
    env.TENANT_PROJECTION.getByName(tenant),
    async (_instance, state) => {
      await state.storage.deleteAlarm();
    },
  );
});

describe("private trusted provider evidence in real Worker/D1/SQLite DO", () => {
  it.each([301, 302, 303, 307, 308])(
    "rejects gateway %s without following or retaining its body",
    async (status) => {
      const { stub, accepted } = await fixture();
      redirectStatus = status;
      const response = await post(accepted.command.id);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "provider_evidence_unavailable",
      });
      expect(calls).toBe(1);
      expect(redirectBodyCancelled).toBe(true);
      expect(
        await rows(stub, "SELECT provider_stage FROM outbound_dispatches"),
      ).toEqual([{ provider_stage: "unknown" }]);
      expect(
        (
          await stub.listOutboundEvidence({
            schema_version: 1,
            tenant_id: tenant,
            command_id: accepted.command.id,
          })
        ).filter((e) => e.source === "provider"),
      ).toEqual([]);
    },
  );
  it("recovers the exact uncertain attempt after eviction and keeps delivery monotonic across repeats and out-of-order failures", async () => {
    const { stub, accepted } = await fixture();
    await evictDurableObject(stub);
    const response = await post(accepted.command.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "delivered",
      provider_stage: "delivered",
      provider_read: "unsupported",
    });
    expect((await post(accepted.command.id)).status).toBe(200);
    expect((await post(accepted.command.id, "$failure")).status).toBe(200);
    expect((await post(accepted.command.id, "$accepted")).status).toBe(200);
    const commands = await rows(stub, "SELECT status FROM commands");
    expect(commands).toEqual([{ status: "delivered" }]);
    expect(
      await rows(stub, "SELECT status,provider_stage FROM outbound_dispatches"),
    ).toEqual([{ status: "dispatched", provider_stage: "delivered" }]);
    expect(
      (
        await stub.listOutboundEvidence({
          schema_version: 1,
          tenant_id: tenant,
          command_id: accepted.command.id,
        })
      ).filter((e) => e.evidence_id === "$delivery"),
    ).toHaveLength(1);
    expect(await rows(stub, "SELECT COUNT(*) AS count FROM messages")).toEqual([
      { count: 1 },
    ]);
    expect(
      JSON.stringify(
        await stub.listOutboundEvidence({
          schema_version: 1,
          tenant_id: tenant,
          command_id: accepted.command.id,
        }),
      ),
    ).not.toContain("Local controlled");
  });
  it("records bridge rejection separately from provider delivery and permits later success", async () => {
    const { stub, accepted } = await fixture();
    await stub.reconcileOutbound({
      schema_version: 1,
      tenant_id: tenant,
      command_id: accepted.command.id,
      now: new Date().toISOString(),
      connection_available: true,
      evidence: {
        schema_version: 1,
        tenant_id: tenant,
        command_id: accepted.command.id,
        account_id: accepted.dispatch.account_id,
        conversation_id: accepted.dispatch.conversation_id,
        transaction_id: accepted.dispatch.transaction_id,
        request_digest: accepted.dispatch.request_digest,
        generation: 1,
        source: "matrix",
        status: "confirmed",
        evidence_id: "$saved-matrix-send",
        observed_at: timestamp,
      },
    });
    expect((await post(accepted.command.id, "$failure")).status).toBe(200);
    expect(await rows(stub, "SELECT status FROM commands")).toEqual([
      { status: "delivery_uncertain" },
    ]);
    expect(
      await rows(stub, "SELECT provider_stage FROM outbound_dispatches"),
    ).toEqual([{ provider_stage: "unknown" }]);
    expect(
      (
        await stub.listOutboundEvidence({
          schema_version: 1,
          tenant_id: tenant,
          command_id: accepted.command.id,
        })
      ).find((e) => e.evidence_id === "$failure")?.reason,
    ).toBe("bridge_fail_permanent");
    expect((await post(accepted.command.id)).status).toBe(200);
  });
  it("reconciles old-attempt evidence after an explicit resend without attributing it to the new attempt", async () => {
    const { stub, accepted } = await fixture();
    const resend = await stub.decideOutbound({
      schema_version: 1,
      tenant_id: tenant,
      command_id: accepted.command.id,
      decision: "resend",
      idempotency_key: "explicit-resend",
      actor_principal_id: "principal_human",
      actor_identity_id: "identity_human",
      decided_at: new Date().toISOString(),
      connection_available: true,
      duplicate_risk_acknowledged: true,
      resend_authority: {
        reservation_id: "reservation_resend",
        membership_id: "membership_human",
        identity_id: "identity_human",
        capability: {
          kind: "owner_admin",
          authority_id: "authority_resend",
          authority_epoch: 1,
        },
        saved,
      },
    });
    await stub.claimOutboundDispatch({
      tenant_id: tenant,
      command_id: resend.command.id,
      lease_id: "lease_resend",
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      now: new Date().toISOString(),
    });
    const before = await rows(
      stub,
      "SELECT * FROM outbound_dispatches WHERE command_id=?",
      resend.command.id,
    );
    expect((await post(accepted.command.id)).status).toBe(200);
    expect(
      await rows(
        stub,
        "SELECT * FROM outbound_dispatches WHERE command_id=?",
        resend.command.id,
      ),
    ).toEqual(before);
    expect(
      await stub.listOutboundEvidence({
        schema_version: 1,
        tenant_id: tenant,
        command_id: resend.command.id,
      }),
    ).toEqual([]);
  });
  it("rejects conflicting replay of the same immutable observation", async () => {
    const { stub, accepted } = await fixture();
    expect((await post(accepted.command.id)).status).toBe(200);
    mutate = (value) => {
      value.observed_at = "2026-11-06T00:00:00.000Z";
    };
    expect((await post(accepted.command.id)).status).not.toBe(200);
    expect(
      (
        await stub.listOutboundEvidence({
          schema_version: 1,
          tenant_id: tenant,
          command_id: accepted.command.id,
        })
      ).filter((e) => e.evidence_id === "$delivery"),
    ).toHaveLength(1);
  });
  it("retains bridge acceptance without claiming provider delivery", async () => {
    const { stub, accepted } = await fixture();
    const result = await post(accepted.command.id, "$success");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      status: "bridged",
      bridge_stage: "accepted",
      provider_stage: "unknown",
      provider_read: "unsupported",
    });
    expect(await rows(stub, "SELECT status FROM commands")).toEqual([
      { status: "bridged" },
    ]);
  });
  it("keeps the existing public evidence handler unconditionally forbidden", async () => {
    const { stub, accepted } = await fixture();
    const publicRoute = new Hono();
    publicRoute.post("/evidence", evidenceOutboundHandler());
    const response = await publicRoute.request(
      "https://worker.invalid/evidence",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          tenant_id: tenant,
          command_id: accepted.command.id,
          source: "provider",
          status: "delivered",
        }),
      },
      environment(),
    );
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
    expect(
      await rows(stub, "SELECT provider_stage FROM outbound_dispatches"),
    ).toEqual([{ provider_stage: "unknown" }]);
  });
  it.each([
    "tenant_id",
    "account_id",
    "connection_id",
    "conversation_id",
    "transaction_id",
    "request_digest",
    "session_generation",
    "projection_generation",
    "evidence_id",
  ])("rejects gateway response with mismatched %s", async (field) => {
    const { stub, accepted } = await fixture();
    mutate = (value) => {
      value[field] = "mismatched";
    };
    expect((await post(accepted.command.id)).status).not.toBe(200);
    expect(
      await rows(stub, "SELECT provider_stage FROM outbound_dispatches"),
    ).toEqual([{ provider_stage: "unknown" }]);
  });
  it("rejects outcome injection and unauthorized callers before gateway I/O", async () => {
    const { accepted } = await fixture();
    expect(
      (await post(accepted.command.id, "$delivery", { status: "delivered" }))
        .status,
    ).toBe(400);
    expect(
      (await post(accepted.command.id, "$delivery", {}, "human-token")).status,
    ).not.toBe(200);
    expect(calls).toBe(0);
  });
  it.each([
    "removed",
    "rotated",
    "removal-ledger",
    "route-replaced",
    "service-revoked",
  ])(
    "does not apply an observation when %s during gateway I/O",
    async (kind) => {
      const { stub, accepted } = await fixture();
      during = async () => {
        if (kind === "removed")
          await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec(
              "UPDATE messages SET body='',deleted_at=?",
              new Date().toISOString(),
            );
          });
        else if (kind === "rotated")
          await env.CONTROL_DB.prepare(
            "UPDATE connections SET updated_at=? WHERE id='connection_human_whatsapp'",
          )
            .bind(new Date().toISOString())
            .run();
        else if (kind === "route-replaced")
          await env.CONTROL_DB.prepare(
            "UPDATE connection_routes SET updated_at=? WHERE connection_id='connection_human_whatsapp'",
          )
            .bind(new Date().toISOString())
            .run();
        else if (kind === "service-revoked")
          await env.CONTROL_DB.prepare(
            "UPDATE principals SET status='revoked',revoked_at=? WHERE id='principal_evidence'",
          )
            .bind(new Date().toISOString())
            .run();
        else
          await recordRemovalWithSuppression(env.CONTROL_DB, {
            tenant_id: tenant,
            resource_type: "message",
            resource_id: accepted.message.id,
            content_generation: accepted.message.id,
            account_id: accepted.dispatch.account_id,
            conversation_id: accepted.dispatch.conversation_id,
            source_event_id: "event_remove_evidence",
            source_object_key: null,
            reason: "requested",
            removed_at: new Date().toISOString(),
          });
      };
      expect((await post(accepted.command.id)).status).not.toBe(200);
      expect(
        await rows(stub, "SELECT provider_stage FROM outbound_dispatches"),
      ).toEqual([{ provider_stage: "unknown" }]);
    },
  );
});
