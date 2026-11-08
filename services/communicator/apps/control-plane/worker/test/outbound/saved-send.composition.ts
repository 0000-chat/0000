import {
  applyD1Migrations,
  env,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { createPlatformClient } from "@0000/platform-client";
import {
  OutboundCapabilitySchema,
  SavedSendRouteSchema,
  SessionResponseSchema,
  type OutboundDispatch,
  type OutboundDispatchPayload,
} from "@communicator/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { acceptTextReply } from "../../outbound/acceptance";
import { HttpWhatsAppTextAdapter } from "../../outbound/whatsapp-adapter";
import { dispatchClaimHandlerAt } from "../../outbound/dispatch-claim-route";
import { reserveOutboundAcceptance } from "../../outbound/authority";
import { captureSavedSend } from "../../outbound/saved-authority";
import { canonicalJsonStringify } from "../../archive/canonical-json";
import { sha256Hex } from "../../archive/codec";
import { resolvePlatformAuthorization } from "../../control-directory/authorization";
import {
  auth,
  bindingFor,
  event,
  initialize,
} from "../projection/projector-test-support";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";
import { z } from "zod";
import { runDormantTenantBootstrapTick } from "../../tenant-wakeup-bootstrap";

const runtime = env as typeof env & {
  CONTROL_DB: D1Database;
  TEST_PLATFORM: Fetcher;
  TEST_PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: D1Migration[];
  TEST_OUTBOUND_PROVIDER: Fetcher;
};
const actorSchema = z.object({
  credential: z.string(),
  credentialId: z.string(),
  agentId: z.string(),
  grantId: z.string(),
  organizationId: z.string(),
});
const fixtureSchema = z.object({
  actor: actorSchema,
  gateway: actorSchema.omit({ organizationId: true }),
});
const tenant = "tenant_pilot";
const conversation = "conversation_saved_authority";
const environment = {
  ...runtime,
  COMMUNICATOR_PLATFORM_BASE_URL: "http://localhost",
  COMMUNICATOR_PLATFORM_AUTHORITY: "saved-send-test-authority",
  COMMUNICATOR_PLATFORM_AUDIENCE: "https://communicator.saved.test",
  COMMUNICATOR_PLATFORM_SERVICE_VERIFIER:
    "saved-send-test-only-service-verifier",
  CONNECTION_GATEWAY_URL:
    "https://matrix-gateway.internal.example.invalid" as const,
  CONNECTION_GATEWAY_TOKEN: "saved-send-test-only-gateway-secret",
};
let fixture: z.infer<typeof fixtureSchema>;
let authorization: z.infer<typeof SessionResponseSchema>;
let unavailable = false;
let beforeClaim: (() => Promise<void>) | undefined;
let afterRevalidation: (() => Promise<void>) | undefined;
let loseCaptureResponse = false;
let loseProviderResponse = false;
const restoreRecoveryEnvironment: (() => void)[] = [];
const gatewayPayloadSchema = z.object({
  tenant_id: z.string(),
  membership_id: z.string(),
  actor_identity_id: z.string(),
  account_id: z.string(),
  conversation_id: z.string(),
  connection_id: z.string(),
  reservation_id: z.string(),
  command_id: z.string(),
  dispatch_id: z.string(),
  transaction_id: z.string(),
  request_digest: z.string(),
  body_digest: z.string(),
  session_generation: z.string(),
  route: SavedSendRouteSchema,
  capability: OutboundCapabilitySchema,
});
let tamperGatewayRequest:
  | ((value: z.infer<typeof gatewayPayloadSchema>) => void)
  | undefined;
const projection = () => runtime.TENANT_PROJECTION.getByName(tenant);

async function bindActor(kind: "agent" | "service") {
  const isActor = kind === "agent";
  const target = isActor ? fixture.actor : fixture.gateway;
  await runtime.CONTROL_DB.prepare(`INSERT INTO platform_bindings (
    binding_id, platform_authority, platform_kind, platform_subject_id, platform_organization_id,
    platform_membership_id, platform_grant_id, local_tenant_id, local_principal_id, local_membership_id,
    local_identity_id, local_installation_id, local_client_id, status, created_at, updated_at)
    VALUES (?, 'saved-send-test-authority', ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?)
  `)
    .bind(
      `binding_saved_${kind}`,
      kind,
      target.agentId,
      fixture.actor.organizationId,
      target.grantId,
      tenant,
      isActor ? "principal_agent" : "principal_saved_gateway",
      isActor ? "membership_agent" : "membership_saved_gateway",
      isActor ? "identity_agent" : null,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
}

beforeEach(async () => {
  unavailable = false;
  beforeClaim = undefined;
  afterRevalidation = undefined;
  loseCaptureResponse = false;
  loseProviderResponse = false;
  tamperGatewayRequest = undefined;
  await applyD1Migrations(
    runtime.TEST_PLATFORM_DB,
    runtime.TEST_PLATFORM_MIGRATIONS,
  );
  const response = await runtime.TEST_PLATFORM.fetch(
    "http://localhost/__fixture/seed",
  );
  expect(response.status).toBe(200);
  fixture = fixtureSchema.parse(await response.json());
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (unavailable && request.url.includes("/saved-operations/"))
        return Response.json(
          { status: "authority_unavailable" },
          { status: 503 },
        );
      const result = await runtime.TEST_PLATFORM.fetch(request);
      if (
        loseCaptureResponse &&
        request.url.endsWith("/saved-operations/capture")
      ) {
        loseCaptureResponse = false;
        await result.arrayBuffer();
        throw new Error("controlled capture response loss after real commit");
      }
      if (
        request.url.endsWith("/saved-operations/revalidate") &&
        afterRevalidation
      ) {
        const mutate = afterRevalidation;
        afterRevalidation = undefined;
        await mutate();
      }
      return result;
    },
  );
  await clearDirectory(runtime.CONTROL_DB);
  await seedDirectory(runtime.CONTROL_DB);
  await runtime.CONTROL_DB.batch([
    runtime.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, display_name, principal_type, status, created_at, updated_at) VALUES ('principal_saved_gateway', 'fixture', 'gateway', 'Controlled gateway', 'service', 'active', ?, ?)",
    ).bind(new Date().toISOString(), new Date().toISOString()),
    runtime.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES ('membership_saved_gateway', ?, 'principal_saved_gateway', 'member', 'active', ?, ?)",
    ).bind(tenant, new Date().toISOString(), new Date().toISOString()),
  ]);
  await seedAccountAccess(runtime.CONTROL_DB, "principal_saved_gateway");
  await bindActor("agent");
  await bindActor("service");
  await runtime.CONTROL_DB.batch([
    runtime.CONTROL_DB.prepare(`INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at)
      VALUES ('grant_saved_send', ?, 'membership_agent', 'identity_agent', 'account_human', 'message.send', 'all_chats', 'active', ?, ?)`).bind(
      tenant,
      new Date().toISOString(),
      new Date().toISOString(),
    ),
    runtime.CONTROL_DB.prepare(`INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, connection_id, link_session_id, created_at)
      VALUES (?, 'whatsapp', ?, 'connection_human_whatsapp', 'link_saved_test', ?)`).bind(
      tenant,
      "b".repeat(64),
      new Date().toISOString(),
    ),
  ]);
  const client = createPlatformClient({
    baseUrl: "http://localhost",
    authority: environment.COMMUNICATOR_PLATFORM_AUTHORITY,
    audience: environment.COMMUNICATOR_PLATFORM_AUDIENCE,
    serviceVerifier: environment.COMMUNICATOR_PLATFORM_SERVICE_VERIFIER,
  });
  const authenticated = await client.authenticate(fixture.actor.credential);
  if (
    authenticated.status !== "authenticated" ||
    authenticated.principal.kind === "guest"
  )
    throw new Error("real actor authentication failed");
  const local = await resolvePlatformAuthorization(
    runtime.CONTROL_DB,
    authenticated.principal,
    tenant,
  );
  if (!local.ok) throw new Error(`local actor binding failed: ${local.code}`);
  authorization = local.context;
  await initialize(tenant);
  await runInDurableObject(projection(), (_instance, state) => {
    state.storage.sql.exec("UPDATE projection_meta SET state = 'ready'");
    state.storage.sql.exec("DELETE FROM outbound_actions");
    state.storage.sql.exec("DELETE FROM outbound_evidence");
    state.storage.sql.exec("DELETE FROM outbound_command_decisions");
    state.storage.sql.exec("DELETE FROM outbound_dispatches");
    state.storage.sql.exec("DELETE FROM commands");
  });
  await projection().applyBatch({
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
        `conversation_${crypto.randomUUID()}`,
        { title: "Saved authority fixture", archived: false, muted: false },
        "conversation.updated",
        {
          tenant_id: tenant,
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: conversation,
        },
      ),
    ],
    checkpoint: null,
  });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
});
afterEach(() => {
  for (const restore of restoreRecoveryEnvironment.reverse()) restore();
  restoreRecoveryEnvironment.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const context = () => ({
  env: environment,
  authorization,
  credential: fixture.actor.credential,
});
const accept = (
  key = crypto.randomUUID(),
  dispatchOutbound?: (
    dispatch: OutboundDispatch,
    payload: OutboundDispatchPayload,
  ) => ReturnType<HttpWhatsAppTextAdapter["dispatch"]>,
) =>
  acceptTextReply(
    context(),
    {
      identity_id: "identity_agent",
      conversation_id: conversation,
      account_id: "account_human",
      body: "Controlled local saved authority test",
      delivery_mode: "direct",
    },
    key,
    dispatchOutbound === undefined ? {} : { dispatchOutbound },
  );

const claims = new Hono<{ Bindings: Cloudflare.Env }>();
claims.post("/internal/v1/outbound/dispatch-claims", (context) =>
  dispatchClaimHandlerAt(context, () => new Date(Date.now())),
);
const gatewayFetch: typeof fetch = async (_url, init) => {
  const payload = gatewayPayloadSchema.parse(JSON.parse(String(init?.body)));
  tamperGatewayRequest?.(payload);
  if (beforeClaim) {
    const mutate = beforeClaim;
    beforeClaim = undefined;
    await mutate();
  }
  const now = new Date(Date.now());
  const response = await claims.request(
    "https://communicator.test/internal/v1/outbound/dispatch-claims",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.gateway.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        operation: "message.send",
        tenant_id: payload.tenant_id,
        membership_id: payload.membership_id,
        identity_id: payload.actor_identity_id,
        account_id: payload.account_id,
        conversation_id: payload.conversation_id,
        connection_id: payload.connection_id,
        reservation_id: payload.reservation_id,
        operation_id: payload.dispatch_id,
        request_hash: payload.request_digest,
        capability: payload.capability,
        command_id: payload.command_id,
        dispatch_id: payload.dispatch_id,
        transaction_id: payload.transaction_id,
        request_digest: payload.request_digest,
        body_digest: payload.body_digest,
        session_generation: payload.session_generation,
        route: payload.route,
        now: now.toISOString(),
        expires_at: new Date(now.getTime() + 60_000).toISOString(),
      }),
    },
    environment,
  );
  if (response.status === 503) return response;
  const result = z
    .object({ status: z.string(), provider_allowed: z.boolean().optional() })
    .passthrough()
    .parse(await response.json());
  if (result.status !== "claimed" || result.provider_allowed !== true)
    return Response.json({ reason: "authorization_revoked" }, { status: 403 });
  await runtime.TEST_OUTBOUND_PROVIDER.fetch(
    "https://controlled.provider/send",
    {
      method: "POST",
      body: JSON.stringify({ command_id: payload.command_id }),
    },
  );
  if (loseProviderResponse)
    throw new Error("controlled lost provider response");
  return Response.json({
    outcome: "accepted",
    transaction_id: payload.transaction_id,
    request_digest: payload.request_digest,
    account_id: payload.account_id,
    connection_id: payload.connection_id,
    session_generation: payload.session_generation,
    observed_at: new Date().toISOString(),
    evidence: [
      {
        source: "matrix",
        status: "confirmed",
        evidence_id: `matrix_${payload.transaction_id}`,
      },
    ],
  });
};
const adapter = () => new HttpWhatsAppTextAdapter(context(), gatewayFetch);

async function enableRecovery() {
  await runInDurableObject(projection(), (instance) => {
    const target = Reflect.get(instance, "env");
    const configuration = {
      COMMUNICATOR_PLATFORM_BASE_URL:
        environment.COMMUNICATOR_PLATFORM_BASE_URL,
      COMMUNICATOR_PLATFORM_AUTHORITY:
        environment.COMMUNICATOR_PLATFORM_AUTHORITY,
      COMMUNICATOR_PLATFORM_AUDIENCE:
        environment.COMMUNICATOR_PLATFORM_AUDIENCE,
      COMMUNICATOR_PLATFORM_SERVICE_VERIFIER:
        environment.COMMUNICATOR_PLATFORM_SERVICE_VERIFIER,
      CONNECTION_GATEWAY_URL: environment.CONNECTION_GATEWAY_URL,
      CONNECTION_GATEWAY_TOKEN: environment.CONNECTION_GATEWAY_TOKEN,
      CONNECTION_GATEWAY_VPC: { fetch: gatewayFetch },
    };
    const previous = Object.getOwnPropertyDescriptors(target);
    Object.assign(target, configuration);
    restoreRecoveryEnvironment.push(() => {
      for (const key of Object.keys(configuration)) {
        const descriptor = previous[key];
        if (descriptor === undefined) Reflect.deleteProperty(target, key);
        else Object.defineProperty(target, key, descriptor);
      }
    });
  });
}

async function recover(requireScheduled = true) {
  await enableRecovery();
  const scheduled = await runDurableObjectAlarm(projection());
  if (requireScheduled) expect(scheduled).toBe(true);
  else if (!scheduled) {
    // A stale/spurious invocation after terminal work must also be harmless.
    await runInDurableObject(projection(), (instance) => instance.alarm());
  }
}

async function providerCalls(commandId: string): Promise<unknown> {
  return (
    await runtime.TEST_OUTBOUND_PROVIDER.fetch(
      `https://controlled.provider/?command_id=${commandId}`,
    )
  ).json();
}

async function dispatchRows() {
  return runInDurableObject(projection(), (_instance, state) =>
    state.storage.sql
      .exec(
        "SELECT command_id, status, uncertainty_reason, recovery_attempts, recovery_deadline_ms, recovery_next_attempt_at_ms, next_wakeup_at_ms, confirmation_due_at, authority_saved FROM outbound_dispatches ORDER BY created_at, id",
      )
      .toArray(),
  );
}

async function execute(commandId: string, repeatGateway = false) {
  const now = new Date(Date.now());
  const lease = await projection().claimOutboundDispatch({
    tenant_id: tenant,
    command_id: commandId,
    lease_id: `lease_${crypto.randomUUID().replaceAll("-", "")}`,
    now: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + 30_000).toISOString(),
  });
  expect(lease.outcome).toBe("acquired");
  if (lease.outcome !== "acquired") throw new Error("dispatch not acquired");
  const payload = await projection().getOutboundDispatchPayload({
    schema_version: 1,
    tenant_id: tenant,
    command_id: commandId,
    lease_id: lease.dispatch.dispatch_lease_id ?? "",
    now: now.toISOString(),
  });
  const result = await adapter().dispatch(lease.dispatch, payload);
  if (repeatGateway) await adapter().dispatch(lease.dispatch, payload);
  const calls = await runtime.TEST_OUTBOUND_PROVIDER.fetch(
    `https://controlled.provider/?command_id=${commandId}`,
  );
  return { result, calls: await calls.json() };
}

describe("real Platform + Communicator D1/DO saved-send composition", () => {
  it("retries explicit pre-I/O unavailability only after its persisted backoff", async () => {
    const accepted = await accept();
    const start = Date.now();
    unavailable = true;
    await recover();
    expect(await dispatchRows()).toMatchObject([
      {
        status: "pending",
        recovery_attempts: 1,
        next_wakeup_at_ms: start + 1_000,
      },
    ]);
    expect(await providerCalls(accepted.command.id)).toBe(0);
    unavailable = false;
    await recover();
    expect(await providerCalls(accepted.command.id)).toBe(0);
    vi.spyOn(Date, "now").mockReturnValue(start + 1_000);
    await evictDurableObject(projection());
    await recover();
    expect(await dispatchRows()).toMatchObject([
      { status: "dispatched", recovery_attempts: 2 },
    ]);
    expect(await providerCalls(accepted.command.id)).toBe(1);
  });

  it.each(["before", "at"] as const)(
    "preserves the offline confirmation deadline when reconnecting %s expiry",
    async (boundary) => {
      const accepted = await accept();
      const start = Date.now();
      await runtime.CONTROL_DB.prepare(
        "UPDATE connections SET status = 'disconnected' WHERE id = 'connection_human_whatsapp'",
      ).run();
      await recover();
      const due = new Date(start + 14_400_000).toISOString();
      expect(await dispatchRows()).toMatchObject([
        { status: "waiting_for_connection", confirmation_due_at: due },
      ]);
      await runtime.CONTROL_DB.prepare(
        "UPDATE connections SET status = 'connected' WHERE id = 'connection_human_whatsapp'",
      ).run();
      vi.spyOn(Date, "now").mockReturnValue(
        start + (boundary === "before" ? 60_000 : 14_400_000),
      );
      await evictDurableObject(projection());
      await recover();
      if (boundary === "before") {
        // Connection status transitions revoke the saved account-grant epoch.
        // Recovery must not refresh it to make reconnect sendable.
        expect(await providerCalls(accepted.command.id)).toBe(0);
        expect(await dispatchRows()).toMatchObject([
          {
            status: "cancelled",
            uncertainty_reason: "authorization_revoked",
            confirmation_due_at: due,
          },
        ]);
      } else {
        expect(await dispatchRows()).toMatchObject([
          { status: "confirmation_required", confirmation_due_at: due },
        ]);
        expect(await providerCalls(accepted.command.id)).toBe(0);
        await projection().decideOutbound({
          schema_version: 1,
          tenant_id: tenant,
          command_id: accepted.command.id,
          decision: "confirm",
          idempotency_key: "confirm_expired_credential",
          actor_principal_id: "principal_human",
          actor_identity_id: "identity_human",
          decided_at: new Date(Date.now()).toISOString(),
          connection_available: true,
        });
        await evictDurableObject(projection());
        await recover();
        // Confirmation cannot replace the original one-hour credential.
        expect(await providerCalls(accepted.command.id)).toBe(0);
        expect((await dispatchRows())[0]?.authority_saved).toBe(
          JSON.stringify(accepted.dispatch.authority?.saved),
        );
      }
    },
  );

  it.each(["missing", "tuple", "saved", "ids"] as const)(
    "blocks recovery for a %s reservation without acquiring or sending",
    async (mismatch) => {
      const accepted = await accept();
      const reservation = accepted.dispatch.authority?.reservation_id;
      const mutation = {
        missing: "DELETE FROM outbound_acceptance_intents WHERE id = ?",
        tuple:
          "UPDATE outbound_acceptance_intents SET conversation_id = 'other_chat' WHERE id = ?",
        saved:
          "UPDATE outbound_acceptance_intents SET saved_authority = NULL WHERE id = ?",
        ids: "UPDATE outbound_acceptance_intents SET command_id = 'other_command' WHERE id = ?",
      }[mismatch];
      if (mismatch === "saved") {
        await runInDurableObject(projection(), (_instance, state) => {
          state.storage.sql.exec(
            "UPDATE outbound_dispatches SET authority_saved = json_set(authority_saved, '$.binding_id', 'other_binding') WHERE command_id = ?",
            accepted.command.id,
          );
        });
      } else await runtime.CONTROL_DB.prepare(mutation).bind(reservation).run();
      await evictDurableObject(projection());
      await recover();
      expect(await dispatchRows()).toMatchObject([
        {
          status: "pending",
          recovery_attempts: 1,
          next_wakeup_at_ms: Date.now() + 1_000,
        },
      ]);
      expect(await providerCalls(accepted.command.id)).toBe(0);
      await recover();
      expect((await dispatchRows())[0]?.recovery_attempts).toBe(1);
    },
  );

  it.each(["attempts", "horizon"] as const)(
    "persists bounded backoff and terminates at its %s limit across eviction",
    async (limit) => {
      const accepted = await accept();
      await runtime.CONTROL_DB.prepare(
        "DELETE FROM outbound_acceptance_intents WHERE id = ?",
      )
        .bind(accepted.dispatch.authority?.reservation_id)
        .run();
      const start = Date.now();
      const delays = [
        1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
      ];
      let now = start;
      for (
        let attempt = 1;
        attempt <= (limit === "attempts" ? 8 : 1);
        attempt++
      ) {
        vi.spyOn(Date, "now").mockReturnValue(now);
        await evictDurableObject(projection());
        await recover();
        const next = now + (delays[attempt - 1] ?? 0);
        expect(await dispatchRows()).toMatchObject([
          {
            status: "pending",
            recovery_attempts: attempt,
            recovery_deadline_ms: start + 14_400_000,
            recovery_next_attempt_at_ms: next,
            next_wakeup_at_ms: next,
          },
        ]);
        now = next;
      }
      vi.spyOn(Date, "now").mockReturnValue(
        limit === "horizon" ? start + 14_400_000 : now,
      );
      await evictDurableObject(projection());
      await recover();
      expect(await dispatchRows()).toMatchObject([
        {
          status: "cancelled",
          uncertainty_reason: "recovery_exhausted",
          next_wakeup_at_ms: null,
        },
      ]);
      expect(await providerCalls(accepted.command.id)).toBe(0);
    },
  );

  it("does not let a failing oldest chat monopolize another chat", async () => {
    const oldest = await accept();
    await runtime.CONTROL_DB.prepare(
      "DELETE FROM outbound_acceptance_intents WHERE id = ?",
    )
      .bind(oldest.dispatch.authority?.reservation_id)
      .run();
    const other = "conversation_recovery_other";
    await projection().applyBatch({
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
          "recovery_other_chat",
          { title: "Other chat", archived: false, muted: false },
          "conversation.updated",
          {
            tenant_id: tenant,
            identity_id: "identity_human",
            account_id: "account_human",
            conversation_id: other,
          },
        ),
      ],
      checkpoint: null,
    });
    const healthy = await acceptTextReply(
      context(),
      {
        identity_id: "identity_agent",
        conversation_id: other,
        body: "Controlled independent chat",
        delivery_mode: "direct",
      },
      crypto.randomUUID(),
    );
    await evictDurableObject(projection());
    await recover();
    expect(await providerCalls(oldest.command.id)).toBe(0);
    expect(await providerCalls(healthy.command.id)).toBe(1);
    expect(
      (await dispatchRows()).find(
        (row) => row.command_id === oldest.command.id,
      ),
    ).toMatchObject({
      status: "pending",
      recovery_attempts: 1,
    });
  });

  it("recovers a lost confirmation without substituting its actor or credential", async () => {
    const accepted = await accept();
    const now = Date.now();
    // The trusted decision RPC is the human authorization boundary's output;
    // execution still uses the original real Platform agent authority.
    await runInDurableObject(projection(), async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE outbound_dispatches SET status = 'confirmation_required' WHERE command_id = ?",
        accepted.command.id,
      );
      state.storage.sql.exec(
        "UPDATE commands SET status = 'confirmation_required' WHERE id = ?",
        accepted.command.id,
      );
      const decide = instance.decideOutbound.bind(instance);
      const lost = vi
        .spyOn(instance, "decideOutbound")
        .mockImplementation(async (input) => {
          await decide(input);
          throw new Error("controlled lost confirmation response");
        });
      try {
        await expect(
          instance.decideOutbound({
            schema_version: 1,
            tenant_id: tenant,
            command_id: accepted.command.id,
            decision: "confirm",
            idempotency_key: "confirm_lost",
            actor_principal_id: "principal_human",
            actor_identity_id: "identity_human",
            decided_at: new Date(now).toISOString(),
            connection_available: true,
          }),
        ).rejects.toThrow("controlled lost confirmation response");
      } finally {
        lost.mockRestore();
      }
    });
    await evictDurableObject(projection());
    await recover();
    expect(await providerCalls(accepted.command.id)).toBe(1);
    expect((await dispatchRows())[0]?.authority_saved).toBe(
      JSON.stringify(accepted.dispatch.authority?.saved),
    );
  });

  it("repairs a saved explicit resend after losing its decision response, without retrying the original", async () => {
    const original = await accept();
    const lease = await projection().claimOutboundDispatch({
      tenant_id: tenant,
      command_id: original.command.id,
      lease_id: "original_lost",
      now: new Date(Date.now() - 31_000).toISOString(),
      lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(lease.outcome).toBe("acquired");
    const expired = await projection().claimOutboundDispatch({
      tenant_id: tenant,
      command_id: original.command.id,
      lease_id: "must_not_acquire",
      now: new Date(Date.now()).toISOString(),
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(expired.outcome).toBe("not_acquired");
    expect(expired.dispatch.status).toBe("delivery_uncertain");
    const key = crypto.randomUUID();
    const digest = await sha256Hex(
      new TextEncoder().encode(
        canonicalJsonStringify({
          original_command_id: original.command.id,
          original_request_digest: original.dispatch.request_digest,
          idempotency_key: key,
        }),
      ),
    );
    const authority = original.dispatch.authority;
    if (!authority || !original.dispatch.body_digest)
      throw new Error("missing fixture authority");
    const saved = await captureSavedSend(
      context(),
      {
        tenant_id: tenant,
        membership_id: authority.membership_id,
        identity_id: authority.identity_id,
        account_id: original.dispatch.account_id,
        conversation_id: conversation,
        connection_id: original.dispatch.connection_id,
      },
      digest,
    );
    if (saved === undefined) throw new Error("missing saved resend authority");
    const reservation = await reserveOutboundAcceptance(
      runtime.CONTROL_DB.withSession("first-primary"),
      {
        tenant_id: tenant,
        membership_id: authority.membership_id,
        identity_id: authority.identity_id,
        account_id: original.dispatch.account_id,
        conversation_id: conversation,
        connection_id: original.dispatch.connection_id,
        capability: authority.capability,
        saved,
        idempotency_key: `resend_${digest.slice(0, 48)}`,
        request_digest: digest,
        body_digest: original.dispatch.body_digest,
        now: new Date(Date.now()).toISOString(),
      },
    );
    if (reservation.status !== "reserved")
      throw new Error("resend reservation denied");
    const input = {
      schema_version: 1 as const,
      tenant_id: tenant,
      command_id: original.command.id,
      decision: "resend" as const,
      idempotency_key: key,
      actor_principal_id: "principal_human",
      actor_identity_id: authority.identity_id,
      decided_at: new Date(Date.now()).toISOString(),
      connection_available: true,
      duplicate_risk_acknowledged: true,
      resend_authority: {
        ...authority,
        saved,
        reservation_id: reservation.reservation.id,
      },
    };
    await runInDurableObject(projection(), async (instance) => {
      const decide = instance.decideOutbound.bind(instance);
      const lost = vi
        .spyOn(instance, "decideOutbound")
        .mockImplementation(async (value) => {
          await decide(value);
          throw new Error("controlled lost resend response");
        });
      try {
        await expect(instance.decideOutbound(input)).rejects.toThrow(
          "controlled lost resend response",
        );
      } finally {
        lost.mockRestore();
      }
    });
    const resend = (await dispatchRows()).find(
      (row) => row.command_id !== original.command.id,
    );
    expect(resend).toBeDefined();
    const commandId = String(resend?.command_id);
    await evictDurableObject(projection());
    await recover();
    expect(await providerCalls(original.command.id)).toBe(0);
    expect(await providerCalls(commandId)).toBe(1);
    const replay = await projection().decideOutbound(input);
    expect(replay.replayed).toBe(true);
    expect(replay.command.id).toBe(commandId);
    await evictDurableObject(projection());
    await recover();
    expect(await providerCalls(commandId)).toBe(1);
  });

  it.each(["before", "after"] as const)(
    "recovers a saved command interrupted %s real D1 finalization without client replay",
    async (boundary) => {
      const key = crypto.randomUUID();
      const database = runtime.CONTROL_DB.withSession("first-primary");
      const prototype = Object.getPrototypeOf(database);
      const batch = prototype.batch;
      let batches = 0;
      const interrupted = vi
        .spyOn(prototype, "batch")
        .mockImplementation(async function (...args) {
          batches++;
          if (batches === 2) {
            if (boundary === "after") await batch.apply(this, args);
            throw new Error("controlled finalization interruption");
          }
          return batch.apply(this, args);
        });
      try {
        await expect(accept(key)).rejects.toThrow();
      } finally {
        interrupted.mockRestore();
      }
      const intent = await runtime.CONTROL_DB.prepare(
        "SELECT id, status FROM outbound_acceptance_intents WHERE tenant_id = ? AND idempotency_key = ?",
      )
        .bind(tenant, key)
        .first();
      expect(intent?.status).toBe(
        boundary === "before" ? "reserved" : "committed",
      );
      const saved = await dispatchRows();
      const commandId = String(saved[0]?.command_id);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.status).toBe("pending");
      expect(await providerCalls(commandId)).toBe(0);
      await evictDurableObject(projection());
      await recover();
      expect(await dispatchRows()).toMatchObject([
        { status: "dispatched", recovery_attempts: 1 },
      ]);
      expect(await providerCalls(commandId)).toBe(1);
      const repaired = await runtime.CONTROL_DB.prepare(
        "SELECT status, command_id, dispatch_id, message_id, transaction_id FROM outbound_acceptance_intents WHERE id = ?",
      )
        .bind(intent?.id)
        .first();
      const replay = await accept(key);
      expect(replay.replayed).toBe(true);
      expect(repaired).toEqual({
        status: "committed",
        command_id: commandId,
        dispatch_id: replay.dispatch.id,
        message_id: replay.message.id,
        transaction_id: replay.dispatch.transaction_id,
      });
      await evictDurableObject(projection());
      await recover(false);
      expect(await providerCalls(commandId)).toBe(1);
    },
  );

  it("recovers after a committed save loses its response, without a request session", async () => {
    await expect(
      acceptTextReply(
        context(),
        {
          identity_id: "identity_agent",
          conversation_id: conversation,
          body: "Controlled recovery fixture",
          delivery_mode: "direct",
        },
        crypto.randomUUID(),
        {
          afterCommit: () => {
            throw new Error("controlled response loss");
          },
        },
      ),
    ).rejects.toThrow();
    const saved = await dispatchRows();
    const commandId = String(saved[0]?.command_id);
    await evictDurableObject(projection());
    await recover();
    expect(await providerCalls(commandId)).toBe(1);
    expect((await dispatchRows())[0]?.authority_saved).toBe(
      saved[0]?.authority_saved,
    );
  });

  it.each(["acquisition", "outcome"] as const)(
    "fences a crash after %s across repeated alarms and eviction",
    async (boundary) => {
      const accepted = await accept();
      await enableRecovery();
      await runInDurableObject(projection(), async (instance, state) => {
        const interrupted =
          boundary === "acquisition"
            ? vi
                .spyOn(instance, "getOutboundDispatchPayload")
                .mockRejectedValue(new Error("controlled owner interruption"))
            : vi
                .spyOn(instance, "reconcileOutbound")
                .mockRejectedValue(new Error("controlled owner interruption"));
        try {
          await state.storage.deleteAlarm();
          await expect(instance.alarm()).rejects.toThrow(
            "controlled owner interruption",
          );
        } finally {
          interrupted.mockRestore();
        }
      });
      expect((await dispatchRows())[0]?.status).toBe("dispatching");
      const calls = boundary === "acquisition" ? 0 : 1;
      expect(await providerCalls(accepted.command.id)).toBe(calls);
      const now = Date.now();
      for (const offset of [31_000, 91_000, 151_000]) {
        vi.spyOn(Date, "now").mockReturnValue(now + offset);
        await evictDurableObject(projection());
        await recover();
        expect((await dispatchRows())[0]?.status).toBe("delivery_uncertain");
        expect(await providerCalls(accepted.command.id)).toBe(calls);
      }
    },
  );

  it("never repeats a controlled POST whose result was lost", async () => {
    const accepted = await accept();
    loseProviderResponse = true;
    await evictDurableObject(projection());
    await recover();
    expect((await dispatchRows())[0]?.status).toBe("delivery_uncertain");
    for (let pass = 0; pass < 3; pass++) {
      await evictDurableObject(projection());
      await recover();
      expect(await providerCalls(accepted.command.id)).toBe(1);
    }
  });

  it("captures idempotently after response loss, persists through DO eviction, and sends only once", async () => {
    const key = crypto.randomUUID();
    loseCaptureResponse = true;
    await expect(accept(key)).rejects.toThrow();
    const savedBefore = await runtime.TEST_PLATFORM_DB.prepare(
      "SELECT id FROM platform_saved_operation WHERE credential_id = ?",
    )
      .bind(fixture.actor.credentialId)
      .all();
    expect(savedBefore.results).toHaveLength(1);
    const accepted = await accept(key);
    expect(accepted.dispatch.authority?.saved?.platform.id).toBe(
      savedBefore.results[0]?.id,
    );
    expect(JSON.stringify(accepted)).not.toContain(fixture.actor.credential);
    await evictDurableObject(projection());
    expect(await execute(accepted.command.id, true)).toMatchObject({
      calls: 1,
      result: { type: "evidence_batch" },
    });
    expect((await accept(key)).replayed).toBe(true);
    expect(
      (
        await runtime.TEST_PLATFORM_DB.prepare(
          "SELECT id FROM platform_saved_operation WHERE credential_id = ?",
        )
          .bind(fixture.actor.credentialId)
          .all()
      ).results,
    ).toHaveLength(1);
  });

  it("caps the final claim at the originating credential expiry", async () => {
    const accepted = await accept();
    const expiry = Date.now() + 10_000;
    await runtime.TEST_PLATFORM_DB.prepare(
      "UPDATE platform_credential SET expires_at = ? WHERE id = ?",
    )
      .bind(expiry, fixture.actor.credentialId)
      .run();
    expect((await execute(accepted.command.id)).calls).toBe(1);
    const claim = await runtime.CONTROL_DB.prepare(
      "SELECT expires_at FROM outbound_dispatch_claims WHERE command_id = ?",
    )
      .bind(accepted.command.id)
      .first<{ expires_at: string }>();
    expect(claim?.expires_at).toBe(new Date(expiry).toISOString());
  });

  it.each(["route", "session", "capability", "operation", "tenant"] as const)(
    "rejects gateway %s rebinding without provider I/O",
    async (field) => {
      const accepted = await accept();
      tamperGatewayRequest = (value) => {
        if (field === "route")
          value.route.bridge_instance_id = "rebound_bridge";
        if (field === "session")
          value.session_generation = "2026-11-07T00:00:00.000Z";
        if (field === "capability")
          value.capability = {
            kind: "account_grant",
            grant_id: "grant_other",
            authorization_epoch: 1,
          };
        if (field === "operation") value.request_digest = "f".repeat(64);
        if (field === "tenant") value.tenant_id = "tenant_other";
      };
      expect((await execute(accepted.command.id)).calls).toBe(0);
    },
  );

  it.each(["legacy", "expired", "malformed", "uncertain"] as const)(
    "bootstrap preserves %s work and never replays it through repaired alarms",
    async (kind) => {
      const accepted = await accept();
      const due = Date.now() + 60_000;
      vi.spyOn(Date, "now").mockReturnValue(due);
      await runInDurableObject(projection(), async (_instance, state) => {
        if (kind === "legacy") {
          state.storage.sql.exec(
            "UPDATE outbound_dispatches SET authority_saved = NULL",
          );
        } else if (kind === "uncertain") {
          state.storage.sql.exec(
            "UPDATE outbound_dispatches SET status = 'delivery_uncertain', chat_paused = 1",
          );
        } else {
          state.storage.sql.exec(
            "UPDATE outbound_dispatches SET status = 'dispatching', dispatch_lease_id = 'historical_lease', dispatch_lease_expires_at = ?",
            kind === "malformed"
              ? "not-a-time"
              : new Date(due - 1).toISOString(),
          );
        }
        await state.storage.deleteAlarm();
      });
      const before = await dispatchRows();
      await runDormantTenantBootstrapTick(environment);
      expect(await dispatchRows()).toEqual(before);
      expect(await providerCalls(accepted.command.id)).toBe(0);
      await recover();
      expect(await dispatchRows()).toMatchObject([
        { status: kind === "legacy" ? "pending" : "delivery_uncertain" },
      ]);
      await evictDurableObject(projection());
      await recover(false);
      expect(await providerCalls(accepted.command.id)).toBe(0);
    },
  );

  it("refuses legacy authority and prevents replacing persisted capture metadata", async () => {
    const accepted = await accept();
    await expect(
      runtime.CONTROL_DB.prepare(
        "UPDATE outbound_acceptance_intents SET saved_authority = NULL",
      ).run(),
    ).rejects.toThrow("immutable");
    await runInDurableObject(projection(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE outbound_dispatches SET authority_saved = NULL WHERE command_id = ?",
        accepted.command.id,
      );
    });
    expect(await execute(accepted.command.id)).toMatchObject({
      calls: 0,
      result: { type: "failure", failure_code: "authorization_revoked" },
    });
  });

  const mutations = [
    [
      "Platform credential revocation",
      "platform",
      "UPDATE platform_credential SET revoked_at = 1 WHERE id = ?",
      "credentialId",
    ],
    [
      "Platform credential expiry",
      "platform",
      "UPDATE platform_credential SET expires_at = 1 WHERE id = ?",
      "credentialId",
    ],
    [
      "Platform grant revocation",
      "platform",
      "UPDATE platform_agent_grant SET revoked_at = 1 WHERE id = ?",
      "grantId",
    ],
    [
      "Platform actor disabled",
      "platform",
      "UPDATE platform_agent SET enabled = 0 WHERE id = ?",
      "agentId",
    ],
    [
      "local binding revocation",
      "control",
      "UPDATE platform_bindings SET status = 'revoked', revoked_at = '2026-11-07T00:00:00.000Z' WHERE binding_id = 'binding_saved_agent'",
    ],
    [
      "membership revocation",
      "control",
      "UPDATE memberships SET status = 'revoked' WHERE id = 'membership_agent'",
    ],
    [
      "identity revocation",
      "control",
      "UPDATE identities SET status = 'revoked' WHERE id = 'identity_agent'",
    ],
    [
      "grant epoch rotation",
      "control",
      "UPDATE account_grants SET authorization_epoch = authorization_epoch + 1 WHERE id = 'grant_saved_send'",
    ],
    [
      "chat grant narrowing",
      "control",
      "UPDATE account_grants SET chat_scope = 'selected_chats' WHERE id = 'grant_saved_send'",
    ],
    [
      "identity scope removal",
      "control",
      "DELETE FROM identity_grants WHERE membership_id = 'membership_agent' AND operation_scope = 'message.send'",
    ],
    [
      "account detachment",
      "control",
      "UPDATE connection_accounts SET status = 'retired', retired_at = '2026-11-07T00:00:00.000Z' WHERE account_id = 'account_human'",
    ],
    [
      "route disabled",
      "control",
      "UPDATE gateway_routes SET status = 'revoked', revoked_at = '2026-11-07T00:00:00.000Z' WHERE id = 'gateway_route_human'",
    ],
    [
      "route generation rotation",
      "control",
      "UPDATE connection_routes SET updated_at = '2026-11-07T00:00:00.000Z' WHERE connection_id = 'connection_human_whatsapp'",
    ],
    [
      "session rotation",
      "control",
      "UPDATE connections SET updated_at = '2026-11-07T00:00:00.000Z' WHERE id = 'connection_human_whatsapp'",
    ],
    [
      "provider capability withdrawal",
      "control",
      "DELETE FROM connection_capabilities WHERE connection_id = 'connection_human_whatsapp' AND capability = 'message.send'",
    ],
  ] as const;
  it.each(mutations)(
    "makes zero provider calls after %s",
    async (_label, database, sql, field?) => {
      const accepted = await accept();
      await evictDurableObject(projection());
      const statement = (
        database === "platform" ? runtime.TEST_PLATFORM_DB : runtime.CONTROL_DB
      ).prepare(sql);
      await (field === undefined
        ? statement
        : statement.bind(fixture.actor[field])
      ).run();
      expect(await execute(accepted.command.id)).toMatchObject({
        calls: 0,
        result: { type: "failure" },
      });
    },
  );

  it("rechecks local state atomically after awaited Platform revalidation", async () => {
    const accepted = await accept();
    afterRevalidation = async () => {
      await runtime.CONTROL_DB.prepare(
        "UPDATE connection_routes SET updated_at = '2026-11-07T00:00:00.000Z' WHERE connection_id = 'connection_human_whatsapp'",
      ).run();
    };
    expect(await execute(accepted.command.id)).toMatchObject({
      calls: 0,
      result: { type: "failure", failure_code: "authorization_revoked" },
    });
  });

  it("denies a final-boundary revocation and defers only explicit pre-claim unavailability", async () => {
    const accepted = await accept();
    beforeClaim = async () => {
      await runtime.TEST_PLATFORM_DB.prepare(
        "UPDATE platform_credential SET revoked_at = 1 WHERE id = ?",
      )
        .bind(fixture.actor.credentialId)
        .run();
    };
    expect(await execute(accepted.command.id)).toMatchObject({
      calls: 0,
      result: { type: "failure", failure_code: "authorization_revoked" },
    });
  });

  it("keeps pre-I/O authority_unavailable pending, unpaused and without a consumed D1 claim", async () => {
    const gateway = adapter();
    beforeClaim = async () => {
      unavailable = true;
    };
    const accepted = await accept(
      crypto.randomUUID(),
      gateway.dispatch.bind(gateway),
    );
    expect(accepted.command.status).toBe("accepted");
    expect(accepted.command.failure_code).toBe("authority_unavailable");
    expect(accepted.dispatch.status).toBe("pending");
    expect(accepted.dispatch.chat_paused).toBe(false);
    expect(
      (
        await runtime.CONTROL_DB.prepare(
          "SELECT id FROM outbound_dispatch_claims",
        ).all()
      ).results,
    ).toHaveLength(0);
    unavailable = false;
    expect(await execute(accepted.command.id)).toMatchObject({ calls: 1 });
  });
});
