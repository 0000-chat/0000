import { expect, test } from "bun:test";

import { createGatewayApp } from "../src/app";
import type {
  AgentPrincipal,
  HumanPrincipal,
  ServiceToolDeclaration,
} from "../src/access";

const manager: HumanPrincipal = {
  kind: "human",
  userId: "human-manager",
  organizationId: "org-a",
};
const agent: AgentPrincipal = {
  kind: "agent",
  agentId: "agent-a",
  organizationId: "org-a",
  profileId: "profile-a",
};

function createFixture(canManage = false) {
  const profiles = new Set<string>();
  const grants = new Map<string, string[]>();
  const seenSessions: string[] = [];
  const fixtureTool = {
    operationId: "fixture.read",
    name: "fixture_read",
    description: "Read a fixture.",
    inputSchema: {
      "~standard": {
        validate(value: unknown) {
          return { value };
        },
      },
    },
    async invoke() {
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  } as unknown as ServiceToolDeclaration;
  const app = createGatewayApp({
    identityVerifier: {
      async verifyAgentCredential(request) {
        return request.headers.get("authorization") === "Bearer agent"
          ? agent
          : null;
      },
      async verifyHumanSession(request) {
        const cookie = request.headers.get("cookie") ?? "";
        const session = cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("platform_session="))
          ?.slice("platform_session=".length);
        if (session) seenSessions.push(session);
        return session === "manager" ? manager : null;
      },
    },
    profileGrantStore: {
      async getGrantedOperationIds(organizationId, profileId) {
        const key = `${organizationId}/${profileId}`;
        return profiles.has(key) ? [...(grants.get(key) ?? [])] : null;
      },
      async createProfile(organizationId: string, profileId: string) {
        const key = `${organizationId}/${profileId}`;
        const before = profiles.size;
        profiles.add(key);
        return profiles.size !== before;
      },
      async setGrantedOperationIds(
        organizationId: string,
        profileId: string,
        operationIds: readonly string[],
      ) {
        const key = `${organizationId}/${profileId}`;
        if (!profiles.has(key)) throw new Error("missing profile");
        grants.set(key, [...operationIds]);
      },
      async revokeGrantedOperationId(
        organizationId: string,
        profileId: string,
        operationId: string,
      ) {
        const key = `${organizationId}/${profileId}`;
        const current = grants.get(key) ?? [];
        const next = current.filter((id) => id !== operationId);
        grants.set(key, next);
        return next.length !== current.length;
      },
    },
    profileManagementAuthorizer: {
      async canManageProfile() {
        return canManage;
      },
    },
    serviceTools: [fixtureTool],
  });
  return { app, grants, seenSessions };
}

function managementRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://gateway.0000.chat${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: "platform_session=manager; unrelated=must-not-forward",
      "x-0000-organization": "org-a",
      ...init.headers,
    },
  });
}

test("profile management requires a human with the explicit management permission", async () => {
  const fixture = createFixture(true);
  const noSession = await fixture.app.fetch(
    new Request("https://gateway.0000.chat/internal/profiles/org-a/profile-a", {
      method: "POST",
    }),
  );
  expect(noSession.status).toBe(401);

  const agentRequest = await fixture.app.fetch(
    new Request("https://gateway.0000.chat/internal/profiles/org-a/profile-a", {
      method: "POST",
      headers: { authorization: "Bearer agent" },
    }),
  );
  expect(agentRequest.status).toBe(401);

  const created = await fixture.app.fetch(
    managementRequest("/internal/profiles/org-a/profile-a", { method: "POST" }),
  );
  expect(created.status).toBe(200);
  expect(fixture.seenSessions).toEqual(["manager"]);
});

test("profile management fails closed when canManageProfile denies or is unavailable", async () => {
  const denied = createFixture(false);
  const response = await denied.app.fetch(
    managementRequest("/internal/profiles/org-a/profile-a", { method: "POST" }),
  );
  expect(response.status).toBe(403);

  const unavailable = createGatewayApp({
    identityVerifier: {
      async verifyAgentCredential() {
        return null;
      },
      async verifyHumanSession() {
        return manager;
      },
    },
    profileGrantStore: {
      async getGrantedOperationIds() {
        return null;
      },
    },
    profileManagementAuthorizer: {
      async canManageProfile() {
        throw new Error("binding unavailable");
      },
    },
    serviceTools: [],
  });
  const unavailableResponse = await unavailable.fetch(
    managementRequest("/internal/profiles/org-a/profile-a", { method: "POST" }),
  );
  expect(unavailableResponse.status).toBe(503);

  const malformed = createGatewayApp({
    identityVerifier: {
      async verifyAgentCredential() {
        return null;
      },
      async verifyHumanSession() {
        return manager;
      },
    },
    profileGrantStore: {
      async getGrantedOperationIds() {
        return null;
      },
    },
    profileManagementAuthorizer: {
      async canManageProfile() {
        return "true" as unknown as boolean;
      },
    },
    serviceTools: [],
  });
  const malformedResponse = await malformed.fetch(
    managementRequest("/internal/profiles/org-a/profile-a", { method: "POST" }),
  );
  expect(malformedResponse.status).toBe(403);
});

test("grant management rejects later-milestone state and preserves the empty blocked profile", async () => {
  const fixture = createFixture(true);
  await fixture.app.fetch(
    managementRequest("/internal/profiles/org-a/profile-a", { method: "POST" }),
  );
  const response = await fixture.app.fetch(
    managementRequest("/internal/profiles/org-a/profile-a/grants", {
      method: "PUT",
      body: JSON.stringify({ operationIds: ["fixture.read"], state: "ask" }),
    }),
  );
  expect(response.status).toBe(400);
  expect(fixture.grants.get("org-a/profile-a") ?? []).toEqual([]);
});
