import { expect, test } from "bun:test";
import { z } from "zod";

import {
  GatewayOperations,
  type AgentPrincipal,
  type ServiceToolDeclaration,
} from "../src/access";

const principal: AgentPrincipal = {
  kind: "agent",
  agentId: "agent-a",
  organizationId: "org-a",
  profileId: "profile-a",
};

test("a grant lookup resolving after the deadline cannot start a service effect", async () => {
  let invocations = 0;
  const declaration: ServiceToolDeclaration = {
    operationId: "fixture.read",
    name: "fixture_read",
    description: "Read a fixture.",
    inputSchema: z.object({ resourceId: z.string() }),
    async invoke() {
      invocations += 1;
      return { content: [{ type: "text", text: "unexpected" }] };
    },
  };
  const operations = new GatewayOperations([declaration], {
    async getGrantedOperationIds() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return ["fixture.read"];
    },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const result = await operations.invokeForAgent(
    principal,
    "org-a",
    "profile-a",
    "fixture_read",
    { resourceId: "allowed" },
    { operationId: "fixture.read", signal: controller.signal },
  );
  expect(result.isError).toBe(true);
  expect(invocations).toBe(0);
});
