import { describe, expect, test } from "bun:test"

import {
  AGENT_TOOL_MCP_TOOL_NAMES,
  AGENT_TOOL_MCP_INPUT_SCHEMAS,
  AGENT_TOOL_GUIDE_RESOURCE,
  AGENT_TOOL_SESSION_CONTEXT_RESOURCE,
  ARTIFACTS_FEATURE_FLAG_KEY,
  buildAgentToolMcpEnv,
  buildAgentToolGuideText,
  buildAgentToolSessionContextText,
  createAgentToolsMcpServer,
  getVisibleAgentToolMcpToolNames,
  invokeAgentToolOverHttp,
  toMcpToolResult,
} from "./agent-tools-mcp"

describe("agent tools MCP server helpers", () => {
  test("lists the portable agent tool names", () => {
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toEqual([
      "userPrompts.requestChoice",
      "threads.list",
      "threads.create",
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
      "artifacts.create",
      "artifacts.createUploadIntent",
      "artifacts.completeUpload",
      "artifacts.search",
      "artifacts.read",
      "artifacts.getContentUrl",
      "artifacts.link",
      "scripts.createDraft",
      "scripts.updateDraft",
      "scripts.search",
      "scripts.read",
    ])
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("threads.list")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("threads.create")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("databases.get")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).not.toContain("threads.current")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).not.toContain("threads.read")
  })

  test("describes 0000 Chat context and tool usage through MCP resources", () => {
    expect(AGENT_TOOL_GUIDE_RESOURCE).toBe("https://0000.chat/mcp/resources/agent-tools-guide")
    expect(AGENT_TOOL_SESSION_CONTEXT_RESOURCE).toBe("https://0000.chat/mcp/resources/session-context")

    expect(buildAgentToolGuideText()).toContain("You are operating inside 0000 Chat")
    expect(buildAgentToolGuideText()).toContain("userPrompts.requestChoice")
    expect(buildAgentToolGuideText()).toContain("multiple-choice UI")
    expect(buildAgentToolGuideText()).toContain("spaces.archive")
    expect(buildAgentToolGuideText()).toContain("threads.list")
    expect(buildAgentToolGuideText()).toContain("threads.create")
    expect(buildAgentToolGuideText()).toContain("agentIdOrSlug")
    expect(buildAgentToolGuideText()).not.toContain("threads.current")
    expect(buildAgentToolGuideText()).not.toContain("threads.read")
    expect(buildAgentToolGuideText()).not.toContain("call threads.current first")
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
    expect(buildAgentToolGuideText()).not.toContain("artifacts.create")
    expect(buildAgentToolGuideText()).not.toContain("artifacts.createUploadIntent")
    expect(buildAgentToolGuideText({ enabledFeatureFlags: [ARTIFACTS_FEATURE_FLAG_KEY] })).toContain(
      "artifacts.create",
    )
    expect(buildAgentToolGuideText({ enabledFeatureFlags: [ARTIFACTS_FEATURE_FLAG_KEY] })).toContain(
      "instead of local files",
    )
    expect(buildAgentToolGuideText()).toContain(
      "Do not call messages.search just to recover current-thread history",
    )
    expect(buildAgentToolGuideText()).not.toContain("use messages.search with that threadId")

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
    ).not.toContain("currentThreadTool")
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

  test("validates thread creation schema including self assignment", () => {
    const schema = AGENT_TOOL_MCP_INPUT_SCHEMAS["threads.create"]

    expect(schema.safeParse({
      agentIdOrSlug: "self",
      approvalLevel: "full_permissions",
      clientThreadId: "client-thread-123",
      initialUserMessage: "Start here only if requested.",
      requireAgentSession: true,
      spaceIdOrSlug: "build",
      summary: "Follow-up context",
      title: "Follow-up thread",
    }).success).toBe(true)
    expect(schema.safeParse({ title: "Missing space" }).success).toBe(false)
    expect(schema.safeParse({ approvalLevel: "always", spaceIdOrSlug: "build" }).success).toBe(false)
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
        ZERO_CHAT_ENABLED_FEATURE_FLAGS: "artifacts",
        ZERO_CHAT_THREAD_ID: "thread_abc",
      }),
    ).toEqual({
      agentSessionId: "agent_session_1",
      appUrl: "https://chat.example.test/app",
      bridgeToken: "secret-token",
      deviceId: "device_123",
      enabledFeatureFlags: ["artifacts"],
      threadId: "thread_abc",
      toolBaseUrl: "https://bridge.example.test",
    })
    expect(() => buildAgentToolMcpEnv({})).toThrow(/ZERO_CHAT_APP_URL/)
  })

  test("registers artifact MCP tools only when Artifacts is enabled", () => {
    expect(getVisibleAgentToolMcpToolNames()).not.toContain("artifacts.create")
    expect(getVisibleAgentToolMcpToolNames([ARTIFACTS_FEATURE_FLAG_KEY])).toEqual(
      expect.arrayContaining([
        "artifacts.create",
        "artifacts.createUploadIntent",
        "artifacts.completeUpload",
        "artifacts.search",
        "artifacts.read",
        "artifacts.getContentUrl",
        "artifacts.link",
      ]),
    )
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

  test("returns an MCP error result when the app endpoint does not answer before timeout", async () => {
    const result = await Promise.race([
      invokeAgentToolOverHttp(
        {
          agentSessionId: "agent_session_1",
          appUrl: "https://chat.example.test/app",
          bridgeToken: "secret-token",
          deviceId: "device_123",
        },
        "messages.search",
        { query: "status" },
        async () =>
          new Promise<Response>(() => {
            // Intentionally never resolves; invokeAgentToolOverHttp must abort it.
          }),
        { timeoutMs: 20 },
      ),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
    ])

    expect(result).toEqual({
      reasonCode: "TIMEOUT",
      error: "Agent tool request timed out after 20ms",
      ok: false,
      retryable: true,
      timeoutMs: 20,
      tool: "messages.search",
    })
  })

  test("returns structured error details for non-2xx HTTP responses", async () => {
    await expect(
      invokeAgentToolOverHttp(
        {
          agentSessionId: "agent_session_1",
          appUrl: "https://chat.example.test/app",
          bridgeToken: "secret-token",
          deviceId: "device_123",
        },
        "databases.get",
        { tableIdOrSlug: "customers" },
        async () =>
          new Response("x".repeat(5_000), {
            headers: { "content-type": "text/plain" },
            status: 502,
            statusText: "Bad Gateway",
          }),
      ),
    ).resolves.toEqual({
      error: "Agent tool request failed with HTTP 502",
      httpStatus: 502,
      ok: false,
      reasonCode: "HTTP_ERROR",
      retryable: true,
      tool: "databases.get",
    })
  })

  test("returns structured error details for invalid JSON responses", async () => {
    await expect(
      invokeAgentToolOverHttp(
        {
          agentSessionId: "agent_session_1",
          appUrl: "https://chat.example.test/app",
          bridgeToken: "secret-token",
          deviceId: "device_123",
        },
        "threads.list",
        { limit: 10 },
        async () =>
          new Response("{not-json", {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      ),
    ).resolves.toEqual({
      error: "Agent tool response was not valid JSON",
      ok: false,
      reasonCode: "INVALID_JSON",
      tool: "threads.list",
    })
  })

  test("returns structured error details for app error payloads", async () => {
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
        async () =>
          new Response(
            JSON.stringify({
              error:
                "Approval required for this write. " +
                "Do not leak secrets. ".repeat(200),
              ok: false,
              retryable: false,
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          ),
      ),
    ).resolves.toEqual({
      error:
        "Approval required for this write. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do not leak secrets. Do [truncated]",
      ok: false,
      reasonCode: "APP_ERROR",
      retryable: false,
      tool: "apps.create",
    })
  })

  test("returns structured error details for thrown fetch errors", async () => {
    await expect(
      invokeAgentToolOverHttp(
        {
          agentSessionId: "agent_session_1",
          appUrl: "https://chat.example.test/app",
          bridgeToken: "secret-token",
          deviceId: "device_123",
        },
        "databases.listRows",
        { tableIdOrSlug: "customers" },
        async () => {
          throw new Error("connect ECONNRESET while reaching bridge")
        },
      ),
    ).resolves.toEqual({
      error: "connect ECONNRESET while reaching bridge",
      ok: false,
      reasonCode: "FETCH_ERROR",
      retryable: true,
      tool: "databases.listRows",
    })
  })

  test("maps tool results and errors into MCP text content", () => {
    expect(toMcpToolResult({ ok: true, result: { slug: "customers" } })).toEqual({
      content: [
        { type: "text", text: '{\n  "ok": true,\n  "result": {\n    "slug": "customers"\n  }\n}' },
      ],
    })
    expect(toMcpToolResult({ error: "Denied", ok: false })).toEqual({
      content: [
        {
          type: "text",
          text: '{\n  "error": "Denied",\n  "ok": false,\n  "reasonCode": "APP_ERROR"\n}',
        },
      ],
      isError: true,
    })
  })

  test("bounds MCP error text and marks failures as errors", () => {
    const result = toMcpToolResult({
      error: "Approval required. " + "a".repeat(5_000),
      ok: false,
      reasonCode: "APP_ERROR",
      tool: "apps.create",
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.type).toBe("text")
    expect(result.content[0]?.text.length).toBeLessThan(2_000)
    expect(result.content[0]?.text).toContain('"reasonCode": "APP_ERROR"')
    expect(result.content[0]?.text).toContain('"tool": "apps.create"')
  })

  test("registers the allowed tools and converts thrown handler failures into MCP error results", async () => {
    const registeredToolNames: string[] = []
    let databasesGetHandler:
      | ((
          input: unknown,
        ) => Promise<{ content: Array<{ text: string; type: "text" }>; isError?: true }>)
      | undefined
    const prototype = Object.getPrototypeOf(createAgentToolsMcpServer({
      agentSessionId: "bootstrap",
      appUrl: "https://chat.example.test/app",
      bridgeToken: "secret-token",
      deviceId: "device_123",
    }))
    const originalRegisterTool = prototype.registerTool as (
      name: string,
      config: unknown,
      cb: (input: unknown) => Promise<unknown>,
    ) => void
    const originalFetch = globalThis.fetch

    try {
      prototype.registerTool = function (
        this: unknown,
        name: string,
        _config: unknown,
        cb: (input: unknown) => Promise<{
          content: Array<{ text: string; type: "text" }>
          isError?: true
        }>,
      ) {
        registeredToolNames.push(name)
        if (name === "databases.get") {
          databasesGetHandler = cb
        }
      }

      createAgentToolsMcpServer({
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test/app",
        bridgeToken: "secret-token",
        deviceId: "device_123",
      })

      globalThis.fetch = Object.assign(
        async () => {
          throw new Error("socket hang up")
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch
    } finally {
      prototype.registerTool = originalRegisterTool
    }

    expect(registeredToolNames).toContain("threads.list")
    expect(registeredToolNames).toContain("databases.get")
    expect(registeredToolNames).not.toContain("threads.current")
    expect(registeredToolNames).not.toContain("threads.read")

    expect(databasesGetHandler).toBeDefined()

    try {
      const result = await databasesGetHandler?.({ tableIdOrSlug: "customers" })
      expect(result).toEqual({
        content: [
          {
            text: '{\n  "error": "socket hang up",\n  "ok": false,\n  "reasonCode": "FETCH_ERROR",\n  "retryable": true,\n  "tool": "databases.get"\n}',
            type: "text",
          },
        ],
        isError: true,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
