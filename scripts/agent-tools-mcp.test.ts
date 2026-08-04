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
  executeCatalogPlan,
  getVisibleAgentToolMcpToolNames,
  invokeAgentToolOverHttp,
  parseAgentToolMcpFeatureFlags,
  searchAgentToolCatalog,
  toMcpToolResult,
} from "./agent-tools-mcp"
import {
  buildAgentToolManifestSnapshotSource,
  renderAgentToolManifestSnapshotModule,
  verifyAgentToolManifestSnapshotModule,
} from "./generate-agent-tool-manifest-snapshot"

describe("agent tools MCP server helpers", () => {
  test("generates and checks the bridge manifest snapshot from the app portable snapshot", async () => {
    const portableSnapshot = {
      capabilityPackOrder: ["core"],
      capabilityPacks: { core: { contexts: [], defaultVisibility: "core", name: "core", title: "Core", tools: [] } },
      generatedBy: "bun scripts/export-agent-tool-mcp-manifest.ts --write",
      note: "fixture",
      schemaVersion: 1,
      source: "apps/convex/convex/agentToolManifest.ts",
      toolNames: ["context.get"],
      tools: {
        "context.get": {
          annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
          approvalBehavior: "read_only",
          capabilityPack: "core",
          description: "Read context.",
          effect: "read",
          executionMode: "read",
          inputSchema: {},
          risk: "read",
          visibility: "core",
        },
      },
    }

    const source = await buildAgentToolManifestSnapshotSource({ portableSnapshot })
    expect(source).toContain("Portable bridge MCP snapshot generated from 0000 Chat")
    expect(source).toContain("AGENT_TOOL_MANIFEST_SNAPSHOT")
    expect(source).toContain('"context.get"')
    expect(renderAgentToolManifestSnapshotModule(portableSnapshot)).toBe(source)
    expect(verifyAgentToolManifestSnapshotModule({ actual: source, portableSnapshot }).ok).toBe(true)
    expect(verifyAgentToolManifestSnapshotModule({ actual: source.replace("Read context", "Drifted context"), portableSnapshot }).ok).toBe(false)
  })

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
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("runtime.readEvidence")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("notifications.getBrowserConfig")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("actions.updateDraft")
    expect(AGENT_TOOL_MCP_TOOL_NAMES).toContain("apps.code.create")
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

  test("hard-switches MCP exposure to broker tools plus the Architect advisor", () => {
    expect(AGENT_TOOL_BROKER_MCP_TOOL_NAMES).toEqual([
      "tools.search",
      "tools.describe",
      "tools.call",
      "tools.executePlan",
      "tools.executeCode",
    ])
    expect(getVisibleAgentToolMcpToolNames()).toEqual([
      ...AGENT_TOOL_BROKER_MCP_TOOL_NAMES,
      "capabilities.advise",
    ])
    expect(getVisibleAgentToolMcpToolNames(["thread", "database"], [ARTIFACTS_FEATURE_FLAG_KEY, ACTIONS_RUNTIME_FEATURE_FLAG_KEY])).toEqual([
      ...AGENT_TOOL_BROKER_MCP_TOOL_NAMES,
      "capabilities.advise",
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

  test("keeps React code catalog tools fail-closed until their feature flag is present", () => {
    expect(parseAgentToolMcpFeatureFlags("react-code-apps,future-flag")).toEqual(["react-code-apps"])

    const withoutFlag = searchAgentToolCatalog({ query: "describe runtime", limit: 10 })
    expect(withoutFlag.items.map((item) => item.tool)).not.toContain("apps.code.describeRuntime")
    expect(describeAgentToolCatalogEntry("apps.code.describeRuntime")).toMatchObject({
      error: { code: "tool_not_found" },
    })

    const withFlag = searchAgentToolCatalog({
      enabledFeatureFlags: ["react-code-apps"],
      limit: 10,
      query: "describe runtime",
    })
    expect(withFlag.items.map((item) => item.tool)).toContain("apps.code.describeRuntime")
    expect(describeAgentToolCatalogEntry("apps.code.describeRuntime", ["react-code-apps"])).toMatchObject({
      capabilityPack: "apps",
      tool: "apps.code.describeRuntime",
    })
  })

  test("derives Machine catalog access from generated manifest feature flags", () => {
    expect(parseAgentToolMcpFeatureFlags("machines,future-flag")).toEqual(["machines"])

    const withoutFlag = searchAgentToolCatalog({ query: "list active machine enrollments", limit: 10 })
    expect(withoutFlag.items.map((item) => item.tool)).not.toContain("machineEnrollments.listActive")
    expect(describeAgentToolCatalogEntry("machineEnrollments.listActive")).toMatchObject({
      error: { code: "tool_not_found" },
    })

    const withFlag = searchAgentToolCatalog({
      enabledFeatureFlags: ["machines"],
      limit: 10,
      query: "list active machine enrollments",
    })
    expect(withFlag.items.map((item) => item.tool)).toContain("machineEnrollments.listActive")
    expect(describeAgentToolCatalogEntry("machineEnrollments.listActive", ["machines"])).toMatchObject({
      capabilityPack: "admin",
      tool: "machineEnrollments.listActive",
    })
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

  test("uploads bounded React source and completes it without sending source bytes to Convex", async () => {
    const requests: Request[] = []
    const sourceText = "export default function App() { return <main>Hello</main> }"

    const result = await invokeAgentToolOverHttp(
      {
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test/app",
        bridgeToken: "secret-token",
        deviceId: "device_123",
      },
      "apps.code.reserveSource",
      {
        appId: "react_app_1",
        completionOperationId: "complete_source_1",
        editSessionId: "react_edit_1",
        operationId: "reserve_source_1",
        sourceText,
      },
      async (input, init) => {
        const request = new Request(input, init)
        requests.push(request.clone())
        if (request.url === "https://upload.example.test/source") {
          expect(await request.text()).toBe(sourceText)
          expect(request.headers.get("x-upload-token")).toBe("bounded")
          expect(request.redirect).toBe("error")
          return new Response(null, { status: 200 })
        }
        const body = (await request.json()) as {
          agentSessionId: string
          deviceId: string
          input: Record<string, unknown>
          tool: string
        }
        if (body.tool === "apps.code.reserveSource") {
          expect(body.input.sourceText).toBeUndefined()
          expect(body.input.sourceBase64).toBeUndefined()
          expect(body.input.byteLength).toBe(new TextEncoder().encode(sourceText).byteLength)
          expect(body.input.sha256).toMatch(/^[a-f0-9]{64}$/)
          return Response.json({
            ok: true,
            result: {
              requiredUploadHeaders: { "x-upload-token": "bounded" },
              sourceBlobId: "source_blob_1",
              status: "pending",
              uploadUrl: "https://upload.example.test/source",
            },
          })
        }
        expect(body).toEqual({
          agentSessionId: "agent_session_1",
          deviceId: "device_123",
          input: {
            appId: "react_app_1",
            editSessionId: "react_edit_1",
            operationId: "complete_source_1",
            sourceBlobId: "source_blob_1",
          },
          tool: "apps.code.completeSource",
        })
        return Response.json({
          ok: true,
          result: { replayed: false, sourceBlobId: "source_blob_1", status: "available" },
        })
      },
    )

    expect(result).toEqual({
      ok: true,
      result: { replayed: false, sourceBlobId: "source_blob_1", status: "available" },
    })
    expect(requests).toHaveLength(3)
  })

  test("does not expose a signed upload URL when the private source upload fails", async () => {
    const privateMarker = "private-upload-signature"
    const result = await invokeAgentToolOverHttp(
      {
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test",
        bridgeToken: "secret-token",
        deviceId: "device_123",
      },
      "apps.code.reserveSource",
      {
        appId: "react_app_1",
        editSessionId: "react_edit_1",
        operationId: "reserve_source_failed_upload",
        sourceText: "export default function App() { return null }",
      },
      async (input, init) => {
        const request = new Request(input, init)
        if (request.url.startsWith("https://upload.example.test/source")) {
          throw new Error(`fetch failed for ${request.url}`)
        }
        return Response.json({
          ok: true,
          result: {
            sourceBlobId: "source_blob_1",
            status: "pending",
            uploadUrl: `https://upload.example.test/source?signature=${privateMarker}`,
          },
        })
      },
    )

    expect(result).toMatchObject({
      error: "React code source upload failed",
      ok: false,
      tool: "apps.code.reserveSource",
    })
    expect(JSON.stringify(result)).not.toContain(privateMarker)
  })

  test("preserves a failed React source reservation receipt without attempting upload", async () => {
    let requests = 0
    const result = await invokeAgentToolOverHttp(
      {
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test",
        bridgeToken: "secret-token",
        deviceId: "device_123",
      },
      "apps.code.reserveSource",
      {
        appId: "react_app_1",
        editSessionId: "react_edit_1",
        operationId: "reserve_source_unavailable",
        sourceText: "export default null",
      },
      async () => {
        requests += 1
        return new Response("unavailable", { status: 503 })
      },
    )

    expect(result).toEqual({
      error: "Agent tool request failed with HTTP 503",
      httpStatus: 503,
      ok: false,
      reasonCode: "HTTP_ERROR",
      retryable: true,
      tool: "apps.code.reserveSource",
    })
    expect(requests).toBe(1)
  })

  test("redacts signed URLs in failed React source reservation receipts", async () => {
    const marker = "private-reservation-signature"
    const result = await invokeAgentToolOverHttp(
      { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test", bridgeToken: "secret-token", deviceId: "device_123" },
      "apps.code.reserveSource",
      { appId: "react_app_1", editSessionId: "react_edit_1", operationId: "reserve_failed", sourceText: "export default null" },
      async () => Response.json({
        error: `Upload failed at https://upload.example.test/source?signature=${marker}`,
        httpStatus: 503,
        ok: false,
        reasonCode: "HTTP_ERROR",
        retryable: true,
      }),
    )

    expect(result).toMatchObject({ httpStatus: 503, ok: false, reasonCode: "HTTP_ERROR", retryable: true })
    expect(JSON.stringify(result)).not.toContain(marker)
  })

  test("derives distinct bounded completion operation IDs for long reservation IDs", async () => {
    const completionIds: string[] = []
    for (const suffix of ["a", "b"]) {
      const operationId = `${"x".repeat(127)}${suffix}`
      await invokeAgentToolOverHttp(
        { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test", bridgeToken: "secret-token", deviceId: "device_123" },
        "apps.code.reserveSource",
        { appId: "react_app_1", editSessionId: "react_edit_1", operationId, sourceText: "export default null" },
        async (input, init) => {
          const request = new Request(input, init)
          if (request.url === "https://upload.example.test/source") return new Response(null, { status: 200 })
          const body = await request.json() as { input: { operationId: string }; tool: string }
          if (body.tool === "apps.code.completeSource") completionIds.push(body.input.operationId)
          return body.tool === "apps.code.reserveSource"
            ? Response.json({ ok: true, result: { sourceBlobId: `blob_${suffix}`, status: "pending", uploadUrl: "https://upload.example.test/source" } })
            : Response.json({ ok: true, result: { status: "available" } })
        },
      )
    }
    expect(completionIds).toHaveLength(2)
    expect(completionIds[0]).not.toBe(completionIds[1])
    expect(completionIds.every((value) => value.length <= 128)).toBe(true)
  })

  test("applies one timeout budget across React source reserve, upload, and complete", async () => {
    let requests = 0
    const result = await invokeAgentToolOverHttp(
      { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test", bridgeToken: "secret-token", deviceId: "device_123" },
      "apps.code.reserveSource",
      { appId: "react_app_1", editSessionId: "react_edit_1", operationId: "reserve_slow", sourceText: "export default null" },
      async (input, init) => {
        requests += 1
        await Bun.sleep(15)
        const request = new Request(input, init)
        if (request.url === "https://upload.example.test/source") return new Response(null, { status: 200 })
        return Response.json({ ok: true, result: { sourceBlobId: "source_blob_1", status: "pending", uploadUrl: "https://upload.example.test/source" } })
      },
      { timeoutMs: 25 },
    )
    expect(result).toMatchObject({ ok: false, reasonCode: "TIMEOUT", retryable: true })
    expect(requests).toBe(2)
  })

  test.each([409, 412])("completes React source after a replay-safe %s upload response", async (status) => {
    const tools: string[] = []
    const result = await invokeAgentToolOverHttp(
      {
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test",
        bridgeToken: "secret-token",
        deviceId: "device_123",
      },
      "apps.code.reserveSource",
      {
        appId: "react_app_1",
        editSessionId: "react_edit_1",
        operationId: `reserve_source_${status}`,
        sourceBase64: Buffer.from("export default null").toString("base64"),
      },
      async (input, init) => {
        const request = new Request(input, init)
        if (request.url === "https://upload.example.test/source") {
          return new Response(null, { status })
        }
        const body = await request.json() as { tool: string }
        tools.push(body.tool)
        return body.tool === "apps.code.reserveSource"
          ? Response.json({
              ok: true,
              result: {
                sourceBlobId: "source_blob_1",
                status: "pending",
                uploadUrl: "https://upload.example.test/source",
              },
            })
          : Response.json({
              ok: true,
              result: { replayed: true, sourceBlobId: "source_blob_1", status: "available" },
            })
      },
    )

    expect(result).toMatchObject({ ok: true, result: { status: "available" } })
    expect(tools).toEqual(["apps.code.reserveSource", "apps.code.completeSource"])
  })

  test("rejects invalid React source payloads before reserving private storage", async () => {
    const requests: Request[] = []
    const invoke = async (input: Record<string, unknown>) => await invokeAgentToolOverHttp(
      {
        agentSessionId: "agent_session_1",
        appUrl: "https://chat.example.test",
        bridgeToken: "secret-token",
        deviceId: "device_123",
      },
      "apps.code.reserveSource",
      {
        appId: "react_app_1",
        editSessionId: "react_edit_1",
        operationId: "reserve_source_invalid",
        ...input,
      },
      async (requestInput, init) => {
        requests.push(new Request(requestInput, init))
        return Response.json({ ok: true, result: {} })
      },
    )

    for (const input of [
      { sourceText: "" },
      { sourceBase64: "not-base64" },
      { sourceBase64: "eA==", sourceText: "x" },
      { sourceText: "x".repeat(48 * 1024 + 1) },
      { byteLength: 2, sourceText: "x" },
      { sha256: "0".repeat(64), sourceText: "x" },
    ]) {
      expect(await invoke(input)).toMatchObject({ ok: false, tool: "apps.code.reserveSource" })
    }
    expect(requests).toHaveLength(0)
  })

  test("rejects unsafe React source upload URLs and headers before the signed PUT", async () => {
    for (const reservation of [
      { sourceBlobId: "source_blob_1", status: "pending", uploadUrl: "http://upload.example.test/source" },
      { sourceBlobId: "source_blob_1", status: "pending", uploadUrl: "https://user@upload.example.test/source" },
      { sourceBlobId: "source_blob_1", status: "pending", uploadUrl: "https://upload.example.test/source#private" },
      {
        requiredUploadHeaders: { "invalid header": "private" },
        sourceBlobId: "source_blob_1",
        status: "pending",
        uploadUrl: "https://upload.example.test/source",
      },
      {
        requiredUploadHeaders: { Host: "private.example.test" },
        sourceBlobId: "source_blob_1",
        status: "pending",
        uploadUrl: "https://upload.example.test/source",
      },
      {
        requiredUploadHeaders: { "X-Test": "one", "x-test": "two" },
        sourceBlobId: "source_blob_1",
        status: "pending",
        uploadUrl: "https://upload.example.test/source",
      },
    ]) {
      let uploadCalls = 0
      const result = await invokeAgentToolOverHttp(
        {
          agentSessionId: "agent_session_1",
          appUrl: "https://chat.example.test",
          bridgeToken: "secret-token",
          deviceId: "device_123",
        },
        "apps.code.reserveSource",
        {
          appId: "react_app_1",
          editSessionId: "react_edit_1",
          operationId: "reserve_source_unsafe",
          sourceText: "export default null",
        },
        async (input, init) => {
          const request = new Request(input, init)
          if (request.url !== "https://chat.example.test/api/agent-tools/invoke") uploadCalls += 1
          return Response.json({ ok: true, result: reservation })
        },
      )
      expect(result).toMatchObject({ ok: false, tool: "apps.code.reserveSource" })
      expect(uploadCalls).toBe(0)
    }
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

  test("returns executePlan partial failures as readable plan results instead of generic MCP errors", async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    try {
      globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { tool?: string }
        calls.push(String(body.tool))
        if (body.tool === "databases.createRow") {
          return new Response(JSON.stringify({ error: "Row write failed", ok: false }), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: true, result: { id: "ok" } }), { status: 200 })
      }, { preconnect: originalFetch.preconnect }) as typeof fetch

      const planResult = await executeCatalogPlan(
        { agentSessionId: "agent_session_1", appUrl: "https://chat.example.test", bridgeToken: "secret-token", deviceId: "device_1" },
        {
          mode: "parallel",
          steps: [
            { id: "read", input: { threadId: "thread_1" }, tool: "threads.read" },
            { id: "write", input: { attributes: { title: "Task" }, tableId: "dev-tasks" }, tool: "databases.createRow" },
          ],
        },
      ) as { error?: string; failedSteps?: Array<{ error?: string; id: string; reasonCode?: string; tool: string }>; ok: boolean; result: { steps: unknown[] } }

      expect(calls).toEqual(["threads.read", "databases.createRow"])
      expect(planResult.ok).toBe(false)
      expect(planResult.error).toContain("write (databases.createRow): Row write failed")
      expect(planResult.failedSteps).toEqual([{ error: "Row write failed", id: "write", reasonCode: "APP_ERROR", tool: "databases.createRow" }])
      expect(planResult.result).toMatchObject({ mode: "sequential", requestedMode: "parallel" })
      expect(planResult.result.steps).toHaveLength(2)

      const mcpResult = toMcpToolResult(planResult, { markOkFalseAsError: false })
      expect(mcpResult.isError).toBeUndefined()
      expect(mcpResult.content[0]?.text).toContain('"failedSteps"')
      expect(mcpResult.content[0]?.text).toContain('"result"')
    } finally {
      globalThis.fetch = originalFetch
    }
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
    expect(registeredToolNames).toEqual([
      "tools.search",
      "tools.describe",
      "tools.call",
      "tools.executePlan",
      "tools.executeCode",
      "capabilities.advise",
    ])
    expect(registeredToolNames).not.toContain("context.get")
    expect(registeredToolNames).not.toContain("threads.list")
    expect(registeredToolNames).not.toContain("databases.get")
    expect(registeredToolNames).not.toContain("github.createPullRequest")
    expect(registeredToolNames.some((name) => name.startsWith("scripts."))).toBe(false)

    expect(contextGetHandler).toBeUndefined()
    globalThis.fetch = originalFetch
  })
})
