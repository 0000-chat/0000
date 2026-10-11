import { createGatewayApp } from "../src/app";
import type { AgentPrincipal, ServiceToolDeclaration } from "../src/access";
import { D1ProfileGrantStore, type D1DatabaseLike } from "../src/profile-store";
import { z } from "zod";

const principals = new Map<string, AgentPrincipal>([
  [
    "agent-a",
    {
      kind: "agent",
      agentId: "agent-a",
      organizationId: "org-a",
      profileId: "profile-a",
    },
  ],
  [
    "agent-b",
    {
      kind: "agent",
      agentId: "agent-b",
      organizationId: "org-a",
      profileId: "profile-b",
    },
  ],
  [
    "outsider",
    {
      kind: "agent",
      agentId: "outsider",
      organizationId: "org-b",
      profileId: "profile-a",
    },
  ],
]);
const grants = new Map<string, string[]>([
  ["org-a/profile-a", ["fixture.read"]],
  ["org-a/profile-b", ["fixture.write"]],
  ["org-b/profile-a", ["fixture.read"]],
]);
const invocations = new Map<string, number>();

const serviceTools: readonly ServiceToolDeclaration[] = [
  {
    operationId: "fixture.read",
    name: "fixture_read",
    description: "Read a fixture resource through the downstream service.",
    inputSchema: z.object({ resourceId: z.string().min(1) }),
    invoke: async (_principal, input) => {
      invocations.set(
        "fixture.read",
        (invocations.get("fixture.read") ?? 0) + 1,
      );
      if (input.resourceId === "restricted") {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: "Service resource access denied." },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: "fixture read" }],
        structuredContent: { resourceId: input.resourceId, value: "ok" },
      };
    },
  },
  {
    operationId: "fixture.write",
    name: "fixture_write",
    description: "Write a fixture resource through the downstream service.",
    inputSchema: z.object({
      resourceId: z.string().min(1),
      value: z.string().min(1),
    }),
    invoke: async (_principal, input) => {
      invocations.set(
        "fixture.write",
        (invocations.get("fixture.write") ?? 0) + 1,
      );
      return {
        content: [{ type: "text" as const, text: "fixture write" }],
        structuredContent: { resourceId: input.resourceId, value: input.value },
      };
    },
  },
];

const memoryStore = {
  async getGrantedOperationIds(organizationId: string, profileId: string) {
    const value = grants.get(`${organizationId}/${profileId}`);
    return value === undefined ? null : [...value];
  },
};

const dependencies = (store: {
  getGrantedOperationIds(
    organizationId: string,
    profileId: string,
  ): Promise<readonly string[] | null>;
}) => ({
  identityVerifier: {
    async verifyAgentCredential(request: Request) {
      const token = request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/iu, "");
      return token ? (principals.get(token) ?? null) : null;
    },
    async verifyHumanSession() {
      return null;
    },
  },
  profileGrantStore: store,
  profileManagementAuthorizer: {
    async canManageProfile() {
      return false;
    },
  },
  serviceTools,
});

const apps = new WeakMap<object, ReturnType<typeof createGatewayApp>>();
const stores = new WeakMap<object, D1ProfileGrantStore>();
const makeConfigured = (environment: { GATEWAY_DB?: D1DatabaseLike }) => {
  if (!environment.GATEWAY_DB)
    return { app: createGatewayApp(dependencies(memoryStore)), store: null };
  const store = new D1ProfileGrantStore(environment.GATEWAY_DB, [
    "fixture.read",
    "fixture.write",
  ]);
  return { app: createGatewayApp(dependencies(store)), store };
};

export default {
  async fetch(
    request: Request,
    environment: { GATEWAY_DB?: D1DatabaseLike },
  ): Promise<Response> {
    let app = apps.get(environment);
    let store = stores.get(environment) ?? null;
    if (!app) {
      const configured = makeConfigured(environment);
      app = configured.app;
      if (configured.store) stores.set(environment, configured.store);
      store = configured.store;
      apps.set(environment, app);
    }
    const url = new URL(request.url);
    if (url.pathname === "/__test/grants" && request.method === "POST") {
      const body = (await request.json()) as {
        profile: string;
        operationIds: string[];
      };
      if (store) {
        const [organizationId, profileId] = body.profile.split("/");
        await store.setGrantedOperationIds(
          organizationId,
          profileId,
          body.operationIds,
        );
      } else {
        grants.set(body.profile, body.operationIds);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/profile" && request.method === "POST") {
      const body = (await request.json()) as { profile: string };
      if (store) {
        const [organizationId, profileId] = body.profile.split("/");
        await store.createProfile(organizationId, profileId);
      } else if (!grants.has(body.profile)) {
        grants.set(body.profile, []);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/invocations") {
      return Response.json(Object.fromEntries(invocations));
    }
    return app.fetch(request);
  },
};
