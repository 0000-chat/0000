import { createPlatformClient } from "@0000/platform-client";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrNarrowAgentGrant,
  revokeAgentCredential,
  rotateAgentCredential,
} from "../../src/agent-state";
import { opaqueSecret } from "../../src/platform-state";
import { updateServiceMetadata } from "../../src/service-registration";
import { authenticateCredential } from "../../src/worker";
import { handleResourceRequest } from "./fixtures/resource-service";
import { registerTestService, type TestService } from "./fixtures/provision";

const testEnv = env as Cloudflare.Env;
const mutableEnv = testEnv as unknown as Record<string, string>;
let googleIdentity = {
  subject: "platform-t05-owner",
  name: "T05 Owner",
  email: "t05-owner@example.test",
};

function cookiesFrom(...responses: Response[]): string {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    const values = response.headers.getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];
    for (const value of values) {
      const pair = value.split(";")[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) cookies.set(pair.slice(0, separator), pair);
    }
  }
  return [...cookies.values()].join("; ");
}

async function loginAs(identity: typeof googleIdentity): Promise<{
  id: string;
  email: string;
  cookie: string;
  organizationId: string;
}> {
  googleIdentity = identity;
  const start = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "google",
      callbackURL: "http://localhost/account",
    }),
  });
  const state = new URL(
    ((await start.json()) as { url: string }).url,
  ).searchParams.get("state");
  if (!state) throw new Error("Google state missing");
  const callback = await SELF.fetch(
    `http://localhost/api/auth/callback/google?code=${encodeURIComponent(identity.subject)}&state=${encodeURIComponent(state)}`,
    {
      headers: {
        cookie: cookiesFrom(start),
        origin: testEnv.PLATFORM_BASE_URL,
      },
      redirect: "manual",
    },
  );
  const cookie = cookiesFrom(start, callback);
  const user = await testEnv.IDENTITY_DB.prepare(
    'SELECT id, email FROM "user" WHERE email = ?',
  )
    .bind(identity.email)
    .first<{ id: string; email: string }>();
  if (!user) throw new Error("user missing after login");
  const me = await SELF.fetch("http://localhost/api/me", {
    headers: { cookie },
  });
  const organization = (await me.json()) as { organizationId: string };
  return { ...user, cookie, organizationId: organization.organizationId };
}

async function post(
  path: string,
  cookie: string,
  body: unknown,
  origin: string = testEnv.PLATFORM_BASE_URL,
) {
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function client(service: TestService) {
  return createPlatformClient({
    baseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: service.audience,
    serviceVerifier: service.verifier,
    fetch: (input, init) => SELF.fetch(input, init),
  });
}

function agentService(service: TestService) {
  return {
    serviceId: service.serviceId,
    audience: service.audience,
    verifierHash: "test-agent-verifier-hash",
    allowedCapabilities: service.allowedCapabilities,
  };
}

async function fixtureRead(
  service: TestService,
  credential: string,
  resourceId: string,
): Promise<Response> {
  return handleResourceRequest(
    new Request(`http://fixture.test/resources/${resourceId}`, {
      headers: { authorization: `Bearer ${credential}` },
    }),
    {
      database: testEnv.IDENTITY_DB,
      platformBaseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      guestGrantIssuer: service.guestGrantIssuer,
      fetch: (input, init) => SELF.fetch(input, init),
    },
  );
}

type NarrowingRace = {
  currentReads: number;
  releaseReads: () => void;
  readsReady: Promise<void>;
  firstUpdateDone: Promise<void>;
  markFirstUpdate: () => void;
};

function createNarrowingRace(): NarrowingRace {
  let releaseReads!: () => void;
  let markFirstUpdate!: () => void;
  return {
    currentReads: 0,
    releaseReads: () => releaseReads(),
    readsReady: new Promise<void>((resolve) => {
      releaseReads = resolve;
    }),
    firstUpdateDone: new Promise<void>((resolve) => {
      markFirstUpdate = resolve;
    }),
    markFirstUpdate: () => markFirstUpdate(),
  };
}

function interleavedNarrowingDatabase(
  database: D1Database,
  role: "first" | "second",
  race: NarrowingRace,
): D1DatabaseSession {
  const wrapStatement = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const isCurrentGrantSelect =
      query.includes("SELECT id, agent_id") &&
      query.includes("FROM platform_agent_grant") &&
      query.includes("platform_agent.organization_id");
    const isGrantUpdate =
      query.includes("UPDATE platform_agent_grant") &&
      query.includes("SET capabilities =");
    return {
      bind: (...values: unknown[]) =>
        wrapStatement(statement.bind(...values), query),
      first: async <T = Record<string, unknown>>(columnName?: string) => {
        const result =
          columnName === undefined
            ? await statement.first<T>()
            : await statement.first<T>(columnName);
        if (isCurrentGrantSelect) {
          race.currentReads += 1;
          if (race.currentReads === 2) race.releaseReads();
          await race.readsReady;
        }
        return result;
      },
      run: async <T = Record<string, unknown>>() => {
        if (isGrantUpdate && role === "second") {
          await race.firstUpdateDone;
        }
        const result = await statement.run<T>();
        if (isGrantUpdate && role === "first") race.markFirstUpdate();
        return result;
      },
      all: <T = Record<string, unknown>>() => statement.all<T>(),
      raw: <T = unknown[]>(options?: { columnNames?: boolean }) =>
        statement.raw<T>(options as never),
    } as unknown as D1PreparedStatement;
  };
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query), query);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as D1DatabaseSession;
}

function interleavedCredentialReadDatabase(
  database: D1Database,
  afterCredentialRead: () => Promise<void>,
): D1Database {
  let callbackComplete = false;
  const wrapStatement = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const isCredentialLookup = query.includes(
      "FROM platform_credential WHERE credential_hash = ?",
    );
    return {
      bind: (...values: unknown[]) =>
        wrapStatement(statement.bind(...values), query),
      first: async <T = Record<string, unknown>>(columnName?: string) => {
        const result =
          columnName === undefined
            ? await statement.first<T>()
            : await statement.first<T>(columnName);
        if (isCredentialLookup && result && !callbackComplete) {
          callbackComplete = true;
          await afterCredentialRead();
        }
        return result;
      },
      run: <T = Record<string, unknown>>() => statement.run<T>(),
      all: <T = Record<string, unknown>>() => statement.all<T>(),
      raw: <T = unknown[]>(options?: { columnNames?: boolean }) =>
        statement.raw<T>(options as never),
    } as unknown as D1PreparedStatement;
  };
  const wrapSession = (session: D1DatabaseSession): D1DatabaseSession =>
    new Proxy(session, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => wrapStatement(target.prepare(query), query);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as D1DatabaseSession;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "withSession") {
        return (constraint: string) =>
          wrapSession(target.withSession(constraint as never));
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as D1Database;
}

async function inviteAndAccept(
  owner: Awaited<ReturnType<typeof loginAs>>,
  member: Awaited<ReturnType<typeof loginAs>>,
  organizationId: string,
  role: "owner" | "admin" | "member",
): Promise<string> {
  const invitation = await post(
    "/api/account/invitations/create",
    owner.cookie,
    {
      organizationId,
      email: member.email,
      role,
    },
  );
  expect(invitation.status, await invitation.clone().text()).toBe(201);
  const invitationId = ((await invitation.json()) as { id: string }).id;
  const accepted = await post(
    "/api/account/invitations/accept",
    member.cookie,
    {
      invitationId,
    },
  );
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  const membership = await testEnv.IDENTITY_DB.prepare(
    "SELECT id FROM member WHERE organizationId = ? AND userId = ?",
  )
    .bind(organizationId, member.id)
    .first<{ id: string }>();
  if (!membership) throw new Error("membership missing");
  return membership.id;
}

describe("T05 organization-owned agents", () => {
  beforeEach(() => {
    googleIdentity = {
      subject: "platform-t05-owner",
      name: "T05 Owner",
      email: "t05-owner@example.test",
    };
    mutableEnv.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS = "90";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (
          url.hostname === "oauth2.googleapis.com" &&
          url.pathname === "/token"
        ) {
          const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
          const claims = btoa(
            JSON.stringify({
              iss: "https://accounts.google.com",
              aud: "platform-t02-google-client",
              sub: googleIdentity.subject,
              email: googleIdentity.email,
              email_verified: true,
              name: googleIdentity.name,
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          )
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
          return Response.json({
            access_token: "platform-t05-provider-token",
            expires_in: 3600,
            id_token: `${header}.${claims}.synthetic-signature`,
            token_type: "Bearer",
          });
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });

  it("keeps a stable agent across audiences and creator departure", async () => {
    const owner = await loginAs({
      subject: "platform-t05-owner-main",
      name: "T05 Owner",
      email: "t05-owner-main@example.test",
    });
    const first: TestService = {
      serviceId: "t05-agent-one",
      audience: "https://agent-one.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read", "resource:write"],
    };
    const second: TestService = {
      serviceId: "t05-agent-two",
      audience: "https://agent-two.0000.test/mcp",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    await registerTestService(testEnv.IDENTITY_DB, first);
    await registerTestService(testEnv.IDENTITY_DB, second);

    const created = await post("/api/account/agents", owner.cookie, {
      organizationId: owner.organizationId,
      name: "<automation>",
      forgedCreatorId: "attacker",
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const agent = (await created.json()) as { id: string };
    expect(agent.id).toBeTruthy();

    const grantOne = await post("/api/account/agents/grants", owner.cookie, {
      organizationId: owner.organizationId,
      agentId: agent.id,
      serviceId: first.serviceId,
      capabilities: ["resource:read", "resource:write"],
    });
    const grantTwo = await post("/api/account/agents/grants", owner.cookie, {
      organizationId: owner.organizationId,
      agentId: agent.id,
      serviceId: second.serviceId,
      capabilities: ["resource:read"],
    });
    expect(grantOne.status, await grantOne.clone().text()).toBe(201);
    expect(grantTwo.status, await grantTwo.clone().text()).toBe(201);
    const firstGrant = (await grantOne.json()) as { id: string };
    const secondGrant = (await grantTwo.json()) as { id: string };
    const firstResourceId = "t05-agent-resource-one";
    const secondResourceId = "t05-agent-resource-two";
    const foreignResourceId = "t05-agent-resource-foreign";
    await testEnv.IDENTITY_DB.prepare(
      "INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at, audience) VALUES (?, 'organization', ?, ?, ?), (?, 'organization', ?, ?, ?), (?, 'organization', ?, ?, ?)",
    )
      .bind(
        firstResourceId,
        owner.organizationId,
        Date.now(),
        first.audience,
        secondResourceId,
        owner.organizationId,
        Date.now(),
        second.audience,
        foreignResourceId,
        "org-foreign-owner",
        Date.now(),
        first.audience,
      )
      .run();
    const excessiveGrant = await post(
      "/api/account/agents/grants",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        serviceId: second.serviceId,
        capabilities: ["resource:write"],
      },
    );
    expect(excessiveGrant.status).toBe(400);

    const issuedOne = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: firstGrant.id,
        serviceId: first.serviceId,
        capabilities: ["resource:read", "resource:write"],
        name: "Agent first",
      },
    );
    const issuedTwo = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: secondGrant.id,
        serviceId: second.serviceId,
        capabilities: ["resource:read"],
        name: "Agent second",
      },
    );
    expect(issuedOne.status, await issuedOne.clone().text()).toBe(201);
    expect(issuedTwo.status, await issuedTwo.clone().text()).toBe(201);
    const excessiveCredential = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: secondGrant.id,
        serviceId: second.serviceId,
        capabilities: ["resource:write"],
      },
    );
    expect(excessiveCredential.status).toBe(403);
    const firstCredential = (await issuedOne.json()) as {
      credential: string;
      credentialId: string;
    };
    const secondCredential = (await issuedTwo.json()) as {
      credential: string;
      credentialId: string;
    };
    const firstAuth = await client(first).authenticate(
      firstCredential.credential,
    );
    const secondAuth = await client(second).authenticate(
      secondCredential.credential,
    );
    expect(firstAuth.status).toBe("authenticated");
    expect(secondAuth.status).toBe("authenticated");
    if (
      firstAuth.status === "authenticated" &&
      secondAuth.status === "authenticated" &&
      firstAuth.principal.kind === "agent" &&
      secondAuth.principal.kind === "agent"
    ) {
      expect(firstAuth.principal.kind).toBe("agent");
      expect(firstAuth.principal.subjectId).toBe(
        secondAuth.principal.subjectId,
      );
      expect(firstAuth.principal.grantId).not.toBe(
        secondAuth.principal.grantId,
      );
      expect(firstAuth.principal.capabilities).toEqual([
        "resource:read",
        "resource:write",
      ]);
    }
    expect(
      (await client(second).authenticate(firstCredential.credential)).status,
    ).toBe("invalid_credential");

    const writeOnlyIssued = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: firstGrant.id,
        serviceId: first.serviceId,
        capabilities: ["resource:write"],
        name: "Agent write only",
      },
    );
    expect(writeOnlyIssued.status, await writeOnlyIssued.clone().text()).toBe(
      201,
    );
    const writeOnlyCredential = (await writeOnlyIssued.json()) as {
      credential: string;
    };
    expect(
      (
        await fixtureRead(
          first,
          writeOnlyCredential.credential,
          firstResourceId,
        )
      ).status,
    ).toBe(403);

    const narrowingRace = createNarrowingRace();
    const firstNarrowing = createOrNarrowAgentGrant(
      interleavedNarrowingDatabase(testEnv.IDENTITY_DB, "first", narrowingRace),
      {
        actorUserId: owner.id,
        organizationId: owner.organizationId,
        agentId: agent.id,
        service: agentService(first),
        capabilities: ["resource:read"],
      },
    );
    const secondNarrowing = createOrNarrowAgentGrant(
      interleavedNarrowingDatabase(
        testEnv.IDENTITY_DB,
        "second",
        narrowingRace,
      ),
      {
        actorUserId: owner.id,
        organizationId: owner.organizationId,
        agentId: agent.id,
        service: agentService(first),
        capabilities: ["resource:write"],
      },
    );
    const [firstNarrowingResult, secondNarrowingResult] = await Promise.all([
      firstNarrowing,
      secondNarrowing,
    ]);
    expect(firstNarrowingResult.status).toBe("narrowed");
    expect(secondNarrowingResult.status).toBe("conflict");
    expect(
      (await client(first).authenticate(writeOnlyCredential.credential)).status,
    ).toBe("invalid_credential");

    const firstReadIssued = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: firstGrant.id,
        serviceId: first.serviceId,
        capabilities: ["resource:read"],
        name: "Agent first read",
      },
    );
    expect(firstReadIssued.status, await firstReadIssued.clone().text()).toBe(
      201,
    );
    const firstReadCredential = (await firstReadIssued.json()) as {
      credential: string;
      credentialId: string;
    };
    expect(
      (await client(first).authenticate(firstReadCredential.credential)).status,
    ).toBe("authenticated");
    expect(
      (await client(first).authenticate(firstCredential.credential)).status,
    ).toBe("invalid_credential");
    const agentRaceIssued = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: firstGrant.id,
        serviceId: first.serviceId,
        capabilities: ["resource:read"],
        name: "Agent verification race",
      },
    );
    expect(agentRaceIssued.status, await agentRaceIssued.clone().text()).toBe(
      201,
    );
    const agentRaceCredential = (await agentRaceIssued.json()) as {
      credential: string;
      credentialId: string;
    };
    let agentRaceInitialRead = false;
    const agentRaceDatabase = interleavedCredentialReadDatabase(
      testEnv.IDENTITY_DB,
      async () => {
        agentRaceInitialRead = true;
        await testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_agent SET enabled = 0 WHERE id = ? AND organization_id = ?",
        )
          .bind(agent.id, owner.organizationId)
          .run();
        expect(
          await revokeAgentCredential(
            testEnv.IDENTITY_DB.withSession("first-primary"),
            {
              actorUserId: owner.id,
              organizationId: owner.organizationId,
              agentId: agent.id,
              credentialId: agentRaceCredential.credentialId,
            },
          ),
        ).toBe(true);
        await testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_agent SET enabled = 1 WHERE id = ? AND organization_id = ?",
        )
          .bind(agent.id, owner.organizationId)
          .run();
      },
    );
    const agentRaceAuthentication = await authenticateCredential(
      new Request("http://localhost/internal/v1/authenticate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${first.verifier}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ credential: agentRaceCredential.credential }),
      }),
      { ...testEnv, IDENTITY_DB: agentRaceDatabase } as Cloudflare.Env,
    );
    expect(agentRaceInitialRead).toBe(true);
    expect(agentRaceAuthentication.status).toBe(401);
    expect(await agentRaceAuthentication.json()).toEqual({
      status: "invalid_credential",
    });

    const humanRaceIssued = await post("/api/credentials", owner.cookie, {
      organizationId: owner.organizationId,
      serviceId: first.serviceId,
      capabilities: ["resource:read"],
      name: "Human verification race",
    });
    expect(humanRaceIssued.status, await humanRaceIssued.clone().text()).toBe(
      201,
    );
    const humanRaceCredential = (await humanRaceIssued.json()) as {
      credential: string;
      credentialId: string;
    };
    let humanRaceInitialRead = false;
    const humanRaceDatabase = interleavedCredentialReadDatabase(
      testEnv.IDENTITY_DB,
      async () => {
        humanRaceInitialRead = true;
        const suspendedAt = Date.now();
        await testEnv.IDENTITY_DB.prepare(
          "UPDATE organization SET suspendedAt = ? WHERE id = ?",
        )
          .bind(suspendedAt, owner.organizationId)
          .run();
        await testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_credential SET revoked_at = ?, revoked_reason = 't05_verification_race' WHERE id = ? AND revoked_at IS NULL",
        )
          .bind(suspendedAt, humanRaceCredential.credentialId)
          .run();
        await testEnv.IDENTITY_DB.prepare(
          "UPDATE organization SET suspendedAt = NULL WHERE id = ?",
        )
          .bind(owner.organizationId)
          .run();
      },
    );
    const humanRaceAuthentication = await authenticateCredential(
      new Request("http://localhost/internal/v1/authenticate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${first.verifier}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ credential: humanRaceCredential.credential }),
      }),
      { ...testEnv, IDENTITY_DB: humanRaceDatabase } as Cloudflare.Env,
    );
    expect(humanRaceInitialRead).toBe(true);
    expect(humanRaceAuthentication.status).toBe(401);
    expect(await humanRaceAuthentication.json()).toEqual({
      status: "invalid_credential",
    });

    expect(
      (
        await fixtureRead(
          first,
          firstReadCredential.credential,
          firstResourceId,
        )
      ).status,
    ).toBe(200);
    expect(
      (await fixtureRead(second, secondCredential.credential, secondResourceId))
        .status,
    ).toBe(200);
    expect(
      (
        await fixtureRead(
          second,
          firstReadCredential.credential,
          secondResourceId,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await fixtureRead(
          first,
          firstReadCredential.credential,
          foreignResourceId,
        )
      ).status,
    ).toBe(404);
    const widened = await post("/api/account/agents/grants", owner.cookie, {
      organizationId: owner.organizationId,
      agentId: agent.id,
      serviceId: first.serviceId,
      capabilities: ["resource:read", "resource:write"],
    });
    expect(widened.status).toBe(409);

    const disabled = await post("/api/account/agents/lifecycle", owner.cookie, {
      organizationId: owner.organizationId,
      agentId: agent.id,
      action: "disable",
    });
    expect(disabled.status).toBe(200);
    expect(
      (await client(second).authenticate(secondCredential.credential)).status,
    ).toBe("invalid_credential");
    const restored = await post("/api/account/agents/lifecycle", owner.cookie, {
      organizationId: owner.organizationId,
      agentId: agent.id,
      action: "restore",
    });
    expect(restored.status).toBe(200);
    expect(
      (await client(second).authenticate(secondCredential.credential)).status,
    ).toBe("authenticated");
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), owner.organizationId)
      .run();
    expect(
      (await client(second).authenticate(secondCredential.credential)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = NULL WHERE id = ?",
    )
      .bind(owner.organizationId)
      .run();
    expect(
      (await client(second).authenticate(secondCredential.credential)).status,
    ).toBe("authenticated");

    const rotate = () =>
      post("/api/account/agents/credentials/rotate", owner.cookie, {
        organizationId: owner.organizationId,
        agentId: agent.id,
        credentialId: secondCredential.credentialId,
      });
    const rotations = await Promise.all([rotate(), rotate()]);
    expect(rotations.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const replacementResponse = rotations.find(
      (response) => response.status === 201,
    );
    if (!replacementResponse) throw new Error("agent rotation winner missing");
    const replacement = (await replacementResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    expect(
      (await client(second).authenticate(secondCredential.credential)).status,
    ).toBe("invalid_credential");
    expect(
      (await client(second).authenticate(replacement.credential)).status,
    ).toBe("authenticated");
    const revokeReplacement = await post(
      "/api/account/agents/credentials/revoke",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        credentialId: replacement.credentialId,
      },
    );
    expect(revokeReplacement.status).toBe(200);
    expect(
      (
        await post("/api/account/agents/credentials/revoke", owner.cookie, {
          organizationId: owner.organizationId,
          agentId: agent.id,
          credentialId: replacement.credentialId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await client(second).authenticate(replacement.credential)).status,
    ).toBe("invalid_credential");

    const revokedGrant = await post(
      "/api/account/agents/grants/revoke",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: secondGrant.id,
      },
    );
    expect(revokedGrant.status).toBe(200);
    const reauthorized = await post(
      "/api/account/agents/grants",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        serviceId: second.serviceId,
        capabilities: ["resource:read"],
      },
    );
    expect(reauthorized.status).toBe(201);
    const replacementGrant = (await reauthorized.json()) as { id: string };
    expect(replacementGrant.id).not.toBe(secondGrant.id);
    const reissued = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: replacementGrant.id,
        serviceId: second.serviceId,
        capabilities: ["resource:read"],
      },
    );
    expect(reissued.status, await reissued.clone().text()).toBe(201);
    const reissuedBody = (await reissued.json()) as { credential: string };
    expect(
      (await client(second).authenticate(reissuedBody.credential)).status,
    ).toBe("authenticated");

    mutableEnv.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS = "not-a-duration";
    const invalidConfigIssue = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: replacementGrant.id,
        serviceId: second.serviceId,
        capabilities: ["resource:read"],
      },
    );
    expect(invalidConfigIssue.status).toBe(503);
    const listedWithInvalidConfig = await SELF.fetch(
      `http://localhost/api/account/agents/credentials?organizationId=${encodeURIComponent(owner.organizationId)}&agentId=${encodeURIComponent(agent.id)}`,
      { headers: { cookie: owner.cookie } },
    );
    expect(listedWithInvalidConfig.status).toBe(200);
    const listedCredentials = (await listedWithInvalidConfig.json()) as {
      credentials: Array<{ id: string; revokedAt: string | null }>;
    };
    const activeCredentialId = listedCredentials.credentials.find(
      (credential) => !credential.revokedAt,
    )?.id;
    if (!activeCredentialId) throw new Error("active agent credential missing");
    const invalidConfigRotate = await post(
      "/api/account/agents/credentials/rotate",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        credentialId: activeCredentialId,
      },
    );
    expect(invalidConfigRotate.status).toBe(503);
    const revokeWithInvalidConfig = await post(
      "/api/account/agents/credentials/revoke",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        credentialId: activeCredentialId,
      },
    );
    expect(revokeWithInvalidConfig.status).toBe(200);
    mutableEnv.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS = "90";

    const catalogCredentialResponse = await post(
      "/api/account/agents/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: replacementGrant.id,
        serviceId: second.serviceId,
        capabilities: ["resource:read"],
      },
    );
    expect(catalogCredentialResponse.status).toBe(201);
    const catalogCredential = (await catalogCredentialResponse.json()) as {
      credential: string;
    };

    const rotationFailureTrigger = "t05_agent_rotation_insert_failure";
    const predecessorLiteral = firstReadCredential.credentialId.replaceAll(
      "'",
      "''",
    );
    await testEnv.IDENTITY_DB.prepare(
      `DROP TRIGGER IF EXISTS ${rotationFailureTrigger}`,
    ).run();
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER ${rotationFailureTrigger}
       BEFORE INSERT ON platform_credential
       WHEN NEW.kind = 'agent'
         AND NEW.predecessor_id = '${predecessorLiteral}'
       BEGIN
         SELECT RAISE(ABORT, 'injected replacement insert failure');
       END`,
    ).run();
    let rotationFailureObserved = false;
    try {
      await rotateAgentCredential(testEnv.IDENTITY_DB, {
        actorUserId: owner.id,
        service: agentService(first),
        organizationId: owner.organizationId,
        agentId: agent.id,
        grantId: firstGrant.id,
        credentialId: firstReadCredential.credentialId,
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
      });
    } catch {
      rotationFailureObserved = true;
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        `DROP TRIGGER IF EXISTS ${rotationFailureTrigger}`,
      ).run();
    }
    expect(rotationFailureObserved).toBe(true);
    const rolledBackPredecessor = await testEnv.IDENTITY_DB.prepare(
      "SELECT revoked_at, replaced_by_id FROM platform_credential WHERE id = ?",
    )
      .bind(firstReadCredential.credentialId)
      .first<{ revoked_at: number | null; replaced_by_id: string | null }>();
    expect(rolledBackPredecessor).toEqual({
      revoked_at: null,
      replaced_by_id: null,
    });
    const replacementRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_credential WHERE predecessor_id = ?",
    )
      .bind(firstReadCredential.credentialId)
      .first<{ count: number }>();
    expect(replacementRows?.count).toBe(0);
    expect(
      (await client(first).authenticate(firstReadCredential.credential)).status,
    ).toBe("authenticated");

    await updateServiceMetadata(testEnv.IDENTITY_DB, {
      serviceId: second.serviceId,
      capabilities: ["resource:write"],
      displayName: "Narrowed agent audience",
    });
    expect(
      (await client(second).authenticate(catalogCredential.credential)).status,
    ).toBe("invalid_credential");
    await updateServiceMetadata(testEnv.IDENTITY_DB, {
      serviceId: second.serviceId,
      capabilities: ["resource:read", "resource:write"],
      displayName: "Expanded agent audience",
    });
    expect(
      (await client(second).authenticate(catalogCredential.credential)).status,
    ).toBe("authenticated");

    const admin = await loginAs({
      subject: "platform-t05-admin",
      name: "T05 Admin",
      email: "t05-admin@example.test",
    });
    const adminMembershipId = await inviteAndAccept(
      owner,
      admin,
      owner.organizationId,
      "admin",
    );
    const promote = await post("/api/account/members/role", owner.cookie, {
      organizationId: owner.organizationId,
      membershipId: adminMembershipId,
      role: "owner",
    });
    expect(promote.status).toBe(200);
    const left = await post("/api/account/members/leave", owner.cookie, {
      organizationId: owner.organizationId,
    });
    expect(left.status).toBe(200);
    expect(
      (
        await fixtureRead(
          first,
          firstReadCredential.credential,
          firstResourceId,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fixtureRead(
          second,
          catalogCredential.credential,
          secondResourceId,
        )
      ).status,
    ).toBe(200);
    const ownerAgentList = await SELF.fetch(
      `http://localhost/api/account/agents?organizationId=${encodeURIComponent(owner.organizationId)}`,
      { headers: { cookie: owner.cookie } },
    );
    expect(ownerAgentList.status).toBe(404);
    const adminAgentList = await SELF.fetch(
      `http://localhost/api/account/agents?organizationId=${encodeURIComponent(owner.organizationId)}`,
      { headers: { cookie: admin.cookie } },
    );
    expect(adminAgentList.status).toBe(200);
    const adminAgents = (await adminAgentList.json()) as {
      agents: Array<{ id: string; name: string }>;
    };
    expect(
      adminAgents.agents.find((candidate) => candidate.id === agent.id)?.name,
    ).toBe("<automation>");
    const renamed = await post("/api/account/agents/update", admin.cookie, {
      organizationId: owner.organizationId,
      agentId: agent.id,
      name: "Managed by the successor",
    });
    expect(renamed.status).toBe(200);
  });

  it("denies non-managers, foreign tenants, machines, and untrusted mutations", async () => {
    const owner = await loginAs({
      subject: "platform-t05-boundary-owner",
      name: "Boundary owner",
      email: "t05-boundary-owner@example.test",
    });
    const member = await loginAs({
      subject: "platform-t05-boundary-member",
      name: "Boundary member",
      email: "t05-boundary-member@example.test",
    });
    await inviteAndAccept(owner, member, owner.organizationId, "member");
    const agent = await post("/api/account/agents", owner.cookie, {
      organizationId: owner.organizationId,
      name: "Boundary agent",
    });
    expect(agent.status).toBe(201);
    const agentId = ((await agent.json()) as { id: string }).id;
    expect(
      (
        await SELF.fetch(
          `http://localhost/api/account/agents?organizationId=${encodeURIComponent(owner.organizationId)}`,
          { headers: { cookie: member.cookie } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/api/account/agents/lifecycle", member.cookie, {
          organizationId: owner.organizationId,
          agentId,
          action: "disable",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          "/api/account/agents/lifecycle",
          owner.cookie,
          { organizationId: owner.organizationId, agentId, action: "disable" },
          "https://attacker.example",
        )
      ).status,
    ).toBe(403);
    const foreign = await loginAs({
      subject: "platform-t05-boundary-foreign",
      name: "Foreign",
      email: "t05-boundary-foreign@example.test",
    });
    expect(
      (
        await post("/api/account/agents/update", foreign.cookie, {
          organizationId: owner.organizationId,
          agentId,
          name: "stolen",
        })
      ).status,
    ).toBe(404);
    const machine = await SELF.fetch("http://localhost/api/account/agents", {
      method: "POST",
      headers: {
        origin: testEnv.PLATFORM_BASE_URL,
        authorization: "Bearer machine-bearer",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organizationId: owner.organizationId,
        name: "machine",
      }),
    });
    expect(machine.status).toBe(401);
  });
});
