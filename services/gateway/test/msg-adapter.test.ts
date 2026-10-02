import { expect, test } from "bun:test";

import { createMsgServiceCatalog } from "../src/msg-adapter";
import type { AgentPrincipal } from "../src/access";

const principal: AgentPrincipal = {
  kind: "agent",
  agentId: "agent-a",
  organizationId: "org-a",
  profileId: "profile-a",
};

function listedTool(name: string) {
  return {
    name,
    description: `Run ${name}.`,
    inputSchema: {
      type: "object",
      properties: { room_url: { type: "string", minLength: 1 } },
      required: ["room_url"],
    },
  };
}

test("Msg adapter consumes the complete paginated service-owned catalog", async () => {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> =
    [];
  const binding = {
    async fetch(_input: RequestInfo | URL, init?: RequestInit) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers: new Headers(init?.headers) });
      const params = body.params as Record<string, unknown>;
      const result =
        body.method === "tools/list" && params.cursor === undefined
          ? { tools: [listedTool("read_room")], nextCursor: "page-2" }
          : body.method === "tools/list"
            ? { tools: [listedTool("post_message")] }
            : {
                content: [
                  { type: "text", text: "ok", _meta: { private: "drop" } },
                ],
                structuredContent: { accepted: true },
                _meta: { private: "drop" },
              };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
  const catalog = createMsgServiceCatalog({ binding });
  const declarations = await catalog.getDeclarations();
  expect(declarations.map((tool) => tool.name)).toEqual([
    "msg_read_room",
    "msg_post_message",
  ]);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.headers.get("authorization")).toBeNull();
  expect(requests[0]?.headers.get("cookie")).toBeNull();
  expect(requests[0]?.headers.get("origin")).toBe("https://msg.0000.chat");

  const result = await declarations[0]!.invoke(
    principal,
    { room_url: "https://msg.0000.chat/room" },
    {
      operationId: declarations[0]!.operationId,
      signal: new AbortController().signal,
    },
  );
  expect(result.structuredContent).toEqual({ accepted: true });
  expect(result).not.toHaveProperty("_meta");
  expect(result.content[0]).toEqual({ type: "text", text: "ok" });
});

test("Msg adapter turns downstream tool errors into a generic result", async () => {
  const binding = {
    async fetch(_input: RequestInfo | URL, init?: RequestInit) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const result =
        body.method === "tools/list"
          ? { tools: [listedTool("read_room")] }
          : {
              isError: true,
              content: [
                { type: "text", text: "private management capability" },
              ],
            };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
  const [declaration] = await createMsgServiceCatalog({
    binding,
  }).getDeclarations();
  if (!declaration) throw new Error("Expected a Msg declaration.");
  const result = await declaration.invoke(
    principal,
    { room_url: "https://msg.0000.chat/room" },
    {
      operationId: declaration.operationId,
      signal: new AbortController().signal,
    },
  );
  expect(result).toEqual({
    isError: true,
    content: [{ type: "text", text: "Msg operation failed." }],
  });
});

test("Msg adapter bounds a response whose body stalls after headers", {
  timeout: 10_000,
}, async () => {
  let canceled = false;
  const binding = {
    async fetch() {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const started = performance.now();
  const declarations = await createMsgServiceCatalog({
    binding,
  }).getDeclarations();
  const elapsed = performance.now() - started;
  expect(declarations).toEqual([]);
  expect(canceled).toBe(true);
  expect(elapsed).toBeLessThan(4_500);
});
