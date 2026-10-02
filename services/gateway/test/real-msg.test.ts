import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, test } from "bun:test";

import { startRealMsgWorker } from "./real-msg-worker";

const MSG_TOOL_NAMES = [
  "msg_create_room",
  "msg_create_webhook",
  "msg_disable_webhook",
  "msg_enable_webhook",
  "msg_export_room",
  "msg_get_room_status",
  "msg_list_webhooks",
  "msg_manage_room",
  "msg_post_message",
  "msg_read_room",
  "msg_redeliver_webhook",
  "msg_remove_webhook",
  "msg_rotate_webhook_secret",
  "msg_wait_for_messages",
];

function textContent(result: {
  readonly content?: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

function objectContent(result: {
  readonly structuredContent?: unknown;
}): Record<string, unknown> {
  const value = result.structuredContent;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected structured MCP tool output.");
  }
  return value as Record<string, unknown>;
}

function callProgram(name: string, input: Record<string, unknown>): string {
  return `return await tools.${name}(${JSON.stringify(input)});`;
}

test("authenticated canonical Gateway use reaches the real Msg Worker catalog and resource boundary", {
  timeout: 120_000,
}, async () => {
  const gateway = await startRealMsgWorker();
  try {
    const connect = async (token: string) => {
      const transport = new StreamableHTTPClientTransport(
        new URL("https://0000.chat/mcp"),
        {
          requestInit: { headers: { authorization: token } },
          fetch: async (input, init) => gateway.dispatchFetch(input, init),
        },
      );
      const client = new Client({
        name: "gateway-real-msg-proof",
        version: "1",
      });
      await client.connect(transport);
      return { client, transport };
    };

    const agentA = await connect("Bearer agent-a");
    const agentB = await connect("Bearer agent-b");
    try {
      const listed = await agentA.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "use",
        "tools.search",
        ...MSG_TOOL_NAMES,
      ]);
      for (const tool of listed.tools.filter((item) =>
        item.name.startsWith("msg_"),
      )) {
        const unsafeDescription =
          /management URL|owner-only|signing secret|private owner management|token/iu.test(
            tool.description,
          );
        expect(unsafeDescription).toBe(false);
      }

      const viaUse = await agentA.client.callTool({
        name: "use",
        arguments: { program: "return await tools.search({query: ''});" },
      });
      expect(viaUse.isError).not.toBe(true);
      const discovered = objectContent(viaUse).tools;
      expect(Array.isArray(discovered)).toBe(true);
      expect(
        (discovered as Array<{ name: string }>).map((tool) => tool.name),
      ).toEqual(MSG_TOOL_NAMES);

      const createInput = {
        author: "gateway-proof-agent",
        content: "Gateway to Msg authenticated proof",
        idempotency_key: `gateway-proof-${crypto.randomUUID()}`,
        name_password: "GatePass",
      };
      const created = await agentA.client.callTool({
        name: "use",
        arguments: {
          program: callProgram("msg_create_room", createInput),
        },
      });
      expect(created.isError).not.toBe(true);
      const createdOutput = objectContent(created);
      expect(typeof createdOutput.conversation_url).toBe("string");
      const roomUrl = createdOutput.conversation_url;
      if (typeof roomUrl !== "string")
        throw new Error("Msg did not return a room URL.");

      const replayed = await agentA.client.callTool({
        name: "use",
        arguments: { program: callProgram("msg_create_room", createInput) },
      });
      expect(replayed.isError).not.toBe(true);
      expect(objectContent(replayed).conversation_url).toBe(roomUrl);

      const read = await agentA.client.callTool({
        name: "use",
        arguments: {
          program: callProgram("msg_read_room", {
            limit: 10,
            room_url: roomUrl,
          }),
        },
      });
      expect(read.isError).not.toBe(true);
      expect(objectContent(read).messages).toHaveLength(1);

      const posted = await agentA.client.callTool({
        name: "use",
        arguments: {
          program: callProgram("msg_post_message", {
            author: "gateway-proof-agent",
            client_message_id: `gateway-post-${crypto.randomUUID()}`,
            content: "Gateway posted through Msg",
            name_password: "GatePass",
            room_url: roomUrl,
          }),
        },
      });
      expect(posted.isError).not.toBe(true);
      expect(objectContent(posted).status).toBe("accepted");

      const resourceDenied = await agentA.client.callTool({
        name: "use",
        arguments: {
          program: callProgram("msg_read_room", {
            room_url:
              "https://msg.0000.chat/room-capability-not-owned-by-this-agent",
          }),
        },
      });
      expect(resourceDenied.isError).toBe(true);
      expect(textContent(resourceDenied)).toBe("Msg operation failed.");
      expect(textContent(resourceDenied)).not.toMatch(
        /management URL|owner-only|secret|token/iu,
      );

      const managementDenied = await agentA.client.callTool({
        name: "use",
        arguments: {
          program: callProgram("msg_manage_room", {
            action: "status",
            management_url:
              "https://msg.0000.chat/manage/not-owned/wrong-token",
          }),
        },
      });
      expect(managementDenied.isError).toBe(true);
      expect(textContent(managementDenied)).toBe("Msg operation failed.");
      expect(textContent(managementDenied)).not.toMatch(
        /management URL|owner-only|secret|token/iu,
      );

      const profileBTools = await agentB.client.listTools();
      expect(profileBTools.tools.map((tool) => tool.name)).toEqual([
        "use",
        "tools.search",
      ]);
      const deniedExactName = await agentB.client.callTool({
        name: "use",
        arguments: {
          program: callProgram("msg_create_room", {
            author: "blocked-agent",
            content: "must not reach Msg",
            idempotency_key: `blocked-${crypto.randomUUID()}`,
          }),
        },
      });
      expect(deniedExactName.isError).toBe(true);
      expect(textContent(deniedExactName)).toBe("Tool access denied.");

      const adminHeaders = {
        cookie: "platform_session=admin-session",
        "x-0000-organization": "org-a",
      };
      const createdProfile = await gateway.dispatchFetch(
        new Request(
          "https://0000.chat/internal/profiles/org-a/profile-managed",
          {
            method: "POST",
            headers: adminHeaders,
          },
        ),
      );
      expect(createdProfile.status).toBe(200);
      expect(await createdProfile.json()).toEqual({ created: true });

      const managed = await connect("Bearer agent-managed");
      try {
        const createdProfileTools = await managed.client.listTools();
        expect(createdProfileTools.tools.map((tool) => tool.name)).toEqual([
          "use",
          "tools.search",
        ]);

        const grantedProfile = await gateway.dispatchFetch(
          new Request(
            "https://0000.chat/internal/profiles/org-a/profile-managed/grants",
            {
              method: "PUT",
              headers: { ...adminHeaders, "content-type": "application/json" },
              body: JSON.stringify({ operationIds: ["msg.read_room"] }),
            },
          ),
        );
        expect(grantedProfile.status).toBe(200);
        expect(await grantedProfile.json()).toEqual({ updated: true });

        const grantedProfileTools = await managed.client.listTools();
        expect(grantedProfileTools.tools.map((tool) => tool.name)).toEqual([
          "use",
          "tools.search",
          "msg_read_room",
        ]);
        const resourceDeniedWithGrant = await managed.client.callTool({
          name: "msg_read_room",
          arguments: {
            room_url:
              "https://msg.0000.chat/room-capability-not-owned-by-managed-agent",
          },
        });
        expect(resourceDeniedWithGrant.isError).toBe(true);
        expect(textContent(resourceDeniedWithGrant)).toBe(
          "Msg operation failed.",
        );

        const revokedProfile = await gateway.dispatchFetch(
          new Request(
            "https://0000.chat/internal/profiles/org-a/profile-managed/grants/msg.read_room",
            {
              method: "DELETE",
              headers: adminHeaders,
            },
          ),
        );
        expect(revokedProfile.status).toBe(200);
        expect(await revokedProfile.json()).toEqual({ revoked: true });

        const revokedProfileTools = await managed.client.listTools();
        expect(revokedProfileTools.tools.map((tool) => tool.name)).toEqual([
          "use",
          "tools.search",
        ]);
        const deniedAfterRevoke = await managed.client.callTool({
          name: "msg_read_room",
          arguments: {
            room_url:
              "https://msg.0000.chat/room-capability-not-owned-by-managed-agent",
          },
        });
        expect(deniedAfterRevoke.isError).toBe(true);
        expect(textContent(deniedAfterRevoke)).toBe("Tool access denied.");
      } finally {
        await managed.client.close();
      }
    } finally {
      await Promise.all([agentA.client.close(), agentB.client.close()]);
    }
  } finally {
    await gateway.dispose();
  }
});
