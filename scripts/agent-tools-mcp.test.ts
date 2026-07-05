import { describe, expect, test } from "bun:test"

import {
  ACTIONS_RUNTIME_FEATURE_FLAG_KEY,
  AGENT_TOOL_CAPABILITY_PACKS_RESOURCE,
  AGENT_TOOL_BROKER_MCP_TOOL_NAMES,
  AGENT_TOOL_MCP_INPUT_SCHEMAS,
  AGENT_TOOL_MCP_TOOL_NAMES,
  AGENT_TOOL_SESSION_CONTEXT_RESOURCE,
  ARTIFACTS_FEATURE_FLAG_KEY,
  buildAgentToolGuideText,
  buildAgentToolMcpEnv,
  buildAgentToolSessionContextText,
  createAgentToolsMcpServer,
  describeAgentToolCatalogEntry,
  getVisibleAgentToolMcpToolNames,
  invokeAgentToolOverHttp,
  searchAgentToolCatalog,
  toMcpToolResult,
} from "./agent-tools-mcp"

describe("agent tools MCP server helpers", () => {
  test("uses the generated app-manifest tool surface", () => {
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("capabilities.describe")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("context.get")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("objects.get")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("threads.current")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("threads.read")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("threads.readActivity")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("threads.fork")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("tags.assign")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("databaseViews.list")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("bridgeDevices.list")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("notifications.getBrowserConfig")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("actions.updateDraft")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).not.toContain("github.createPullRequest")
    expect(AGENT_TOOL_MCP_TOOL_NAMES.some((name) => name.startsWith("scripts."))).toBe(false)
  })

  test("builds zod schemas from the generated snapshot", () => {
    expect(AGENT_TOOL_MCP_INPUT_SCHEMAS["context.get"].safeParse({}).success).toBe(true)
    expect(AGENT_TOOL_MCP_INPUT_SCHEMAS["objects.get"].safeParse({ object: { id: "thread_1", type: "thread" } }).success).toBe(true)
    expect(AGENT_TOOL_MCP_INPUT_SCHEMAS["threads.fork"].safeParse({ sourceThreadId: "thread_1", title: "Fork" }).success).toBe(true)
    expect(AGENT_TOOL_MCP_INPUT_SCHEMAS["databases.createField"].safeParse({
      displayName: "Status",
      fieldKey: "status",
      fieldPreset: "single_select",
      options: [{ color: "green", key: "active", label: "Active" }],
      tableId: "table_1",
    }).success).toBe(true)
    expect(AGENT_TOOL_MCP_INPUT_SCHEMAS["databases.createField"].safeParse({
      displayName: "Status",
      fieldKey: "status",
      fieldPreset: "single_select",
      options: [{ key: "active" }],
      tableId: "table_1",
    }).success).toBe(false)
    expect(AGENT_TOOL_MCP_INPUT_SCHEMAS["actions.updateDraft"].safeParse({
      actionId: "action_1",
      code: "export default {}",
      description: "Update",
      kind: "agent_action",
      manifest: {},
      name: "Updated action",
    }).success).toBe(true)
    expect(AGENT_TOOL_MCP_INPUT_SCHEMAS["actions.updateDraft"].safeParse({ actionId: "action_1" }).success).toBe(false)
  })

  test("hard-switches MCP exposure to broker tools only", () => {
    expect(AGENT_TOOL_BROKER_MCP_TOOL_NAMES).toEqual(["tools.search", "tools.describe", "tools.call", "tools.executePlan"])
    expect(getVisibleAgentToolMcpToolNames()).toEqual([...AGENT_TOOL_BROKER_MCP_TOOL_NAMES])
    expect(getVisibleAgentToolMcpToolNames(["thread", "database"], [ARTIFACTS_FEATURE_FLAG_KEY, ACTIONS_RUNTIME_FEATURE_FLAG_KEY])).toEqual([
      ...AGENT_TOOL_BROKER_MCP_TOOL_NAMES,
    ])
  })

  test("searches and describes the hidden 0000 tool catalog", () => {
    const search = searchAgentToolCatalog({ query: "create thread", limit: 5 })
    expect(search.items.map((item) => item.tool)).toContain("threads.create")
    expect(search.items.every((item) => typeof item.score === "number" && item.score > 0)).toBe(true)

    const automation = searchAgentToolCatalog({ query: "edit this automation", limit: 5 })
    expect(automation.items.map((item) => item.tool)).toContain("automations.update")

    const withoutActionsRun = describeAgentToolCatalogEntry("actions.run")
    expect("error" in withoutActionsRun).toBe(true)
    const withActionsRun = describeAgentToolCatalogEntry("actions.run", [ACTIONS_RUNTIME_FEATURE_FLAG_KEY])
    expect(withActionsRun).toMatchObject({ capabilityPack: "actions", tool: "actions.run" })
  })

  test("loads bridge env including active surfaces and feature flags", () => {
    expect(buildAgentToolMcpEnv({
      ZERO_CHAT_ACTIVE_TOOL_SURFACES: "thread,database,unknown,thread",
      ZERO_CHAT_AGENT_SESSION_ID: "agent_session_1",
      ZERO_CHAT_AGENT_TOOLS_URL: "https://bridge.example.test",
      ZERO_CHAT_APP_URL: "https://chat.example.test/app",
      ZERO_CHAT_BRIDGE_DEVICE_ID: "device_123",
      ZERO_CHAT_BRIDGE_TOKEN: "secret-token",
      ZERO_CHAT_ENABLED_FEATURE_FLAGS: "artifacts,future-flag,actions-runtime",
      ZERO_CHAT_THREAD_ID: "thread_abc",
    })).toEqual({
      activeToolSurfaces: ["thread", "database"],
      agentSessionId: "agent_session_1",
      appUrl: "https://chat.example.test/app",
      bridgeToken: "secret-token",
      deviceId: "device_123",
      enabledFeatureFlags: ["artifacts", "actions-runtime"],
      threadId: "thread_abc",
      toolBaseUrl: "https://bridge.example.test",
    })
    expect(() => buildAgentToolMcpEnv({})).toThrow(/ZERO_CHAT_APP_URL/)
  })

  test("describes progressive disclosure and capability pack resources", () => {
    expect(AGENT_TOOL_CAPABILITY_PACKS_RESOURCE).toBe("https://0000.chat/mcp/resources/capabilities/packs")
    expect(buildAgentToolGuideText()).toContain("hard-switched to a small broker")
    expect(buildAgentToolGuideText()).toContain("tools.search")
    expect(buildAgentToolGuideText()).toContain("threads.current")
    expect(buildAgentToolGuideText()).toContain("capability packs")
    expect(buildAgentToolGuideText()).not.toContain("github.createPullRequest")
    expect(buildAgentToolGuideText()).not.toContain("scripts.createDraft")
    expect(buildAgentToolGuideText()).toContain("actions.run is feature-flagged")
    expect(buildAgentToolGuideText({ enabledFeatureFlags: [ACTIONS_RUNTIME_FEATURE_FLAG_KEY] })).toContain("actions.run")

    expect(buildAgentToolSessionContextText({
      activeToolSurfaces: ["thread", "app"],
      agentSessionId: "agent_session_1",
      appUrl: "https://chat.example.test/app",
      bridgeToken: "secret-token",
      deviceId: "device_123",
      enabledFeatureFlags: ["artifacts"],
      threadId: "thread_abc",
    })).toContain("activeToolSurfaces: thread,app (legacy hint only")
    expect(buildAgentToolSessionContextText({
      agentSessionId: "agent_session_1",
      appUrl: "https://chat.example.test/app",
      bridgeToken: "secret-token",
      deviceId: "device_123",
      threadId: "thread_abc",
    })).toContain("mcpServer: 0000\n")
    expect(AGENT_TOOL_SESSION_CONTEXT_RESOURCE).toBe("https://0000.chat/mcp/resources/session-context")
  })

  test("forwards MCP tool calls to the bridge-authenticated app endpoint", async () => {
    const requests: Request[] = []
    await expect(invokeAgentToolOverHttp(
      {
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test/app",
        bridgeToken: "secret-token",
        deviceId: "device_123",
        threadId: "thread_abc",
        toolBaseUrl: "https://bridge.example.test",
      },
      "context.get",
      {},
      async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(JSON.stringify({ ok: true, result: { threadId: "thread_abc" } }), { status: 200 })
      },
    )).resolves.toEqual({ ok: true, result: { threadId: "thread_abc" } })

    expect(requests[0]?.url).toBe("https://bridge.example.test/api/agent-tools/invoke")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret-token")
    expect(await requests[0]?.json()).toEqual({
      agentSessionId: "agent_session_1",
      deviceId: "device_123",
      input: {},
      threadId: "thread_abc",
      tool: "context.get",
    })
  })

  test("returns structured error details for timeout, HTTP, JSON, app, and fetch failures", async () => {
    await expect(invokeAgentToolOverHttp(
      { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test/app", bridgeToken: "secret-token", deviceId: "device_123" },
      "threads.read",
      { threadId: "thread_123" },
      async () => new Promise<Response>(() => {}),
      { timeoutMs: 20 },
    )).resolves.toEqual({ error: "Agent tool request timed out after 20ms", ok: false, reasonCode: "TIMEOUT", retryable: true, timeoutMs: 20, tool: "threads.read" })

    await expect(invokeAgentToolOverHttp(
      { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test/app", bridgeToken: "secret-token", deviceId: "device_123" },
      "databases.get",
      { tableIdOrSlug: "customers" },
      async () => new Response("bad", { status: 502 }),
    )).resolves.toEqual({ error: "Agent tool request failed with HTTP 502", httpStatus: 502, ok: false, reasonCode: "HTTP_ERROR", retryable: true, tool: "databases.get" })

    await expect(invokeAgentToolOverHttp(
      { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test/app", bridgeToken: "secret-token", deviceId: "device_123" },
      "threads.list",
      { limit: 10 },
      async () => new Response("{not-json", { status: 200 }),
    )).resolves.toEqual({ error: "Agent tool response was not valid JSON", ok: false, reasonCode: "INVALID_JSON", tool: "threads.list" })

    await expect(invokeAgentToolOverHttp(
      { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test/app", bridgeToken: "secret-token", deviceId: "device_123" },
      "apps.create",
      { spaceIdOrSlug: "projects", title: "Health" },
      async () => new Response(JSON.stringify({ error: "Approval required", ok: false, retryable: false }), { status: 200 }),
    )).resolves.toEqual({ error: "Approval required", ok: false, reasonCode: "APP_ERROR", retryable: false, tool: "apps.create" })

    await expect(invokeAgentToolOverHttp(
      { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test/app", bridgeToken: "secret-token", deviceId: "device_123" },
      "databases.listRows",
      { tableIdOrSlug: "customers" },
      async () => { throw new Error("connect ECONNRESET while reaching bridge") },
    )).resolves.toEqual({ error: "connect ECONNRESET while reaching bridge", ok: false, reasonCode: "FETCH_ERROR", retryable: true, tool: "databases.listRows" })
  })

  test("maps tool results and bounded errors into MCP text content", () => {
    expect(toMcpToolResult({ ok: true, result: { slug: "customers" } })).toEqual({
      content: [{ type: "text", text: '{\n  "ok": true,\n  "result": {\n    "slug": "customers"\n  }\n}' }],
    })
    const result = toMcpToolResult({ error: "Approval required. " + "a".repeat(5_000), ok: false, reasonCode: "APP_ERROR", tool: "apps.create" })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text.length).toBeLessThan(2_000)
    expect(result.content[0]?.text).toContain('"tool": "apps.create"')
  })

  test("registers visible tools and capability resources", async () => {
    const registeredToolNames: string[] = []
    const registeredResourceNames: string[] = []
    let contextGetHandler: ((input: unknown) => Promise<{ content: Array<{ text: string; type: "text" }>; isError?: true }>) | undefined
    const prototype = Object.getPrototypeOf(createAgentToolsMcpServer({
      agentSessionId: "bootstrap",
      appUrl: "https://chat.example.test/app",
      bridgeToken: "secret-token",
      deviceId: "device_123",
    }))
    const originalRegisterTool = prototype.registerTool
    const originalRegisterResource = prototype.registerResource
    const originalFetch = globalThis.fetch

    try {
      prototype.registerTool = function (_thisName: string, _config: unknown, cb: (input: unknown) => Promise<{ content: Array<{ text: string; type: "text" }>; isError?: true }>) {
        registeredToolNames.push(_thisName)
        if (_thisName === "context.get") contextGetHandler = cb
      }
      prototype.registerResource = function (name: string) {
        registeredResourceNames.push(name)
      }
      createAgentToolsMcpServer({
        activeToolSurfaces: ["thread"],
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test/app",
        bridgeToken: "secret-token",
        deviceId: "device_123",
      })
      globalThis.fetch = Object.assign(async () => { throw new Error("socket hang up") }, { preconnect: originalFetch.preconnect }) as typeof fetch
    } finally {
      prototype.registerTool = originalRegisterTool
      prototype.registerResource = originalRegisterResource
    }

    expect(registeredResourceNames).toContain("0000 Chat capability packs")
    expect(registeredResourceNames).toContain("0000 Chat core capability pack")
    expect(registeredToolNames).toEqual(["tools.search", "tools.describe", "tools.call", "tools.executePlan"])
    expect(registeredToolNames).not.toContain("context.get")
    expect(registeredToolNames).not.toContain("threads.list")
    expect(registeredToolNames).not.toContain("databases.get")
    expect(registeredToolNames).not.toContain("github.createPullRequest")
    expect(registeredToolNames.some((name) => name.startsWith("scripts."))).toBe(false)

    expect(contextGetHandler).toBeUndefined()
    globalThis.fetch = originalFetch
  })
})
