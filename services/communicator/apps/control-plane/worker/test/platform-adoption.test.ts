import { Hono } from "hono";
import { env as runtimeEnv, evictDurableObject } from "cloudflare:test";
import {
  REALTIME_SUBPROTOCOL,
  RealtimeTicketResponseSchema,
  type ApplyProjectionBatchInput,
  type ProjectionAuthorizationContext,
  type ProjectionConnectionBinding,
  type ProjectionEventEnvelope,
  type RealtimeTicketRequest,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { createPlatformAuthenticator } from "../auth/platform";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };

const platformAuthority = "platform-test-authority";
const platformAudience = "communicator-test-audience";
const platformVerifier = "communicator-service-verifier";
const platformBaseUrl = "https://platform.test";
const expiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();

type FixturePrincipal = {
  version: 1;
  authority: string;
  audience: string;
  kind: "human" | "agent" | "service";
  subjectId: string;
  credentialId: string;
  capabilities: string[];
  expiresAt: string;
  organizationId: string;
  membershipId?: string;
  grantId?: string;
};

function principal(
  subjectId: string,
  overrides: Partial<FixturePrincipal> = {},
): FixturePrincipal {
  return {
    version: 1,
    authority: platformAuthority,
    audience: platformAudience,
    kind: "human",
    subjectId,
    credentialId: `credential-${subjectId}`,
    capabilities: ["conversation.read", "message.send"],
    expiresAt,
    organizationId: "platform-org",
    membershipId: "platform-membership",
    ...overrides,
  };
}

function machinePrincipal(
  kind: "agent" | "service",
  subjectId: string,
  grantId: string,
  capabilities: string[],
): FixturePrincipal {
  return {
    version: 1,
    authority: platformAuthority,
    audience: platformAudience,
    kind,
    subjectId,
    credentialId: `credential-${subjectId}`,
    capabilities,
    expiresAt,
    organizationId: "platform-org",
    grantId,
  };
}

function createPlatformFixture() {
  const authority = new Hono();
  let humanCredentialRevoked = false;
  authority.post("/internal/v1/authenticate", async (context) => {
    if (context.req.header("authorization") !== `Bearer ${platformVerifier}`) {
      return context.json({ status: "authority_unavailable" }, 503);
    }
    const body = (await context.req.json().catch(() => null)) as {
      credential?: unknown;
    } | null;
    if (body?.credential === "platform-human" && humanCredentialRevoked) {
      return context.json({ status: "invalid_credential" }, 401);
    }
    if (body?.credential === "platform-human") {
      return context.json({
        status: "authenticated",
        principal: principal("platform-user"),
      });
    }
    if (body?.credential === "platform-admin") {
      return context.json({
        status: "authenticated",
        principal: principal("platform-user", {
          capabilities: [
            "conversation.read",
            "message.send",
            "directory.read",
            "directory.manage",
          ],
        }),
      });
    }
    if (body?.credential === "platform-browser-credential") {
      return context.json({
        status: "authenticated",
        principal: principal("platform-user"),
      });
    }
    if (body?.credential === "platform-agent") {
      return context.json({
        status: "authenticated",
        principal: machinePrincipal(
          "agent",
          "platform-agent",
          "platform-agent-grant",
          ["conversation.read"],
        ),
      });
    }
    if (body?.credential === "platform-service") {
      return context.json({
        status: "authenticated",
        principal: machinePrincipal(
          "service",
          "platform-service",
          "platform-service-grant",
          ["ingestion.write", "outbound.claim"],
        ),
      });
    }
    if (body?.credential === "platform-revoked") {
      return context.json({ status: "invalid_credential" }, 401);
    }
    if (body?.credential === "platform-unbound") {
      return context.json({
        status: "authenticated",
        principal: principal("unbound-user"),
      });
    }
    if (body?.credential === "platform-wrong-authority") {
      return context.json({
        status: "authenticated",
        principal: principal("platform-user", {
          authority: "another-authority",
        }),
      });
    }
    return context.json({ status: "invalid_credential" }, 401);
  });

  const fetcher: typeof fetch = async (input, init) =>
    authority.fetch(
      input instanceof Request ? input : new Request(input, init),
    );
  const app = createApp({
    createPlatformAuthenticator: (runtime) =>
      createPlatformAuthenticator(runtime, fetcher),
  });
  return {
    app,
    authority,
    revokeHumanCredential: () => {
      humanCredentialRevoked = true;
    },
  };
}

function platformEnvironment(): Cloudflare.Env {
  const requestEnv = Object.create(env) as Cloudflare.Env &
    Record<string, unknown>;
  Object.defineProperties(requestEnv, {
    COMMUNICATOR_PLATFORM_BASE_URL: {
      enumerable: true,
      value: platformBaseUrl,
    },
    COMMUNICATOR_PLATFORM_AUTHORITY: {
      enumerable: true,
      value: platformAuthority,
    },
    COMMUNICATOR_PLATFORM_AUDIENCE: {
      enumerable: true,
      value: platformAudience,
    },
    COMMUNICATOR_PLATFORM_SERVICE_VERIFIER: {
      enumerable: true,
      value: platformVerifier,
    },
  });
  return requestEnv;
}

function realtimeEnvironment(calls: Request[]): Cloudflare.Env {
  const requestEnv = platformEnvironment() as Cloudflare.Env &
    Record<string, unknown>;
  const namespace = {
    getByName(tenantId: string) {
      expect(tenantId).toBe("tenant_pilot");
      return {
        fetch: async (request: Request) => {
          calls.push(request);
          return {
            status: 101,
            headers: new Headers({
              "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
            }),
          } as Response;
        },
      };
    },
  };
  Object.defineProperty(requestEnv, "TENANT_PROJECTION", {
    configurable: true,
    enumerable: true,
    value: namespace,
  });
  return requestEnv as Cloudflare.Env;
}

function browserEnvironment(): Cloudflare.Env {
  const requestEnv = platformEnvironment() as Cloudflare.Env &
    Record<string, unknown>;
  Object.defineProperties(requestEnv, {
    COMMUNICATOR_PLATFORM_BROWSER_CLIENT_ID: {
      enumerable: true,
      value: "communicator-browser-client",
    },
    COMMUNICATOR_PLATFORM_BROWSER_CLIENT_SECRET: {
      enumerable: true,
      value: "communicator-browser-secret",
    },
    COMMUNICATOR_PLATFORM_BROWSER_REDIRECT_URI: {
      enumerable: true,
      value: "https://communicator.test/auth/callback",
    },
    COMMUNICATOR_PLATFORM_BROWSER_RESOURCE: {
      enumerable: true,
      value: "https://communicator.test",
    },
    COMMUNICATOR_PLATFORM_BROWSER_SCOPES: {
      enumerable: true,
      value: "conversation.read message.send",
    },
  });
  return requestEnv;
}

async function seedPlatformBinding() {
  await seedDirectory(env.CONTROL_DB);
  const timestamp = new Date().toISOString();
  await env.CONTROL_DB.prepare(
    `INSERT INTO platform_bindings (
       binding_id,
       platform_authority,
       platform_kind,
       platform_subject_id,
       platform_organization_id,
       platform_membership_id,
       platform_grant_id,
       local_tenant_id,
       local_principal_id,
       local_membership_id,
       local_identity_id,
       local_installation_id,
       local_client_id,
       status,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(
      "binding_platform_human",
      platformAuthority,
      "human",
      "platform-user",
      "platform-org",
      "platform-membership",
      null,
      "tenant_pilot",
      "principal_human",
      "membership_human",
      "identity_human",
      null,
      null,
      timestamp,
      timestamp,
    )
    .run();
}

async function seedPlatformMachineBindings() {
  const timestamp = new Date().toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    ).bind(
      "principal_service",
      "https://platform.test/",
      "platform-service",
      "service",
      "Platform service",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)",
    ).bind(
      "membership_service",
      "tenant_pilot",
      "principal_service",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO platform_bindings (
         binding_id, platform_authority, platform_kind, platform_subject_id,
         platform_organization_id, platform_membership_id, platform_grant_id,
         local_tenant_id, local_principal_id, local_membership_id,
         local_identity_id, local_installation_id, local_client_id, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(
      "binding_platform_agent",
      platformAuthority,
      "agent",
      "platform-agent",
      "platform-org",
      null,
      "platform-agent-grant",
      "tenant_pilot",
      "principal_agent",
      "membership_agent",
      "identity_agent",
      null,
      null,
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO platform_bindings (
         binding_id, platform_authority, platform_kind, platform_subject_id,
         platform_organization_id, platform_membership_id, platform_grant_id,
         local_tenant_id, local_principal_id, local_membership_id,
         local_identity_id, local_installation_id, local_client_id, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(
      "binding_platform_service",
      platformAuthority,
      "service",
      "platform-service",
      "platform-org",
      null,
      "platform-service-grant",
      "tenant_pilot",
      "principal_service",
      "membership_service",
      null,
      null,
      null,
      timestamp,
      timestamp,
    ),
  ]);
}

async function seedUnboundHumanAccount() {
  const timestamp = new Date().toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB
      .prepare(
        "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      )
      .bind(
        "gateway_route_human_secondary",
        "principal_operator",
        timestamp,
        timestamp,
      ),
    env.CONTROL_DB
      .prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, 'whatsapp', ?, 'ready', ?, ?)",
      )
      .bind(
        "connection_human_secondary",
        "tenant_pilot",
        "identity_human",
        "Human secondary WhatsApp",
        timestamp,
        timestamp,
      ),
    env.CONTROL_DB
      .prepare(
        "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "connection_human_secondary",
        "gateway_route_human_secondary",
        "bridge-human-secondary",
        "route-user-human-secondary",
        "route-room-human-secondary",
        timestamp,
        timestamp,
      ),
    env.CONTROL_DB
      .prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      )
      .bind(
        "account_human_secondary",
        "connection_human_secondary",
        timestamp,
        timestamp,
      ),
  ]);
}

const platformProjectionAuthorization = (
  scopes: ProjectionAuthorizationContext["scopes"],
): ProjectionAuthorizationContext => ({
  schema_version: 1,
  tenant_id: "tenant_pilot",
  principal_id: "principal_human",
  allowed_identity_ids: ["identity_human"],
  scopes: [...scopes].sort() as ProjectionAuthorizationContext["scopes"],
});

const platformProjectionBindings: ProjectionConnectionBinding[] = [
  {
    account_id: "account_human",
    connection_id: "connection_human_whatsapp",
    identity_id: "identity_human",
    platform: "whatsapp",
  },
  {
    account_id: "account_human_secondary",
    connection_id: "connection_human_secondary",
    identity_id: "identity_human",
    platform: "whatsapp",
  },
];

const platformProjectionEvent = (
  suffix: string,
  accountId: string,
  connectionId: string,
  conversationId: string,
): ProjectionEventEnvelope => ({
  schema_version: 1,
  event_id: `$platform_realtime_${suffix}:example`,
  event_type: "conversation.updated",
  event_source: "live",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  platform: "whatsapp",
  account_id: accountId,
  conversation_id: conversationId,
  matrix_room_id: null,
  matrix_event_id: null,
  remote_message_id: null,
  occurred_at: new Date(
    Date.now() - (suffix.startsWith("a") ? 4_000 : 3_000),
  ).toISOString(),
  observed_at: new Date(
    Date.now() - (suffix.startsWith("a") ? 2_000 : 1_000),
  ).toISOString(),
  payload: {
    title: `Platform realtime ${suffix}`,
    archived: false,
    muted: false,
  },
});

const platformProjectionBatch = (
  events: ProjectionEventEnvelope[],
  connections: ProjectionConnectionBinding[] = platformProjectionBindings,
): ApplyProjectionBatchInput => ({
  schema_version: 1,
  tenant_id: "tenant_pilot",
  authorization: platformProjectionAuthorization(["projection.write"]),
  mode: "live",
  rebuild_id: null,
  connections,
  events,
  checkpoint: null,
});

async function initializePlatformProjection() {
  const projection = env.TENANT_PROJECTION.getByName("tenant_pilot");
  await projection.initialize({
    schema_version: 1,
    tenant_id: "tenant_pilot",
    initialized_at: new Date().toISOString(),
    authorization: platformProjectionAuthorization(["projection.initialize"]),
  });
  return projection;
}

function installPlatformDurableObjectAuthority(authority: Hono) {
  const runtime = env as unknown as Record<string, unknown>;
  const previous = {
    baseUrl: runtime.COMMUNICATOR_PLATFORM_BASE_URL,
    authority: runtime.COMMUNICATOR_PLATFORM_AUTHORITY,
    audience: runtime.COMMUNICATOR_PLATFORM_AUDIENCE,
    verifier: runtime.COMMUNICATOR_PLATFORM_SERVICE_VERIFIER,
  };
  runtime.COMMUNICATOR_PLATFORM_BASE_URL = platformBaseUrl;
  runtime.COMMUNICATOR_PLATFORM_AUTHORITY = platformAuthority;
  runtime.COMMUNICATOR_PLATFORM_AUDIENCE = platformAudience;
  runtime.COMMUNICATOR_PLATFORM_SERVICE_VERIFIER = platformVerifier;
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.url.startsWith(platformBaseUrl)) {
        return authority.fetch(request);
      }
      return originalFetch(input, init);
    });
  return () => {
    fetchSpy.mockRestore();
    runtime.COMMUNICATOR_PLATFORM_BASE_URL = previous.baseUrl;
    runtime.COMMUNICATOR_PLATFORM_AUTHORITY = previous.authority;
    runtime.COMMUNICATOR_PLATFORM_AUDIENCE = previous.audience;
    runtime.COMMUNICATOR_PLATFORM_SERVICE_VERIFIER = previous.verifier;
  };
}

async function receiveRealtimeFrames(
  socket: WebSocket,
  expectedCount: number,
): Promise<unknown[]> {
  const frames: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expectedCount} frames`)),
      5_000,
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      frames.push(JSON.parse(event.data) as unknown);
      if (frames.length >= expectedCount) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return frames;
}

function waitForRealtimeClose(socket: WebSocket): Promise<number> {
  if (socket.readyState === 3) return Promise.resolve(1000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for realtime socket close")),
      5_000,
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve((event as CloseEvent).code);
      },
      { once: true },
    );
  });
}

async function request(
  app: ReturnType<typeof createApp>,
  credential: string,
  path: string,
  requestEnv = platformEnvironment(),
) {
  return app.request(
    `https://communicator.test${path}`,
    { headers: { Authorization: `Bearer ${credential}` } },
    requestEnv,
  );
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedPlatformBinding();
});

describe("Platform to Communicator adoption boundary", () => {
  it("verifies through the Platform HTTP contract and resolves one immutable local binding", async () => {
    const { app } = createPlatformFixture();
    const response = await request(app, "platform-human", "/api/v1/session");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      binding_id: "binding_platform_human",
      tenant: { id: "tenant_pilot" },
      principal: { id: "principal_human", type: "human" },
      membership: { id: "membership_human", role: "owner" },
      identities: [
        {
          identity_id: "identity_human",
          scopes: ["conversation.read", "message.send"],
        },
      ],
    });
  });

  it("resolves explicitly provisioned agent and service bindings without changing their local kinds", async () => {
    await seedPlatformMachineBindings();
    const { app } = createPlatformFixture();

    const agent = await request(app, "platform-agent", "/api/v1/session");
    expect(agent.status).toBe(200);
    expect(await agent.json()).toMatchObject({
      binding_id: "binding_platform_agent",
      principal: { id: "principal_agent", type: "agent" },
      membership: { id: "membership_agent", role: "member" },
      identities: [
        { identity_id: "identity_agent", scopes: ["conversation.read"] },
      ],
    });

    const service = await request(app, "platform-service", "/api/v1/session");
    expect(service.status).toBe(200);
    expect(await service.json()).toMatchObject({
      binding_id: "binding_platform_service",
      principal: { id: "principal_service", type: "service" },
      membership: { id: "membership_service", role: "member" },
      identities: [],
    });
  });

  it("issues a Platform-bound realtime ticket, forwards only safe context, and rejects a revoked credential", async () => {
    await seedAccountAccess(env.CONTROL_DB);
    const { app } = createPlatformFixture();
    const realtimeRequest: RealtimeTicketRequest = {
      schema_version: 1,
      subscriptions: [
        { identity_id: "identity_human", families: ["projection"] },
      ],
    };
    const ticketResponse = await app.request(
      "https://communicator.test/api/v1/realtime/tickets",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer platform-human",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(realtimeRequest),
      },
      platformEnvironment(),
    );
    expect(ticketResponse.status).toBe(201);
    const issued = RealtimeTicketResponseSchema.parse(
      await ticketResponse.json(),
    );
    const stored = await env.CONTROL_DB.prepare(
      "SELECT platform_json FROM realtime_tickets ORDER BY created_at DESC LIMIT 1",
    ).first<{ platform_json: string | null }>();
    expect(stored?.platform_json).toBeTruthy();
    expect(JSON.parse(stored!.platform_json!)).toMatchObject({
      binding_id: "binding_platform_human",
      subject_id: "platform-user",
      credential_id: "credential-platform-user",
    });
    expect(stored!.platform_json).not.toContain("platform-human");

    const internalRequests: Request[] = [];
    const upgraded = await app.request(
      `https://communicator.test/api/v1/realtime?ticket=${issued.ticket}`,
      {
        headers: {
          Authorization: "Bearer platform-human",
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
        },
      },
      realtimeEnvironment(internalRequests),
    );
    expect(upgraded.status).toBe(101);
    expect(internalRequests).toHaveLength(1);
    expect(
      internalRequests[0]?.headers.get("X-Communicator-Platform-Credential"),
    ).toBe("platform-human");
    expect(
      internalRequests[0]?.headers.get("X-Communicator-Realtime-Context"),
    ).not.toContain("platform-human");

    const revokedTicketResponse = await app.request(
      "https://communicator.test/api/v1/realtime/tickets",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer platform-human",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(realtimeRequest),
      },
      platformEnvironment(),
    );
    const revokedTicket = RealtimeTicketResponseSchema.parse(
      await revokedTicketResponse.json(),
    );
    const revokedUpgrade = await app.request(
      `https://communicator.test/api/v1/realtime?ticket=${revokedTicket.ticket}`,
      {
        headers: {
          Authorization: "Bearer platform-revoked",
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
        },
      },
      realtimeEnvironment([]),
    );
    expect(revokedUpgrade.status).toBe(401);
  });

  it("uses the real Platform-backed DO replay and live account ACL boundary", async () => {
    await seedAccountAccess(env.CONTROL_DB);
    await seedUnboundHumanAccount();
    const projection = await initializePlatformProjection();
    await projection.applyBatch(
      platformProjectionBatch([
        platformProjectionEvent(
          "a_initial",
          "account_human",
          "connection_human_whatsapp",
          "conversation_allowed_initial",
        ),
        platformProjectionEvent(
          "b_initial",
          "account_human_secondary",
          "connection_human_secondary",
          "conversation_denied_initial",
        ),
      ]),
    );

    const { app, authority, revokeHumanCredential } = createPlatformFixture();
    const restoreAuthority = installPlatformDurableObjectAuthority(authority);
    let socket: WebSocket | null = null;
    try {
      const ticketResponse = await app.request(
        "https://communicator.test/api/v1/realtime/tickets",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer platform-human",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            schema_version: 1,
            subscriptions: [
              { identity_id: "identity_human", families: ["projection"] },
            ],
            resume: [
              { identity_id: "identity_human", generation: 1, after_sequence: 0 },
            ],
          } satisfies RealtimeTicketRequest),
        },
        platformEnvironment(),
      );
      expect(ticketResponse.status).toBe(201);
      const issued = RealtimeTicketResponseSchema.parse(
        await ticketResponse.json(),
      );
      const upgrade = await app.request(
        `https://communicator.test/api/v1/realtime?ticket=${issued.ticket}`,
        {
          headers: {
            Authorization: "Bearer platform-human",
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
          },
        },
        platformEnvironment(),
      );
      expect(upgrade.status).toBe(101);
      socket = upgrade.webSocket;
      if (socket === null) throw new Error("missing actual realtime socket");
      const replayFrames = receiveRealtimeFrames(socket, 3);
      socket.accept();
      const replay = await replayFrames;
      expect(replay[0]).toMatchObject({ type: "connected" });
      expect(replay[1]).toMatchObject({
        type: "projection.changes",
        changes: [
          {
            sequence: 1,
            conversation_id: "conversation_allowed_initial",
          },
        ],
      });
      expect(replay[2]).toMatchObject({
        type: "reset_required",
        latest_sequence: 2,
        reason: "history_unavailable",
      });
      expect(JSON.stringify(replay)).not.toContain(
        "conversation_denied_initial",
      );

      const liveFrames = receiveRealtimeFrames(socket, 2);
      await projection.applyBatch(
        platformProjectionBatch([
          platformProjectionEvent(
            "a_live",
            "account_human",
            "connection_human_whatsapp",
            "conversation_allowed_live",
          ),
          platformProjectionEvent(
            "b_live",
            "account_human_secondary",
            "connection_human_secondary",
            "conversation_denied_live",
          ),
        ]),
      );
      const live = await liveFrames;
      expect(live[0]).toMatchObject({
        type: "projection.changes",
        changes: [
          { sequence: 3, conversation_id: "conversation_allowed_live" },
        ],
      });
      expect(live[1]).toMatchObject({
        type: "reset_required",
        latest_sequence: 4,
        reason: "history_unavailable",
      });
      expect(JSON.stringify(live)).not.toContain("conversation_denied_live");

      const hibernatedClose = waitForRealtimeClose(socket);
      await evictDurableObject(projection, { webSockets: "hibernate" });
      await projection.applyBatch(
        platformProjectionBatch([
          platformProjectionEvent(
            "a_after_hibernation",
            "account_human",
            "connection_human_whatsapp",
            "conversation_allowed_after_hibernation",
          ),
        ], [platformProjectionBindings[0]!]),
      );
      expect(await hibernatedClose).toBe(1008);

      const reconnectTicketResponse = await app.request(
        "https://communicator.test/api/v1/realtime/tickets",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer platform-human",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            schema_version: 1,
            subscriptions: [
              { identity_id: "identity_human", families: ["projection"] },
            ],
            resume: [
              { identity_id: "identity_human", generation: 1, after_sequence: 4 },
            ],
          } satisfies RealtimeTicketRequest),
        },
        platformEnvironment(),
      );
      expect(reconnectTicketResponse.status).toBe(201);
      const reconnectTicket = RealtimeTicketResponseSchema.parse(
        await reconnectTicketResponse.json(),
      );
      const reconnectUpgrade = await app.request(
        `https://communicator.test/api/v1/realtime?ticket=${reconnectTicket.ticket}`,
        {
          headers: {
            Authorization: "Bearer platform-human",
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
          },
        },
        platformEnvironment(),
      );
      expect(reconnectUpgrade.status).toBe(101);
      socket = reconnectUpgrade.webSocket;
      if (socket === null) throw new Error("missing hibernation reconnect socket");
      const reconnectFrames = receiveRealtimeFrames(socket, 2);
      socket.accept();
      const reconnected = await reconnectFrames;
      expect(reconnected[0]).toMatchObject({ type: "connected" });
      expect(reconnected[1]).toMatchObject({
        type: "projection.changes",
        changes: [
          {
            sequence: 5,
            conversation_id: "conversation_allowed_after_hibernation",
          },
        ],
      });

      const revokedClose = waitForRealtimeClose(socket);
      revokeHumanCredential();
      await projection.applyBatch(
        platformProjectionBatch([
          platformProjectionEvent(
            "a_after_platform_revocation",
            "account_human",
            "connection_human_whatsapp",
            "conversation_after_platform_revocation",
          ),
        ], [platformProjectionBindings[0]!]),
      );
      expect(await revokedClose).toBe(1008);
      const revokedSession = await request(
        app,
        "platform-human",
        "/api/v1/session",
      );
      expect(revokedSession.status).toBe(401);
    } finally {
      if (socket !== null && socket.readyState !== 3) {
        socket.close(1000, "test complete");
      }
      restoreAuthority();
    }
  });

  it("enforces Platform capability ceilings even for a local owner", async () => {
    const { app } = createPlatformFixture();
    const response = await request(
      app,
      "platform-human",
      "/api/v1/grant-targets",
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Forbidden" },
    });

    const permitted = await request(
      app,
      "platform-admin",
      "/api/v1/grant-targets",
    );
    expect(permitted.status).toBe(200);
  });

  it("returns fixed boundary statuses for invalid, unbound, and incoherent authority results", async () => {
    const { app } = createPlatformFixture();
    const invalid = await request(app, "invalid", "/api/v1/session");
    expect(invalid.status).toBe(401);

    const unbound = await request(app, "platform-unbound", "/api/v1/session");
    expect(unbound.status).toBe(404);
    expect(await unbound.json()).toEqual({
      error: { code: "not_found", message: "Resource not found" },
    });

    const wrongAuthority = await request(
      app,
      "platform-wrong-authority",
      "/api/v1/session",
    );
    expect(wrongAuthority.status).toBe(503);
  });

  it("retires local issuer discovery whenever Platform is configured", async () => {
    const { app } = createPlatformFixture();
    const metadata = await app.request(
      "https://communicator.test/.well-known/oauth-authorization-server",
      {},
      platformEnvironment(),
    );
    expect(metadata.status).toBe(503);
    expect(await metadata.json()).toEqual({
      error: "temporarily_unavailable",
      error_description:
        "Communicator no longer issues local OAuth credentials",
    });
  });

  it("lets an explicit Authorization credential override a stale browser cookie", async () => {
    const { app } = createPlatformFixture();
    const response = await app.request(
      "https://communicator.test/api/v1/session",
      {
        headers: {
          Authorization: "Bearer invalid",
          Cookie: "__Host-0000-access=platform-human",
        },
      },
      platformEnvironment(),
    );
    expect(response.status).toBe(401);

    const cookieOnly = await app.request(
      "https://communicator.test/api/v1/session",
      { headers: { Cookie: "__Host-0000-access=platform-human" } },
      platformEnvironment(),
    );
    expect(cookieOnly.status).toBe(200);
  });

  it("runs the native Worker browser login route with one-use D1 state and HttpOnly redirects", async () => {
    const { app } = createPlatformFixture();
    const tokenRequestBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.pathname === "/api/auth/oauth2/token") {
          if (typeof init?.body === "string") {
            tokenRequestBodies.push(init.body);
          } else if (init?.body instanceof URLSearchParams) {
            tokenRequestBodies.push(init.body.toString());
          }
          return Response.json({
            access_token: "platform-browser-credential",
            token_type: "Bearer",
            expires_in: 900,
          });
        }
        if (url.pathname === "/internal/v1/authenticate") {
          return Response.json({
            status: "authenticated",
            principal: principal("platform-user"),
          });
        }
        throw new Error(`Unexpected browser authority request: ${url}`);
      }),
    );

    try {
      const login = await app.request(
        "https://communicator.test/auth/login?return_to=%2Fconversations",
        {},
        browserEnvironment(),
      );
      expect(login.status).toBe(302);
      const authorization = new URL(login.headers.get("location") ?? "");
      expect(authorization.origin).toBe(platformBaseUrl);
      expect(authorization.pathname).toBe("/api/auth/oauth2/authorize");
      const state = authorization.searchParams.get("state");
      expect(state).toBeTruthy();
      expect(authorization.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]{40,}$/u,
      );
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      const bindingCookie = (login.headers.get("set-cookie") ?? "").split(
        ";",
        1,
      )[0];
      expect(bindingCookie).toMatch(/^__Host-0000-oauth-binding=/u);
      if (!bindingCookie)
        throw new Error("browser login did not set state cookie");
      expect(login.headers.get("set-cookie")).toMatch(
        /; Path=\/; Secure; HttpOnly; SameSite=Lax/u,
      );
      expect(login.headers.get("set-cookie")).not.toContain("Domain=");

      const callback = await app.request(
        `https://communicator.test/auth/callback?code=browser-code&state=${encodeURIComponent(state!)}`,
        {
          headers: { Cookie: bindingCookie },
        },
        browserEnvironment(),
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(
        "https://communicator.test/conversations",
      );
      expect(callback.headers.get("set-cookie")).toContain(
        "__Host-0000-access=platform-browser-credential",
      );
      expect(callback.headers.get("set-cookie")).toContain(
        "__Host-0000-oauth-binding=;",
      );
      expect(callback.headers.get("set-cookie")).toMatch(
        /; Path=\/; Secure; HttpOnly; SameSite=Lax/u,
      );
      expect(callback.headers.get("set-cookie")).not.toContain("Domain=");

      const tokenRequestBody = tokenRequestBodies[0];
      expect(tokenRequestBody).toBeDefined();
      const tokenBody = new URLSearchParams(tokenRequestBody);
      expect(tokenBody.get("grant_type")).toBe("authorization_code");
      expect(tokenBody.get("client_id")).toBe("communicator-browser-client");
      expect(tokenBody.get("client_secret")).toBe(
        "communicator-browser-secret",
      );
      expect(tokenBody.get("redirect_uri")).toBe(
        "https://communicator.test/auth/callback",
      );
      expect(tokenBody.get("resource")).toBe("https://communicator.test");
      expect(tokenBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);

      const accessCookie = (callback.headers.get("set-cookie") ?? "").match(
        /__Host-0000-access=[^;]+/u,
      )?.[0];
      expect(accessCookie).toBeDefined();
      const protectedSession = await app.request(
        "https://communicator.test/api/v1/session",
        { headers: { Cookie: accessCookie! } },
        browserEnvironment(),
      );
      expect(protectedSession.status).toBe(200);
      expect(await protectedSession.json()).toMatchObject({
        binding_id: "binding_platform_human",
      });

      const replay = await app.request(
        `https://communicator.test/auth/callback?code=browser-code&state=${encodeURIComponent(state!)}`,
        {
          headers: { Cookie: bindingCookie },
        },
        browserEnvironment(),
      );
      expect(replay.status).toBe(302);
      expect(
        new URL(replay.headers.get("location") ?? "").searchParams.get(
          "login_error",
        ),
      ).toBe("invalid_state");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
