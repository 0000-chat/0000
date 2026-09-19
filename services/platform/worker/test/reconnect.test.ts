import { createPlatformClient } from "@0000/platform-client";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { opaqueSecret } from "../../src/platform-state";
import { registerTestService, type TestService } from "./fixtures/provision";
import {
  handleReconnectRead,
  handleReconnectWrite,
  ReconnectFixtureClient,
  type ReconnectPayload,
  type ReconnectServiceConfig,
} from "./fixtures/reconnect-service";

const testEnv = env as Cloudflare.Env;
const mutableTestEnv = testEnv as unknown as Record<string, string>;

interface GithubIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

interface HumanSession {
  id: string;
  email: string;
  cookie: string;
  defaultOrganizationId: string;
  defaultMembershipId: string;
}

interface StoredResource {
  id: string;
  organization_id: string;
  payload: string;
  revision: number;
}

let githubIdentity: GithubIdentity = {
  id: 814001,
  login: "platform-t14-owner",
  name: "T14 Owner",
  email: "t14-owner@example.test",
};

function cookiesFrom(...responses: Response[]): string {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    const all = response.headers.getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];
    for (const cookie of all) {
      const pair = cookie.split(";")[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) {
        cookies.set(pair.slice(0, separator), pair);
      }
    }
  }
  return [...cookies.values()].join("; ");
}

async function loginAs(identity: GithubIdentity): Promise<HumanSession> {
  githubIdentity = identity;
  const started = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "github",
      callbackURL: "http://localhost/account",
    }),
  });
  expect(started.status).toBe(200);
  const state = new URL(
    ((await started.clone().json()) as { url: string }).url,
  ).searchParams.get("state");
  expect(state).toBeTruthy();
  const callback = await SELF.fetch(
    `http://localhost/api/auth/callback/github?code=${encodeURIComponent(identity.login)}&state=${encodeURIComponent(state!)}`,
    {
      headers: {
        cookie: cookiesFrom(started),
        origin: testEnv.PLATFORM_BASE_URL,
      },
      redirect: "manual",
    },
  );
  expect(callback.status).toBe(302);
  const cookie = cookiesFrom(started, callback);
  const sessionResponse = await SELF.fetch(
    "http://localhost/api/auth/get-session",
    { headers: { cookie, origin: testEnv.PLATFORM_BASE_URL } },
  );
  expect(sessionResponse.status).toBe(200);
  const session = (await sessionResponse.json()) as {
    user?: { id: string; email: string };
    session?: { id: string };
  };
  expect(session.user?.email).toBe(identity.email);
  expect(session.session?.id).toBeTruthy();
  const me = await SELF.fetch("http://localhost/api/me", {
    headers: { cookie },
  });
  expect(me.status).toBe(200);
  const organization = (await me.json()) as {
    organizationId: string;
    membershipId: string;
  };
  return {
    id: session.user!.id,
    email: identity.email,
    cookie,
    defaultOrganizationId: organization.organizationId,
    defaultMembershipId: organization.membershipId,
  };
}

async function signOut(cookie: string): Promise<void> {
  const response = await SELF.fetch("http://localhost/api/auth/sign-out", {
    method: "POST",
    headers: {
      cookie,
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({ disableRedirect: true }),
  });
  expect(response.status).toBe(200);
}

async function post(
  path: string,
  cookie: string,
  body: unknown,
): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: {
      cookie,
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function issueCredential(
  session: HumanSession,
  serviceId: string,
  organizationId: string,
): Promise<Response> {
  return post("/api/credentials", session.cookie, {
    serviceId,
    organizationId,
    capabilities: ["resource:write"],
  });
}

async function memberId(
  organizationId: string,
  userId: string,
): Promise<string> {
  const member = await testEnv.IDENTITY_DB.prepare(
    "SELECT id FROM member WHERE organizationId = ? AND userId = ?",
  )
    .bind(organizationId, userId)
    .first<{ id: string }>();
  if (!member) throw new Error("T14 member row is missing");
  return member.id;
}

async function insertResources(
  resources: Array<{
    id: string;
    organizationId: string;
    payload: string;
  }>,
  audience: string,
): Promise<void> {
  for (const resource of resources) {
    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO fixture_reconnect_resource
         (id, organization_id, audience, payload, revision, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
      .bind(
        resource.id,
        resource.organizationId,
        audience,
        resource.payload,
        Date.now(),
      )
      .run();
  }
}

async function storedResource(resourceId: string): Promise<StoredResource> {
  const stored = await testEnv.IDENTITY_DB.prepare(
    `SELECT id, organization_id, payload, revision
     FROM fixture_reconnect_resource WHERE id = ?`,
  )
    .bind(resourceId)
    .first<StoredResource>();
  if (!stored) throw new Error(`T14 resource ${resourceId} is missing`);
  return stored;
}

function fixtureConfig(
  service: TestService,
  overrides: Partial<ReconnectServiceConfig> = {},
): ReconnectServiceConfig {
  return {
    database: testEnv.IDENTITY_DB,
    platformBaseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: service.audience,
    serviceVerifier: service.verifier,
    fetch: (input, init) => SELF.fetch(input, init),
    ...overrides,
  };
}

function resourceRequest(resourceId: string, credential: string): Request {
  return new Request(`http://fixture.test/reconnect/${resourceId}`, {
    headers: { authorization: `Bearer ${credential}` },
  });
}

function writeRequest(payload: ReconnectPayload, credential: string): Request {
  return new Request("http://fixture.test/reconnect/write", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function transport(
  service: TestService,
  overrides: Partial<ReconnectServiceConfig> = {},
): ReconnectServiceConfig & {
  submit: (credential: string, payload: ReconnectPayload) => Promise<Response>;
  preflight: (
    credential: string,
    payload: ReconnectPayload,
  ) => Promise<Response>;
} {
  const config = fixtureConfig(service, overrides);
  return {
    ...config,
    preflight: (credential, payload) =>
      handleReconnectRead(
        resourceRequest(payload.resourceId, credential),
        config,
      ),
    submit: (credential, payload) =>
      handleReconnectWrite(writeRequest(payload, credential), config),
  };
}

function submitOnlyTransport(
  service: TestService,
  overrides: Partial<ReconnectServiceConfig> = {},
): {
  submit: (credential: string, payload: ReconnectPayload) => Promise<Response>;
} {
  const config = fixtureConfig(service, overrides);
  return {
    submit: (credential, payload) =>
      handleReconnectWrite(writeRequest(payload, credential), config),
  };
}

describe("T14 reconnect proof fixture", () => {
  beforeEach(() => {
    githubIdentity = {
      id: 814001,
      login: "platform-t14-owner",
      name: "T14 Owner",
      email: "t14-owner@example.test",
    };
    mutableTestEnv.PLATFORM_DEPLOYMENT_MODE = "self-hosted";
    mutableTestEnv.PLATFORM_SIGNUP_POLICY = "open";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (
          url.hostname === "github.com" &&
          url.pathname === "/login/oauth/access_token"
        ) {
          return Response.json({
            access_token: "platform-t14-provider-token",
            token_type: "bearer",
            scope: "read:user user:email",
          });
        }
        if (url.hostname === "api.github.com" && url.pathname === "/user") {
          return Response.json({
            id: githubIdentity.id,
            login: githubIdentity.login,
            name: githubIdentity.name,
            avatar_url: null,
          });
        }
        if (
          url.hostname === "api.github.com" &&
          url.pathname === "/user/emails"
        ) {
          return Response.json([
            {
              email: githubIdentity.email,
              primary: true,
              verified: true,
            },
          ]);
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });

  it("reconnects through current auth, retains denied work, and checks ACL at apply", async () => {
    const ownerIdentity: GithubIdentity = {
      id: 814001,
      login: "platform-t14-owner",
      name: "T14 Owner",
      email: "t14-owner@example.test",
    };
    const memberIdentity: GithubIdentity = {
      id: 814002,
      login: "platform-t14-member",
      name: "T14 Member",
      email: "t14-member@example.test",
    };
    const owner = await loginAs(ownerIdentity);
    const service: TestService = {
      serviceId: "platform-t14-reconnect-service",
      audience: "https://reconnect.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:write"],
    };
    await registerTestService(testEnv.IDENTITY_DB, service);

    const organizationResponse = await post(
      "/api/account/organizations/create",
      owner.cookie,
      { name: "T14 reconnect organization" },
    );
    expect(organizationResponse.status).toBe(201);
    const organization = (await organizationResponse.json()) as {
      organizationId: string;
      membershipId: string;
    };

    const member = await loginAs(memberIdentity);
    const invitationResponse = await post(
      "/api/account/invitations/create",
      owner.cookie,
      {
        organizationId: organization.organizationId,
        email: member.email,
        role: "member",
        actorId: "forged-actor",
        actorRole: "owner",
      },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { id: string };
    const accepted = await post(
      "/api/account/invitations/accept",
      member.cookie,
      {
        invitationId: invitation.id,
        organizationId: "forged-organization",
        role: "owner",
      },
    );
    expect(accepted.status).toBe(200);
    const memberOrganizationMembershipId = await memberId(
      organization.organizationId,
      member.id,
    );
    expect(memberOrganizationMembershipId).toBeTruthy();

    const ownerCredentialResponse = await issueCredential(
      owner,
      service.serviceId,
      organization.organizationId,
    );
    expect(ownerCredentialResponse.status).toBe(201);
    const ownerCredential = (await ownerCredentialResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    const revokedCredentialResponse = await issueCredential(
      owner,
      service.serviceId,
      organization.organizationId,
    );
    expect(revokedCredentialResponse.status).toBe(201);
    const revokedCredential = (await revokedCredentialResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    const memberCredentialResponse = await issueCredential(
      member,
      service.serviceId,
      organization.organizationId,
    );
    expect(memberCredentialResponse.status).toBe(201);
    const memberCredential = (await memberCredentialResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    const foreignCredentialResponse = await issueCredential(
      member,
      service.serviceId,
      member.defaultOrganizationId,
    );
    expect(foreignCredentialResponse.status).toBe(201);
    const foreignCredential = (await foreignCredentialResponse.json()) as {
      credential: string;
      credentialId: string;
    };

    await insertResources(
      [
        {
          id: "t14-success",
          organizationId: organization.organizationId,
          payload: "offline-success-before",
        },
        {
          id: "t14-acl",
          organizationId: organization.organizationId,
          payload: "acl-before",
        },
        {
          id: "t14-foreign-owner",
          organizationId: member.defaultOrganizationId,
          payload: "foreign-before",
        },
        {
          id: "t14-revoked",
          organizationId: organization.organizationId,
          payload: "revoked-before",
        },
        {
          id: "t14-removed-member",
          organizationId: organization.organizationId,
          payload: "membership-before",
        },
        {
          id: "t14-outage",
          organizationId: organization.organizationId,
          payload: "outage-before",
        },
        {
          id: "t14-race",
          organizationId: organization.organizationId,
          payload: "race-before",
        },
      ],
      service.audience,
    );

    const ownerClient = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      fetch: (input, init) => SELF.fetch(input, init),
    });
    expect(
      (await ownerClient.authenticate(ownerCredential.credential)).status,
    ).toBe("authenticated");

    const queuedBeforeReconnect = new ReconnectFixtureClient();
    queuedBeforeReconnect.enqueue({
      resourceId: "t14-success",
      payload: "offline-success-after",
    });
    queuedBeforeReconnect.enqueue({
      resourceId: "t14-foreign-owner",
      payload: "foreign-should-remain",
    });
    await signOut(owner.cookie);
    const reauthenticatedOwner = await loginAs(ownerIdentity);
    const freshSession = await SELF.fetch(
      "http://localhost/api/auth/get-session",
      {
        headers: {
          cookie: reauthenticatedOwner.cookie,
          origin: testEnv.PLATFORM_BASE_URL,
        },
      },
    );
    expect(freshSession.status).toBe(200);
    const reconnectAttempts = await queuedBeforeReconnect.reconnect(
      ownerCredential.credential,
      transport(service),
    );
    expect(reconnectAttempts).toEqual([
      { resourceId: "t14-success", status: 200, acknowledged: true },
      { resourceId: "t14-foreign-owner", status: 404, acknowledged: false },
    ]);
    expect(queuedBeforeReconnect.pendingPayloads()).toEqual([
      {
        resourceId: "t14-foreign-owner",
        payload: "foreign-should-remain",
      },
    ]);
    expect(await storedResource("t14-success")).toMatchObject({
      organization_id: organization.organizationId,
      payload: "offline-success-after",
      revision: 1,
    });
    expect(await storedResource("t14-foreign-owner")).toMatchObject({
      organization_id: member.defaultOrganizationId,
      payload: "foreign-before",
      revision: 0,
    });

    const revokedQueue = new ReconnectFixtureClient();
    revokedQueue.enqueue({
      resourceId: "t14-revoked",
      payload: "revoked-must-remain-local",
    });
    const revoke = await post(
      "/api/credentials/revoke",
      reauthenticatedOwner.cookie,
      {
        credentialId: revokedCredential.credentialId,
        organizationId: organization.organizationId,
      },
    );
    expect(revoke.status).toBe(200);
    const revokedAttempts = await revokedQueue.reconnect(
      revokedCredential.credential,
      submitOnlyTransport(service),
    );
    expect(revokedAttempts).toEqual([
      { resourceId: "t14-revoked", status: 401, acknowledged: false },
    ]);
    expect(revokedQueue.pendingPayloads()).toEqual([
      { resourceId: "t14-revoked", payload: "revoked-must-remain-local" },
    ]);
    expect(await storedResource("t14-revoked")).toMatchObject({
      payload: "revoked-before",
      revision: 0,
    });

    const foreignClient = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      fetch: (input, init) => SELF.fetch(input, init),
    });
    expect(
      (await foreignClient.authenticate(foreignCredential.credential)).status,
    ).toBe("authenticated");
    const aclQueue = new ReconnectFixtureClient();
    aclQueue.enqueue({
      resourceId: "t14-acl",
      payload: "cross-org-must-remain-local",
    });
    const aclAttempts = await aclQueue.reconnect(
      foreignCredential.credential,
      submitOnlyTransport(service),
    );
    expect(aclAttempts).toEqual([
      { resourceId: "t14-acl", status: 404, acknowledged: false },
    ]);
    expect(aclQueue.pendingPayloads()).toEqual([
      { resourceId: "t14-acl", payload: "cross-org-must-remain-local" },
    ]);
    expect(await storedResource("t14-acl")).toMatchObject({
      organization_id: organization.organizationId,
      payload: "acl-before",
      revision: 0,
    });

    const outageQueue = new ReconnectFixtureClient();
    outageQueue.enqueue({
      resourceId: "t14-outage",
      payload: "outage-must-remain-local",
    });
    const outageAttempts = await outageQueue.reconnect(
      ownerCredential.credential,
      submitOnlyTransport(service, {
        fetch: async () => {
          throw new Error("controlled authority outage");
        },
      }),
    );
    expect(outageAttempts).toEqual([
      { resourceId: "t14-outage", status: 503, acknowledged: false },
    ]);
    expect(outageQueue.pendingPayloads()).toEqual([
      { resourceId: "t14-outage", payload: "outage-must-remain-local" },
    ]);
    expect(await storedResource("t14-outage")).toMatchObject({
      payload: "outage-before",
      revision: 0,
    });

    const removedMemberQueue = new ReconnectFixtureClient();
    removedMemberQueue.enqueue({
      resourceId: "t14-removed-member",
      payload: "removed-member-must-remain-local",
    });
    const removed = await post(
      "/api/account/members/remove",
      reauthenticatedOwner.cookie,
      {
        organizationId: organization.organizationId,
        membershipId: memberOrganizationMembershipId,
      },
    );
    expect(removed.status).toBe(200);
    expect(
      (await ownerClient.authenticate(memberCredential.credential)).status,
    ).toBe("invalid_credential");
    const removedIssue = await issueCredential(
      member,
      service.serviceId,
      organization.organizationId,
    );
    expect(removedIssue.status).toBe(403);
    await signOut(member.cookie);
    const reestablishedMember = await loginAs(memberIdentity);
    const reestablishedSession = await SELF.fetch(
      "http://localhost/api/auth/get-session",
      {
        headers: {
          cookie: reestablishedMember.cookie,
          origin: testEnv.PLATFORM_BASE_URL,
        },
      },
    );
    expect(reestablishedSession.status).toBe(200);
    const removedAttempts = await removedMemberQueue.reconnect(
      memberCredential.credential,
      submitOnlyTransport(service),
    );
    expect(removedAttempts).toEqual([
      { resourceId: "t14-removed-member", status: 401, acknowledged: false },
    ]);
    expect(removedMemberQueue.pendingPayloads()).toEqual([
      {
        resourceId: "t14-removed-member",
        payload: "removed-member-must-remain-local",
      },
    ]);
    expect(await storedResource("t14-removed-member")).toMatchObject({
      payload: "membership-before",
      revision: 0,
    });

    const raceCredentialResponse = await issueCredential(
      reauthenticatedOwner,
      service.serviceId,
      organization.organizationId,
    );
    expect(raceCredentialResponse.status).toBe(201);
    const raceCredential = (await raceCredentialResponse.json()) as {
      credential: string;
    };
    const raceQueue = new ReconnectFixtureClient();
    raceQueue.enqueue({
      resourceId: "t14-race",
      payload: "race-must-remain-local",
    });
    let preflightStatus = 0;
    let beforeApplyCalled = false;
    const raceConfig = transport(service, {
      beforeApply: async ({ resourceId }) => {
        beforeApplyCalled = true;
        await testEnv.IDENTITY_DB.prepare(
          "UPDATE fixture_reconnect_resource SET organization_id = ? WHERE id = ?",
        )
          .bind(reestablishedMember.defaultOrganizationId, resourceId)
          .run();
      },
    });
    const raceAttempts = await raceQueue.reconnect(raceCredential.credential, {
      preflight: async (credential, payload) => {
        const response = await raceConfig.preflight(credential, payload);
        preflightStatus = response.status;
        return response;
      },
      submit: raceConfig.submit,
    });
    expect(preflightStatus).toBe(200);
    expect(beforeApplyCalled).toBe(true);
    expect(raceAttempts).toEqual([
      { resourceId: "t14-race", status: 403, acknowledged: false },
    ]);
    expect(raceQueue.pendingPayloads()).toEqual([
      { resourceId: "t14-race", payload: "race-must-remain-local" },
    ]);
    expect(await storedResource("t14-race")).toMatchObject({
      organization_id: reestablishedMember.defaultOrganizationId,
      payload: "race-before",
      revision: 0,
    });
  });
});
