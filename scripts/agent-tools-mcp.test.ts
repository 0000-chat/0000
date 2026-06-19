import { describe, expect, test } from "bun:test"

import {
  AGENT_TOOL_MCP_TOOL_NAMES,
  AGENT_TOOL_MCP_INPUT_SCHEMAS,
  AGENT_TOOL_GUIDE_RESOURCE,
  AGENT_TOOL_SESSION_CONTEXT_RESOURCE,
  buildAgentToolMcpEnv,
  buildAgentToolGuideText,
  buildAgentToolSessionContextText,
  invokeAgentToolOverHttp,
  toMcpToolResult,
} from "./agent-tools-mcp"

describe("agent tools MCP server helpers", () => {
  test("lists the portable agent tool names", () => {
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toEqual([
      "userPrompts.requestChoice",
      "threads.current",
      "threads.list",
      "threads.read",
      "messages.search",
      "settings.setDefaultApprovalLevel",
      "agents.list",
      "agents.sendMailboxMessage",
      "spaces.list",
      "spaces.get",
      "spaces.create",
      "spaces.update",
      "spaces.archive",
      "spaces.unarchive",
      "apps.list",
      "apps.get",
      "apps.create",
      "apps.createRevision",
      "apps.generateFromRevision",
      "apps.listGenerations",
      "apps.update",
      "apps.archive",
      "apps.validateOpenUi",
      "automations.list",
      "automations.get",
      "automations.create",
      "automations.update",
      "automations.disable",
      "automations.runNow",
      "databases.list",
      "databases.get",
      "databases.listRows",
      "databases.getRow",
      "databases.searchRows",
      "databases.create",
      "databases.createField",
      "databases.createRow",
      "databases.updateRow",
      "databases.deleteRow",
      "secrets.put",
      "secrets.listAvailable",
      "scripts.createDraft",
      "scripts.updateDraft",
      "scripts.search",
      "scripts.read",
    ])
  })

  test("describes 0000 Chat context and tool usage through MCP resources", () => {
    expect(AGENT_TOOL_GUIDE_RESOURCE).toBe("https://0000.chat/mcp/resources/agent-tools-guide")
    expect(AGENT_TOOL_SESSION_CONTEXT_RESOURCE).toBe("https://0000.chat/mcp/resources/session-context")

    expect(buildAgentToolGuideText()).toContain("You are operating inside 0000 Chat")
    expect(buildAgentToolGuideText()).toContain("userPrompts.requestChoice")
    expect(buildAgentToolGuideText()).toContain("multiple-choice UI")
    expect(buildAgentToolGuideText()).toContain("spaces.archive")
    expect(buildAgentToolGuideText()).toContain("threads.current")
    expect(buildAgentToolGuideText()).toContain("call threads.current first")
    expect(buildAgentToolGuideText()).toContain("settings.setDefaultApprovalLevel")
    expect(buildAgentToolGuideText()).toContain("trusted local automation")
    expect(buildAgentToolGuideText()).toContain("in-thread approval")
    expect(buildAgentToolGuideText()).toContain("agents.list")
    expect(buildAgentToolGuideText()).toContain("agent-to-agent handoffs")
    expect(buildAgentToolGuideText()).toContain("agents.sendMailboxMessage")
    expect(buildAgentToolGuideText()).toContain("autoArchiveInactiveThreadsAfterHours")
    expect(buildAgentToolGuideText()).toContain("apps.create")
    expect(buildAgentToolGuideText()).toContain("brand-new app")
    expect(buildAgentToolGuideText()).toContain("apps.generateFromRevision")
    expect(buildAgentToolGuideText()).toContain("AppCanvas")
    expect(buildAgentToolGuideText()).toContain("apps.validateOpenUi")
    expect(buildAgentToolGuideText()).toContain("Do not create an HTML file")
    expect(buildAgentToolGuideText()).toContain("save a 0000 app")
    expect(buildAgentToolGuideText()).toContain("automations.create")
    expect(buildAgentToolGuideText()).toContain("full permissions")
    expect(buildAgentToolGuideText()).toContain("databases.searchRows")
    expect(buildAgentToolGuideText()).toContain("Inspect existing databases before creating")
    expect(buildAgentToolGuideText()).toContain("Store or update structured data")
    expect(buildAgentToolGuideText()).toContain("re-read those records on refresh")
    expect(buildAgentToolGuideText()).toContain("secrets.put")
    expect(buildAgentToolGuideText()).toContain("Secret values are encrypted by 0000 Chat")
    expect(buildAgentToolGuideText()).toContain("secrets.listAvailable")
    expect(buildAgentToolGuideText()).toContain("scripts.createDraft")
    expect(buildAgentToolGuideText()).toContain("Never request raw Convex credentials")

    expect(
      buildAgentToolSessionContextText({
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test/app",
        bridgeToken: "secret-token",
        deviceId: "device_123",
        threadId: "thread_abc",
      }),
    ).toContain("currentThreadId: thread_abc")
    expect(
      buildAgentToolSessionContextText({
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test/app",
        bridgeToken: "secret-token",
        deviceId: "device_123",
        threadId: "thread_abc",
      }),
    ).toContain("mcpServer: 0000\n")
    expect(
      buildAgentToolSessionContextText({
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test/app",
        bridgeToken: "secret-token",
        deviceId: "device_123",
        threadId: "thread_abc",
      }),
    ).not.toContain("mcpServer: 0000-chat")
  })

  test("keeps the public mailbox tool schema aligned with conversation replies", () => {
    const schema = AGENT_TOOL_MCP_INPUT_SCHEMAS["agents.sendMailboxMessage"]

    expect(schema.safeParse({
      body: "Can you take this follow-up?",
      maxHops: 2,
      parentMailboxMessageId: "mailbox_message_123",
      responsePolicy: "reply-requested",
      subject: "Delegated task",
      toAgentIdOrSlug: "codex",
    }).success).toBe(true)

    expect(schema.safeParse({
      body: "Please archive this when done.",
      responsePolicy: "not-a-policy",
      subject: "Bad policy",
      toAgentIdOrSlug: "codex",
    }).success).toBe(false)

    expect(buildAgentToolGuideText()).toContain("reply-requested")
    expect(buildAgentToolGuideText()).toContain("parentMailboxMessageId")
  })

  test("loads required bridge and session environment", () => {
    expect(
      buildAgentToolMcpEnv({
        ZERO_CHAT_AGENT_SESSION_ID: "agent_session_1",
        ZERO_CHAT_APP_URL: "https://chat.example.test/app",
        ZERO_CHAT_AGENT_TOOLS_URL: "https://bridge.example.test",
        ZERO_CHAT_BRIDGE_DEVICE_ID: "device_123",
        ZERO_CHAT_BRIDGE_TOKEN: "secret-token",
        ZERO_CHAT_THREAD_ID: "thread_abc",
      }),
    ).toEqual({
      agentSessionId: "agent_session_1",
      appUrl: "https://chat.example.test/app",
      bridgeToken: "secret-token",
      deviceId: "device_123",
      threadId: "thread_abc",
      toolBaseUrl: "https://bridge.example.test",
    })
    expect(() => buildAgentToolMcpEnv({})).toThrow(/ZERO_CHAT_APP_URL/)
  })

  test("forwards MCP tool calls to the bridge-authenticated app endpoint", async () => {
    const requests: Request[] = []

    await expect(
      invokeAgentToolOverHttp(
        {
          agentSessionId: "agent_session_1",
          appUrl: "https://chat.example.test/app",
          bridgeToken: "secret-token",
          deviceId: "device_123",
          threadId: "thread_abc",
          toolBaseUrl: "https://bridge.example.test",
        },
        "databases.create",
        { name: "Customers" },
        async (input, init) => {
          requests.push(new Request(input, init))
          return new Response(JSON.stringify({ ok: true, result: { slug: "customers" } }), {
            headers: { "content-type": "application/json" },
            status: 200,
          })
        },
      ),
    ).resolves.toEqual({ ok: true, result: { slug: "customers" } })

    expect(requests[0]?.url).toBe("https://bridge.example.test/api/agent-tools/invoke")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret-token")
    expect(await requests[0]?.json()).toEqual({
      agentSessionId: "agent_session_1",
      deviceId: "device_123",
      input: { name: "Customers" },
      threadId: "thread_abc",
      tool: "databases.create",
    })
  })

  test("forwards app MCP tool calls to the bridge-authenticated app endpoint", async () => {
    const requests: Request[] = []

    await expect(
      invokeAgentToolOverHttp(
        {
          agentSessionId: "agent_session_1",
          appUrl: "https://chat.example.test/app",
          bridgeToken: "secret-token",
          deviceId: "device_123",
        },
        "apps.create",
        {
          prompt: "Create an OpenUI app rooted at AppCanvas.",
          spaceIdOrSlug: "projects",
          title: "Health",
        },
        async (input, init) => {
          requests.push(new Request(input, init))
          return new Response(JSON.stringify({ ok: true, result: { slug: "health" } }), {
            headers: { "content-type": "application/json" },
            status: 200,
          })
        },
      ),
    ).resolves.toEqual({ ok: true, result: { slug: "health" } })

    expect(await requests[0]?.json()).toEqual({
      agentSessionId: "agent_session_1",
      deviceId: "device_123",
      input: {
        prompt: "Create an OpenUI app rooted at AppCanvas.",
        spaceIdOrSlug: "projects",
        title: "Health",
      },
      tool: "apps.create",
    })
  })

  test("maps tool results and errors into MCP text content", () => {
    expect(toMcpToolResult({ ok: true, result: { slug: "customers" } })).toEqual({
      content: [
        { type: "text", text: '{\n  "ok": true,\n  "result": {\n    "slug": "customers"\n  }\n}' },
      ],
    })
    expect(toMcpToolResult({ error: "Denied", ok: false })).toEqual({
      content: [{ type: "text", text: '{\n  "error": "Denied",\n  "ok": false\n}' }],
      isError: true,
    })
  })
})
