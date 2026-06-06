import { describe, expect, test } from "bun:test"

import { BridgeSupervisor } from "./bridge-supervisor"
import { BridgeSessionManager, type BridgeSessionContext } from "./session-manager"

describe("bridge session cwd safety", () => {
  test("does not let a stuck ACP close block manager shutdown forever", async () => {
    const closeStarted = deferred<void>()
    const manager = new BridgeSessionManager({
      closeTimeoutMs: 5,
      cloudClient: fakeCloudClient(),
      createSession: () => ({
        close: async () => {
          closeStarted.resolve()
          await new Promise<void>(() => {})
        },
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ok",
        }),
      }),
    })

    await manager.handleQueueItem({
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    await manager.close()
    await closeStarted.promise
    expect(manager.getStatus().activeSessions).toEqual([])
  })

  test("ignores remote queue cwd by default", async () => {
    const contexts: BridgeSessionContext[] = []
    const manager = new BridgeSessionManager({
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context)
        return fakeSession()
      },
    })

    await manager.handleQueueItem({
      claimId: "claim-1",
      cwd: "/Users/alice/private-project",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts[0]?.cwd).toBeUndefined()
  })

  test("honors remote queue cwd only when explicitly enabled", async () => {
    const contexts: BridgeSessionContext[] = []
    const manager = new BridgeSessionManager({
      allowRemoteCwd: true,
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context)
        return fakeSession()
      },
    })

    await manager.handleQueueItem({
      claimId: "claim-1",
      cwd: "/Users/alice/private-project",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts[0]?.cwd).toBe("/Users/alice/private-project")
  })

  test("uses configured agent names instead of runtime labels for run start events", async () => {
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => fakeSession(),
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@zed-industries/codex-acp@latest"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      bridgeProfileId: "codex:codex-acp",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(cloud.events[0]?.[0]?.normalizedPayload).toMatchObject({
      text: "Agent started this run.",
    })
  })

  test("mirrors prompt lifecycle into the shadow supervisor", async () => {
    const supervisor = new BridgeSupervisor()
    const manager = new BridgeSessionManager({
      cloudClient: fakeCloudClient(),
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          context.onEvent({
            eventType: "choice",
            externalEventId: "choice-1",
            part: { type: "choice", status: "streaming" },
            payload: {},
            source: "hermes_acp",
          })
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          }
        },
      }),
      supervisor,
    })

    await manager.handleQueueItem({
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(supervisor.getTurnState("queue-1")).toMatchObject({
      checkpoint: "completed",
      claimId: "claim-1",
      queueItemId: "queue-1",
    })
  })

  test("recreates an ACP session when an explicit runtime profile changes", async () => {
    const cloud = fakeCloudClient()
    const contexts: BridgeSessionContext[] = []
    const closedProfiles: Array<string | undefined> = []
    const logs: Array<Record<string, unknown>> = []
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context)
        return {
          close: async () => {
            closedProfiles.push(context.bridgeProfileId)
          },
          cancel: async () => {},
          sendUserMessage: async () => ({
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: context.bridgeProfileId ?? "unknown",
          }),
        }
      },
      log: (entry) => logs.push(entry as Record<string, unknown>),
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@zed-industries/codex-acp@0.15.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
        {
          capabilities: { sessionMcpServers: true },
          command: ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.39.0"],
          id: "claude-code:claude-acp",
          kind: "claude-code",
          label: "Claude Code",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      bridgeProfileId: "codex:codex-acp",
      claimId: "claim-codex",
      id: "queue-codex",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      bridgeProfileId: "claude-code:claude-acp",
      claimId: "claim-claude",
      id: "queue-claude",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts.map((context) => context.bridgeProfileId)).toEqual([
      "codex:codex-acp",
      "claude-code:claude-acp",
    ])
    expect(contexts.map((context) => context.agentCommand)).toEqual([
      ["npx", "--yes", "@zed-industries/codex-acp@0.15.0"],
      ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.39.0"],
    ])
    expect(closedProfiles).toContain("codex:codex-acp")
    expect(logs).toContainEqual(
      expect.objectContaining({
        bridgeProfileId: "codex:codex-acp",
        event: "bridge.lifecycle.replacement_session",
        sessionId: "agent-session-1",
        threadId: "thread-1",
      }),
    )
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-claude",
      result: { ok: true, text: "claude-code:claude-acp" },
    })
    expect(manager.getStatus().sessions).toEqual([
      expect.objectContaining({
        runtimeKind: "claude-code",
        runtimeLabel: "Claude Code",
        runtimeProfileId: "claude-code:claude-acp",
      }),
    ])
  })

  test("rejects session-creating work without a profile when multiple runtimes are available", async () => {
    const cloud = fakeCloudClient()
    const contexts: BridgeSessionContext[] = []
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context)
        return fakeSession()
      },
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@zed-industries/codex-acp@0.15.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
        {
          capabilities: { sessionMcpServers: true },
          command: ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.39.0"],
          id: "claude-code:claude-acp",
          kind: "claude-code",
          label: "Claude Code",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-missing-profile",
      id: "queue-missing-profile",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts).toEqual([])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-missing-profile",
      result: {
        ok: false,
        error: expect.stringContaining("Bridge runtime profile is required"),
      },
    })
  })

  test("keeps legacy default runtime fallback when only one runtime is available", async () => {
    const contexts: BridgeSessionContext[] = []
    const manager = new BridgeSessionManager({
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context)
        return fakeSession()
      },
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@zed-industries/codex-acp@0.15.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-single-profile",
      id: "queue-single-profile",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts[0]?.bridgeProfileId).toBeUndefined()
    expect(contexts[0]?.runtimeProfile?.id).toBe("codex:codex-acp")
    expect(contexts[0]?.agentCommand).toEqual([
      "npx",
      "--yes",
      "@zed-industries/codex-acp@0.15.0",
    ])
  })

  test("recreates cwd-bound runtime sessions when the queue cwd changes", async () => {
    const contexts: BridgeSessionContext[] = []
    const closedCwds: Array<string | undefined> = []
    const manager = new BridgeSessionManager({
      allowRemoteCwd: true,
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context)
        return {
          close: async () => {
            closedCwds.push(context.cwd)
          },
          cancel: async () => {},
          sendUserMessage: async () => ({
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: context.cwd ?? "none",
          }),
        }
      },
      runtimeProfiles: [
        {
          capabilities: { sessionMcpServers: true },
          command: ["hermes", "acp"],
          id: "hermes:default",
          identityRules: { cwdBoundSessions: true, cwdSwitchPolicy: "new_session_required" },
          kind: "hermes",
          label: "Hermes",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      bridgeProfileId: "hermes:default",
      claimId: "claim-1",
      cwd: "/repo/a",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      bridgeProfileId: "hermes:default",
      claimId: "claim-2",
      id: "queue-2",
      prompt: "hello again",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts.map((context) => context.cwd)).toEqual(["/repo/a", undefined])
    expect(closedCwds).toEqual(["/repo/a"])
  })

  test("scopes runtime session keys by organization, device, runtime, and thread", async () => {
    const manager = new BridgeSessionManager({
      cloudClient: fakeCloudClient(),
      createSession: () => fakeSession(),
      deviceId: "device-1",
      runtimeProfiles: [
        {
          capabilities: { sessionMcpServers: true },
          command: ["openclaw", "acp"],
          id: "openclaw:gateway",
          identityRules: { appIdentityFromMeta: false, scopeSessionKeyByThread: true },
          kind: "openclaw",
          label: "OpenClaw",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "openclaw:gateway",
      claimId: "claim-1",
      id: "queue-1",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "openclaw:gateway",
      claimId: "claim-2",
      id: "queue-2",
      organizationId: "org-2",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    const sessions = manager.getStatus().activeSessions
    expect(sessions).toHaveLength(2)
    expect(new Set(sessions).size).toBe(2)
    expect(sessions.every((key) => key.includes("provider-session"))).toBe(true)
  })

  test("returns provider session ids instead of internal scoped session keys", async () => {
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => fakeSession(),
      deviceId: "device-1",
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["codex", "acp"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-1",
      id: "queue-1",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-1",
      result: { agentSessionId: "provider-session", ok: true },
    })
  })

  test("applies runtime config fallback metadata before prompt delivery", async () => {
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => fakeSession(),
      runtimeProfiles: [
        {
          capabilities: { sessionMcpServers: true },
          command: ["codex", "acp"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          runtimeConfigOptions: { model: ["gpt-5.5"], thoughtLevel: ["medium"] },
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      bridgeProfileId: "codex:default",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      runtimeConfig: { model: "gpt-5.5", thoughtLevel: "high" },
      threadId: "thread-1",
      type: "prompt",
    })

    expect(cloud.results.at(-1)?.result).toMatchObject({
      runtimeConfigApplied: { model: "gpt-5.5" },
      runtimeConfigDiagnostics: [
        {
          option: "thoughtLevel",
          reasonCode: "runtime_config_option_unavailable",
          value: "high",
        },
      ],
    })
  })

  test("maps per-message runtime options into ACP runtime config before prompt delivery", async () => {
    const promptOptions: Array<Record<string, unknown> | undefined> = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (_prompt, options) => {
          promptOptions.push(options)
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          }
        },
      }),
      runtimeProfiles: [
        {
          capabilities: { sessionMcpServers: true },
          command: ["codex", "acp"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          runtimeConfigOptions: { model: ["gpt-5.5"], thoughtLevel: ["high", "medium"] },
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      bridgeProfileId: "codex:default",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      runtimeOptions: { modelId: "gpt-5.5", thinkingLevel: "high" },
      threadId: "thread-1",
      type: "prompt",
    })

    expect(promptOptions.at(-1)?.runtimeConfig).toEqual({
      model: "gpt-5.5",
      thoughtLevel: "high",
    })
    expect(cloud.results.at(-1)?.result).toMatchObject({
      runtimeConfigApplied: { model: "gpt-5.5", thoughtLevel: "high" },
      runtimeConfigDiagnostics: [],
    })
  })

  test("waits for a starting ACP session before handling an approval response", async () => {
    const promptStarted = deferred<void>()
    const finishPrompt = deferred<void>()
    const permissionResponses: Array<{ id: string; approved: boolean }> = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        respondToPermissionRequest: async (id, response) => {
          permissionResponses.push({ id, approved: response.approved })
          return true
        },
        sendUserMessage: async () => {
          promptStarted.resolve()
          await finishPrompt.promise
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          }
        },
      }),
    })

    const prompt = manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    await manager.handleQueueItem({
      approvalOutcome: "approved",
      claimId: "claim-approval",
      externalRequestId: "request-1",
      id: "queue-approval",
      threadId: "thread-1",
      type: "permission-response",
    })

    expect(permissionResponses).toEqual([{ id: "request-1", approved: true }])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-approval",
      result: { ok: true, approved: true },
    })

    await promptStarted.promise
    finishPrompt.resolve()
    await prompt
  })

  test("persists ACP continuation output after a choice response", async () => {
    const prompts: string[] = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt)
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text: prompt === "Selected choice: option-a" ? "continued after choice" : "ready",
          }
        },
      }),
    })

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    })

    expect(prompts).toEqual(["hello", "Selected choice: option-a"])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: { choiceId: "option-a", ok: true, text: "continued after choice" },
    })
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      text: "continued after choice",
    })
  })

  test("persists ACP continuation output after an input response", async () => {
    const prompts: string[] = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt)
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text: prompt === "Here is the missing detail." ? "continued after input" : "ready",
          }
        },
      }),
    })

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      claimId: "claim-input",
      id: "queue-input",
      prompt: "Here is the missing detail.",
      threadId: "thread-1",
      type: "input-response",
    })

    expect(prompts).toEqual(["hello", "Here is the missing detail."])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-input",
      result: { inputResponse: true, ok: true, text: "continued after input" },
    })
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      text: "continued after input",
    })
  })

  test("routes sparse choice responses to runtime-scoped active sessions", async () => {
    const prompts: string[] = []
    const cloud = fakeCloudClient()
    let sessionCount = 0
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => {
        sessionCount += 1
        return {
          close: async () => {},
          cancel: async () => {},
          sendUserMessage: async (prompt) => {
            prompts.push(prompt)
            return {
              events: [],
              rawResult: { ok: true },
              sessionId: "session-1",
              text: prompt === "Selected choice: option-a" ? "continued after choice" : "ready",
            }
          },
        }
      },
      deviceId: "device-1",
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["codex", "acp"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    })

    expect(prompts).toEqual(["hello", "Selected choice: option-a"])
    expect(sessionCount).toBe(1)
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: { agentSessionId: "provider-session", choiceId: "option-a", ok: true },
    })
  })

  test("rejects ambiguous sparse choice responses across scoped sessions", async () => {
    const prompts: string[] = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt)
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text: "ready",
          }
        },
      }),
      deviceId: "device-1",
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["codex", "acp"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-org-1",
      id: "queue-org-1",
      organizationId: "org-1",
      prompt: "hello org 1",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-org-2",
      id: "queue-org-2",
      organizationId: "org-2",
      prompt: "hello org 2",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    })

    expect(prompts).toEqual(["hello org 1", "hello org 2"])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: {
        error: expect.stringContaining("matches multiple active ACP sessions"),
        ok: false,
      },
    })
  })

  test("does not route sparse choice responses by substring-matched thread ids", async () => {
    const contexts: BridgeSessionContext[] = []
    const prompts: string[] = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context)
        return {
          close: async () => {},
          cancel: async () => {},
          sendUserMessage: async (prompt) => {
            prompts.push(prompt)
            return {
              events: [],
              rawResult: { ok: true },
              sessionId: "session-1",
              text: "ready",
            }
          },
        }
      },
      deviceId: "device-1",
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["codex", "acp"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello thread 10",
      threadId: "thread-10",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    })

    expect(contexts.map((context) => context.threadId)).toEqual(["thread-10", "thread-1"])
    expect(prompts).toEqual(["hello thread 10", "Selected choice: option-a"])
  })

  test("does not fallback explicit runtime choice responses to another active runtime", async () => {
    const prompts: string[] = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt)
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text: "ready",
          }
        },
      }),
      deviceId: "device-1",
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["openclaw", "acp"],
          id: "openclaw:gateway",
          kind: "openclaw",
          label: "OpenClaw",
          status: "available",
        },
        {
          capabilities: {},
          command: ["codex", "acp"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "openclaw:gateway",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      approvalOutcome: "option-a",
      bridgeProfileId: "codex:default",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    })

    expect(prompts).toEqual(["hello"])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: {
        error: expect.stringContaining("does not match an active ACP session"),
        ok: false,
      },
    })
  })

  test("choice response resumes after the original ACP session idles closed", async () => {
    const prompts: string[] = []
    const closedSessions: string[] = []
    const logs: Array<Record<string, unknown>> = []
    let sessionCount = 0
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      idleSessionTtlMs: 1,
      createSession: () => {
        sessionCount += 1
        const sessionId = `session-${sessionCount}`
        return {
          close: async () => {
            closedSessions.push(sessionId)
          },
          cancel: async () => {},
          sendUserMessage: async (prompt) => {
            prompts.push(prompt)
            return {
              events: [],
              rawResult: { ok: true },
              sessionId,
              text: prompt === "Selected choice: option-a" ? "continued after idle" : "ready",
            }
          },
        }
      },
      log: (entry) => logs.push(entry as Record<string, unknown>),
    })

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    })

    expect(closedSessions).toContain("session-1")
    expect(logs).toContainEqual(
      expect.objectContaining({
        agentSessionId: "agent-session-1",
        event: "bridge.lifecycle.idle_close",
        providerSessionId: "agent-session-1",
        threadId: "thread-1",
      }),
    )
    expect(sessionCount).toBe(2)
    expect(prompts).toEqual(["hello", "Selected choice: option-a"])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: { choiceId: "option-a", ok: true, text: "continued after idle" },
    })
  })

  test("choice response waits behind an active prompt for the same session", async () => {
    const prompts: string[] = []
    const promptStarted = deferred<void>()
    const finishPrompt = deferred<void>()
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt)
          if (prompt === "hello") {
            promptStarted.resolve()
            await finishPrompt.promise
          }
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text: prompt === "Selected choice: option-a" ? "continued after active prompt" : "ready",
          }
        },
      }),
    })

    const prompt = manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await promptStarted.promise

    const choice = manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    })
    await Promise.resolve()

    expect(prompts).toEqual(["hello"])
    finishPrompt.resolve()
    await prompt
    await choice

    expect(prompts).toEqual(["hello", "Selected choice: option-a"])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: { choiceId: "option-a", ok: true, text: "continued after active prompt" },
    })
  })

  test("cancel-session acknowledged by ACP produces a terminal cancelled event", async () => {
    let cancelCount = 0
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {
          cancelCount += 1
          return true
        },
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ready",
        }),
      }),
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    })

    expect(cancelCount).toBe(1)
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-cancel",
      result: { cancelled: true, ok: true, stopReason: "cancelled", terminal: true },
    })
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      status: "complete",
      text: "Run cancelled.",
      type: "event",
    })
  })

  test("cancel-session fences an active prompt and ignores its late final text", async () => {
    const promptRelease = deferred<void>()
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => true,
        sendUserMessage: async () => {
          await promptRelease.promise
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "late text that must not publish",
          }
        },
      }),
    })

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe("queue-prompt"),
    )

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    })
    promptRelease.resolve()
    await promptRun

    expect(cloud.results.find((result) => result.id === "queue-cancel")).toMatchObject({
      result: { cancelled: true, ok: true, stopReason: "cancelled", terminal: true },
    })
    expect(cloud.results.find((result) => result.id === "queue-prompt")).toMatchObject({
      result: { cancelled: true, ignoredLateResult: true, ok: false, terminal: true },
    })
    expect(JSON.stringify(cloud.events)).not.toContain("late text that must not publish")
  })

  test("cancel-session reports cancel_not_acknowledged when ACP cannot cancel", async () => {
    const cloud = fakeCloudClient()
    const supervisor = new BridgeSupervisor()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => false,
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ready",
        }),
      }),
      supervisor,
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    })

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-cancel",
      result: { error: "cancel_not_acknowledged", ok: false, terminal: true },
    })
    expect(supervisor.getTurnState("queue-cancel")?.checkpoint).toBe("failed")
  })

  test("cancel-session force-closes an active turn when ACP does not acknowledge cancel", async () => {
    const promptRelease = deferred<void>()
    const cloud = fakeCloudClient()
    let closeCount = 0
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {
          closeCount += 1
        },
        cancel: async () => false,
        sendUserMessage: async () => {
          await promptRelease.promise
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "late after forced close",
          }
        },
      }),
    })

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe("queue-prompt"),
    )
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    })
    promptRelease.resolve()
    await promptRun

    expect(closeCount).toBe(1)
    expect(cloud.results.find((result) => result.id === "queue-cancel")).toMatchObject({
      result: {
        cancelled: true,
        forced: true,
        ok: true,
        stopReason: "cancelled",
        terminal: true,
      },
    })
    expect(cloud.results.find((result) => result.id === "queue-prompt")).toMatchObject({
      result: { cancelled: true, ignoredLateResult: true, ok: false, terminal: true },
    })
    expect(JSON.stringify(cloud.events)).not.toContain("late after forced close")
  })

  test("cancel-session reports terminal failure when ACP cancel throws", async () => {
    const cloud = fakeCloudClient()
    const supervisor = new BridgeSupervisor()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {
          throw new Error("session/cancel rejected")
        },
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ready",
        }),
      }),
      supervisor,
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    })

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-cancel",
      result: { error: "cancel_not_acknowledged", ok: false, terminal: true },
    })
    expect(supervisor.getTurnState("queue-cancel")?.checkpoint).toBe("failed")
  })

  test("steer-session cancels the active turn and sends replacement instructions on the same session", async () => {
    const prompts: string[] = []
    let cancelCount = 0
    let sessionCount = 0
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => {
        sessionCount += 1
        return {
          close: async () => {},
          cancel: async () => {
            cancelCount += 1
            return true
          },
          sendUserMessage: async (prompt) => {
            prompts.push(prompt)
            return {
              events: [],
              rawResult: {},
              sessionId: "session-1",
              text: prompt === "Try a smaller patch" ? "steered" : "ready",
            }
          },
        }
      },
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    })

    expect(sessionCount).toBe(1)
    expect(cancelCount).toBe(1)
    expect(prompts).toEqual(["hello", "Try a smaller patch"])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-steer",
      result: { ok: true, steered: true, text: "steered" },
    })
  })

  test("steer-session replaces the ACP session when an active turn is still running", async () => {
    const activePromptRelease = deferred<void>()
    const prompts: string[] = []
    let cancelCount = 0
    let closeCount = 0
    let sessionCount = 0
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => {
        sessionCount += 1
        const currentSession = sessionCount
        return {
          close: async () => {
            closeCount += 1
          },
          cancel: async () => {
            cancelCount += 1
            return true
          },
          sendUserMessage: async (prompt) => {
            prompts.push(`${currentSession}:${prompt}`)
            if (currentSession === 1) {
              await activePromptRelease.promise
              return {
                events: [],
                rawResult: {},
                sessionId: "session-1",
                text: "late original",
              }
            }
            return {
              events: [],
              rawResult: {},
              sessionId: "session-2",
              text: "steered",
            }
          },
        }
      },
    })

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe("queue-prompt"),
    )
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    })
    activePromptRelease.resolve()
    await promptRun

    expect(sessionCount).toBe(2)
    expect(cancelCount).toBe(1)
    expect(closeCount).toBe(1)
    expect(prompts).toEqual(["1:hello", "2:Try a smaller patch"])
    expect(cloud.results.find((result) => result.id === "queue-steer")).toMatchObject({
      result: { ok: true, steered: true, text: "steered" },
    })
    expect(cloud.results.find((result) => result.id === "queue-prompt")).toMatchObject({
      result: { cancelled: true, ignoredLateResult: true, ok: false, terminal: true },
    })
    expect(JSON.stringify(cloud.events)).not.toContain("late original")
  })

  test("steer-session terminalizes when the replacement response has withheld final text", async () => {
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => true,
        sendUserMessage: async (prompt) => ({
          events: [],
          finalText:
            prompt === "Try a smaller patch"
              ? {
                  answerChunkCount: 0,
                  answerTextLength: 0,
                  reason: "codex_unclassified_message_chunks",
                  runtimeId: "codex",
                  thoughtChunkCount: 0,
                  toolEventCount: 1,
                  trustedFinalResultText: false,
                  withheld: true,
                }
              : undefined,
          rawResult: {},
          sessionId: "session-1",
          text: prompt === "Try a smaller patch" ? "" : "ready",
        }),
      }),
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    })

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-steer",
      result: { error: "steer_reprompt_failed", ok: false, terminal: true },
    })
  })

  test("steer-session records failed when ACP cannot stop the active turn", async () => {
    const cloud = fakeCloudClient()
    const supervisor = new BridgeSupervisor()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => false,
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ready",
        }),
      }),
      supervisor,
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    })

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-steer",
      result: { error: "session_replacement_required", ok: false, terminal: true },
    })
    expect(supervisor.getTurnState("queue-steer")?.checkpoint).toBe("failed")
  })

  test("steer-session replaces an active ACP session when cancel is not acknowledged", async () => {
    const activePromptRelease = deferred<void>()
    const prompts: string[] = []
    let sessionCount = 0
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => {
        sessionCount += 1
        const currentSession = sessionCount
        return {
          close: async () => {},
          cancel: async () => false,
          sendUserMessage: async (prompt) => {
            prompts.push(`${currentSession}:${prompt}`)
            if (currentSession === 1) {
              await activePromptRelease.promise
              return {
                events: [],
                rawResult: {},
                sessionId: "session-1",
                text: "late original",
              }
            }
            return {
              events: [],
              rawResult: {},
              sessionId: "session-2",
              text: "steered",
            }
          },
        }
      },
    })

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe("queue-prompt"),
    )
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    })
    activePromptRelease.resolve()
    await promptRun

    expect(sessionCount).toBe(2)
    expect(prompts).toEqual(["1:hello", "2:Try a smaller patch"])
    expect(cloud.results.find((result) => result.id === "queue-steer")).toMatchObject({
      result: { ok: true, replacementSession: true, steered: true, text: "steered" },
    })
    expect(cloud.results.find((result) => result.id === "queue-prompt")).toMatchObject({
      result: { cancelled: true, ignoredLateResult: true, ok: false, terminal: true },
    })
  })

  test("close-session closes an idle native ACP session", async () => {
    let closeCount = 0
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {
          closeCount += 1
        },
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ready",
        }),
      }),
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-close",
      id: "queue-close",
      threadId: "thread-1",
      type: "close-session",
    })

    expect(closeCount).toBe(1)
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-close",
      result: { closed: true, ok: true },
    })
    expect(manager.getStatus().activeSessions).toEqual([])
  })

  test("revive-session uses native load context when an external session id is available", async () => {
    const contexts: BridgeSessionContext[] = []
    const cloud = fakeCloudClient()
    let startCount = 0
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context)
        return {
          ...fakeSession(),
          getExternalContinuityState: () => ({
            attempted: true,
            fallback: false,
            loaded: true,
          }),
          start: async () => {
            startCount += 1
            return "external-session-1"
          },
        }
      },
      resumeEnabled: true,
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-revive",
      externalSessionId: "external-session-1",
      id: "queue-revive",
      threadId: "thread-1",
      type: "revive-session",
    })

    expect(contexts[0]?.initialSessionId).toBe("external-session-1")
    expect(startCount).toBe(1)
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-revive",
      result: { ok: true, revived: true, reviveMode: "native-load" },
    })
  })

  test("revive-session reuses an active session without claiming native load", async () => {
    const contexts: BridgeSessionContext[] = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context)
        return fakeSession()
      },
      resumeEnabled: true,
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-revive",
      externalSessionId: "external-session-1",
      id: "queue-revive",
      threadId: "thread-1",
      type: "revive-session",
    })

    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.initialSessionId).toBeUndefined()
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-revive",
      result: { ok: true, revived: true, reviveMode: "thread-history" },
    })
  })

  test("revive-session closes a newly created session when native start fails", async () => {
    const cloud = fakeCloudClient()
    let closeCount = 0
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        ...fakeSession(),
        close: async () => {
          closeCount += 1
        },
        start: async () => {
          throw new Error("load failed")
        },
      }),
      resumeEnabled: true,
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-revive",
      externalSessionId: "external-session-1",
      id: "queue-revive",
      threadId: "thread-1",
      type: "revive-session",
    })

    expect(closeCount).toBe(1)
    expect(manager.getStatus().activeSessions).toEqual([])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-revive",
      result: { error: "load failed", ok: false },
    })
  })

  test("revive-session falls back to thread history when native resume is disabled", async () => {
    const contexts: BridgeSessionContext[] = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context)
        return fakeSession()
      },
    })

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-revive",
      externalSessionId: "external-session-1",
      id: "queue-revive",
      threadId: "thread-1",
      type: "revive-session",
    })

    expect(contexts[0]?.initialSessionId).toBeUndefined()
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-revive",
      result: { ok: true, revived: true, reviveMode: "thread-history" },
    })
  })

  test("logs redacted diagnostics when Codex final text is withheld", async () => {
    const cloud = fakeCloudClient()
    const logs: Array<Record<string, unknown>> = []
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [],
          finalText: {
            answerChunkCount: 2,
            answerTextLength: 30,
            reason: "codex_unclassified_message_chunks",
            runtimeId: "codex",
            thoughtChunkCount: 0,
            toolEventCount: 1,
            trustedFinalResultText: false,
            withheld: true,
          },
          rawResult: { stopReason: "end_turn" },
          sessionId: "session-1",
          stopReason: "end_turn",
          text: "",
        }),
      }),
      log: (entry) => logs.push(entry as Record<string, unknown>),
    })

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-prompt",
      result: { ok: true, text: "" },
    })
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      json: {
        finalText: {
          answerChunkCount: 2,
          answerTextLength: 30,
          reason: "codex_unclassified_message_chunks",
          runtimeId: "codex",
          thoughtChunkCount: 0,
          toolEventCount: 1,
          trustedFinalResultText: false,
          withheld: true,
        },
        stopReason: "end_turn",
      },
      text: "",
      type: "event",
    })
    expect(logs).toContainEqual(
      expect.objectContaining({
        answerChunkCount: 2,
        answerTextLength: 30,
        event: "agent.final_text.withheld",
        reason: "codex_unclassified_message_chunks",
        runtimeId: "codex",
        thoughtChunkCount: 0,
        toolEventCount: 1,
      }),
    )
    expect(JSON.stringify({ events: cloud.events, logs })).not.toContain("private")
  })
})

function fakeCloudClient() {
  const events: Array<Array<{ normalizedPayload?: unknown }>> = []
  const results: Array<{ claimId: string; id: string; result: unknown }> = []
  return {
    events,
    results,
    appendEvents: async <TResponse = Record<string, unknown>>(
      input: Array<{ normalizedPayload?: unknown }>,
    ) => {
      events.push(input)
      return {} as TResponse
    },
    markResult: async <TResponse = Record<string, unknown>>(
      id: string,
      result: unknown,
      claimId?: string,
    ) => {
      if (!claimId) {
        throw new Error("claimId is required")
      }
      results.push({ claimId, id, result })
      return {} as TResponse
    },
  }
}

function fakeSession() {
  return {
    close: async () => {},
    cancel: async () => {},
    sendUserMessage: async () => ({
      events: [],
      rawResult: {},
      sessionId: "session-1",
      text: "ok",
    }),
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  throw lastError
}
