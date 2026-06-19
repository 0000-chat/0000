import { describe, expect, test } from "bun:test";

import { BridgeSupervisor } from "./bridge-supervisor";
import {
  BridgeSessionManager,
  bridgeQueueItemMatchesSessionRuntimeScope,
  type BridgeSessionContext,
  type BridgeSessionQueueItem,
} from "./session-manager";
import type { NormalizedBridgeEvent } from "./event-normalizer";
import type { SdkAcpRuntimeTerminalHandle } from "./sdk-acp-runtime-client";
import { TerminalHandleRegistry } from "./terminal-handles";

describe("bridge session cwd safety", () => {
  test("runtime-scoped active items do not match sessions from another runtime", () => {
    expect(
      bridgeQueueItemMatchesSessionRuntimeScope(
        { bridgeProfileId: "runtime-a" },
        { runtimeProfileId: "runtime-b" },
      ),
    ).toBe(false);
    expect(
      bridgeQueueItemMatchesSessionRuntimeScope(
        { bridgeProfileId: "runtime-a" },
        { runtimeProfileId: "runtime-a" },
      ),
    ).toBe(true);
    expect(
      bridgeQueueItemMatchesSessionRuntimeScope(
        { hermesProfileName: "ops" },
        { hermesProfileName: "default", runtimeProfileId: "runtime-a" },
      ),
    ).toBe(false);
  });

  test("does not let a stuck ACP close block manager shutdown forever", async () => {
    const closeStarted = deferred<void>();
    const manager = new BridgeSessionManager({
      closeTimeoutMs: 5,
      cloudClient: fakeCloudClient(),
      createSession: () => ({
        close: async () => {
          closeStarted.resolve();
          await new Promise<void>(() => {});
        },
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ok",
        }),
      }),
    });

    await manager.handleQueueItem({
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    await manager.close();
    await closeStarted.promise;
    expect(manager.getStatus().activeSessions).toEqual([]);
  });

  test("honors remote queue cwd by default", async () => {
    const contexts: BridgeSessionContext[] = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context);
        return fakeSession();
      },
    });

    await manager.handleQueueItem({
      claimId: "claim-1",
      cwd: "/Users/alice/private-project",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(contexts[0]?.cwd).toBe("/Users/alice/private-project");
  });

  test("ignores remote queue cwd only when explicitly disabled", async () => {
    const contexts: BridgeSessionContext[] = [];
    const manager = new BridgeSessionManager({
      allowRemoteCwd: false,
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context);
        return fakeSession();
      },
    });

    await manager.handleQueueItem({
      claimId: "claim-1",
      cwd: "/Users/alice/private-project",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(contexts[0]?.cwd).toBeUndefined();
  });

  test("uses the honored queue cwd for MCP server context", async () => {
    const mcpContexts: Array<Pick<BridgeSessionContext, "cwd">> = [];
    const manager = new BridgeSessionManager({
      cloudClient: fakeCloudClient(),
      createMcpServers: (context) => {
        mcpContexts.push({ cwd: context.cwd });
        return [];
      },
      createSession: () => fakeSession(),
    });

    await manager.handleQueueItem({
      claimId: "claim-1",
      cwd: "/Users/alice/private-project",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(mcpContexts[0]?.cwd).toBe("/Users/alice/private-project");
  });

  test("omits disabled queue cwd from MCP server context", async () => {
    const mcpContexts: Array<Pick<BridgeSessionContext, "cwd">> = [];
    const manager = new BridgeSessionManager({
      allowRemoteCwd: false,
      cloudClient: fakeCloudClient(),
      createMcpServers: (context) => {
        mcpContexts.push({ cwd: context.cwd });
        return [];
      },
      createSession: () => fakeSession(),
    });

    await manager.handleQueueItem({
      claimId: "claim-1",
      cwd: "/Users/alice/private-project",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(mcpContexts[0]?.cwd).toBeUndefined();
  });

  test("passes the real Convex agent session id into MCP server context", async () => {
    const mcpContexts: Array<{
      agentSessionId?: string;
      organizationId?: string;
      sessionKey: string;
      threadId: string;
    }> = [];
    const sessionContexts: BridgeSessionContext[] = [];
    const manager = new BridgeSessionManager({
      cloudClient: fakeCloudClient(),
      createMcpServers: (context) => {
        mcpContexts.push(context);
        return [];
      },
      createSession: (context) => {
        sessionContexts.push(context);
        return fakeSession();
      },
    });

    await manager.handleQueueItem({
      agentSessionId: "jd73bbytzzt5af89n710xtvp4n885zn8",
      claimId: "claim-1",
      id: "queue-1",
      organizationId: "org_123",
      prompt: "hello",
      threadId: "kx7fm6pymvpev19va22hr9zkax884mgs",
      type: "prompt",
    });

    expect(mcpContexts[0]?.agentSessionId).toBe(
      "jd73bbytzzt5af89n710xtvp4n885zn8",
    );
    expect(mcpContexts[0]?.organizationId).toBe("org_123");
    expect(mcpContexts[0]?.sessionKey).not.toBe(
      "jd73bbytzzt5af89n710xtvp4n885zn8",
    );
    expect(sessionContexts[0]?.agentSessionId).toBe(
      "jd73bbytzzt5af89n710xtvp4n885zn8",
    );
  });

  test("strict scoped identity rejects missing organization or agent session ids", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => fakeSession(),
      deviceId: "bridge_123",
      requireScopedIdentity: true,
    });

    await manager.handleQueueItem({
      agentSessionId: "agent_session_1",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      claimId: "claim-2",
      id: "queue-2",
      organizationId: "org_123",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.results).toContainEqual(
      expect.objectContaining({
        id: "queue-1",
        result: expect.objectContaining({
          error: expect.stringContaining("missing organizationId"),
        }),
      }),
    );
    expect(cloud.results).toContainEqual(
      expect.objectContaining({
        id: "queue-2",
        result: expect.objectContaining({
          error: expect.stringContaining("missing agentSessionId"),
        }),
      }),
    );
  });

  test("uses configured agent names instead of runtime labels for run start events", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => fakeSession(),
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    });

    await manager.handleQueueItem({
      bridgeProfileId: "codex:codex-acp",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.events[0]?.[0]?.normalizedPayload).toMatchObject({
      text: "Agent started this run.",
    });
  });

  test("mirrors prompt lifecycle into the shadow supervisor", async () => {
    const supervisor = new BridgeSupervisor();
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          context.onEvent({
            eventType: "choice",
            externalEventId: "choice-1",
            part: { type: "choice", status: "streaming" },
            payload: {},
            source: "acp_bridge",
          });
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          };
        },
      }),
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
      supervisor,
    });

    await manager.handleQueueItem({
      bridgeProfileId: "codex:codex-acp",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(supervisor.getTurnState("queue-1")).toMatchObject({
      checkpoint: "completed",
      claimId: "claim-1",
      queueItemId: "queue-1",
    });
    const acpEvent = cloud.events
      .flat()
      .find((event) => event.source === "acp_bridge");
    expect(acpEvent?.rawPayload).toMatchObject({
      runtimeCommand: {
        executable: "bunx",
        package: "@zed-industries/codex-acp@0.16.0",
      },
      runtimeKind: "codex",
      runtimeLabel: "Codex",
      runtimeProfileId: "codex:codex-acp",
    });
  });

  test("terminalizes active prompt when provider silent watchdog fires", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
    let closeCount = 0;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {
          closeCount += 1;
        },
        cancel: async () => {},
        sendUserMessage: async () => await new Promise(() => {}),
      }),
      log: (entry) => logs.push(entry),
    });

    void manager.handleQueueItem(promptQueueItem());
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe(
        "queue-prompt",
      ),
    );

    await expect(
      manager.failActiveQueueItem("queue-prompt", "provider_silent_timeout"),
    ).resolves.toBe(true);

    expect(closeCount).toBe(1);
    expect(manager.getStatus().sessions).toEqual([]);
    expect(cloud.results).toContainEqual(
      expect.objectContaining({
        claimId: "claim-prompt",
        id: "queue-prompt",
        result: expect.objectContaining({
          ok: false,
          reasonCode: "provider_silent_timeout",
          terminal: true,
        }),
      }),
    );
    expect(flattenPersistedEvents(cloud.events)).toContainEqual(
      expect.objectContaining({
        eventType: "bridge_error",
        normalizedPayload: expect.objectContaining({
          json: expect.objectContaining({
            reasonCode: "provider_silent_timeout",
          }),
          status: "error",
          type: "error",
        }),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        error: "provider_silent_timeout",
        event: "agent.turn.failed",
        queueId: "queue-prompt",
      }),
    );
  });

  test("terminalizes active prompt when a tool call never resolves", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
    let closeCount = 0;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {
          closeCount += 1;
        },
        cancel: async () => {},
        sendUserMessage: async () => {
          context.onEvent(toolCallEvent(1));
          await new Promise(() => {});
          throw new Error("unreachable");
        },
      }),
      livenessTimeoutMs: 10_000,
      log: (entry) => logs.push(entry),
      toolResultTimeoutMs: 5,
    });

    const handled = manager.handleQueueItem(promptQueueItem());
    await eventually(() =>
      expect(cloud.results).toContainEqual(
        expect.objectContaining({
          claimId: "claim-prompt",
          id: "queue-prompt",
          result: expect.objectContaining({
            ok: false,
            reasonCode: "tool_result_timeout",
            terminal: true,
          }),
        }),
      ),
    );

    expect(closeCount).toBe(1);
    expect(manager.getStatus().sessions).toEqual([]);
    expect(flattenPersistedEvents(cloud.events)).toContainEqual(
      expect.objectContaining({
        eventType: "bridge_error",
        normalizedPayload: expect.objectContaining({
          json: expect.objectContaining({
            reasonCode: "tool_result_timeout",
            toolCallId: "tool-1",
          }),
          status: "error",
          type: "error",
        }),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.session.tool_result_timeout",
        queueId: "queue-prompt",
        reasonCode: "tool_result_timeout",
        toolCallId: "tool-1",
      }),
    );
    await handled;
    expect(logs).toContainEqual(
      expect.objectContaining({
        error: "tool_result_timeout",
        event: "agent.turn.failed",
        queueId: "queue-prompt",
      }),
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({
        event: "agent.turn.completed",
        queueId: "queue-prompt",
      }),
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({
        event: "bridge.queue_item.complete",
        queueId: "queue-prompt",
      }),
    );
  });

  test("tracks unresolved tool calls against the running item in a reused session", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
    let sendCount = 0;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          sendCount += 1;
          if (sendCount === 1) {
            return {
              events: [],
              rawResult: {},
              sessionId: "session-1",
              text: "first complete",
            };
          }
          context.onEvent(toolCallEvent(1));
          await new Promise(() => {});
          throw new Error("unreachable");
        },
      }),
      livenessTimeoutMs: 10_000,
      log: (entry) => logs.push(entry),
      toolResultTimeoutMs: 5,
    });

    await manager.handleQueueItem(promptQueueItem());
    void manager.handleQueueItem({
      ...promptQueueItem(),
      claimId: "claim-second",
      id: "queue-second",
      prompt: "again",
    });

    await eventually(() =>
      expect(cloud.results).toContainEqual(
        expect.objectContaining({
          claimId: "claim-second",
          id: "queue-second",
          result: expect.objectContaining({
            ok: false,
            reasonCode: "tool_result_timeout",
            terminal: true,
          }),
        }),
      ),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.session.tool_result_timeout",
        queueId: "queue-second",
        reasonCode: "tool_result_timeout",
        toolCallId: "tool-1",
      }),
    );
  });

  test("clears pending tool timeout when the tool result arrives", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          context.onEvent(toolCallEvent(1));
          context.onEvent(toolResultEvent(2));
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          };
        },
      }),
      log: (entry) => logs.push(entry),
      toolResultTimeoutMs: 5,
    });

    await manager.handleQueueItem(promptQueueItem());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cloud.results).toContainEqual(
      expect.objectContaining({
        id: "queue-prompt",
        result: expect.objectContaining({ ok: true }),
      }),
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({
        event: "bridge.session.tool_result_timeout",
      }),
    );
  });

  test("clears pending tool timeout when assistant output resumes after a tool call", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          context.onEvent(toolCallEvent(1));
          context.onEvent(
            streamChunkEvent("agent_thought_chunk", "continuing", 2),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          };
        },
      }),
      livenessTimeoutMs: 10_000,
      log: (entry) => logs.push(entry),
      toolResultTimeoutMs: 5,
    });

    await manager.handleQueueItem(promptQueueItem());

    expect(cloud.results).toContainEqual(
      expect.objectContaining({
        id: "queue-prompt",
        result: expect.objectContaining({ ok: true }),
      }),
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({
        event: "bridge.session.tool_result_timeout",
      }),
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({
        error: "tool_result_timeout",
        event: "agent.turn.failed",
      }),
    );
  });

  test("clears pending tool timeout from a nested tool result", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          context.onEvent(toolCallEvent(1));
          context.onEvent(nestedToolResultEvent(2));
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          };
        },
      }),
      log: (entry) => logs.push(entry),
      toolResultTimeoutMs: 5,
    });

    await manager.handleQueueItem(promptQueueItem());

    expect(cloud.results).toContainEqual(
      expect.objectContaining({
        id: "queue-prompt",
        result: expect.objectContaining({ ok: true }),
      }),
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({
        event: "bridge.session.tool_result_timeout",
      }),
    );
  });

  test("attributes late reused-session events to the most recent turn", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
    let sendCount = 0;
    let sessionContext!: BridgeSessionContext;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        sessionContext = context;
        return {
          close: async () => {},
          cancel: async () => {},
          sendUserMessage: async () => {
            sendCount += 1;
            return {
              events: [],
              rawResult: {},
              sessionId: "session-1",
              text: sendCount === 1 ? "first" : "second",
            };
          },
        };
      },
      log: (entry) => logs.push(entry),
      toolResultTimeoutMs: 1_000,
    });

    await manager.handleQueueItem(promptQueueItem());
    await manager.handleQueueItem({
      ...promptQueueItem(),
      claimId: "claim-second",
      id: "queue-second",
      prompt: "again",
    });
    sessionContext.onEvent(toolCallEvent(3));

    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "agent.tool.requested",
        queueId: "queue-second",
        toolCallId: "tool-1",
      }),
    );
  });

  test("recreates an ACP session when an explicit runtime profile changes", async () => {
    const cloud = fakeCloudClient();
    const contexts: BridgeSessionContext[] = [];
    const closedProfiles: Array<string | undefined> = [];
    const logs: Array<Record<string, unknown>> = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context);
        return {
          close: async () => {
            closedProfiles.push(context.bridgeProfileId);
          },
          cancel: async () => {},
          sendUserMessage: async () => ({
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: context.bridgeProfileId ?? "unknown",
          }),
        };
      },
      log: (entry) => logs.push(entry as Record<string, unknown>),
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
        {
          capabilities: { sessionMcpServers: true },
          command: [
            "npx",
            "--yes",
            "@agentclientprotocol/claude-agent-acp@0.39.0",
          ],
          id: "claude-code:claude-acp",
          kind: "claude-code",
          label: "Claude Code",
          status: "available",
        },
      ],
    });

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      bridgeProfileId: "codex:codex-acp",
      claimId: "claim-codex",
      id: "queue-codex",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      bridgeProfileId: "claude-code:claude-acp",
      claimId: "claim-claude",
      id: "queue-claude",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(contexts.map((context) => context.bridgeProfileId)).toEqual([
      "codex:codex-acp",
      "claude-code:claude-acp",
    ]);
    expect(contexts.map((context) => context.agentCommand)).toEqual([
      ["bunx", "@zed-industries/codex-acp@0.16.0"],
      ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.39.0"],
    ]);
    expect(closedProfiles).toContain("codex:codex-acp");
    expect(logs).toContainEqual(
      expect.objectContaining({
        bridgeProfileId: "codex:codex-acp",
        event: "bridge.lifecycle.replacement_session",
        sessionId: "agent-session-1",
        threadId: "thread-1",
      }),
    );
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-claude",
      result: { ok: true, text: "claude-code:claude-acp" },
    });
    expect(manager.getStatus().sessions).toEqual([
      expect.objectContaining({
        runtimeKind: "claude-code",
        runtimeLabel: "Claude Code",
        runtimeProfileId: "claude-code:claude-acp",
      }),
    ]);
  });

  test("rejects session-creating work without a profile when multiple runtimes are available", async () => {
    const cloud = fakeCloudClient();
    const contexts: BridgeSessionContext[] = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context);
        return fakeSession();
      },
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
        {
          capabilities: { sessionMcpServers: true },
          command: [
            "npx",
            "--yes",
            "@agentclientprotocol/claude-agent-acp@0.39.0",
          ],
          id: "claude-code:claude-acp",
          kind: "claude-code",
          label: "Claude Code",
          status: "available",
        },
      ],
    });

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-missing-profile",
      id: "queue-missing-profile",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(contexts).toEqual([]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-missing-profile",
      result: {
        ok: false,
        error: expect.stringContaining("Bridge runtime profile is required"),
      },
    });
  });

  test("keeps legacy default runtime fallback when only one runtime is available", async () => {
    const contexts: BridgeSessionContext[] = [];
    const manager = new BridgeSessionManager({
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context);
        return fakeSession();
      },
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    });

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-single-profile",
      id: "queue-single-profile",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(contexts[0]?.bridgeProfileId).toBeUndefined();
    expect(contexts[0]?.runtimeProfile?.id).toBe("codex:codex-acp");
    expect(contexts[0]?.agentCommand).toEqual([
      "bunx",
      "@zed-industries/codex-acp@0.16.0",
    ]);
  });

  test("recreates cwd-bound runtime sessions when the queue cwd changes", async () => {
    const contexts: BridgeSessionContext[] = [];
    const closedCwds: Array<string | undefined> = [];
    const manager = new BridgeSessionManager({
      allowRemoteCwd: true,
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context);
        return {
          close: async () => {
            closedCwds.push(context.cwd);
          },
          cancel: async () => {},
          sendUserMessage: async () => ({
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: context.cwd ?? "none",
          }),
        };
      },
      runtimeProfiles: [
        {
          capabilities: { sessionMcpServers: true },
          command: ["hermes", "acp"],
          id: "hermes:default",
          identityRules: {
            cwdBoundSessions: true,
            cwdSwitchPolicy: "new_session_required",
          },
          kind: "hermes",
          label: "Hermes",
          status: "available",
        },
      ],
    });

    await manager.handleQueueItem({
      bridgeProfileId: "hermes:default",
      claimId: "claim-1",
      cwd: "/repo/a",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      bridgeProfileId: "hermes:default",
      claimId: "claim-2",
      id: "queue-2",
      prompt: "hello again",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(contexts.map((context) => context.cwd)).toEqual([
      "/repo/a",
      undefined,
    ]);
    expect(closedCwds).toEqual(["/repo/a"]);
  });

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
          identityRules: {
            appIdentityFromMeta: false,
            scopeSessionKeyByThread: true,
          },
          kind: "openclaw",
          label: "OpenClaw",
          status: "available",
        },
      ],
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "openclaw:gateway",
      claimId: "claim-1",
      id: "queue-1",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "openclaw:gateway",
      claimId: "claim-2",
      id: "queue-2",
      organizationId: "org-2",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    const status = manager.getStatus();
    const sessions = status.sessions.map((session) => session.sessionKey);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions).size).toBe(2);
    expect(sessions.every((key) => key.includes("provider-session"))).toBe(
      true,
    );
    expect(status.activeSessions).toEqual([]);
    expect(status.liveness?.activeSessions).toEqual([]);
  });

  test("returns provider session ids instead of internal scoped session keys", async () => {
    const cloud = fakeCloudClient();
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-1",
      id: "queue-1",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-1",
      result: { agentSessionId: "provider-session", ok: true },
    });
  });

  test("applies runtime config fallback metadata before prompt delivery", async () => {
    const cloud = fakeCloudClient();
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
          runtimeConfigOptions: {
            model: ["gpt-5.5"],
            thoughtLevel: ["medium"],
          },
          status: "available",
        },
      ],
    });

    await manager.handleQueueItem({
      bridgeProfileId: "codex:default",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      runtimeConfig: { model: "gpt-5.5", thoughtLevel: "high" },
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.results.at(-1)?.result).toMatchObject({
      runtimeConfigApplied: { model: "gpt-5.5" },
      runtimeConfigDiagnostics: [
        {
          option: "thoughtLevel",
          reasonCode: "runtime_config_option_unavailable",
          value: "high",
        },
      ],
    });
  });

  test("maps per-message runtime options into ACP runtime config before prompt delivery", async () => {
    const promptOptions: Array<Record<string, unknown> | undefined> = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (_prompt, options) => {
          promptOptions.push(options);
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          };
        },
      }),
      runtimeProfiles: [
        {
          capabilities: { sessionMcpServers: true },
          command: ["codex", "acp"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          runtimeConfigOptions: {
            model: ["gpt-5.5"],
            thoughtLevel: ["high", "medium"],
          },
          status: "available",
        },
      ],
    });

    await manager.handleQueueItem({
      bridgeProfileId: "codex:default",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "hello",
      runtimeOptions: { modelId: "gpt-5.5", thinkingLevel: "high" },
      threadId: "thread-1",
      type: "prompt",
    });

    expect(promptOptions.at(-1)?.runtimeConfig).toEqual({
      model: "gpt-5.5",
      thoughtLevel: "high",
    });
    expect(cloud.results.at(-1)?.result).toMatchObject({
      runtimeConfigApplied: { model: "gpt-5.5", thoughtLevel: "high" },
      runtimeConfigDiagnostics: [],
    });
  });

  test("acknowledges stale interaction responses as no-op terminal-safe results", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "",
        }),
      }),
    });

    await manager.handleQueueItem({
      claimId: "claim-terminal",
      id: "queue-terminal",
      prompt: "terminalize",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      approvalId: "permission-1",
      approvalOutcome: "approved",
      claimId: "claim-permission",
      externalRequestId: "permission-1",
      id: "queue-permission",
      threadId: "thread-1",
      type: "approval-response",
    });
    await manager.handleQueueItem({
      approvalOutcome: "choice-a",
      claimId: "claim-choice",
      id: "queue-choice",
      prompt: "choice-a",
      threadId: "thread-1",
      type: "choice-response",
    });
    await manager.handleQueueItem({
      claimId: "claim-input",
      id: "queue-input",
      prompt: "late input",
      threadId: "thread-1",
      type: "input-response",
    });

    expect(cloud.results.slice(-3)).toEqual([
      expect.objectContaining({
        id: "queue-permission",
        result: expect.objectContaining({
          ok: true,
          stale: true,
          noOp: true,
          reasonCode: "stale_interaction_response",
        }),
      }),
      expect.objectContaining({
        id: "queue-choice",
        result: expect.objectContaining({
          ok: true,
          stale: true,
          noOp: true,
          reasonCode: "stale_interaction_response",
        }),
      }),
      expect.objectContaining({
        id: "queue-input",
        result: expect.objectContaining({
          ok: true,
          stale: true,
          noOp: true,
          reasonCode: "stale_interaction_response",
        }),
      }),
    ]);
  });

  test("bounds remembered terminal interaction session keys", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => ({
          events: [],
          rawResult: {},
          sessionId: `session-${prompt}`,
          text: "",
        }),
      }),
    });

    for (let index = 0; index < 130; index += 1) {
      await manager.handleQueueItem({
        agentSessionId: `provider-${index}`,
        claimId: `claim-${index}`,
        id: `queue-${index}`,
        prompt: `${index}`,
        threadId: `thread-${index}`,
        type: "prompt",
      });
    }

    expect(manager.getStatus().terminalInteractionSessionKeyCount).toBe(300);
    await manager.handleQueueItem({
      approvalOutcome: "choice-old",
      claimId: "claim-old-choice",
      id: "queue-old-choice",
      prompt: "choice-old",
      threadId: "thread-0",
      type: "choice-response",
    });
    await manager.handleQueueItem({
      approvalOutcome: "choice-new",
      claimId: "claim-new-choice",
      id: "queue-new-choice",
      prompt: "choice-new",
      threadId: "thread-129",
      type: "choice-response",
    });

    expect(cloud.results.at(-2)).toMatchObject({
      id: "queue-old-choice",
      result: { ok: true, choiceId: "choice-old" },
    });
    expect(cloud.results.at(-2)?.result).not.toMatchObject({
      stale: true,
      reasonCode: "stale_interaction_response",
    });
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-new-choice",
      result: {
        ok: true,
        stale: true,
        noOp: true,
        reasonCode: "stale_interaction_response",
      },
    });
  });

  test("passes system prompt while adapting structured attachments into native prompt references", async () => {
    const prompts: string[] = [];
    const promptOptions: Array<Record<string, unknown> | undefined> = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt, options) => {
          prompts.push(prompt);
          promptOptions.push(options);
          return {
            attachmentDeliveryMode: "resource_links",
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          };
        },
      }),
    });

    await manager.handleQueueItem({
      attachments: [
        {
          access: {
            mode: "worker",
            url: "https://0000.chat/api/attachments/attachments/2026/06/screenshot.png",
          },
          bucket: "chat-attachments",
          checksumSha256: "b".repeat(64),
          filename: "screenshot.png",
          mediaType: "image/png",
          objectKey: "attachments/2026/06/screenshot.png",
          sizeBytes: 1234,
          status: "available",
          storageBackend: "r2",
          type: "file",
          url: "https://0000.chat/api/attachments/attachments/2026/06/screenshot.png",
        },
        {
          access: {
            mode: "worker",
            url: "https://0000.chat/api/attachments/attachments/2026/06/notes.txt",
          },
          bucket: "chat-attachments",
          checksumSha256: "c".repeat(64),
          filename: "notes.txt",
          mediaType: "text/plain",
          objectKey: "attachments/2026/06/notes.txt",
          sizeBytes: 42,
          status: "available",
          storageBackend: "r2",
          type: "file",
          url: "https://0000.chat/api/attachments/attachments/2026/06/notes.txt",
        },
      ],
      claimId: "claim-1",
      id: "queue-1",
      prompt: "Inspect these files.",
      systemPrompt: "Keep the workspace policy.",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(promptOptions.at(-1)?.systemPrompt).toBe(
      "Keep the workspace policy.",
    );
    expect(prompts.at(-1)).toBe("Inspect these files.");
    expect(promptOptions.at(-1)?.attachmentReferenceText).toContain(
      "Attached files available to this ACP run:",
    );
    expect(promptOptions.at(-1)?.attachments).toEqual([
      expect.objectContaining({
        filename: "screenshot.png",
        mediaType: "image/png",
        sizeBytes: 1234,
      }),
      expect.objectContaining({
        filename: "notes.txt",
        mediaType: "text/plain",
        sizeBytes: 42,
      }),
    ]);
    expect(cloud.results.at(-1)?.result).toMatchObject({
      attachmentCount: 2,
      attachmentDeliveryMode: "resource_links",
      attachmentTotalBytes: 1276,
    });
  });

  test("passes normalized agent attachment parts back in prompt results", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [
            {
              eventType: "file",
              externalEventId: "session-1:1:file",
              part: {
                json: {
                  filename: "agent-output.txt",
                  mediaType: "text/plain",
                  sizeBytes: 17,
                  storageBackend: "r2",
                  type: "file",
                  url: "https://0000.chat/api/attachments/attachments/agent/agent-output.txt",
                },
                status: "complete",
                type: "attachment",
              },
              payload: {},
              source: "acp_bridge",
            },
          ],
          rawResult: {},
          sessionId: "session-1",
          text: "created a file",
        }),
      }),
    });

    await manager.handleQueueItem({
      claimId: "claim-1",
      id: "queue-1",
      prompt: "Create the file.",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.results.at(-1)?.result).toMatchObject({
      ok: true,
      parts: [
        {
          externalPartId: "session-1:1:file:attachment",
          payload: {
            filename: "agent-output.txt",
            mediaType: "text/plain",
            sizeBytes: 17,
            storageBackend: "r2",
            type: "file",
            url: "https://0000.chat/api/attachments/attachments/agent/agent-output.txt",
          },
          type: "attachment",
        },
      ],
      text: "created a file",
    });
  });

  test("uploads byte agent attachments before persisting prompt result parts", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [
            {
              attachmentUpload: {
                dataBase64: "YWdlbnQgb3V0cHV0",
                filename: "agent-output.txt",
                kind: "base64",
                mediaType: "text/plain",
                sizeBytes: 12,
              },
              eventType: "file",
              externalEventId: "session-1:1:file",
              part: {
                json: {
                  candidateKind: "base64",
                  mediaType: "text/plain",
                  sizeBytes: 12,
                  status: "pending_upload",
                  type: "agent_attachment_upload",
                },
                status: "streaming",
                type: "event",
              },
              payload: {
                candidateKind: "base64",
                mediaType: "text/plain",
                sizeBytes: 12,
                status: "pending_upload",
                type: "agent_attachment_upload",
              },
              source: "acp_bridge",
            },
          ],
          rawResult: {},
          sessionId: "session-1",
          text: "created a file",
        }),
      }),
    });

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-1",
      id: "queue-1",
      prompt: "Create the file.",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.uploads).toEqual([
      {
        agentSessionId: "agent-session-1",
        byteLength: 12,
        filename: "agent-output.txt",
        mediaType: "text/plain",
        threadId: "thread-1",
      },
    ]);
    expect(cloud.results.at(-1)?.result).toMatchObject({
      ok: true,
      parts: [
        {
          externalPartId: "session-1:1:file:attachment",
          payload: {
            bucket: "chat-attachments",
            checksumSha256: "e".repeat(64),
            createdBy: "agent",
            filename: "agent-output.txt",
            key: "attachments/agent-output/thread-1/agent-session-1/agent-output.txt",
            mediaType: "text/plain",
            objectKey:
              "attachments/agent-output/thread-1/agent-session-1/agent-output.txt",
            sizeBytes: 12,
            status: "available",
            storageBackend: "r2",
            type: "file",
          },
          type: "attachment",
        },
      ],
      text: "created a file",
    });
    const appendedPayloads = cloud.events
      .flat()
      .map((event) => event.normalizedPayload);
    expect(JSON.stringify(appendedPayloads)).not.toContain("YWdlbnQgb3V0cHV0");
  });

  test("waits for a starting ACP session before handling an approval response", async () => {
    const promptStarted = deferred<void>();
    const finishPrompt = deferred<void>();
    const permissionResponses: Array<{ id: string; approved: boolean }> = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        respondToPermissionRequest: async (id, response) => {
          permissionResponses.push({ id, approved: response.approved });
          return true;
        },
        sendUserMessage: async () => {
          promptStarted.resolve();
          await finishPrompt.promise;
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          };
        },
      }),
    });

    const prompt = manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    await manager.handleQueueItem({
      approvalOutcome: "approved",
      claimId: "claim-approval",
      externalRequestId: "request-1",
      id: "queue-approval",
      threadId: "thread-1",
      type: "permission-response",
    });

    expect(permissionResponses).toEqual([{ id: "request-1", approved: true }]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-approval",
      result: { ok: true, approved: true },
    });

    await promptStarted.promise;
    finishPrompt.resolve();
    await prompt;
  });

  test("persists ACP continuation output after a choice response", async () => {
    const prompts: string[] = [];
    const continuationPrompt =
      "The user selected an option for this pending multiple-choice prompt:\n\nShould folder membership include descendants?\n\nSelected: Inherited membership (inherited)";
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt);
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text:
              prompt === continuationPrompt
                ? "continued after choice"
                : "ready",
          };
        },
      }),
    });

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      prompt: continuationPrompt,
      threadId: "thread-1",
      type: "choice-response",
    });

    expect(prompts).toEqual(["hello", continuationPrompt]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: {
        choiceId: "option-a",
        ok: true,
        text: "continued after choice",
      },
    });
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      text: "continued after choice",
    });
  });

  test("persists ACP continuation output after an input response", async () => {
    const prompts: string[] = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt);
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text:
              prompt === "Here is the missing detail."
                ? "continued after input"
                : "ready",
          };
        },
      }),
    });

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      claimId: "claim-input",
      id: "queue-input",
      prompt: "Here is the missing detail.",
      threadId: "thread-1",
      type: "input-response",
    });

    expect(prompts).toEqual(["hello", "Here is the missing detail."]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-input",
      result: { inputResponse: true, ok: true, text: "continued after input" },
    });
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      text: "continued after input",
    });
  });

  test("routes sparse choice responses to runtime-scoped active sessions", async () => {
    const prompts: string[] = [];
    const cloud = fakeCloudClient();
    let sessionCount = 0;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => {
        sessionCount += 1;
        return {
          close: async () => {},
          cancel: async () => {},
          sendUserMessage: async (prompt) => {
            prompts.push(prompt);
            return {
              events: [],
              rawResult: { ok: true },
              sessionId: "session-1",
              text:
                prompt === "Selected choice: option-a"
                  ? "continued after choice"
                  : "ready",
            };
          },
        };
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    });

    expect(prompts).toEqual(["hello", "Selected choice: option-a"]);
    expect(sessionCount).toBe(1);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: {
        agentSessionId: "provider-session",
        choiceId: "option-a",
        ok: true,
      },
    });
  });

  test("does not count retained idle sessions as active live runs", async () => {
    const cloud = fakeCloudClient();
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    const status = manager.getStatus();
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({
      queueDepth: 0,
      runtimeProfileId: "codex:default",
      threadId: "thread-1",
    });
    expect(status.retainedSessions).toEqual([
      expect.objectContaining({
        queueDepth: 0,
        runtimeProfileId: "codex:default",
        sessionKey: expect.stringContaining("provider-session"),
      }),
    ]);
    expect(status.activeSessions).toEqual([]);
    expect(status.liveness?.activeSessions).toEqual([]);
  });

  test("rejects ambiguous sparse choice responses across scoped sessions", async () => {
    const prompts: string[] = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt);
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text: "ready",
          };
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-org-1",
      id: "queue-org-1",
      organizationId: "org-1",
      prompt: "hello org 1",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-org-2",
      id: "queue-org-2",
      organizationId: "org-2",
      prompt: "hello org 2",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    });

    expect(prompts).toEqual(["hello org 1", "hello org 2"]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: {
        error: expect.stringContaining("matches multiple active ACP sessions"),
        ok: false,
      },
    });
  });

  test("does not route sparse choice responses by substring-matched thread ids", async () => {
    const contexts: BridgeSessionContext[] = [];
    const prompts: string[] = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context);
        return {
          close: async () => {},
          cancel: async () => {},
          sendUserMessage: async (prompt) => {
            prompts.push(prompt);
            return {
              events: [],
              rawResult: { ok: true },
              sessionId: "session-1",
              text: "ready",
            };
          },
        };
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "codex:default",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello thread 10",
      threadId: "thread-10",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    });

    expect(contexts.map((context) => context.threadId)).toEqual([
      "thread-10",
      "thread-1",
    ]);
    expect(prompts).toEqual(["hello thread 10", "Selected choice: option-a"]);
  });

  test("does not fallback explicit runtime choice responses to another active runtime", async () => {
    const prompts: string[] = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt);
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text: "ready",
          };
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      bridgeProfileId: "openclaw:gateway",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      approvalOutcome: "option-a",
      bridgeProfileId: "codex:default",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    });

    expect(prompts).toEqual(["hello"]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: {
        error: expect.stringContaining("does not match an active ACP session"),
        ok: false,
      },
    });
  });

  test("choice response resumes after the original ACP session idles closed", async () => {
    const prompts: string[] = [];
    const closedSessions: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    let sessionCount = 0;
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      idleSessionTtlMs: 1,
      createSession: () => {
        sessionCount += 1;
        const sessionId = `session-${sessionCount}`;
        return {
          close: async () => {
            closedSessions.push(sessionId);
          },
          cancel: async () => {},
          sendUserMessage: async (prompt) => {
            prompts.push(prompt);
            return {
              events: [],
              rawResult: { ok: true },
              sessionId,
              text:
                prompt === "Selected choice: option-a"
                  ? "continued after idle"
                  : "ready",
            };
          },
        };
      },
      log: (entry) => logs.push(entry as Record<string, unknown>),
    });

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    });

    expect(closedSessions).toContain("session-1");
    expect(logs).toContainEqual(
      expect.objectContaining({
        agentSessionId: "agent-session-1",
        event: "bridge.lifecycle.idle_close",
        providerSessionId: "agent-session-1",
        threadId: "thread-1",
      }),
    );
    expect(sessionCount).toBe(2);
    expect(prompts).toEqual(["hello", "Selected choice: option-a"]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: { choiceId: "option-a", ok: true, text: "continued after idle" },
    });
  });

  test("choice response waits behind an active prompt for the same session", async () => {
    const prompts: string[] = [];
    const promptStarted = deferred<void>();
    const finishPrompt = deferred<void>();
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async (prompt) => {
          prompts.push(prompt);
          if (prompt === "hello") {
            promptStarted.resolve();
            await finishPrompt.promise;
          }
          return {
            events: [],
            rawResult: { ok: true },
            sessionId: "session-1",
            text:
              prompt === "Selected choice: option-a"
                ? "continued after active prompt"
                : "ready",
          };
        },
      }),
    });

    const prompt = manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await promptStarted.promise;

    const choice = manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      approvalOutcome: "option-a",
      claimId: "claim-choice",
      id: "queue-choice",
      threadId: "thread-1",
      type: "choice-response",
    });
    await Promise.resolve();

    expect(prompts).toEqual(["hello"]);
    finishPrompt.resolve();
    await prompt;
    await choice;

    expect(prompts).toEqual(["hello", "Selected choice: option-a"]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-choice",
      result: {
        choiceId: "option-a",
        ok: true,
        text: "continued after active prompt",
      },
    });
  });

  test("cancel-session acknowledged by ACP produces a terminal cancelled event", async () => {
    let cancelCount = 0;
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {
          cancelCount += 1;
          return true;
        },
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ready",
        }),
      }),
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    });

    expect(cancelCount).toBe(1);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-cancel",
      result: {
        cancelled: true,
        ok: true,
        stopReason: "cancelled",
        terminal: true,
      },
    });
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      status: "complete",
      text: "Run cancelled.",
      type: "event",
    });
  });

  test("cancel-session kills active SDK terminal handles for the active turn", async () => {
    const promptStarted = deferred<void>();
    const finishPrompt = deferred<void>();
    const cloud = fakeCloudClient();
    const terminalRegistry =
      new TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>();
    const handles: RecordingTerminalHandle[] = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createTerminal: async () => {
        const handle = recordingTerminalHandle(
          `terminal-${handles.length + 1}`,
        );
        handles.push(handle);
        return handle;
      },
      deviceId: "bridge-device-1",
      terminalRegistry,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => true,
        sendUserMessage: async () => {
          if (!context.terminalAdapter) {
            throw new Error("expected terminal adapter");
          }
          const handle = await context.terminalAdapter.createTerminal({
            command: "echo",
            sessionId: "session-1",
          });
          context.terminalAdapter.registry.create({
            handle,
            scope: context.terminalAdapter.scope,
          });
          promptStarted.resolve();
          await finishPrompt.promise;
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "late",
          };
        },
      }),
    });

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await promptStarted.promise;
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      organizationId: "org-1",
      threadId: "thread-1",
      type: "cancel-session",
    });
    finishPrompt.resolve();
    await promptRun;

    expect(handles).toHaveLength(1);
    expect(handles[0]?.kills).toEqual(["SIGTERM"]);
    expect(handles[0]?.releases).toBe(0);
    expect(terminalRegistry.list()).toEqual([]);
  });

  test("cancel-session fences an active prompt and ignores its late final text", async () => {
    const promptRelease = deferred<void>();
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => true,
        sendUserMessage: async () => {
          await promptRelease.promise;
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "late text that must not publish",
          };
        },
      }),
    });

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe(
        "queue-prompt",
      ),
    );

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    });
    promptRelease.resolve();
    await promptRun;

    expect(
      cloud.results.find((result) => result.id === "queue-cancel"),
    ).toMatchObject({
      result: {
        cancelled: true,
        ok: true,
        stopReason: "cancelled",
        terminal: true,
      },
    });
    expect(
      cloud.results.find((result) => result.id === "queue-prompt"),
    ).toMatchObject({
      result: {
        cancelled: true,
        ignoredLateResult: true,
        ok: false,
        terminal: true,
      },
    });
    expect(JSON.stringify(cloud.events)).not.toContain(
      "late text that must not publish",
    );
  });

  test("cancel-session reports cancel_not_acknowledged when ACP cannot cancel", async () => {
    const cloud = fakeCloudClient();
    const supervisor = new BridgeSupervisor();
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-cancel",
      result: { error: "cancel_not_acknowledged", ok: false, terminal: true },
    });
    expect(supervisor.getTurnState("queue-cancel")?.checkpoint).toBe("failed");
  });

  test("cancel-session force-closes an active turn when ACP does not acknowledge cancel", async () => {
    const promptRelease = deferred<void>();
    const cloud = fakeCloudClient();
    let closeCount = 0;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {
          closeCount += 1;
        },
        cancel: async () => false,
        sendUserMessage: async () => {
          await promptRelease.promise;
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "late after forced close",
          };
        },
      }),
    });

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe(
        "queue-prompt",
      ),
    );
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    });
    promptRelease.resolve();
    await promptRun;

    expect(closeCount).toBe(1);
    expect(
      cloud.results.find((result) => result.id === "queue-cancel"),
    ).toMatchObject({
      result: {
        cancelled: true,
        forced: true,
        ok: true,
        stopReason: "cancelled",
        terminal: true,
      },
    });
    expect(
      cloud.results.find((result) => result.id === "queue-prompt"),
    ).toMatchObject({
      result: {
        cancelled: true,
        ignoredLateResult: true,
        ok: false,
        terminal: true,
      },
    });
    expect(JSON.stringify(cloud.events)).not.toContain(
      "late after forced close",
    );
  });

  test("cancel-session reports terminal failure when ACP cancel throws", async () => {
    const cloud = fakeCloudClient();
    const supervisor = new BridgeSupervisor();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {
          throw new Error("session/cancel rejected");
        },
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ready",
        }),
      }),
      supervisor,
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      threadId: "thread-1",
      type: "cancel-session",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-cancel",
      result: { error: "cancel_not_acknowledged", ok: false, terminal: true },
    });
    expect(supervisor.getTurnState("queue-cancel")?.checkpoint).toBe("failed");
  });

  test("steer-session cancels the active turn and sends replacement instructions on the same session", async () => {
    const prompts: string[] = [];
    let cancelCount = 0;
    let sessionCount = 0;
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => {
        sessionCount += 1;
        return {
          close: async () => {},
          cancel: async () => {
            cancelCount += 1;
            return true;
          },
          sendUserMessage: async (prompt) => {
            prompts.push(prompt);
            return {
              events: [],
              rawResult: {},
              sessionId: "session-1",
              text: prompt === "Try a smaller patch" ? "steered" : "ready",
            };
          },
        };
      },
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    });

    expect(sessionCount).toBe(1);
    expect(cancelCount).toBe(1);
    expect(prompts).toEqual(["hello", "Try a smaller patch"]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-steer",
      result: { ok: true, steered: true, text: "steered" },
    });
  });

  test("process pressure cleanup does not close an active direct steer prompt", async () => {
    const steerRelease = deferred<void>();
    const prompts: string[] = [];
    let closeCount = 0;
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {
          closeCount += 1;
        },
        cancel: async () => true,
        sendUserMessage: async (prompt) => {
          prompts.push(prompt);
          if (prompt === "Keep going") {
            await steerRelease.promise;
            return {
              events: [],
              rawResult: {},
              sessionId: "session-1",
              text: "steered",
            };
          }
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ready",
          };
        },
      }),
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    const eventBatchCountAfterPrompt = cloud.events.length;
    const steerRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Keep going",
      threadId: "thread-1",
      type: "steer-session",
    });
    let assertionError: unknown;
    try {
      await eventually(() => {
        expect(manager.getStatus().liveness?.activeSessions).toHaveLength(1);
        expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBeUndefined();
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await eventually(() =>
        expect(cloud.events.length).toBeGreaterThan(eventBatchCountAfterPrompt),
      );

      const closed = await manager.closeIdleSessionsForProcessPressure({
        maxSessionsToClose: 1,
        targetFreeProcessSlots: 2,
      });

      expect(closed).toBe(0);
      expect(closeCount).toBe(0);
      expect(manager.getStatus().liveness?.activeSessions).toHaveLength(1);
      expect(prompts).toEqual(["hello", "Keep going"]);
    } catch (error) {
      assertionError = error;
    }
    steerRelease.resolve();
    await steerRun.catch(() => undefined);
    if (assertionError) {
      throw assertionError;
    }
  });

  test("steer-session replaces the ACP session when an active turn is still running", async () => {
    const activePromptRelease = deferred<void>();
    const prompts: string[] = [];
    let cancelCount = 0;
    let closeCount = 0;
    let sessionCount = 0;
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => {
        sessionCount += 1;
        const currentSession = sessionCount;
        return {
          close: async () => {
            closeCount += 1;
          },
          cancel: async () => {
            cancelCount += 1;
            return true;
          },
          sendUserMessage: async (prompt) => {
            prompts.push(`${currentSession}:${prompt}`);
            if (currentSession === 1) {
              await activePromptRelease.promise;
              return {
                events: [],
                rawResult: {},
                sessionId: "session-1",
                text: "late original",
              };
            }
            return {
              events: [],
              rawResult: {},
              sessionId: "session-2",
              text: "steered",
            };
          },
        };
      },
    });

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe(
        "queue-prompt",
      ),
    );
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    });
    activePromptRelease.resolve();
    await promptRun;

    expect(sessionCount).toBe(2);
    expect(cancelCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(prompts).toEqual(["1:hello", "2:Try a smaller patch"]);
    expect(
      cloud.results.find((result) => result.id === "queue-steer"),
    ).toMatchObject({
      result: { ok: true, steered: true, text: "steered" },
    });
    expect(
      cloud.results.find((result) => result.id === "queue-prompt"),
    ).toMatchObject({
      result: {
        cancelled: true,
        ignoredLateResult: true,
        ok: false,
        terminal: true,
      },
    });
    expect(JSON.stringify(cloud.events)).not.toContain("late original");
  });

  test("steer-session terminalizes when the replacement response has withheld final text", async () => {
    const cloud = fakeCloudClient();
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-steer",
      result: { error: "steer_reprompt_failed", ok: false, terminal: true },
    });
  });

  test("steer-session terminalizes when the replacement response is empty", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => true,
        sendUserMessage: async (prompt) => ({
          events: [],
          finalText: undefined,
          rawResult: {},
          sessionId: "session-1",
          text: prompt === "Try a smaller patch" ? "" : "ready",
        }),
      }),
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-steer",
      result: { error: "steer_reprompt_failed", ok: false, terminal: true },
    });
  });

  test("steer-session records failed when ACP cannot stop the active turn", async () => {
    const cloud = fakeCloudClient();
    const supervisor = new BridgeSupervisor();
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
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-steer",
      result: {
        error: "session_replacement_required",
        ok: false,
        terminal: true,
      },
    });
    expect(supervisor.getTurnState("queue-steer")?.checkpoint).toBe("failed");
  });

  test("steer-session replaces an active ACP session when cancel is not acknowledged", async () => {
    const activePromptRelease = deferred<void>();
    const prompts: string[] = [];
    let sessionCount = 0;
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => {
        sessionCount += 1;
        const currentSession = sessionCount;
        return {
          close: async () => {},
          cancel: async () => false,
          sendUserMessage: async (prompt) => {
            prompts.push(`${currentSession}:${prompt}`);
            if (currentSession === 1) {
              await activePromptRelease.promise;
              return {
                events: [],
                rawResult: {},
                sessionId: "session-1",
                text: "late original",
              };
            }
            return {
              events: [],
              rawResult: {},
              sessionId: "session-2",
              text: "steered",
            };
          },
        };
      },
    });

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await eventually(() =>
      expect(manager.getStatus().sessions[0]?.runningQueueItemId).toBe(
        "queue-prompt",
      ),
    );
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-steer",
      id: "queue-steer",
      prompt: "Try a smaller patch",
      threadId: "thread-1",
      type: "steer-session",
    });
    activePromptRelease.resolve();
    await promptRun;

    expect(sessionCount).toBe(2);
    expect(prompts).toEqual(["1:hello", "2:Try a smaller patch"]);
    expect(
      cloud.results.find((result) => result.id === "queue-steer"),
    ).toMatchObject({
      result: {
        ok: true,
        replacementSession: true,
        steered: true,
        text: "steered",
      },
    });
    expect(
      cloud.results.find((result) => result.id === "queue-prompt"),
    ).toMatchObject({
      result: {
        cancelled: true,
        ignoredLateResult: true,
        ok: false,
        terminal: true,
      },
    });
  });

  test("close-session closes an idle native ACP session", async () => {
    let closeCount = 0;
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {
          closeCount += 1;
        },
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ready",
        }),
      }),
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-close",
      id: "queue-close",
      threadId: "thread-1",
      type: "close-session",
    });

    expect(closeCount).toBe(1);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-close",
      result: { closed: true, ok: true },
    });
    expect(manager.getStatus().activeSessions).toEqual([]);
  });

  test("close-session releases active SDK terminal handles for the session", async () => {
    const cloud = fakeCloudClient();
    const terminalRegistry =
      new TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>();
    const handles: RecordingTerminalHandle[] = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createTerminal: async () => {
        const handle = recordingTerminalHandle(
          `terminal-${handles.length + 1}`,
        );
        handles.push(handle);
        return handle;
      },
      deviceId: "bridge-device-1",
      terminalRegistry,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          if (!context.terminalAdapter) {
            throw new Error("expected terminal adapter");
          }
          const handle = await context.terminalAdapter.createTerminal({
            command: "echo",
            sessionId: "session-1",
          });
          context.terminalAdapter.registry.create({
            handle,
            scope: context.terminalAdapter.scope,
          });
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ready",
          };
        },
      }),
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    expect(terminalRegistry.list()).toHaveLength(1);
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-close",
      id: "queue-close",
      organizationId: "org-1",
      threadId: "thread-1",
      type: "close-session",
    });

    expect(handles).toHaveLength(1);
    expect(handles[0]?.kills).toEqual([]);
    expect(handles[0]?.releases).toBe(1);
    expect(terminalRegistry.list()).toEqual([]);
  });

  test("late terminal operations after cancel are ignored by clearing the session registry record", async () => {
    const promptStarted = deferred<void>();
    const finishPrompt = deferred<void>();
    const cloud = fakeCloudClient();
    const terminalRegistry =
      new TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>();
    const records: ReturnType<typeof terminalRegistry.create>[] = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createTerminal: async () => recordingTerminalHandle("terminal-1"),
      deviceId: "bridge-device-1",
      terminalRegistry,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => true,
        sendUserMessage: async () => {
          if (!context.terminalAdapter) {
            throw new Error("expected terminal adapter");
          }
          const handle = await context.terminalAdapter.createTerminal({
            command: "echo",
            sessionId: "session-1",
          });
          records.push(
            context.terminalAdapter.registry.create({
              handle,
              scope: context.terminalAdapter.scope,
            }),
          );
          promptStarted.resolve();
          await finishPrompt.promise;
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "late",
          };
        },
      }),
    });

    const promptRun = manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await promptStarted.promise;
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      organizationId: "org-1",
      threadId: "thread-1",
      type: "cancel-session",
    });

    const record = records[0];
    expect(record).toBeDefined();
    expect(terminalRegistry.lookup(record!.scope)).toBeUndefined();
    await expect(
      terminalRegistry.release(record!.scope, {
        generation: record!.generation,
      }),
    ).resolves.toMatchObject({ status: "missing" });

    finishPrompt.resolve();
    await promptRun;
  });

  test("stale generation terminal operations do not affect the current turn", async () => {
    const cloud = fakeCloudClient();
    const terminalRegistry =
      new TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>();
    const handles: RecordingTerminalHandle[] = [];
    const records: ReturnType<typeof terminalRegistry.create>[] = [];
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createTerminal: async () => {
        const handle = recordingTerminalHandle(
          `terminal-${handles.length + 1}`,
        );
        handles.push(handle);
        return handle;
      },
      deviceId: "bridge-device-1",
      terminalRegistry,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => true,
        sendUserMessage: async () => {
          if (!context.terminalAdapter) {
            throw new Error("expected terminal adapter");
          }
          const handle = await context.terminalAdapter.createTerminal({
            command: "echo",
            sessionId: "session-1",
          });
          records.push(
            context.terminalAdapter.registry.create({
              handle,
              scope: context.terminalAdapter.scope,
            }),
          );
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ready",
          };
        },
      }),
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt-1",
      id: "queue-prompt-1",
      organizationId: "org-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-cancel",
      id: "queue-cancel",
      organizationId: "org-1",
      threadId: "thread-1",
      type: "cancel-session",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt-2",
      id: "queue-prompt-2",
      organizationId: "org-1",
      prompt: "hello again",
      threadId: "thread-1",
      type: "prompt",
    });

    const staleRecord = records[0];
    const currentRecord = records[1];
    expect(staleRecord?.generation).toBe(1);
    expect(currentRecord?.generation).toBe(2);
    await expect(
      terminalRegistry.kill(staleRecord!.scope, {
        generation: staleRecord!.generation,
      }),
    ).resolves.toMatchObject({
      currentGeneration: currentRecord!.generation,
      generation: staleRecord!.generation,
      status: "stale",
    });
    expect(handles[1]?.kills).toEqual([]);
    expect(terminalRegistry.lookup(currentRecord!.scope)).toBe(currentRecord);
  });

  test("revive-session uses native load context when an external session id is available", async () => {
    const contexts: BridgeSessionContext[] = [];
    const cloud = fakeCloudClient();
    let startCount = 0;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context);
        return {
          ...fakeSession(),
          getExternalContinuityState: () => ({
            attempted: true,
            fallback: false,
            loaded: true,
          }),
          start: async () => {
            startCount += 1;
            return "external-session-1";
          },
        };
      },
      resumeEnabled: true,
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-revive",
      externalSessionId: "external-session-1",
      id: "queue-revive",
      threadId: "thread-1",
      type: "revive-session",
    });

    expect(contexts[0]?.initialSessionId).toBe("external-session-1");
    expect(startCount).toBe(1);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-revive",
      result: { ok: true, revived: true, reviveMode: "native-load" },
    });
  });

  test("revive-session reuses an active session without claiming native load", async () => {
    const contexts: BridgeSessionContext[] = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context);
        return fakeSession();
      },
      resumeEnabled: true,
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });
    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-revive",
      externalSessionId: "external-session-1",
      id: "queue-revive",
      threadId: "thread-1",
      type: "revive-session",
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.initialSessionId).toBeUndefined();
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-revive",
      result: { ok: true, revived: true, reviveMode: "thread-history" },
    });
  });

  test("revive-session closes a newly created session when native start fails", async () => {
    const cloud = fakeCloudClient();
    let closeCount = 0;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        ...fakeSession(),
        close: async () => {
          closeCount += 1;
        },
        start: async () => {
          throw new Error("load failed");
        },
      }),
      resumeEnabled: true,
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-revive",
      externalSessionId: "external-session-1",
      id: "queue-revive",
      threadId: "thread-1",
      type: "revive-session",
    });

    expect(closeCount).toBe(1);
    expect(manager.getStatus().activeSessions).toEqual([]);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-revive",
      result: { error: "load failed", ok: false },
    });
  });

  test("terminalizes ACP prompt request timeouts without retrying the same prompt", async () => {
    const cloud = fakeCloudClient();
    let closeCount = 0;
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {
          closeCount += 1;
        },
        cancel: async () => {},
        getPromptTimeoutDiagnostics: () => ({
          deferredPromptEventCount: 1,
          eventTypeCounts: { permission_request: 2, tool_call: 1 },
          externalContinuity: {
            attempted: true,
            fallback: false,
            loaded: true,
          },
          lastPromptEventType: "permission_request",
          lifecyclePhase: "livePrompt",
          pendingPermissionRequestCount: 1,
          promptEventCount: 3,
          requestTimeoutMs: 600_000,
        }),
        sendUserMessage: async () => {
          throw new Error("ACP request timed out: session/prompt");
        },
      }),
    });

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(closeCount).toBe(1);
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-prompt",
      result: {
        error: "ACP prompt request timed out.",
        ok: false,
        diagnostics: {
          deferredPromptEventCount: 1,
          eventTypeCounts: { permission_request: 2, tool_call: 1 },
          externalContinuity: {
            attempted: true,
            fallback: false,
            loaded: true,
          },
          lastPromptEventType: "permission_request",
          lifecyclePhase: "livePrompt",
          pendingPermissionRequestCount: 1,
          promptEventCount: 3,
          requestTimeoutMs: 600_000,
        },
        reasonCode: "acp_method_timeout",
        terminal: true,
      },
    });
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      json: {
        diagnostics: {
          eventTypeCounts: { permission_request: 2, tool_call: 1 },
          pendingPermissionRequestCount: 1,
        },
        reasonCode: "acp_method_timeout",
      },
      text: "ACP prompt request timed out.",
      type: "error",
    });
  });

  test("revive-session falls back to thread history when native resume is disabled", async () => {
    const contexts: BridgeSessionContext[] = [];
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context);
        return fakeSession();
      },
    });

    await manager.handleQueueItem({
      agentSessionId: "provider-session",
      claimId: "claim-revive",
      externalSessionId: "external-session-1",
      id: "queue-revive",
      threadId: "thread-1",
      type: "revive-session",
    });

    expect(contexts[0]?.initialSessionId).toBeUndefined();
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-revive",
      result: { ok: true, revived: true, reviveMode: "thread-history" },
    });
  });

  test("fails visibly when a prompt completes with hidden reasoning and no final assistant text", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
    const hiddenThoughtEvent = {
      eventType: "agent_thought_chunk",
      externalEventId: "thought-1",
      part: {
        reasoningVisibility: "hidden" as const,
        status: "streaming" as const,
        text: "private reasoning",
        type: "thinking" as const,
      },
      payload: { text: "private reasoning" },
      source: "acp_bridge" as const,
    };
    const sessionInfoActiveEvent = {
      eventType: "unknown",
      externalEventId: "session-info-active",
      part: {
        json: {
          _meta: {
            codex: {
              threadStatus: {
                activeFlags: ["background"],
                type: "active",
              },
            },
          },
          sessionUpdate: "session_info_update",
        },
        status: "streaming" as const,
        type: "event" as const,
      },
      payload: {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            _meta: {
              codex: {
                threadStatus: {
                  activeFlags: ["background"],
                  type: "active",
                },
              },
            },
            sessionUpdate: "session_info_update",
          },
        },
      },
      source: "acp_bridge" as const,
    };
    const sessionInfoIdleEvent = {
      ...sessionInfoActiveEvent,
      externalEventId: "session-info-idle",
      part: {
        ...sessionInfoActiveEvent.part,
        json: {
          _meta: {
            codex: {
              threadStatus: {
                type: "idle",
              },
            },
          },
          sessionUpdate: "session_info_update",
        },
      },
      payload: {
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            _meta: {
              codex: {
                threadStatus: {
                  type: "idle",
                },
              },
            },
            sessionUpdate: "session_info_update",
          },
        },
      },
    };
    const toolCallEvent = {
      eventType: "tool_call",
      externalEventId: "tool-1",
      part: {
        json: { name: "shell" },
        status: "streaming" as const,
        type: "tool_call" as const,
      },
      payload: { content: { name: "shell", type: "tool_call" } },
      source: "acp_bridge" as const,
    };
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          context.onEvent(hiddenThoughtEvent);
          context.onEvent(sessionInfoActiveEvent);
          context.onEvent(toolCallEvent);
          context.onEvent(sessionInfoIdleEvent);
          const events = [
            hiddenThoughtEvent,
            sessionInfoActiveEvent,
            toolCallEvent,
            sessionInfoIdleEvent,
          ];
          return {
            events,
            finalText: {
              answerChunkCount: 0,
              answerTextLength: 0,
              runtimeId: "codex",
              thoughtChunkCount: 1,
              toolEventCount: 1,
              trustedFinalResultText: false,
              withheld: false,
            },
            rawResult: { stopReason: "end_turn" },
            sessionId: "session-1",
            stopReason: "end_turn",
            text: "",
          };
        },
      }),
      log: (entry) => logs.push(entry as Record<string, unknown>),
    });

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-prompt",
      result: {
        error: "empty_final_response",
        ok: false,
        reasonCode: "no_visible_assistant_output",
        terminal: true,
      },
    });
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      json: {
        finalText: expect.objectContaining({
          answerChunkCount: 0,
          answerTextLength: 0,
          runtimeId: "codex",
          thoughtChunkCount: 1,
          toolEventCount: 1,
          trustedFinalResultText: false,
          withheld: false,
        }),
        reasonCode: "empty_final_response",
        stopReason: "end_turn",
        streamSummary: {
          eventTypeCounts: {
            agent_thought_chunk: 1,
            tool_call: 1,
            unknown: 2,
          },
          totalEventCount: 4,
          unknownEvents: [
            {
              codexThreadStatus: "active",
              hasTextLikeField: false,
              method: "session/update",
              sessionUpdate: "session_info_update",
            },
            {
              codexThreadStatus: "idle",
              hasTextLikeField: false,
              method: "session/update",
              sessionUpdate: "session_info_update",
            },
          ],
        },
      },
      status: "error",
      text: "ACP runtime completed without visible assistant output.",
      type: "error",
    });
    const normalizedPayloads = cloud.events.flatMap((batch) =>
      batch.map((event) => event.normalizedPayload),
    );
    expect(normalizedPayloads).toContainEqual(
      expect.objectContaining({
        reasoningVisibility: "hidden",
        text: "private reasoning",
        type: "thinking",
      }),
    );
    expect(JSON.stringify(cloud.results)).not.toContain("private reasoning");
    expect(JSON.stringify(cloud.results)).not.toContain("background");
  });

  test("logs redacted diagnostics when Codex final text is withheld and fails empty output", async () => {
    const cloud = fakeCloudClient();
    const logs: Array<Record<string, unknown>> = [];
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
    });

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-prompt",
      result: { error: "empty_final_response", ok: false, terminal: true },
    });
    expect(cloud.events.at(-1)?.at(-1)?.normalizedPayload).toMatchObject({
      json: {
        finalText: expect.objectContaining({
          answerChunkCount: 2,
          answerTextLength: 30,
          reason: "codex_unclassified_message_chunks",
          runtimeId: "codex",
          thoughtChunkCount: 0,
          toolEventCount: 1,
          trustedFinalResultText: false,
          withheld: true,
        }),
        reasonCode: "empty_final_response",
        stopReason: "end_turn",
      },
      type: "error",
    });
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
    );
    expect(JSON.stringify({ events: cloud.events, logs })).not.toContain(
      "private",
    );
  });

  test("keeps final assistant text successful", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [],
          rawResult: { stopReason: "end_turn" },
          sessionId: "session-1",
          stopReason: "end_turn",
          text: "visible answer",
        }),
      }),
    });

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-prompt",
      result: { ok: true, text: "visible answer" },
    });
  });

  test("keeps attachment-only assistant output successful", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: [
            {
              eventType: "file",
              externalEventId: "file-1",
              part: {
                json: {
                  filename: "result.txt",
                  key: "attachments/result.txt",
                  objectKey: "attachments/result.txt",
                  status: "available",
                  type: "file",
                },
                status: "complete",
                type: "attachment",
              },
              payload: {},
              source: "acp_bridge",
            },
          ],
          rawResult: { stopReason: "end_turn" },
          sessionId: "session-1",
          stopReason: "end_turn",
          text: "",
        }),
      }),
    });

    await manager.handleQueueItem({
      claimId: "claim-prompt",
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    });

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-prompt",
      result: {
        ok: true,
        parts: [expect.objectContaining({ type: "attachment" })],
        text: "",
      },
    });
  });

  test("coalesces consecutive ACP thought chunks before persistence", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: emitSessionEvents(
            context,
            Array.from({ length: 10 }, (_, index) =>
              streamChunkEvent(
                "agent_thought_chunk",
                `thought-${index} `,
                index + 1,
              ),
            ),
          ),
          rawResult: { stopReason: "end_turn" },
          sessionId: "session-1",
          stopReason: "end_turn",
          text: "ok",
        }),
      }),
    });

    await manager.handleQueueItem(promptQueueItem());

    const persisted = flattenPersistedEvents(cloud.events);
    const thoughts = persisted.filter(
      (event) => event.eventType === "agent_thought_chunk",
    );
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({
      eventType: "agent_thought_chunk",
      sequence: 2,
      normalizedPayload: {
        chunkCount: 10,
        firstSequence: 2,
        lastSequence: 11,
        text: "thought-0 thought-1 thought-2 thought-3 thought-4 thought-5 thought-6 thought-7 thought-8 thought-9 ",
      },
      rawPayload: {
        chunkCount: 10,
        coalesced: true,
        firstSequence: 2,
        lastSequence: 11,
      },
    });
  });

  test("coalesces consecutive ACP message chunks before persistence", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: emitSessionEvents(
            context,
            Array.from({ length: 10 }, (_, index) =>
              streamChunkEvent(
                "agent_message_chunk",
                `message-${index} `,
                index + 1,
              ),
            ),
          ),
          rawResult: { stopReason: "end_turn" },
          sessionId: "session-1",
          stopReason: "end_turn",
          text: "ok",
        }),
      }),
    });

    await manager.handleQueueItem(promptQueueItem());

    const messages = flattenPersistedEvents(cloud.events).filter(
      (event) => event.eventType === "agent_message_chunk",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      eventType: "agent_message_chunk",
      sequence: 2,
      normalizedPayload: {
        chunkCount: 10,
        firstSequence: 2,
        lastSequence: 11,
        text: "message-0 message-1 message-2 message-3 message-4 message-5 message-6 message-7 message-8 message-9 ",
      },
    });
  });

  test("suppresses empty ACP thought and message chunks before persistence", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: emitSessionEvents(context, [
            streamChunkEvent("agent_thought_chunk", "", 1),
            streamChunkEvent("agent_message_chunk", "", 2),
            streamChunkEvent("agent_thought_chunk", "real thought", 3),
            streamChunkEvent("agent_message_chunk", "real message", 4),
          ]),
          rawResult: { stopReason: "end_turn" },
          sessionId: "session-1",
          stopReason: "end_turn",
          text: "ok",
        }),
      }),
    });

    await manager.handleQueueItem(promptQueueItem());

    const chunks = flattenPersistedEvents(cloud.events)
      .filter(
        (event) =>
          event.eventType === "agent_thought_chunk" ||
          event.eventType === "agent_message_chunk",
      )
      .map((event) => ({
        eventType: event.eventType,
        sequence: event.sequence,
        text: (event.normalizedPayload as { text?: string }).text,
      }));
    expect(chunks).toEqual([
      { eventType: "agent_thought_chunk", sequence: 4, text: "real thought" },
      { eventType: "agent_message_chunk", sequence: 5, text: "real message" },
    ]);
  });

  test("does not coalesce ACP chunks across tool boundaries", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => ({
          events: emitSessionEvents(context, [
            streamChunkEvent("agent_thought_chunk", "before", 1),
            toolCallEvent(2),
            streamChunkEvent("agent_thought_chunk", "after", 3),
          ]),
          rawResult: { stopReason: "end_turn" },
          sessionId: "session-1",
          stopReason: "end_turn",
          text: "ok",
        }),
      }),
    });

    await manager.handleQueueItem(promptQueueItem());

    const persisted = flattenPersistedEvents(cloud.events)
      .filter((event) =>
        ["agent_thought_chunk", "tool_call"].includes(String(event.eventType)),
      )
      .map((event) => ({
        eventType: event.eventType,
        sequence: event.sequence,
        text: (event.normalizedPayload as { text?: string }).text,
      }));
    expect(persisted).toEqual([
      { eventType: "agent_thought_chunk", sequence: 2, text: "before" },
      { eventType: "tool_call", sequence: 3, text: "tool started" },
      { eventType: "agent_thought_chunk", sequence: 4, text: "after" },
    ]);
  });

  test("preserves deferred Codex thought order and coalesces only within tool boundaries", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => ({
        close: async () => {},
        cancel: async () => {},
        sendUserMessage: async () => {
          context.onEvent(toolCallEvent(3));
          context.onEvent(streamChunkEvent("agent_thought_chunk", "before ", 1));
          context.onEvent(streamChunkEvent("agent_thought_chunk", "tool", 2));
          context.onEventBoundary?.();
          context.onEvent(streamChunkEvent("agent_thought_chunk", "after ", 4));
          context.onEvent(streamChunkEvent("agent_thought_chunk", "tool", 5));
          return {
            events: [],
            rawResult: { stopReason: "end_turn" },
            sessionId: "session-1",
            stopReason: "end_turn",
            text: "ok",
          };
        },
      }),
    });

    await manager.handleQueueItem(promptQueueItem());

    const persisted = flattenPersistedEvents(cloud.events)
      .filter((event) =>
        ["agent_thought_chunk", "tool_call"].includes(String(event.eventType)),
      )
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      .map((event) => ({
        eventType: event.eventType,
        sequence: event.sequence,
        text: (event.normalizedPayload as { text?: string }).text,
      }));
    expect(persisted).toEqual([
      { eventType: "agent_thought_chunk", sequence: 2, text: "before tool" },
      { eventType: "tool_call", sequence: 4, text: "tool started" },
      { eventType: "agent_thought_chunk", sequence: 5, text: "after tool" },
    ]);
  });

  test("marks ACP prompt timeouts as terminal queue failures", async () => {
    const cloud = fakeCloudClient();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        ...fakeSession(),
        sendUserMessage: async () => {
          throw new Error(
            "ACP session/prompt failed: ACP request timed out: session/prompt",
          );
        },
      }),
    });

    await manager.handleQueueItem(promptQueueItem());

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-prompt",
      result: {
        error: "ACP prompt request timed out.",
        ok: false,
        reasonCode: "acp_method_timeout",
        terminal: true,
      },
    });
  });

  test("marks silent live ACP sessions quiet without terminal queue failure", async () => {
    const cloud = fakeCloudClient();
    const releasePrompt = deferred<void>();
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        ...fakeSession(),
        sendUserMessage: async () => {
          await releasePrompt.promise;
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "late ok",
          };
        },
      }),
      livenessTimeoutMs: 5,
    });

    const handling = manager.handleQueueItem(promptQueueItem());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.getStatus().liveness?.activeSessions).toMatchObject([
      {
        providerActivitySeen: false,
        queueItemId: "queue-prompt",
        state: "quiet",
      },
    ]);
    releasePrompt.resolve();
    await handling;

    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-prompt",
      result: {
        ok: true,
        text: "late ok",
      },
    });
    expect(manager.getStatus().liveness?.activeSessions).toEqual([]);
  });
});

function fakeCloudClient() {
  const events: Array<
    Array<{
      eventType?: string;
      normalizedPayload?: unknown;
      rawPayload?: unknown;
      sequence?: number;
      source?: string;
    }>
  > = [];
  const results: Array<{ claimId: string; id: string; result: unknown }> = [];
  const uploads: Array<{
    agentSessionId?: string;
    byteLength: number;
    filename: string;
    mediaType?: string;
    threadId: string;
  }> = [];
  return {
    events,
    results,
    uploads,
    appendEvents: async <TResponse = Record<string, unknown>>(
      input: Array<(typeof events)[number][number]>,
    ) => {
      events.push(input);
      return {} as TResponse;
    },
    uploadAttachment: async <
      TResponse = { file: Record<string, unknown> },
    >(input: {
      agentSessionId?: string;
      bytes: Uint8Array;
      filename: string;
      mediaType?: string;
      threadId: string;
    }) => {
      uploads.push({
        agentSessionId: input.agentSessionId,
        byteLength: input.bytes.byteLength,
        filename: input.filename,
        mediaType: input.mediaType,
        threadId: input.threadId,
      });
      const objectKey = `attachments/agent-output/${input.threadId}/${input.agentSessionId ?? "session"}/${input.filename}`;
      return {
        file: {
          bucket: "chat-attachments",
          checksumSha256: "e".repeat(64),
          createdBy: "agent",
          filename: input.filename,
          key: objectKey,
          mediaType: input.mediaType,
          objectKey,
          sizeBytes: input.bytes.byteLength,
          status: "available",
          storageBackend: "r2",
          type: "file",
        },
      } as TResponse;
    },
    markResult: async <TResponse = Record<string, unknown>>(
      id: string,
      result: unknown,
      claimId?: string,
    ) => {
      if (!claimId) {
        throw new Error("claimId is required");
      }
      results.push({ claimId, id, result });
      return {} as TResponse;
    },
  };
}

function promptQueueItem(): BridgeSessionQueueItem {
  return {
    agentSessionId: "provider-session",
    claimId: "claim-prompt",
    id: "queue-prompt",
    prompt: "hello",
    threadId: "thread-1",
    type: "prompt",
  };
}

function streamChunkEvent(
  eventType: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
  sequence: number,
): NormalizedBridgeEvent {
  return {
    eventType,
    externalEventId: `session-1:${sequence}:${eventType}`,
    part: {
      status: "streaming",
      text,
      type: eventType === "agent_thought_chunk" ? "thinking" : "text",
    },
    payload: {
      content: { text, type: "text" },
      sessionUpdate: eventType,
    },
    providerSequence: sequence,
    source: "acp_bridge",
  };
}

function toolCallEvent(sequence: number): NormalizedBridgeEvent {
  return {
    eventType: "tool_call",
    externalEventId: `session-1:${sequence}:tool_call`,
    part: {
      json: {
        state: "input-available",
        toolCallId: "tool-1",
        toolName: "shell",
      },
      status: "streaming",
      text: "tool started",
      type: "tool_call",
    },
    payload: { sessionUpdate: "tool_call", toolCallId: "tool-1" },
    providerSequence: sequence,
    source: "acp_bridge",
  };
}

function toolResultEvent(sequence: number): NormalizedBridgeEvent {
  return {
    eventType: "tool_result",
    externalEventId: `session-1:${sequence}:tool_result`,
    part: {
      json: {
        state: "output-available",
        toolCallId: "tool-1",
        toolName: "shell",
      },
      status: "streaming",
      text: "tool finished",
      type: "tool_result",
    },
    payload: { sessionUpdate: "tool_result", toolCallId: "tool-1" },
    providerSequence: sequence,
    source: "acp_bridge",
  };
}

function nestedToolResultEvent(sequence: number): NormalizedBridgeEvent {
  return {
    eventType: "tool_result",
    externalEventId: `session-1:${sequence}:tool_result`,
    part: {
      json: {
        content: {
          state: "output-available",
          toolCallId: "tool-1",
          toolName: "shell",
        },
      },
      status: "streaming",
      text: "tool finished",
      type: "tool_result",
    },
    payload: { sessionUpdate: "tool_result", toolCallId: "tool-1" },
    providerSequence: sequence,
    source: "acp_bridge",
  };
}

function emitSessionEvents(
  context: BridgeSessionContext,
  events: NormalizedBridgeEvent[],
): NormalizedBridgeEvent[] {
  for (const event of events) {
    context.onEvent(event);
  }
  return events;
}

function flattenPersistedEvents(
  batches: Array<
    Array<{
      eventType?: string;
      normalizedPayload?: unknown;
      rawPayload?: unknown;
      sequence?: number;
      source?: string;
    }>
  >,
) {
  return batches.flat();
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
  };
}

type RecordingTerminalHandle = SdkAcpRuntimeTerminalHandle & {
  kills: string[];
  releases: number;
};

function recordingTerminalHandle(terminalId: string): RecordingTerminalHandle {
  const handle: RecordingTerminalHandle = {
    currentOutput: async () => ({ output: terminalId, truncated: false }),
    kill: async (signal?: string) => {
      handle.kills.push(signal ?? "");
    },
    kills: [],
    release: async () => {
      handle.releases += 1;
    },
    releases: 0,
    terminalId,
    waitForExit: async () => ({ exitCode: 0 }),
  };
  return handle;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw lastError;
}
