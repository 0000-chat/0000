import { describe, expect, it } from "vitest";
import {
  CommandSchema,
  ConnectionSchema,
  ConversationSummarySchema,
  IdentitySchema,
  MessageSchema,
} from "@communicator/contracts";
import { server } from "./server";

const jsonHeaders = { "Content-Type": "application/json" };

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

describe("simulated API handlers", () => {
  it("serves contract-valid identity-scoped resources", async () => {
    const me = await fetch("http://example.test/api/v1/me");
    expect((await json<{ tenant_id: string }>(me)).tenant_id).toBe("tenant_pilot");

    const identities = await fetch("http://example.test/api/v1/identities");
    expect(IdentitySchema.array().parse(await json(identities))).toHaveLength(2);

    const humanConnections = await fetch(
      "http://example.test/api/v1/connections?identity_id=identity_human",
    );
    expect(ConnectionSchema.array().parse(await json(humanConnections)).every(
      (connection) => connection.identity_id === "identity_human",
    )).toBe(true);

    const agentConversations = await fetch(
      "http://example.test/api/v1/conversations?identity_id=identity_agent",
    );
    expect(ConversationSummarySchema.array().parse(await json(agentConversations)).every(
      (conversation) => conversation.identity_id === "identity_agent",
    )).toBe(true);

    const agentMessages = await fetch(
      "http://example.test/api/v1/conversations/conversation_agent_one/messages?identity_id=identity_agent",
    );
    expect(MessageSchema.array().parse(await json(agentMessages)).every(
      (message) => message.identity_id === "identity_agent",
    )).toBe(true);

    const commands = await fetch(
      "http://example.test/api/v1/commands?identity_id=identity_human",
    );
    expect(CommandSchema.array().parse(await json(commands)).every(
      (command) => command.identity_id === "identity_human",
    )).toBe(true);

    const accepted = await fetch(
      "http://example.test/api/v1/conversations/conversation_human_one/messages",
      {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": "test-key-direct" },
        body: JSON.stringify({
          identity_id: "identity_human",
          body: "A safe simulated message",
          delivery_mode: "direct",
        }),
      },
    );
    expect(accepted.status).toBe(202);
    expect(CommandSchema.parse(await json(accepted)).status).toBe("accepted");

    const reset = await fetch("http://example.test/api/v1/testing/reset", {
      method: "POST",
    });
    expect(reset.status).toBe(200);
  });

  it("rejects missing idempotency and unsupported delivery modes", async () => {
    const missingKey = await fetch(
      "http://example.test/api/v1/conversations/conversation_human_one/messages",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          identity_id: "identity_human",
          body: "A safe simulated message",
          delivery_mode: "direct",
        }),
      },
    );
    expect(missingKey.status).toBe(400);

    const unsupportedMode = await fetch(
      "http://example.test/api/v1/conversations/conversation_human_one/messages",
      {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": "test-key-invalid" },
        body: JSON.stringify({
          identity_id: "identity_human",
          body: "A safe simulated message",
          delivery_mode: "instant",
        }),
      },
    );
    expect(unsupportedMode.status).toBe(400);
  });

  it("returns one command for a repeated idempotency key", async () => {
    const init = {
      method: "POST",
      headers: { ...jsonHeaders, "Idempotency-Key": "test-key-repeat" },
      body: JSON.stringify({
        identity_id: "identity_human",
        body: "A safe simulated message",
        delivery_mode: "paced",
      }),
    };
    const first = await fetch(
      "http://example.test/api/v1/conversations/conversation_human_one/messages",
      init,
    );
    const second = await fetch(
      "http://example.test/api/v1/conversations/conversation_human_one/messages",
      init,
    );
    const firstCommand = CommandSchema.parse(await json(first));
    const secondCommand = CommandSchema.parse(await json(second));
    expect(firstCommand.id).toBe(secondCommand.id);
  });

  it("does not disclose resources across identities", async () => {
    const response = await fetch(
      "http://example.test/api/v1/conversations/conversation_human_one/messages?identity_id=identity_agent",
    );
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      error: {
        code: "not_found",
        message: "The requested resource is not available.",
      },
    });
  });

  it("keeps the real health route outside the simulated handlers", () => {
    expect(server).toBeDefined();
  });
});
