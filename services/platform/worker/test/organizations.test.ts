import { createPlatformClient } from "@0000/platform-client";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { opaqueSecret } from "../../src/platform-state";
import { registerTestService, type TestService } from "./fixtures/provision";

const testEnv = env as Cloudflare.Env;
const mutableTestEnv = testEnv as unknown as Record<string, string>;
const googleClientId = "platform-t02-google-client";

let googleIdentity = {
  subject: "platform-t03-google-1",
  name: "T03 User",
  email: "t03-user@example.test",
  verified: true,
};

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

function base64Url(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function googleIdToken(): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: googleClientId,
      sub: googleIdentity.subject,
      email: googleIdentity.email,
      email_verified: googleIdentity.verified,
      name: googleIdentity.name,
      picture: null,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${claims}.synthetic-provider-signature`;
}

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

async function loginAs(identity: typeof googleIdentity): Promise<TestUser> {
  googleIdentity = identity;
  const started = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
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
  expect(started.status).toBe(200);
  const { url } = (await started.clone().json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  const callback = await SELF.fetch(
    `http://localhost/api/auth/callback/google?code=${encodeURIComponent(identity.subject)}&state=${encodeURIComponent(state!)}`,
    {
      headers: {
        cookie: cookiesFrom(started),
        origin: testEnv.PLATFORM_BASE_URL,
      },
      redirect: "manual",
    },
  );
  expect(callback.status).toBe(302);
  const user = await testEnv.IDENTITY_DB.prepare(
    'SELECT id, email FROM "user" WHERE email = ?',
  )
    .bind(identity.email)
    .first<{ id: string; email: string }>();
  expect(user).not.toBeNull();
  return { ...user!, cookie: cookiesFrom(started, callback) };
}

function accountRequest(
  path: string,
  options: {
    method?: string;
    cookie?: string;
    body?: unknown;
    origin?: string | null;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? testEnv.PLATFORM_BASE_URL);
  }
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  return SELF.fetch(`http://localhost${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function post(
  path: string,
  cookie: string,
  body: unknown,
  origin?: string | null,
): Promise<Response> {
  return accountRequest(path, { method: "POST", cookie, body, origin });
}

async function defaultOrganization(userId: string): Promise<{
  organization_id: string;
  membership_id: string;
}> {
  const receipt = await testEnv.IDENTITY_DB.prepare(
    "SELECT organization_id, membership_id FROM platform_default_organization WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ organization_id: string; membership_id: string }>();
  if (!receipt) throw new Error("Default organization receipt was not created");
  return receipt;
}

async function membership(
  organizationId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  return testEnv.IDENTITY_DB.prepare(
    "SELECT id, role FROM member WHERE organizationId = ? AND userId = ?",
  )
    .bind(organizationId, userId)
    .first<{ id: string; role: string }>();
}

async function createInvitation(
  actor: TestUser,
  organizationId: string,
  email: string,
  role: "owner" | "admin" | "member",
): Promise<{ id: string; organizationId: string }> {
  const response = await post("/api/account/invitations/create", actor.cookie, {
    organizationId,
    email,
    role,
    actorId: "forged-actor",
    actorRole: "owner",
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<{ id: string; organizationId: string }>;
}

async function acceptInvitation(
  user: TestUser,
  invitationId: string,
): Promise<Response> {
  return post("/api/account/invitations/accept", user.cookie, {
    invitationId,
    organizationId: "forged-organization",
    role: "owner",
  });
}

describe("Platform organization account management", () => {
  beforeEach(() => {
    googleIdentity = {
      subject: "platform-t03-google-1",
      name: "T03 User",
      email: "t03-user@example.test",
      verified: true,
    };
    mutableTestEnv.PLATFORM_OPERATOR_USER_ID = "";
    mutableTestEnv.PLATFORM_DEPLOYMENT_MODE = "self-hosted";
    mutableTestEnv.PLATFORM_SIGNUP_POLICY = "open";
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
          return Response.json({
            access_token: "platform-t03-synthetic-provider-token",
            expires_in: 3600,
            id_token: googleIdToken(),
            token_type: "Bearer",
          });
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });

  it("enforces explicit tenant authority, invitation and owner invariants, and operator recovery", async () => {
    const owner = await loginAs({
      subject: "platform-t03-owner",
      name: "<owner> & team",
      email: "owner-t03@example.test",
      verified: true,
    });
    const account = await accountRequest("/account", { cookie: owner.cookie });
    expect(account.status).toBe(200);
    expect(await account.text()).not.toContain("Platform operator");
    expect(
      (await accountRequest("/api/account/operator", { cookie: owner.cookie }))
        .status,
    ).toBe(403);
    const ownerDefault = await defaultOrganization(owner.id);

    const crossOriginCreate = await post(
      "/api/account/organizations/create",
      owner.cookie,
      { name: "Blocked cross origin" },
      "https://attacker.example",
    );
    expect(crossOriginCreate.status).toBe(403);

    const created = await post(
      "/api/account/organizations/create",
      owner.cookie,
      {
        name: "<img src=x onerror=alert(1)> Shared Team",
        actorId: "forged-user",
        role: "member",
      },
    );
    expect(created.status).toBe(201);
    const createdOrg = (await created.json()) as {
      organizationId: string;
      membershipId: string;
    };
    expect(createdOrg.organizationId).toBeTruthy();
    expect(createdOrg.membershipId).toBeTruthy();
    const createdMembership = await membership(
      createdOrg.organizationId,
      owner.id,
    );
    expect(createdMembership).toEqual({
      id: createdOrg.membershipId,
      role: "owner",
    });

    const accountPage = await accountRequest(
      `/account?organizationId=${encodeURIComponent(createdOrg.organizationId)}`,
      { cookie: owner.cookie },
    );
    const accountHtml = await accountPage.text();
    expect(accountHtml).toContain("Choose an organization");
    expect(accountHtml).toContain(
      "&lt;img src=x onerror=alert(1)&gt; Shared Team",
    );
    expect(accountHtml).not.toContain("<img src=x onerror=alert(1)>");
    expect(accountHtml).toContain("data-create-invitation");
    expect(accountHtml).toContain("Save organization name");

    const renamed = await post(
      "/api/account/organizations/update",
      owner.cookie,
      {
        organizationId: createdOrg.organizationId,
        name: "<b>Renamed Team</b>",
        suspendedAt: Date.now(),
        actorId: "not-the-owner",
      },
    );
    expect(renamed.status).toBe(200);
    const renamedFragment = await accountRequest(
      `/api/account/organizations/detail?organizationId=${encodeURIComponent(createdOrg.organizationId)}`,
      { cookie: owner.cookie },
    );
    const renamedHtml = await renamedFragment.text();
    expect(renamedHtml).toContain("&lt;b&gt;Renamed Team&lt;/b&gt;");
    expect(renamedHtml).not.toContain("<b>Renamed Team</b>");

    const rawPluginPaths = [
      "/api/auth/organization/create",
      "/api/auth/organization/update",
      "/api/auth/organization/delete",
      "/api/auth/organization/set-active",
      "/api/auth/organization/invite-member",
      "/api/auth/organization/accept-invitation",
      "/api/auth/organization/cancel-invitation",
      "/api/auth/organization/update-member-role",
      "/api/auth/organization/remove-member",
      "/api/auth/organization/leave",
      "/api/auth/delete-user",
    ];
    for (const path of rawPluginPaths) {
      const response = await post(path, owner.cookie, {
        organizationId: createdOrg.organizationId,
        invitationId: "forged-invitation",
        memberId: owner.id,
        data: { name: "forged", suspendedAt: Date.now() },
      });
      expect(response.status, path).toBe(404);
    }
    const encodedRaw = await post(
      "/api/auth/%6frganization/update/",
      owner.cookie,
      {
        organizationId: createdOrg.organizationId,
        data: { suspendedAt: Date.now() },
      },
    );
    expect(encodedRaw.status).toBe(404);
    const duplicateSlashRaw = await post(
      "/api/auth//organization//remove-member//",
      owner.cookie,
      { organizationId: createdOrg.organizationId, memberIdOrEmail: owner.id },
    );
    expect(duplicateSlashRaw.status).toBe(404);
    const unchangedLifecycle = await testEnv.IDENTITY_DB.prepare(
      "SELECT name, suspendedAt FROM organization WHERE id = ?",
    )
      .bind(createdOrg.organizationId)
      .first<{ name: string; suspendedAt: number | null }>();
    expect(unchangedLifecycle).toEqual({
      name: "<b>Renamed Team</b>",
      suspendedAt: null,
    });

    const outsider = await loginAs({
      subject: "platform-t03-outsider",
      name: "Outsider",
      email: "outsider-t03@example.test",
      verified: true,
    });
    const nonmemberDetail = await accountRequest(
      `/api/account/organizations/detail?organizationId=${encodeURIComponent(createdOrg.organizationId)}`,
      { cookie: outsider.cookie },
    );
    expect(nonmemberDetail.status).toBe(404);
    const nonmemberCreateInvite = await post(
      "/api/account/invitations/create",
      outsider.cookie,
      {
        organizationId: createdOrg.organizationId,
        email: "forged@example.test",
        role: "member",
      },
    );
    expect(nonmemberCreateInvite.status).toBe(404);

    const coowner = await loginAs({
      subject: "platform-t03-coowner",
      name: "Co-owner",
      email: "coowner-t03@example.test",
      verified: true,
    });
    const coownerInvitation = await createInvitation(
      owner,
      createdOrg.organizationId,
      coowner.email,
      "owner",
    );
    const coownerAccepted = await acceptInvitation(
      coowner,
      coownerInvitation.id,
    );
    expect(coownerAccepted.status, await coownerAccepted.clone().text()).toBe(
      200,
    );
    const coownerMembership = await membership(
      createdOrg.organizationId,
      coowner.id,
    );
    expect(coownerMembership?.role).toBe("owner");
    const ownerDetails = await accountRequest(
      `/api/account/organizations/detail?organizationId=${encodeURIComponent(createdOrg.organizationId)}`,
      { cookie: owner.cookie },
    );
    const ownerDetailsHtml = await ownerDetails.text();
    expect(ownerDetailsHtml).toContain(
      `<select id="member-role-${coownerMembership!.id}" data-member-role="${coownerMembership!.id}"><option value="owner" selected>Owner</option>`,
    );
    expect(ownerDetailsHtml).toContain(
      '<select id="invite-role" name="role"><option value="member" selected>Member</option>',
    );

    const admin = await loginAs({
      subject: "platform-t03-admin",
      name: "Admin",
      email: "admin-t03@example.test",
      verified: true,
    });
    const adminInvitation = await createInvitation(
      owner,
      createdOrg.organizationId,
      admin.email,
      "admin",
    );
    expect((await acceptInvitation(admin, adminInvitation.id)).status).toBe(
      200,
    );
    const adminMembership = await membership(
      createdOrg.organizationId,
      admin.id,
    );
    expect(adminMembership?.role).toBe("admin");
    const adminOwnerInvite = await post(
      "/api/account/invitations/create",
      admin.cookie,
      {
        organizationId: createdOrg.organizationId,
        email: "admin-owner-invite@example.test",
        role: "owner",
      },
    );
    expect(adminOwnerInvite.status).toBe(403);
    const adminPromoteSelf = await post(
      "/api/account/members/role",
      admin.cookie,
      {
        organizationId: createdOrg.organizationId,
        membershipId: adminMembership!.id,
        role: "owner",
        actorRole: "owner",
      },
    );
    expect(adminPromoteSelf.status).toBe(403);
    const adminDemoteOwner = await post(
      "/api/account/members/role",
      admin.cookie,
      {
        organizationId: createdOrg.organizationId,
        membershipId: coownerMembership!.id,
        role: "member",
      },
    );
    expect(adminDemoteOwner.status).toBe(403);
    expect(
      (await membership(createdOrg.organizationId, coowner.id))?.role,
    ).toBe("owner");

    const member = await loginAs({
      subject: "platform-t03-member",
      name: "Member",
      email: "member-t03@example.test",
      verified: true,
    });
    expect(
      (await accountRequest("/account", { cookie: member.cookie })).status,
    ).toBe(200);
    const memberInvitation = await createInvitation(
      owner,
      createdOrg.organizationId,
      member.email,
      "member",
    );
    const memberAccepted = await acceptInvitation(member, memberInvitation.id);
    expect(memberAccepted.status, await memberAccepted.clone().text()).toBe(
      200,
    );
    const originalMembership = await membership(
      createdOrg.organizationId,
      member.id,
    );
    expect(originalMembership?.role).toBe("member");
    const memberDetails = await accountRequest(
      `/api/account/organizations/detail?organizationId=${encodeURIComponent(createdOrg.organizationId)}`,
      { cookie: member.cookie },
    );
    expect(memberDetails.status).toBe(200);
    const memberDetailsHtml = await memberDetails.text();
    expect(memberDetailsHtml).toContain("member-t03@example.test");
    expect(memberDetailsHtml).not.toContain("admin-t03@example.test");
    expect(memberDetailsHtml).not.toContain("data-create-invitation");
    const memberRename = await post(
      "/api/account/organizations/update",
      member.cookie,
      {
        organizationId: createdOrg.organizationId,
        name: "Member attempted rename",
      },
    );
    expect(memberRename.status).toBe(403);
    const memberAdminister = await post(
      "/api/account/members/remove",
      member.cookie,
      {
        organizationId: createdOrg.organizationId,
        membershipId: adminMembership!.id,
      },
    );
    expect(memberAdminister.status).toBe(403);

    const finalOwnerOrganization = await post(
      "/api/account/organizations/create",
      owner.cookie,
      { name: "Final owner protection" },
    );
    const finalOwnerOrg = (await finalOwnerOrganization.json()) as {
      organizationId: string;
    };
    const finalOwnerLeave = await post(
      "/api/account/members/leave",
      owner.cookie,
      { organizationId: finalOwnerOrg.organizationId },
    );
    expect(finalOwnerLeave.status).toBe(409);
    const finalOwnerDemote = await post(
      "/api/account/members/role",
      owner.cookie,
      {
        organizationId: finalOwnerOrg.organizationId,
        membershipId: (await membership(
          finalOwnerOrg.organizationId,
          owner.id,
        ))!.id,
        role: "admin",
      },
    );
    expect(finalOwnerDemote.status).toBe(409);

    const service: TestService = {
      serviceId: "platform-t03-organization-test-service",
      audience: "https://organization-test.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    await registerTestService(testEnv.IDENTITY_DB, service);
    const issueCredential = async (user: TestUser): Promise<string> => {
      const response = await post("/api/credentials", user.cookie, {
        serviceId: service.serviceId,
        organizationId: createdOrg.organizationId,
        capabilities: ["resource:read"],
        actorId: owner.id,
        role: "owner",
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return ((await response.json()) as { credential: string }).credential;
    };
    const requestFetch = (input: RequestInfo | URL, init?: RequestInit) =>
      SELF.fetch(input, init);
    const sharedClient = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      fetch: requestFetch,
    });
    const memberCredential = await issueCredential(member);
    expect((await sharedClient.authenticate(memberCredential)).status).toBe(
      "authenticated",
    );

    const concurrentOwnerChanges = await Promise.all([
      post("/api/account/members/role", owner.cookie, {
        organizationId: createdOrg.organizationId,
        membershipId: coownerMembership!.id,
        role: "member",
      }),
      post("/api/account/members/remove", coowner.cookie, {
        organizationId: createdOrg.organizationId,
        membershipId: createdMembership!.id,
      }),
    ]);
    expect(
      concurrentOwnerChanges.map((response) => response.status).sort(),
    ).toContain(200);
    const owners = await testEnv.IDENTITY_DB.prepare(
      "SELECT userId FROM member WHERE organizationId = ? AND role = 'owner'",
    )
      .bind(createdOrg.organizationId)
      .all<{ userId: string }>();
    expect(owners.results).toHaveLength(1);
    const survivor = owners.results[0]!.userId === owner.id ? owner : coowner;

    const removedMember = await post(
      "/api/account/members/remove",
      survivor.cookie,
      {
        organizationId: createdOrg.organizationId,
        membershipId: originalMembership!.id,
      },
    );
    expect(removedMember.status).toBe(200);
    expect((await sharedClient.authenticate(memberCredential)).status).toBe(
      "invalid_credential",
    );
    const staleOrganization = await accountRequest(
      `/api/account/organizations/detail?organizationId=${encodeURIComponent(createdOrg.organizationId)}`,
      { cookie: member.cookie },
    );
    expect(staleOrganization.status).toBe(404);
    const rejoinInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      member.email,
      "member",
    );
    expect((await acceptInvitation(member, rejoinInvitation.id)).status).toBe(
      200,
    );
    const rejoinedMembership = await membership(
      createdOrg.organizationId,
      member.id,
    );
    expect(rejoinedMembership?.id).not.toBe(originalMembership?.id);
    expect((await sharedClient.authenticate(memberCredential)).status).toBe(
      "invalid_credential",
    );
    const rejoinedCredential = await issueCredential(member);
    expect((await sharedClient.authenticate(rejoinedCredential)).status).toBe(
      "authenticated",
    );
    await post("/api/account/members/remove", survivor.cookie, {
      organizationId: createdOrg.organizationId,
      membershipId: rejoinedMembership!.id,
    });
    const acceptedRetry = await acceptInvitation(member, rejoinInvitation.id);
    expect(acceptedRetry.status).toBe(409);
    expect(await membership(createdOrg.organizationId, member.id)).toBeNull();
    expect((await sharedClient.authenticate(rejoinedCredential)).status).toBe(
      "invalid_credential",
    );

    const retryInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      member.email,
      "member",
    );
    expect((await acceptInvitation(member, retryInvitation.id)).status).toBe(
      200,
    );
    const currentRejoin = await membership(
      createdOrg.organizationId,
      member.id,
    );
    expect(currentRejoin).not.toBeNull();
    const currentCredential = await issueCredential(member);
    expect((await sharedClient.authenticate(currentCredential)).status).toBe(
      "authenticated",
    );

    const raceRecipient = await loginAs({
      subject: "platform-t03-race-cancel",
      name: "Cancel race",
      email: "cancel-race-t03@example.test",
      verified: true,
    });
    const cancelRaceInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      raceRecipient.email,
      "member",
    );
    const [raceAccept, raceCancel] = await Promise.all([
      acceptInvitation(raceRecipient, cancelRaceInvitation.id),
      post("/api/account/invitations/cancel", survivor.cookie, {
        organizationId: createdOrg.organizationId,
        invitationId: cancelRaceInvitation.id,
      }),
    ]);
    const raceState = await testEnv.IDENTITY_DB.prepare(
      "SELECT status FROM invitation WHERE id = ?",
    )
      .bind(cancelRaceInvitation.id)
      .first<{ status: string }>();
    const raceMembership = await membership(
      createdOrg.organizationId,
      raceRecipient.id,
    );
    if (raceState?.status === "accepted") {
      expect(raceMembership).not.toBeNull();
      expect(raceAccept.status).toBe(200);
      expect(raceCancel.status).toBe(409);
    } else {
      expect(raceState?.status).toBe("cancelled");
      expect(raceMembership).toBeNull();
      expect(raceAccept.status).toBe(410);
      expect(raceCancel.status).toBe(200);
    }

    const acceptRecipient = await loginAs({
      subject: "platform-t03-race-accept",
      name: "Accept race",
      email: "accept-race-t03@example.test",
      verified: true,
    });
    const concurrentInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      acceptRecipient.email,
      "member",
    );
    const concurrentAccepts = await Promise.all([
      acceptInvitation(acceptRecipient, concurrentInvitation.id),
      acceptInvitation(acceptRecipient, concurrentInvitation.id),
    ]);
    expect(concurrentAccepts.map((response) => response.status)).toEqual([
      200, 200,
    ]);
    const concurrentMembershipRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM member WHERE organizationId = ? AND userId = ?",
    )
      .bind(createdOrg.organizationId, acceptRecipient.id)
      .all<{ id: string }>();
    expect(concurrentMembershipRows.results).toHaveLength(1);

    const failedBatchRecipient = await loginAs({
      subject: "platform-t03-failed-batch",
      name: "Batch failure",
      email: "batch-failure-t03@example.test",
      verified: true,
    });
    const failedBatchInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      failedBatchRecipient.email,
      "member",
    );
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER test_fail_member_insert
       BEFORE INSERT ON member
       WHEN NEW.userId = '${failedBatchRecipient.id}'
       BEGIN SELECT RAISE(ABORT, 'injected member insert failure'); END`,
    ).run();
    const failedBatchAccept = await acceptInvitation(
      failedBatchRecipient,
      failedBatchInvitation.id,
    );
    expect(failedBatchAccept.status).toBe(503);
    const failedBatchState = await testEnv.IDENTITY_DB.prepare(
      "SELECT status FROM invitation WHERE id = ?",
    )
      .bind(failedBatchInvitation.id)
      .first<{ status: string }>();
    expect(failedBatchState?.status).toBe("pending");
    expect(
      await membership(createdOrg.organizationId, failedBatchRecipient.id),
    ).toBeNull();
    await testEnv.IDENTITY_DB.prepare(
      "DROP TRIGGER test_fail_member_insert",
    ).run();

    const inviteOnlyEmail = "invite-only-t03@example.test";
    const inviteOnlyInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      inviteOnlyEmail,
      "member",
    );
    mutableTestEnv.PLATFORM_SIGNUP_POLICY = "invite-only";
    const inviteOnlyRecipient = await loginAs({
      subject: "platform-t03-invite-only",
      name: "Invite-only Recipient",
      email: inviteOnlyEmail,
      verified: true,
    });
    const inviteOnlyAccount = await accountRequest("/account", {
      cookie: inviteOnlyRecipient.cookie,
    });
    expect(inviteOnlyAccount.status).toBe(200);
    const inviteOnlyAccountHtml = await inviteOnlyAccount.text();
    expect(inviteOnlyAccountHtml).toContain(inviteOnlyEmail);
    expect(inviteOnlyAccountHtml).toContain("Accept invitation");
    const inviteOnlyState = await testEnv.IDENTITY_DB.prepare(
      "SELECT status FROM invitation WHERE id = ?",
    )
      .bind(inviteOnlyInvitation.id)
      .first<{ status: string }>();
    expect(inviteOnlyState?.status).toBe("pending");
    expect(
      await membership(createdOrg.organizationId, inviteOnlyRecipient.id),
    ).toBeNull();
    expect(
      (await acceptInvitation(inviteOnlyRecipient, inviteOnlyInvitation.id))
        .status,
    ).toBe(200);
    mutableTestEnv.PLATFORM_SIGNUP_POLICY = "open";

    const wrongEmailInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      "someone-else-t03@example.test",
      "member",
    );
    const wrongEmailAccept = await acceptInvitation(
      outsider,
      wrongEmailInvitation.id,
    );
    expect(wrongEmailAccept.status).toBe(403);
    expect(((await wrongEmailAccept.json()) as { error: string }).error).toBe(
      "wrong_email",
    );

    const unverifiedRecipient = await loginAs({
      subject: "platform-t03-unverified",
      name: "Unverified Recipient",
      email: "unverified-t03@example.test",
      verified: true,
    });
    const unverifiedInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      unverifiedRecipient.email,
      "member",
    );
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET emailVerified = 0 WHERE id = ?',
    )
      .bind(unverifiedRecipient.id)
      .run();
    const unverifiedAccept = await acceptInvitation(
      unverifiedRecipient,
      unverifiedInvitation.id,
    );
    expect(unverifiedAccept.status).toBe(403);
    expect(((await unverifiedAccept.json()) as { error: string }).error).toBe(
      "email_unverified",
    );
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET emailVerified = 1 WHERE id = ?',
    )
      .bind(unverifiedRecipient.id)
      .run();
    expect(
      (await acceptInvitation(unverifiedRecipient, unverifiedInvitation.id))
        .status,
    ).toBe(200);

    const expiredRecipient = await loginAs({
      subject: "platform-t03-expired",
      name: "Expired Recipient",
      email: "expired-t03@example.test",
      verified: true,
    });
    const expiredInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      expiredRecipient.email,
      "member",
    );
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE invitation SET expiresAt = 0 WHERE id = ?",
    )
      .bind(expiredInvitation.id)
      .run();
    expect(
      (await acceptInvitation(expiredRecipient, expiredInvitation.id)).status,
    ).toBe(410);

    const cancelledRecipient = await loginAs({
      subject: "platform-t03-cancelled",
      name: "Cancelled Recipient",
      email: "cancelled-t03@example.test",
      verified: true,
    });
    const cancelledInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      cancelledRecipient.email,
      "member",
    );
    expect(
      (
        await post("/api/account/invitations/cancel", survivor.cookie, {
          organizationId: createdOrg.organizationId,
          invitationId: cancelledInvitation.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (await acceptInvitation(cancelledRecipient, cancelledInvitation.id))
        .status,
    ).toBe(410);

    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER test_fail_owned_org_member
       BEFORE INSERT ON member
       WHEN NEW.userId = '${survivor.id}' AND NEW.role = 'owner'
         AND (SELECT name FROM organization WHERE id = NEW.organizationId) = 'Atomic rollback org'
       BEGIN SELECT RAISE(ABORT, 'injected owner insert failure'); END`,
    ).run();
    const failedOrganization = await post(
      "/api/account/organizations/create",
      survivor.cookie,
      { name: "Atomic rollback org" },
    );
    expect(failedOrganization.status).toBe(503);
    const orphanOrganization = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM organization WHERE name = 'Atomic rollback org'",
    ).first<{ id: string }>();
    expect(orphanOrganization).toBeNull();
    await testEnv.IDENTITY_DB.prepare(
      "DROP TRIGGER test_fail_owned_org_member",
    ).run();

    const recipientDefault = await defaultOrganization(member.id);
    const recipientDefaultOwner = await membership(
      recipientDefault.organization_id,
      member.id,
    );
    expect(recipientDefaultOwner?.role).toBe("owner");
    const defaultCoownerInvite = await createInvitation(
      member,
      recipientDefault.organization_id,
      coowner.email,
      "owner",
    );
    expect(
      (await acceptInvitation(coowner, defaultCoownerInvite.id)).status,
    ).toBe(200);
    const leaveDefault = await post(
      "/api/account/members/leave",
      member.cookie,
      {
        organizationId: recipientDefault.organization_id,
      },
    );
    expect(leaveDefault.status).toBe(200);
    const accountAfterDefaultLeave = await accountRequest("/account", {
      cookie: member.cookie,
    });
    expect(await accountAfterDefaultLeave.text()).toContain(
      "You no longer have access to the default organization",
    );
    expect(
      await membership(recipientDefault.organization_id, member.id),
    ).toBeNull();

    const operator = await loginAs({
      subject: "platform-t03-operator",
      name: "Configured Operator",
      email: "operator-t03@example.test",
      verified: true,
    });
    mutableTestEnv.PLATFORM_OPERATOR_USER_ID = operator.id;
    const operatorPage = await accountRequest("/account", {
      cookie: operator.cookie,
    });
    expect(await operatorPage.text()).toContain("Platform operator");
    const operatorList = await accountRequest("/api/account/operator", {
      cookie: operator.cookie,
    });
    expect(operatorList.status).toBe(200);
    const operatorData = (await operatorList.json()) as {
      organizations: Array<{ id: string }>;
      users: Array<{ id: string }>;
    };
    expect(
      operatorData.organizations.some(
        (item) => item.id === createdOrg.organizationId,
      ),
    ).toBe(true);
    expect(operatorData.users.some((item) => item.id === member.id)).toBe(true);
    const suspendedRecipient = await loginAs({
      subject: "platform-t03-suspended-invite",
      name: "Suspended Invite Recipient",
      email: "suspended-invite-t03@example.test",
      verified: true,
    });
    const suspendedInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      suspendedRecipient.email,
      "member",
    );
    const ownerCannotUseOperator = await post(
      "/api/account/operator/lifecycle",
      survivor.cookie,
      {
        kind: "organization",
        targetId: createdOrg.organizationId,
        action: "suspend",
        operatorUserId: operator.id,
      },
    );
    expect(ownerCannotUseOperator.status).toBe(403);
    const suspendOrganization = await post(
      "/api/account/operator/lifecycle",
      operator.cookie,
      {
        kind: "organization",
        targetId: createdOrg.organizationId,
        action: "suspend",
        suspendedAt: null,
      },
    );
    expect(suspendOrganization.status).toBe(200);
    expect((await sharedClient.authenticate(currentCredential)).status).toBe(
      "invalid_credential",
    );
    const suspendedMemberDetails = await accountRequest(
      `/api/account/organizations/detail?organizationId=${encodeURIComponent(createdOrg.organizationId)}`,
      { cookie: member.cookie },
    );
    const suspendedMemberHtml = await suspendedMemberDetails.text();
    expect(suspendedMemberHtml).toContain("This organization is suspended");
    expect(suspendedMemberHtml).toContain("Membership changes are unavailable");
    expect(suspendedMemberHtml).not.toContain("data-leave-organization");
    const suspendedLeave = await post(
      "/api/account/members/leave",
      member.cookie,
      {
        organizationId: createdOrg.organizationId,
      },
    );
    expect(suspendedLeave.status).toBe(403);
    expect(
      await membership(createdOrg.organizationId, member.id),
    ).not.toBeNull();
    const suspendedAccept = await acceptInvitation(
      suspendedRecipient,
      suspendedInvitation.id,
    );
    expect(suspendedAccept.status).toBe(403);
    expect(((await suspendedAccept.json()) as { error: string }).error).toBe(
      "organization_suspended",
    );
    const restoreOrganization = await post(
      "/api/account/operator/lifecycle",
      operator.cookie,
      {
        kind: "organization",
        targetId: createdOrg.organizationId,
        action: "restore",
        suspendedAt: Date.now(),
      },
    );
    expect(restoreOrganization.status).toBe(200);
    expect((await sharedClient.authenticate(currentCredential)).status).toBe(
      "authenticated",
    );
    expect(
      (await acceptInvitation(suspendedRecipient, suspendedInvitation.id))
        .status,
    ).toBe(200);

    const disabledRecipient = await loginAs({
      subject: "platform-t03-disabled-invite",
      name: "Disabled Invite Recipient",
      email: "disabled-invite-t03@example.test",
      verified: true,
    });
    const disabledInvitation = await createInvitation(
      survivor,
      createdOrg.organizationId,
      disabledRecipient.email,
      "member",
    );
    expect(
      (
        await post("/api/account/operator/lifecycle", operator.cookie, {
          kind: "user",
          targetId: disabledRecipient.id,
          action: "disable",
        })
      ).status,
    ).toBe(200);
    expect(
      (await acceptInvitation(disabledRecipient, disabledInvitation.id)).status,
    ).toBe(401);
    expect(
      (
        await post("/api/account/operator/lifecycle", operator.cookie, {
          kind: "user",
          targetId: disabledRecipient.id,
          action: "restore",
        })
      ).status,
    ).toBe(200);
    expect(
      (await acceptInvitation(disabledRecipient, disabledInvitation.id)).status,
    ).toBe(200);

    const disableMember = await post(
      "/api/account/operator/lifecycle",
      operator.cookie,
      {
        kind: "user",
        targetId: member.id,
        action: "disable",
        disabledAt: null,
      },
    );
    expect(disableMember.status).toBe(200);
    expect((await sharedClient.authenticate(currentCredential)).status).toBe(
      "invalid_credential",
    );
    const tenantCannotRestoreDisabledMember = await post(
      "/api/account/operator/lifecycle",
      survivor.cookie,
      {
        kind: "user",
        targetId: member.id,
        action: "restore",
      },
    );
    expect(tenantCannotRestoreDisabledMember.status).toBe(403);
    const disabledMemberDetails = await accountRequest(
      `/api/account/organizations/detail?organizationId=${encodeURIComponent(createdOrg.organizationId)}`,
      { cookie: survivor.cookie },
    );
    expect(disabledMemberDetails.status).toBe(200);
    expect(await disabledMemberDetails.text()).toContain("disabled account");
    const disabledMemberMembership = await membership(
      createdOrg.organizationId,
      member.id,
    );
    expect(disabledMemberMembership).not.toBeNull();
    const updateDisabledMemberRole = await post(
      "/api/account/members/role",
      survivor.cookie,
      {
        organizationId: createdOrg.organizationId,
        membershipId: disabledMemberMembership!.id,
        role: "admin",
      },
    );
    expect(updateDisabledMemberRole.status).toBe(200);
    const removeDisabledMember = await post(
      "/api/account/members/remove",
      survivor.cookie,
      {
        organizationId: createdOrg.organizationId,
        membershipId: disabledMemberMembership!.id,
      },
    );
    expect(removeDisabledMember.status).toBe(200);
    expect(await membership(createdOrg.organizationId, member.id)).toBeNull();
    const disabledAccountPage = await SELF.fetch("http://localhost/account", {
      headers: { cookie: member.cookie },
      redirect: "manual",
    });
    expect(disabledAccountPage.status).toBe(302);
    const restoreMember = await post(
      "/api/account/operator/lifecycle",
      operator.cookie,
      {
        kind: "user",
        targetId: member.id,
        action: "restore",
        disabledAt: Date.now(),
      },
    );
    expect(restoreMember.status).toBe(200);
    expect((await sharedClient.authenticate(currentCredential)).status).toBe(
      "invalid_credential",
    );

    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = ? WHERE id = ?',
    )
      .bind(Date.now(), operator.id)
      .run();
    expect(
      (
        await accountRequest("/api/account/operator", {
          cookie: operator.cookie,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post("/api/account/operator/lifecycle", operator.cookie, {
          kind: "organization",
          targetId: createdOrg.organizationId,
          action: "restore",
        })
      ).status,
    ).toBe(401);
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = NULL WHERE id = ?',
    )
      .bind(operator.id)
      .run();

    const credentialWithoutExplicitOrganization = await post(
      "/api/credentials",
      member.cookie,
      { serviceId: service.serviceId, capabilities: ["resource:read"] },
    );
    expect(credentialWithoutExplicitOrganization.status).toBe(400);
    const persistentOrganization = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, suspendedAt FROM organization WHERE id = ?",
    )
      .bind(createdOrg.organizationId)
      .first<{ id: string; suspendedAt: number | null }>();
    expect(persistentOrganization?.suspendedAt).toBeNull();
    expect(await membership(createdOrg.organizationId, member.id)).toBeNull();
    expect(
      await testEnv.IDENTITY_DB.prepare('SELECT id FROM "user" WHERE id = ?')
        .bind(owner.id)
        .first<{ id: string }>(),
    ).not.toBeNull();
    expect(ownerDefault.organization_id).toBeTruthy();
  });
});
