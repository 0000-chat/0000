import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_VERSION,
  buildBridgeRestartHandoff,
  buildBridgeCapacitySnapshot,
  buildBridgeDoctorReport,
  buildBridgeRegistrationFailure,
  buildHeartbeatStatusPayload,
  type BridgeRegistration,
  type BridgeStatus,
  type BridgeLoopIterationInput,
  bridgeHeartbeatSignature,
  consumeBridgeRestartHandoffFile,
  describeStatus,
  deriveConvexCloudUrl,
  appendBridgeRegistration,
  ensureSecureBridgeConfigFile,
  buildAgentToolsMcpServers,
  buildStartupSecuritySummary,
  createBridgeWakeSignal,
  getAllowRemoteCwd,
  getAcpIdleTtlMs,
  getLocalHardMaxInFlight,
  getConvexUrl,
  getWarmRuntimeProfileIds,
  normalizeBridgeConfigFile,
  normalizeQueueCommand,
  parseHermesProfileListOutput,
  parseBridgeArgs,
  preparePendingAgentConnectionRequest,
  refreshRuntimeConformanceProfilesForTest,
  runtimeConformanceRecordsForSuccessfulCommand,
  reconcileBridgeStartupControlCommandStatus,
  runBridgeRegistrationScheduler,
  runBridgeLoopIteration,
  sendHeartbeatWithClient,
  shouldCleanupBridgeOrphanedProcesses,
  upsertBridgeRegistration,
  waitForRestartShutdownTask,
  writeBridgeConfigFile,
  writeBridgeRestartHandoffFile,
  writeBridgeStatusFile,
} from "./acp-bridge";
import {
  BridgeCloudHttpError,
  type BridgeHeartbeatInput,
} from "./acp-bridge/convex-http";
import { openBridgeJournal } from "./acp-bridge/sqlite-journal";
import {
  defaultAgentCommandForEnvironment,
  DEFAULT_CLAUDE_CODE_ACP_COMMAND,
  DEFAULT_CODEX_ACP_COMMAND,
} from "./acp-bridge/runtime-defaults";

describe("bridge command parsing", () => {
  test("accepts connect-org as a legacy alias for connect", () => {
    expect(
      parseBridgeArgs([
        "connect-org",
        "CODE",
        "--app-url",
        "https://0000.chat",
      ]),
    ).toEqual({
      command: "connect",
      flags: { "app-url": "https://0000.chat" },
      positionals: ["CODE"],
    });
  });

  test("normalizes choice response payload text into legacy command fields", () => {
    expect(
      normalizeQueueCommand({
        agentSessionId: "agent-session-1",
        bridgeProfileId: "claude-code:claude-acp",
        claimId: "claim-choice",
        id: "queue-choice",
        kind: "choice-response",
        organizationId: "org-1",
        payload: {
          continuationPrompt:
            "The user selected an option for this pending multiple-choice prompt.",
          externalRequestId: "agent-choice:agent-session-1:123",
          resumePolicy: "durable_continuation",
          text: "enable_drive",
        },
        threadId: "thread-1",
      }),
    ).toMatchObject({
      approvalOutcome: "enable_drive",
      externalRequestId: "agent-choice:agent-session-1:123",
      prompt:
        "The user selected an option for this pending multiple-choice prompt.",
      resumePolicy: "durable_continuation",
      type: "choice-response",
    });
  });

  test("normalizes safe code attribution metadata from queue commands", () => {
    expect(
      normalizeQueueCommand({
        codeAttribution: {
          gitAuthorEmail: "don@users.noreply.github.com",
          gitAuthorName: "Don",
          githubLogin: "don",
          provider: "github",
          providerAccountId: "12345",
          requestedByUserId: "user_123",
          source: "github-linked-account",
          accessToken: "must-not-survive",
        },
        claimId: "claim-1",
        id: "queue-1",
        kind: "prompt",
        prompt: "Ship it",
        threadId: "thread-1",
      }),
    ).toMatchObject({
      codeAttribution: {
        gitAuthorEmail: "don@users.noreply.github.com",
        gitAuthorName: "Don",
        githubLogin: "don",
        provider: "github",
        providerAccountId: "12345",
        requestedByUserId: "user_123",
        source: "github-linked-account",
      },
      type: "prompt",
    });
    expect(
      JSON.stringify(
        normalizeQueueCommand({
          codeAttribution: {
            accessToken: "must-not-survive",
            gitAuthorEmail: "don@users.noreply.github.com",
            gitAuthorName: "Don",
            source: "github-linked-account",
          },
          id: "queue-1",
          kind: "prompt",
          prompt: "Ship it",
        }),
      ),
    ).not.toContain("must-not-survive");
  });
});

describe("Hermes profile discovery", () => {
  test("parses long profile names without absorbing placeholder columns", () => {
    const profiles = parseHermesProfileListOutput(`
Profile                     Model                        Gateway      Alias
────────────────────────────────────────────────────────────────────────────
◆default                   gpt-5.5                      running      —            —
nextpay-chief-of-staff —                            stopped      nextpay-chief-of-staff —
nextpay-chief-of-staff gpt-5.5                      stopped      nextpay-chief-of-staff —
◆ nextpay-chief-of-staff    —                            —            —
`);

    expect(profiles).toEqual([
      {
        gateway: "running",
        model: "gpt-5.5",
        name: "default",
      },
      {
        gateway: "stopped",
        name: "nextpay-chief-of-staff",
        alias: "nextpay-chief-of-staff",
      },
      {
        gateway: "stopped",
        model: "gpt-5.5",
        name: "nextpay-chief-of-staff",
        alias: "nextpay-chief-of-staff",
      },
      {
        name: "nextpay-chief-of-staff",
      },
    ]);
  });
});

describe("bridge capacity configuration", () => {
  test("closes idle ACP sessions by default to avoid process accumulation", () => {
    expect(getAcpIdleTtlMs({}, {})).toBe(30 * 60_000);
    expect(
      getAcpIdleTtlMs(
        {},
        { ZERO_CHAT_BRIDGE_ACP_IDLE_TTL_MS: "0" },
      ),
    ).toBe(0);
  });

  test("does not set a local hard cap unless max-in-flight is configured", () => {
    expect(getLocalHardMaxInFlight({}, {})).toBeUndefined();
  });

  test("uses explicit max-in-flight as an optional local hard cap", () => {
    expect(getLocalHardMaxInFlight({ "max-in-flight": "6" }, {})).toBe(6);
    expect(
      getLocalHardMaxInFlight(
        {},
        { ZERO_CHAT_BRIDGE_MAX_IN_FLIGHT: "9" },
      ),
    ).toBe(9);
  });

  test("does not count retained warm sessions against fresh work capacity", () => {
    const activeWork = new Map<string, Promise<void>>([
      ["queue-active", Promise.resolve()],
    ]);
    const snapshot = buildBridgeCapacitySnapshot(
      [
        {
          inFlightCommands: new Map(),
          manager: {
            getStatus: () => ({
              activeSessions: [],
              retainedSessions: [],
              terminalInteractionSessionKeyCount: 0,
              sessions: [
                {
                  lastUsedAt: Date.UTC(2026, 5, 5, 10, 0, 0),
                  queueDepth: 0,
                  sessionKey: "warm-session",
                  threadId: "thread-warm",
                },
              ],
            }),
          },
          orgMaxInFlight: 2,
        },
        {
          inFlightCommands: activeWork,
          manager: {
            getStatus: () => ({
              activeSessions: ["active-session"],
              retainedSessions: [],
              terminalInteractionSessionKeyCount: 0,
              sessions: [
                {
                  lastUsedAt: Date.UTC(2026, 5, 5, 10, 0, 1),
                  queueDepth: 1,
                  runningQueueItemId: "queue-active",
                  sessionKey: "active-session",
                  threadId: "thread-active",
                },
              ],
            }),
          },
          orgMaxInFlight: 2,
        },
      ],
      3,
    );

    expect(snapshot).toMatchObject({
      bridgeMaxInFlight: 3,
      processSlotUsage: 1,
      retainedSessionCount: 1,
      totalInFlight: 1,
    });
  });

  test("parses explicit warm runtime profiles from flags and env", () => {
    expect(getWarmRuntimeProfileIds({}, {})).toEqual([]);
    expect(
      getWarmRuntimeProfileIds(
        {
          "warm-runtime-profile": [
            "codex:default",
            "hermes:default|hermes-profile:ops",
          ],
        },
        { ZERO_CHAT_BRIDGE_WARM_RUNTIME_PROFILES: "claude-code:default" },
      ),
    ).toEqual([
      "claude-code:default",
      "codex:default",
      "hermes:default|hermes-profile:ops",
    ]);
    expect(
      getWarmRuntimeProfileIds(
        {},
        {
          ZERO_CHAT_BRIDGE_WARM_RUNTIME_PROFILES:
            "codex:default, codex:default, hermes:default",
        },
      ),
    ).toEqual(["codex:default", "hermes:default"]);
  });
});

describe("bridge ACP idle session cleanup", () => {
  test("enables idle ACP session cleanup by default", () => {
    expect(getAcpIdleTtlMs({}, {})).toBe(30 * 60 * 1000);
  });

  test("keeps explicit idle cleanup overrides", () => {
    expect(getAcpIdleTtlMs({ "acp-idle-ttl-ms": "0" }, {})).toBe(0);
    expect(
      getAcpIdleTtlMs(
        {},
        { ZERO_CHAT_BRIDGE_ACP_IDLE_TTL_MS: "1200" },
      ),
    ).toBe(1200);
  });
});

describe("bridge restart shutdown", () => {
  test("does not wait forever for stuck shutdown work during a restart", async () => {
    const result = await waitForRestartShutdownTask(
      new Promise<void>(() => {}),
      5,
    );

    expect(result).toBe("timed_out");
  });
});

describe("bridge process cleanup policy", () => {
  test("defers orphan process cleanup while queue work is active", () => {
    expect(
      shouldCleanupBridgeOrphanedProcesses({
        inFlightCommandCount: 1,
        managerStatus: {
          activeSessions: [],
          sessions: [],
        },
        singletonCanClaim: true,
      }),
    ).toBe(false);
  });

  test("defers orphan process cleanup while a session queue is running", () => {
    expect(
      shouldCleanupBridgeOrphanedProcesses({
        inFlightCommandCount: 0,
        managerStatus: {
          activeSessions: [],
          sessions: [
            {
              lastUsedAt: Date.UTC(2026, 5, 5, 10, 2, 0),
              queueDepth: 0,
              runningQueueItemId: "queue-1",
              sessionKey: "session-1",
              threadId: "thread-1",
            },
          ],
        },
        singletonCanClaim: true,
      }),
    ).toBe(false);
  });

  test("allows orphan process cleanup when the bridge is idle and claimable", () => {
    expect(
      shouldCleanupBridgeOrphanedProcesses({
        inFlightCommandCount: 0,
        managerStatus: {
          activeSessions: [],
          sessions: [],
        },
        singletonCanClaim: true,
      }),
    ).toBe(true);
  });
});

describe("bridge control command lifecycle", () => {
  test("persists accepted and waiting_for_idle for restartWhenIdle while work is still active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const writes: BridgeStatus[] = [];
    let claimCalled = false;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      sessionQueues: [
        {
          queueDepth: 1,
          runningQueueItemId: "queue_1",
          sessionKey: "session_1",
          threadId: "thread_1",
        },
      ],
    };

    const result = await runBridgeLoopIteration({
      claimCommands: async () => {
        claimCalled = true;
        return [];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          sessions: [
            {
              lastUsedAt: Date.UTC(2026, 5, 22, 8, 59, 0),
              queueDepth: 1,
              runningQueueItemId: "queue_1",
              sessionKey: "session_1",
              threadId: "thread_1",
            },
          ],
          terminalInteractionSessionKeyCount: 0,
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 22, 9, 0, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({
        control: {
          command: {
            command: "restartWhenIdle",
            requestedAt: Date.UTC(2026, 5, 22, 8, 59, 0),
          },
        },
        ok: true,
      }),
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async (_path, nextStatus) => {
        writes.push(JSON.parse(JSON.stringify(nextStatus)) as BridgeStatus);
      },
    });

    expect(result.restartRequested).toBe(false);
    expect(claimCalled).toBe(false);
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          controlCommandStatus: expect.objectContaining({
            command: "restartWhenIdle",
            status: "accepted",
          }),
          pendingControlCommand: expect.objectContaining({
            command: "restartWhenIdle",
          }),
        }),
        expect.objectContaining({
          controlCommandStatus: expect.objectContaining({
            command: "restartWhenIdle",
            status: "waiting_for_idle",
          }),
          lifecycle: "draining",
          pendingControlCommand: expect.objectContaining({
            command: "restartWhenIdle",
          }),
        }),
      ]),
    );
    expect(buildHeartbeatStatusPayload(status)).toMatchObject({
      controlCommandStatus: {
        command: "restartWhenIdle",
        status: "waiting_for_idle",
      },
    });
  });

  test("persists executing restartWhenIdle and flushes logs before returning restartRequested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const writes: BridgeStatus[] = [];
    let flushCount = 0;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
    };

    const result = await runBridgeLoopIteration({
      claimCommands: async () => [],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, {
        flush: async () => {
          flushCount += 1;
        },
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          sessions: [],
          terminalInteractionSessionKeyCount: 0,
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 22, 9, 5, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({
        control: {
          command: {
            command: "restartWhenIdle",
            requestedAt: Date.UTC(2026, 5, 22, 9, 4, 0),
          },
        },
        ok: true,
      }),
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async (_path, nextStatus) => {
        writes.push(JSON.parse(JSON.stringify(nextStatus)) as BridgeStatus);
      },
    });

    expect(result.restartRequested).toBe(true);
    expect(flushCount).toBe(1);
    const executingWrite = writes.find(
      (write) => write.controlCommandStatus?.status === "executing",
    );
    expect(executingWrite).toMatchObject({
      controlCommandStatus: {
        command: "restartWhenIdle",
        status: "executing",
      },
      lifecycle: "restarting",
    });
    expect(executingWrite?.pendingControlCommand).toBeUndefined();
    expect(status.controlCommandStatus).toMatchObject({
      command: "restartWhenIdle",
      status: "executing",
    });
  });

  test("marks an executing control command as succeeded on the next startup", () => {
    const nextStatus = reconcileBridgeStartupControlCommandStatus(
      {
        controlCommandStatus: {
          acceptedAt: Date.UTC(2026, 5, 22, 8, 58, 0),
          command: "restartWhenIdle",
          requestedAt: Date.UTC(2026, 5, 22, 8, 57, 0),
          startedAt: Date.UTC(2026, 5, 22, 8, 59, 0),
          status: "executing",
        },
      },
      {
        bridgeVersion: BRIDGE_VERSION,
        instanceId: "bridge-instance-next",
        mcpManifestHash: "manifest",
        pid: 1234,
        processStartedAt: "2026-06-22T09:00:00.000Z",
        toolPolicyHash: "policy",
      },
      () => Date.UTC(2026, 5, 22, 9, 0, 0),
    );

    expect(nextStatus).toMatchObject({
      acceptedAt: Date.UTC(2026, 5, 22, 8, 58, 0),
      command: "restartWhenIdle",
      completedAt: Date.UTC(2026, 5, 22, 9, 0, 0),
      instanceId: "bridge-instance-next",
      requestedAt: Date.UTC(2026, 5, 22, 8, 57, 0),
      startedAt: Date.UTC(2026, 5, 22, 8, 59, 0),
      status: "succeeded",
    });
  });
});

describe("bridge restart handoff", () => {
  test("writes and consumes privacy-safe scoped restart hints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-handoff-"));
    const handoffPath = join(dir, "restart-handoff.json");
    const status: BridgeStatus = {
      activeSessions: [],
      appUrl: "https://0000.chat",
      connected: true,
      controlCommandStatus: {
        command: "updateWhenIdle",
        status: "executing",
        targetVersion: "0.1.29",
      },
      deviceId: "bridge-org-a",
      recentErrors: [],
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:default",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
      sessionQueues: [
        {
          agentSessionId: "provider-session",
          bridgeProfileId: "codex:default",
          lastUsedAt: Date.UTC(2026, 5, 22, 8, 55, 0),
          organizationId: "org-1",
          queueDepth: 1,
          runningQueueItemId: "queue-1",
          runtimeProfileId: "codex:default",
          sessionKey: "org-secret-session-key",
          threadId: "thread-1",
        },
      ],
    };

    const handoff = {
      ...buildBridgeRestartHandoff({
        createdAt: Date.UTC(2026, 5, 22, 9, 0, 0),
        reason: "updateWhenIdle",
        statuses: [status],
        targetVersion: "0.1.29",
      }),
      bridgeVersion: "0.1.27",
      status: "updated",
    };
    await writeBridgeRestartHandoffFile(handoffPath, handoff);

    const raw = await Bun.file(handoffPath).text();
    expect(raw).toContain("bridge-org-a");
    expect(raw).toContain("codex:default");
    expect(raw).not.toContain("org-secret-session-key");
    expect(raw).not.toContain("Bearer");
    expect(raw).not.toContain("token");
    expect((await stat(handoffPath)).mode & 0o777).toBe(0o600);

    const consumed = await consumeBridgeRestartHandoffFile({
      now: () => Date.UTC(2026, 5, 22, 9, 1, 0),
      path: handoffPath,
      registrations: [
        {
          appUrl: "https://0000.chat",
          bridgeToken: "secret-token",
          deviceId: "bridge-org-a",
          deviceName: "Org A",
          pairedAt: "2026-06-22T08:00:00.000Z",
        },
      ],
    });

    expect(consumed?.status).toBe("updated");
    expect(consumed?.entries).toEqual([
      expect.objectContaining({
        deviceId: "bridge-org-a",
        runtimeProfileIds: ["codex:default"],
        sessionWarmupHints: [
          expect.objectContaining({
            agentSessionId: "provider-session",
            bridgeProfileId: "codex:default",
            organizationId: "org-1",
            runtimeProfileId: "codex:default",
            threadId: "thread-1",
          }),
        ],
      }),
    ]);
    expect(Bun.file(handoffPath).exists()).resolves.toBe(false);
  });

  test("ignores stale or schema-mismatched restart handoff files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-handoff-"));
    const handoffPath = join(dir, "restart-handoff.json");
    await writeBridgeRestartHandoffFile(
      handoffPath,
      buildBridgeRestartHandoff({
        createdAt: Date.UTC(2026, 5, 22, 8, 0, 0),
        reason: "restartWhenIdle",
        statuses: [
          {
            activeSessions: [],
            appUrl: "https://0000.chat",
            connected: true,
            deviceId: "bridge-org-a",
            recentErrors: [],
          },
        ],
      }),
    );

    await expect(
      consumeBridgeRestartHandoffFile({
        now: () => Date.UTC(2026, 5, 22, 9, 0, 1),
        path: handoffPath,
        registrations: [
          {
            appUrl: "https://0000.chat",
            bridgeToken: "secret-token",
            deviceId: "bridge-org-a",
            deviceName: "Org A",
            pairedAt: "2026-06-22T08:00:00.000Z",
          },
        ],
      }),
    ).resolves.toBeUndefined();

    await writeBridgeRestartHandoffFile(handoffPath, { schemaVersion: 999 });
    await expect(
      consumeBridgeRestartHandoffFile({
        now: () => Date.UTC(2026, 5, 22, 9, 0, 1),
        path: handoffPath,
        registrations: [
          {
            appUrl: "https://0000.chat",
            bridgeToken: "secret-token",
            deviceId: "bridge-org-a",
            deviceName: "Org A",
            pairedAt: "2026-06-22T08:00:00.000Z",
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  test("leaves another process registration handoff intact when nothing matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-handoff-"));
    const handoffPath = join(dir, "restart-handoff.json");
    const handoff = buildBridgeRestartHandoff({
      createdAt: Date.UTC(2026, 5, 22, 9, 0, 0),
      reason: "restartWhenIdle",
      statuses: [
        {
          activeSessions: [],
          appUrl: "https://0000.chat",
          connected: true,
          deviceId: "bridge-org-a",
          recentErrors: [],
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
        },
      ],
    });
    await writeBridgeRestartHandoffFile(handoffPath, handoff);
    const before = await Bun.file(handoffPath).text();

    await expect(
      consumeBridgeRestartHandoffFile({
        now: () => Date.UTC(2026, 5, 22, 9, 1, 0),
        path: handoffPath,
        registrations: [
          {
            appUrl: "https://0000.chat",
            bridgeToken: "secret-token",
            deviceId: "bridge-org-b",
            deviceName: "Org B",
            pairedAt: "2026-06-22T08:00:00.000Z",
          },
        ],
      }),
    ).resolves.toBeUndefined();

    expect(await Bun.file(handoffPath).text()).toBe(before);
  });

  test("partial restart handoff consumption preserves unmatched valid entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-handoff-"));
    const handoffPath = join(dir, "restart-handoff.json");
    await writeBridgeRestartHandoffFile(
      handoffPath,
      buildBridgeRestartHandoff({
        createdAt: Date.UTC(2026, 5, 22, 9, 0, 0),
        reason: "updateWhenIdle",
        statuses: [
          {
            activeSessions: [],
            appUrl: "https://0000.chat",
            connected: true,
            deviceId: "bridge-org-a",
            recentErrors: [],
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
          },
          {
            activeSessions: [],
            appUrl: "https://staging.0000.chat",
            connected: true,
            deviceId: "bridge-org-b",
            recentErrors: [],
            runtimeProfiles: [
              {
                capabilities: {},
                command: ["claude", "acp"],
                id: "claude:default",
                kind: "claude-code",
                label: "Claude",
                status: "available",
              },
            ],
          },
        ],
        targetVersion: "0.1.29",
      }),
    );

    const consumed = await consumeBridgeRestartHandoffFile({
      now: () => Date.UTC(2026, 5, 22, 9, 1, 0),
      path: handoffPath,
      registrations: [
        {
          appUrl: "https://0000.chat",
          bridgeToken: "secret-token",
          deviceId: "bridge-org-a",
          deviceName: "Org A",
          pairedAt: "2026-06-22T08:00:00.000Z",
        },
      ],
    });

    expect(consumed?.entries.map((entry) => entry.deviceId)).toEqual([
      "bridge-org-a",
    ]);
    const remaining = await consumeBridgeRestartHandoffFile({
      now: () => Date.UTC(2026, 5, 22, 9, 2, 0),
      path: handoffPath,
      registrations: [
        {
          appUrl: "https://staging.0000.chat",
          bridgeToken: "secret-token",
          deviceId: "bridge-org-b",
          deviceName: "Org B",
          pairedAt: "2026-06-22T08:00:00.000Z",
        },
      ],
    });
    expect(remaining?.targetVersion).toBe("0.1.29");
    expect(remaining?.entries).toEqual([
      expect.objectContaining({
        deviceId: "bridge-org-b",
        runtimeProfileIds: ["claude:default"],
      }),
    ]);
    expect(Bun.file(handoffPath).exists()).resolves.toBe(false);
  });
});

describe("bridge restart handoff startup priority", () => {
  test("prioritized handoff profiles refresh before normal stale profiles", async () => {
    const refreshedProfiles: string[] = [];
    const records = await refreshRuntimeConformanceProfilesForTest({
      getInFlightProfileIds: () => new Set(),
      getRunningSessionProfileIds: () => new Set(),
      now: () => 1_000,
      priorityProfileIds: ["codex:default"],
      probeProfile: async (profile) => {
        refreshedProfiles.push(profile.id);
        return {
          checkedAt: 1_000 + refreshedProfiles.length,
          diagnostics: [],
          runtimeId: profile.id,
          state: "passing",
          strength: "init_only",
        };
      },
      profiles: [
        {
          capabilities: {},
          command: ["claude", "acp"],
          id: "claude:default",
          kind: "claude-code",
          label: "Claude",
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
      records: {
        "claude:default": {
          checkedAt: 0,
          diagnostics: [],
          runtimeId: "claude:default",
          state: "passing",
          strength: "init_only",
        },
        "codex:default": {
          checkedAt: 900,
          diagnostics: [],
          runtimeId: "codex:default",
          state: "passing",
          strength: "init_only",
        },
      },
      ttlMs: 1_000,
    });

    expect(refreshedProfiles).toEqual(["codex:default", "claude:default"]);
    expect(records["codex:default"]?.checkedAt).toBe(1_001);
    expect(records["claude:default"]?.checkedAt).toBe(1_002);
  });
});

describe("bridge startup control command reconciliation", () => {
  test("does not mark an executing target-version command succeeded on version mismatch", () => {
    const reconciled = reconcileBridgeStartupControlCommandStatus(
      {
        controlCommandStatus: {
          command: "updateWhenIdle",
          requestedAt: 10,
          startedAt: 20,
          status: "executing",
          targetVersion: "0.1.29",
        },
      },
      {
        bridgeVersion: "0.1.28",
        instanceId: "new-instance",
        mcpManifestHash: "mcp",
        pid: 1234,
        processStartedAt: "2026-06-22T09:00:00.000Z",
        toolPolicyHash: "tool",
      },
      () => 40,
    );

    expect(reconciled).toEqual(
      expect.objectContaining({
        command: "updateWhenIdle",
        failedAt: 40,
        instanceId: "new-instance",
        status: "failed",
        targetVersion: "0.1.29",
      }),
    );
    expect(reconciled?.error).toContain("target version");
  });
});

describe("bridge Convex URL resolution", () => {
  test("derives a Convex cloud URL from a Convex site URL", () => {
    expect(deriveConvexCloudUrl("https://example-123.convex.site")).toBe(
      "https://example-123.convex.cloud",
    );
  });

  test("prefers explicit flag and environment values", () => {
    const config = {
      appUrl: "https://0000.chat",
      bridgeApiUrl: "https://example-123.convex.site",
    };

    expect(
      getConvexUrl({ "convex-url": "https://flag.convex.cloud" }, config, {}),
    ).toBe("https://flag.convex.cloud");
    expect(
      getConvexUrl({}, config, {
        ZERO_CHAT_BRIDGE_CONVEX_URL: "https://env.convex.cloud",
      }),
    ).toBe("https://env.convex.cloud");
  });

  test("falls back to the paired bridge API URL before app URL derivation", () => {
    expect(
      getConvexUrl(
        {},
        {
          appUrl: "https://0000.chat",
          bridgeApiUrl: "https://uncommon-starfish-672.convex.site",
        },
        {},
      ),
    ).toBe("https://uncommon-starfish-672.convex.cloud");
  });
});

describe("bridge wake subscription", () => {
  test("activates a Convex work signal subscription after heartbeat provides a wake token", async () => {
    let updateCallback: (() => void) | undefined;
    const subscriptions: Array<{ args: Record<string, unknown>; query: unknown }> = [];
    const closes: number[] = [];
    const fakeClient = {
      close: async () => {
        closes.push(Date.now());
      },
      onUpdate: (query: unknown, args: Record<string, unknown>, callback: () => void) => {
        subscriptions.push({ query, args });
        updateCallback = callback;
        return { unsubscribe: () => undefined };
      },
    };
    const signal = createBridgeWakeSignal({
      clientFactory: () => fakeClient,
      config: {
        appUrl: "https://0000.chat",
        bridgeToken: "bridge-token",
        deviceName: "Test Bridge",
        deviceId: "bridge-public-1",
        pairedAt: new Date().toISOString(),
      },
      convexUrl: "https://example.convex.cloud",
      limit: 2,
      log: Object.assign(() => undefined, { flush: async () => undefined }),
    });

    signal.updateWakeToken?.({
      expiresAt: Date.now() + 60_000,
      refreshAfterMs: 30_000,
      token: "wake-token",
    });

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.args).toEqual({
      deviceId: "bridge-public-1",
      limit: 2,
      wakeToken: "wake-token",
    });

    const wait = signal.wait(5_000);
    updateCallback?.();
    await wait;
    await signal.close();

    expect(closes).toHaveLength(1);
  });
});

describe("bridge MCP helper configuration", () => {
  test("uses public app URL for agent tool invocation", () => {
    const expectedAgentToolsMcpScriptPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "agent-tools-mcp.ts",
    );

    expect(
      buildAgentToolsMcpServers({
        agentSessionId: "agent_session_1",
        agentToolsUrl: "https://0000.chat",
        appUrl: "https://0000.chat",
        bridgeToken: "token-a",
        deviceId: "bridge_a",
        enabledFeatureFlags: ["artifacts"],
        threadId: "thread_1",
      }),
    ).toEqual([
      {
        args: [expectedAgentToolsMcpScriptPath],
        command: "bun",
        env: [
          { name: "ZERO_CHAT_AGENT_SESSION_ID", value: "agent_session_1" },
          { name: "ZERO_CHAT_APP_URL", value: "https://0000.chat" },
          { name: "ZERO_CHAT_AGENT_TOOLS_URL", value: "https://0000.chat" },
          { name: "ZERO_CHAT_BRIDGE_DEVICE_ID", value: "bridge_a" },
          { name: "ZERO_CHAT_THREAD_ID", value: "thread_1" },
          { name: "ZERO_CHAT_ENABLED_FEATURE_FLAGS", value: "artifacts" },
          { name: "ZERO_CHAT_BRIDGE_TOKEN", value: "token-a" },
        ],
        name: "0000",
      },
    ]);
  });

  test("refreshes feature flags from heartbeat before creating MCP helper config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-flags-"));
    const config = bridgeRegistration();
    const appliedFeatureFlags: string[][] = [];

    await runBridgeLoopIteration({
      applyFeatureFlagsControl: async (enabledFeatureFlags: string[]) => {
        appliedFeatureFlags.push([...enabledFeatureFlags]);
        config.enabledFeatureFlags = [...enabledFeatureFlags];
      },
      claimCommands: async () => [],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config,
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          sessions: [],
          terminalInteractionSessionKeyCount: 0,
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 22, 9, 0, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({
        enabledFeatureFlags: ["artifacts"],
        ok: true,
      }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(appliedFeatureFlags).toEqual([["artifacts"]]);
    expect(config.enabledFeatureFlags).toEqual(["artifacts"]);
    expect(
      buildAgentToolsMcpServers({
        ...config,
        agentSessionId: "agent_session_1",
        agentToolsUrl: config.appUrl,
        threadId: "thread_1",
      })[0]?.env,
    ).toContainEqual({
      name: "ZERO_CHAT_ENABLED_FEATURE_FLAGS",
      value: "artifacts",
    });
  });

  test("rejects bridge-scoped session keys for agent tool invocation", () => {
    expect(() =>
      buildAgentToolsMcpServers({
        agentSessionId:
          "unknown-org:bridge_a9624a953a17eb66246fde28:hermes%3Adefault:kx7:jd73",
        agentToolsUrl: "https://0000.chat",
        appUrl: "https://0000.chat",
        bridgeToken: "token-a",
        deviceId: "bridge_a",
        threadId: "thread_1",
      }),
    ).toThrow("bridge-scoped session key");
  });
});

describe("bridge multi-organization config", () => {
  test("normalizes legacy single-device bridge configs into one registration", () => {
    expect(
      normalizeBridgeConfigFile({
        appUrl: "https://0000.chat",
        bridgeToken: "token-a",
        deviceId: "bridge_a",
        deviceName: "Laptop",
        pairedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toEqual({
      version: 2,
      registrations: [
        {
          appUrl: "https://0000.chat",
          bridgeToken: "token-a",
          deviceId: "bridge_a",
          deviceName: "Laptop",
          pairedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
  });

  test("upserts bridge registrations without deleting other organizations", () => {
    const original = normalizeBridgeConfigFile({
      version: 2,
      registrations: [
        {
          appUrl: "https://0000.chat",
          bridgeToken: "token-a",
          deviceId: "bridge_a",
          deviceName: "Org A",
          pairedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    const appended = upsertBridgeRegistration(original, {
      appUrl: "https://0000.chat",
      bridgeToken: "token-b",
      deviceId: "bridge_b",
      deviceName: "Org B",
      pairedAt: "2026-06-01T00:01:00.000Z",
    });
    const replaced = upsertBridgeRegistration(appended, {
      appUrl: "https://0000.chat",
      bridgeToken: "token-b2",
      deviceId: "bridge_b",
      deviceName: "Org B renamed",
      pairedAt: "2026-06-01T00:02:00.000Z",
    });

    expect(
      appended.registrations.map((registration) => registration.deviceId),
    ).toEqual(["bridge_a", "bridge_b"]);
    expect(replaced.registrations).toEqual([
      original.registrations[0],
      {
        appUrl: "https://0000.chat",
        bridgeToken: "token-b2",
        deviceId: "bridge_b",
        deviceName: "Org B renamed",
        pairedAt: "2026-06-01T00:02:00.000Z",
      },
    ]);
  });

  test("appends to an existing empty v2 bridge config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-empty-config-"));
    const path = join(dir, "bridge.json");
    await writeBridgeConfigFile(path, { version: 2, registrations: [] });

    const updated = await appendBridgeRegistration(path, {
      appUrl: "https://0000.chat",
      bridgeToken: "token-a",
      deviceId: "bridge_a",
      deviceName: "Org A laptop",
      pairedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(updated.registrations).toHaveLength(1);
    expect(updated.registrations[0]?.deviceId).toBe("bridge_a");
    expect(normalizeBridgeConfigFile(updated)).toEqual(updated);
  });

  test("persists retry-stable pending agent connection credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-pending-connect-"));
    const configPath = join(dir, "bridge.json");

    const first = await preparePendingAgentConnectionRequest(
      configPath,
      "ABCD1234",
    );
    const second = await preparePendingAgentConnectionRequest(
      configPath,
      "ABCD1234",
    );

    expect(second).toEqual(first);
    expect(first.deviceId).toMatch(/^bridge_[0-9a-f]{24}$/);
    expect(first.bridgeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
  });

  test("renders multi-registration status without leaking secrets", () => {
    const output = describeStatus(
      {
        connected: true,
        activeSessions: ["session-a"],
        recentErrors: ["Bearer secret-token failed"],
        registrations: [
          {
            appUrl: "https://0000.chat",
            connected: true,
            deviceId: "bridge_a",
            deviceName: "Org A laptop",
            activeSessions: ["session-a"],
            inFlightCommands: [
              { id: "queue-a", startedAt: "2026-06-01T00:00:00.000Z" },
            ],
            recentErrors: ["authorization: secret-value"],
          },
          {
            appUrl: "https://0000.chat",
            connected: false,
            deviceId: "bridge_b",
            deviceName: "Org B laptop",
            activeSessions: [],
            registrationFailure: {
              detectedAt: "2026-06-01T00:05:00.000Z",
              kind: "auth_failed",
              message: "Bridge device is not paired",
              reasonCode: "bridge_device_not_paired",
            },
            recentErrors: [],
          },
        ],
      },
      true,
    );

    expect(output).toContain("registered links: 2");
    expect(output).toContain("Org A laptop");
    expect(output).toContain("Org B laptop");
    expect(output).toContain("registration failure: bridge_device_not_paired");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("secret-value");
  });
});

describe("bridge security defaults", () => {
  test("pins default package-backed ACP runtime commands", () => {
    expect(DEFAULT_CODEX_ACP_COMMAND).toBe(
      "bunx @zed-industries/codex-acp@0.16.0",
    );
    expect(DEFAULT_CLAUDE_CODE_ACP_COMMAND).toBe(
      "npx --yes @agentclientprotocol/claude-agent-acp@0.39.0",
    );
  });

  test("prefers Claude Code defaults when Claude and Codex environments are both present", () => {
    expect(
      defaultAgentCommandForEnvironment({
        CLAUDE_CODE: "1",
        CODEX_SANDBOX: "danger-full-access",
      } as NodeJS.ProcessEnv),
    ).toBe(DEFAULT_CLAUDE_CODE_ACP_COMMAND);
  });

  test("writes bridge config files with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-config-"));
    const path = join(dir, "bridge.json");

    await writeBridgeConfigFile(path, { bridgeToken: "secret" });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("repairs loose permissions on an existing bridge config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-config-"));
    const path = join(dir, "bridge.json");
    await writeBridgeConfigFile(path, { bridgeToken: "secret" });
    await chmod(path, 0o644);

    await ensureSecureBridgeConfigFile(path);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("writes bridge status files with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-status-"));
    const path = join(dir, "bridge-status.json");

    await writeBridgeStatusFile(path, { connected: true });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("honors remote cwd by default with an explicit environment opt-out", () => {
    expect(getAllowRemoteCwd({}, {})).toBe(true);
    expect(getAllowRemoteCwd({ "allow-remote-cwd": "true" }, {})).toBe(true);
    expect(
      getAllowRemoteCwd({}, { ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD: "1" }),
    ).toBe(true);
    expect(
      getAllowRemoteCwd({}, { ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD: "0" }),
    ).toBe(false);
    expect(
      getAllowRemoteCwd({}, { ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD: "false" }),
    ).toBe(false);
  });

  test("prints startup security defaults", () => {
    expect(
      buildStartupSecuritySummary({
        allowRemoteCwd: false,
        configPath: "/home/alice/.0000/bridge.json",
      }),
    ).toContain("remote bridge log forwarding: disabled");
  });
});

describe("bridge doctor", () => {
  test("builds a redacted trace-scoped local debug bundle from the SQLite journal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-doctor-"));
    const journalPath = join(dir, "bridge.sqlite");
    const journal = openBridgeJournal({ path: journalPath });
    const { sessionId } = journal.recordClaimBeforePrompt({
      agentId: "agent-1",
      bridgeDeviceId: "device-1",
      claimId: "claim-1",
      organizationId: "org-1",
      payload: { prompt: "secret prompt content", safe: "queue metadata" },
      queueItemId: "queue-1",
      runtimeProfileId: "codex:default",
      threadId: "thread-1",
      traceId: "trace-1",
    });
    journal.recordOutboxEvent({
      agentId: "agent-1",
      bridgeDeviceId: "device-1",
      eventType: "result.send",
      organizationId: "org-1",
      payload: { content: "secret result content", status: "completed" },
      queueItemId: "queue-2",
      runtimeProfileId: "codex:default",
      threadId: "thread-1",
      traceId: "trace-2",
    });
    journal.appendDiagnostic({
      details: {
        prompt: "secret diagnostic content",
        safe: "diagnostic metadata",
      },
      message: "secret diagnostic message",
      reasonCode: "prompt_send_ambiguous",
      traceId: "trace-1",
    });
    journal.close();

    const report = await buildBridgeDoctorReport(
      {
        command: "doctor",
        flags: { "journal-file": journalPath, trace: "trace-1" },
        positionals: [],
      },
      { ZERO_CHAT_BRIDGE_CONFIG: join(dir, "missing-config.json") },
      () => 1_799_000_000_000,
    );
    const serialized = JSON.stringify(report);

    expect(report.generatedAt).toBe("2027-01-03T18:13:20.000Z");
    expect(report.localJournal.status).toBe("healthy");
    expect(report.localJournal.path).toBe(journalPath);
    expect(report.traceId).toBe("trace-1");
    expect(report.snapshot.pendingOutbox).toHaveLength(1);
    expect(report.snapshot.pendingOutbox[0]).toMatchObject({
      queueItemId: "queue-1",
      sessionId,
    });
    expect(report.snapshot.diagnostics).toHaveLength(1);
    expect(serialized).toContain("diagnostic metadata");
    expect(serialized).not.toContain("secret prompt content");
    expect(serialized).not.toContain("secret result content");
    expect(serialized).not.toContain("secret diagnostic content");
    expect(serialized).not.toContain("secret diagnostic message");
  });
});

describe("bridge supervisor claim gating", () => {
  test("runs registration schedulers independently when one pass stalls", async () => {
    let registrationAActive = true;
    let registrationBActive = true;
    let releaseRegistrationA: (() => void) | undefined;
    const registrationABlocked = new Promise<void>((resolve) => {
      releaseRegistrationA = resolve;
    });
    let registrationBPasses = 0;

    const schedulerA = runBridgeRegistrationScheduler({
      context: { deviceId: "bridge-a" },
      isActive: () => registrationAActive,
      onRestartRequested: async () => {},
      runContextPass: async () => {
        await registrationABlocked;
        return { restartRequested: false };
      },
      totalInFlight: () => 0,
      waitForWakeSignal: async () => "timer",
    });
    const schedulerB = runBridgeRegistrationScheduler({
      context: { deviceId: "bridge-b" },
      isActive: () => registrationBActive,
      onRestartRequested: async () => {},
      runContextPass: async () => {
        registrationBPasses += 1;
        registrationBActive = false;
        return { restartRequested: false };
      },
      totalInFlight: () => 0,
      waitForWakeSignal: async () => "timer",
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registrationBPasses).toBe(1);
    } finally {
      registrationAActive = false;
      releaseRegistrationA?.();
      await Promise.all([schedulerA, schedulerB]);
    }
  });

  test("exits a registration scheduler without waiting after the context deactivates", async () => {
    let active = true;
    let wakeWaits = 0;
    const scheduler = runBridgeRegistrationScheduler({
      context: { deviceId: "bridge-a" },
      isActive: () => active,
      onRestartRequested: async () => {},
      runContextPass: async () => {
        active = false;
        return { restartRequested: false };
      },
      totalInFlight: () => 0,
      waitForWakeSignal: async () => {
        wakeWaits += 1;
        await new Promise(() => {});
        return "timer";
      },
    });

    const result = await Promise.race([
      scheduler.then(() => "completed" as const),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 20),
      ),
    ]);

    expect(result).toBe("completed");
    expect(wakeWaits).toBe(0);
  });

  test("defers process restart until all registrations are idle", async () => {
    let active = true;
    let totalInFlight = 1;
    let restartRequests = 0;
    let passes = 0;
    let wakeWaits = 0;

    await runBridgeRegistrationScheduler({
      context: { deviceId: "bridge-a" },
      isActive: () => active,
      onRestartRequested: async () => {
        restartRequests += 1;
        active = false;
      },
      runContextPass: async () => {
        passes += 1;
        if (passes === 1) {
          return { restartRequested: true };
        }
        return { restartRequested: false };
      },
      totalInFlight: () => totalInFlight,
      waitForWakeSignal: async () => {
        wakeWaits += 1;
        totalInFlight = 0;
        return "timer";
      },
    });

    expect(passes).toBe(2);
    expect(wakeWaits).toBe(1);
    expect(restartRequests).toBe(1);
  });

  test("runtime conformance refresh can run for idle profiles while another profile is active", async () => {
    const refreshedProfiles: string[] = [];

    const records = await refreshRuntimeConformanceProfilesForTest({
      getInFlightProfileIds: () => new Set(["hermes:default"]),
      getRunningSessionProfileIds: () => new Set(["hermes:default"]),
      now: () => 1_781_400_160_000,
      profiles: [
        {
          capabilities: {},
          command: ["hermes", "acp"],
          id: "hermes:default",
          kind: "hermes",
          label: "Hermes",
          status: "available",
        },
        {
          capabilities: {},
          command: ["codex", "acp"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
      probeProfile: async (profile) => {
        refreshedProfiles.push(profile.id);
        return {
          checkedAt: 1_781_400_160_000,
          diagnostics: [],
          runtimeId: profile.id,
          state: "passing",
          strength: "init_only",
        };
      },
      records: {
        "hermes:default": {
          checkedAt: 1_781_400_000_000,
          diagnostics: [],
          runtimeId: "hermes:default",
          state: "passing",
          strength: "init_only",
        },
        "codex:codex-acp": {
          checkedAt: 1_781_400_000_000,
          diagnostics: [],
          runtimeId: "codex:codex-acp",
          state: "passing",
          strength: "init_only",
        },
      },
      ttlMs: 300_000,
    });

    expect(refreshedProfiles).toEqual(["codex:codex-acp"]);
    expect(records["hermes:default"]?.checkedAt).toBe(1_781_400_000_000);
    expect(records["codex:codex-acp"]?.checkedAt).toBe(1_781_400_160_000);
  });

  test("classifies stale bridge registrations as hard auth failures", () => {
    const notPaired = buildBridgeRegistrationFailure(
      new BridgeCloudHttpError(
        "POST",
        "https://example.test/api/agent-bridge/queue/claim",
        400,
        '{"error":"Uncaught Error: Bridge device is not paired"}',
      ),
      Date.UTC(2026, 5, 5, 10, 0, 0),
    );
    const invalidCredentials = buildBridgeRegistrationFailure(
      new BridgeCloudHttpError(
        "POST",
        "https://example.test/api/agent-bridge/heartbeat",
        401,
        '{"error":"Uncaught Error: Bridge device credentials are invalid"}',
      ),
      Date.UTC(2026, 5, 5, 10, 1, 0),
    );

    expect(notPaired).toEqual(
      expect.objectContaining({
        detectedAt: "2026-06-05T10:00:00.000Z",
        reasonCode: "bridge_device_not_paired",
      }),
    );
    expect(invalidCredentials).toEqual(
      expect.objectContaining({
        detectedAt: "2026-06-05T10:01:00.000Z",
        reasonCode: "bridge_credentials_invalid",
      }),
    );
  });

  test("disables stale bridge registrations instead of retrying queue claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
    };

    await runBridgeLoopIteration({
      claimCommands: async () => {
        throw new BridgeCloudHttpError(
          "POST",
          "https://example.test/api/agent-bridge/queue/claim",
          400,
          '{"error":"Uncaught Error: Bridge device is not paired"}',
        );
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 2, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(status.connected).toBe(false);
    expect(status.registrationFailure).toEqual(
      expect.objectContaining({
        detectedAt: "2026-06-05T10:02:00.000Z",
        reasonCode: "bridge_device_not_paired",
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.registration.disabled",
        reason: "bridge_device_not_paired",
      }),
    );
  });

  test("warms configured runtime profiles only when loop capacity is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const warmRequests: Array<{ maxSessions?: number; runtimeProfileIds: string[] }> =
      [];
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
    };

    await runBridgeLoopIteration({
      claimCommands: async () => [],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      getProcessHealth: () =>
        ({
          canClaim: true,
          childCount: 1,
          processCap: 2,
          status: "healthy",
        }) as NonNullable<BridgeStatus["processHealth"]>,
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: Date.UTC(2026, 5, 5, 10, 2, 0),
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
        warmRuntimeSessions: async (request) => {
          warmRequests.push({
            maxSessions: request.maxSessions,
            runtimeProfileIds: request.runtimeProfileIds,
          });
          return 1;
        },
      },
      maxInFlight: 2,
      now: () => Date.UTC(2026, 5, 5, 10, 2, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      warmRuntimeProfileIds: ["codex:default"],
      writeStatus: async () => {},
    });

    expect(warmRequests).toEqual([
      {
        maxSessions: 1,
        runtimeProfileIds: ["codex:default"],
      },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.session.warm_runtime_profiles",
        runtimeProfileCount: 1,
        warmedCount: 1,
      }),
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({
        runtimeProfileIds: ["codex:default"],
      }),
    );
  });

  test("does not warm when newly claimed prompt work reserves process capacity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const warmRequests: Array<{ maxSessions?: number; runtimeProfileIds: string[] }> =
      [];
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
    };

    await runBridgeLoopIteration({
      claimCommands: async () => [
        {
          agentSessionId: "provider-session",
          bridgeProfileId: "codex:default",
          claimId: "claim-1",
          id: "queue-1",
          organizationId: "org-1",
          prompt: "hello",
          threadId: "thread-1",
          type: "prompt",
        },
      ],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      getProcessHealth: () =>
        ({
          canClaim: true,
          childCount: 1,
          processCap: 2,
          status: "healthy",
        }) as NonNullable<BridgeStatus["processHealth"]>,
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: Date.UTC(2026, 5, 5, 10, 2, 0),
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
        warmRuntimeSessions: async (request) => {
          warmRequests.push({
            maxSessions: request.maxSessions,
            runtimeProfileIds: request.runtimeProfileIds,
          });
          return 1;
        },
      },
      maxInFlight: 2,
      now: () => Date.UTC(2026, 5, 5, 10, 2, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      warmRuntimeProfileIds: ["codex:default"],
      writeStatus: async () => {},
    });

    expect(warmRequests).toEqual([]);
  });

  test("does not spam claim skipped logs after a registration is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const status: BridgeStatus = {
      activeSessions: [],
      connected: false,
      recentErrors: [],
      registrationFailure: {
        detectedAt: "2026-06-05T10:02:00.000Z",
        kind: "auth_failed",
        message: "Bridge device credentials are invalid",
        reasonCode: "bridge_credentials_invalid",
      },
    };

    await runBridgeLoopIteration({
      claimCommands: async () => {
        throw new Error("claim should not run for disabled registrations");
      },
      cleanupStaleClaims: async () => {
        throw new Error("cleanup should not run for disabled registrations");
      },
      config: bridgeRegistration(),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 3, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => {
        throw new Error("heartbeat should not run for disabled registrations");
      },
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(logs).toEqual([]);
    expect(status.connected).toBe(false);
    expect(status.registrationFailure?.reasonCode).toBe(
      "bridge_credentials_invalid",
    );
  });

  test("requests restart when refreshed runtime profile commands change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    let claimCalled = false;
    let heartbeatCount = 0;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@agentclientprotocol/codex-acp@0.0.45"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    };

    const result = await runBridgeLoopIteration({
      claimCommands: async () => {
        claimCalled = true;
        return [];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      discoverHermesProfiles: async () => [],
      discoverRuntimeProfiles: async () => [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex" as const,
          label: "Codex",
          status: "available" as const,
        },
      ],
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 3, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => {
        heartbeatCount += 1;
        return heartbeatCount === 1
          ? {
              ok: true,
              control: { refreshRuntimeProfiles: { requestedAt: "now" } },
            }
          : { ok: true };
      },
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(result.restartRequested).toBe(true);
    expect(claimCalled).toBe(false);
    expect(status.lifecycle).toBe("restarting");
    expect(status.runtimeProfiles?.[0]?.command).toEqual([
      "bunx",
      "@zed-industries/codex-acp@0.16.0",
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.runtime_profiles.restart_requested",
      }),
    );
  });

  test("waits for idle when refreshed runtime profile commands change during active work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    let claimCalled = false;
    let heartbeatCount = 0;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@agentclientprotocol/codex-acp@0.0.45"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    };

    const result = await runBridgeLoopIteration({
      claimCommands: async () => {
        claimCalled = true;
        return [];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      discoverHermesProfiles: async () => [],
      discoverRuntimeProfiles: async () => [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          sessions: [
            {
              lastUsedAt: Date.UTC(2026, 5, 5, 10, 2, 0),
              queueDepth: 1,
              runningQueueItemId: "queue-active-1",
              sessionKey: "active-session",
              threadId: "thread-active",
            },
          ],
          terminalInteractionSessionKeyCount: 0,
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 3, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => {
        heartbeatCount += 1;
        return heartbeatCount === 1
          ? {
              ok: true,
              control: { refreshRuntimeProfiles: { requestedAt: "now" } },
            }
          : { ok: true };
      },
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(result.restartRequested).toBe(false);
    expect(claimCalled).toBe(false);
    expect(status.lifecycle).toBe("draining");
    expect(status.pendingControlCommand).toMatchObject({
      command: "restartWhenIdle",
    });
    expect(status.controlCommandStatus).toMatchObject({
      command: "restartWhenIdle",
      status: "waiting_for_idle",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.runtime_profiles.restart_requested",
        restartRequested: false,
      }),
    );
  });

  test("defers runtime profile restart while another registration has active work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    let claimCalled = false;
    let heartbeatCount = 0;
    let processIdle = false;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@agentclientprotocol/codex-acp@0.0.45"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    };
    const baseInput: BridgeLoopIterationInput = {
      claimCommands: async () => {
        claimCalled = true;
        return [];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      discoverHermesProfiles: async () => [],
      discoverRuntimeProfiles: async () => [
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      isProcessIdleForRestart: () => processIdle,
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 3, 0),
      recordLoopError: async (error: unknown) => {
        throw error;
      },
      sendHeartbeat: async () => {
        heartbeatCount += 1;
        return heartbeatCount === 1
          ? {
              ok: true as const,
              control: { refreshRuntimeProfiles: { requestedAt: "now" } },
            }
          : { ok: true as const };
      },
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    };

    const busyResult = await runBridgeLoopIteration(baseInput);
    expect(busyResult.restartRequested).toBe(false);
    expect(claimCalled).toBe(false);
    expect(status.lifecycle).toBe("draining");
    expect(status.updateState?.status).toBe("waitingForIdle");
    expect(status.pendingControlCommand).toMatchObject({
      command: "restartWhenIdle",
    });
    expect(status.controlCommandStatus).toMatchObject({
      command: "restartWhenIdle",
      status: "waiting_for_idle",
    });

    processIdle = true;
    const idleResult = await runBridgeLoopIteration(baseInput);
    expect(idleResult.restartRequested).toBe(true);
    expect(status.lifecycle).toBe("restarting");
    expect(status.pendingControlCommand).toBeUndefined();
    expect(status.controlCommandStatus).toMatchObject({
      command: "restartWhenIdle",
      status: "executing",
    });
  });

  test("requests restart when refreshed runtime profile ids change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    let claimCalled = false;
    let heartbeatCount = 0;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["hermes", "acp"],
          id: "hermes:default",
          kind: "hermes",
          label: "Hermes",
          status: "available",
        },
      ],
    };

    const result = await runBridgeLoopIteration({
      claimCommands: async () => {
        claimCalled = true;
        return [];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      discoverHermesProfiles: async () => [],
      discoverRuntimeProfiles: async () => [
        {
          capabilities: {},
          command: ["hermes", "acp"],
          id: "hermes:default",
          kind: "hermes",
          label: "Hermes",
          status: "available",
        },
        {
          capabilities: {},
          command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 4, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => {
        heartbeatCount += 1;
        return heartbeatCount === 1
          ? {
              ok: true,
              control: { refreshRuntimeProfiles: { requestedAt: "now" } },
            }
          : { ok: true };
      },
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(result.restartRequested).toBe(true);
    expect(claimCalled).toBe(false);
    expect(status.lifecycle).toBe("restarting");
  });

  test("requests restart when refreshed runtime profile capabilities change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    let claimCalled = false;
    let heartbeatCount = 0;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      runtimeProfiles: [
        {
          capabilities: { sessionMcpServers: true },
          command: ["codex", "acp"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    };

    const result = await runBridgeLoopIteration({
      claimCommands: async () => {
        claimCalled = true;
        return [];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      discoverHermesProfiles: async () => [],
      discoverRuntimeProfiles: async () => [
        {
          capabilities: { sessionMcpServers: true, supportsPlans: true },
          command: ["codex", "acp"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 5, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => {
        heartbeatCount += 1;
        return heartbeatCount === 1
          ? {
              ok: true,
              control: { refreshRuntimeProfiles: { requestedAt: "now" } },
            }
          : { ok: true };
      },
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(result.restartRequested).toBe(true);
    expect(claimCalled).toBe(false);
    expect(status.lifecycle).toBe("restarting");
  });

  test("applies bridge capacity settings returned by heartbeat control", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    let appliedSettings: unknown;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      maxInFlight: 2,
      recentErrors: [],
    };
    let statusMaxInFlight = 2;

    await runBridgeLoopIteration({
      applySettingsControl: (settings) => {
        appliedSettings = settings;
        statusMaxInFlight = 6;
        status.maxInFlight = 6;
        status.capacity = {
          orgMaxInFlight: 6,
          bridgeConfiguredMaxInFlight: 6,
          bridgeMaxInFlight: 6,
          totalInFlight: 0,
        };
      },
      claimCommands: async () => [],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: Date.UTC(2026, 5, 5, 10, 3, 30),
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 2,
      getStatusMaxInFlight: () => statusMaxInFlight,
      now: () => Date.UTC(2026, 5, 5, 10, 4, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({
        ok: true,
        control: { settings: { maxInFlight: 6, updatedAt: 1_779_180_010_000 } },
      }),
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(appliedSettings).toEqual({
      maxInFlight: 6,
      updatedAt: 1_779_180_010_000,
    });
    expect(status.maxInFlight).toBe(6);
    expect(buildHeartbeatStatusPayload(status)).toMatchObject({
      maxInFlight: 6,
      capacity: {
        orgMaxInFlight: 6,
        bridgeConfiguredMaxInFlight: 6,
        bridgeMaxInFlight: 6,
      },
    });
  });

  test("idle timer refreshes heartbeat without polling the queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const now = Date.UTC(2026, 5, 5, 10, 10, 0);
    let heartbeatCount = 0;
    let cleanupRan = false;
    let claimed = false;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      lastHeartbeatAt: new Date(now - 5 * 60_000 - 1).toISOString(),
      recentErrors: [],
    };
    status.lastHeartbeatSignature = bridgeHeartbeatSignature(status);

    await runBridgeLoopIteration({
      claimCommands: async () => {
        claimed = true;
        return [];
      },
      cleanupStaleClaims: async () => {
        cleanupRan = true;
        return { inspected: 0, released: 0 };
      },
      config: bridgeRegistration(),
      heartbeatIntervalMs: 5 * 60_000,
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => now,
      pollReason: "timer",
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => {
        heartbeatCount += 1;
        return { ok: true };
      },
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(heartbeatCount).toBe(1);
    expect(cleanupRan).toBe(false);
    expect(claimed).toBe(false);
    expect(status.lastPollAt).toBeUndefined();
  });

  test("skips queue claims when local journal health is hard-failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    let claimed = false;

    await runBridgeLoopIteration({
      canClaimWork: () => false,
      claimCommands: async () => {
        claimed = true;
        return [];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: Date.now(),
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(claimed).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.queue.claim_skipped",
        reason: "local_journal_hard_failed",
      }),
    );
  });

  test("runs cleanup but skips queue claims when process health is unsafe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    let cleanupRan = false;
    let claimed = false;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
    };

    await runBridgeLoopIteration({
      canClaimWork: () => false,
      claimCommands: async () => {
        claimed = true;
        return [];
      },
      cleanupStaleClaims: async () => {
        cleanupRan = true;
        return { inspected: 0, released: 0 };
      },
      config: bridgeRegistration(),
      getProcessHealth: () => ({
        ambiguousProcessCount: 1,
        canClaim: false,
        childCount: 2,
        childCountsByRuntimeProfile: { "codex:default": 2 },
        processCap: 1,
        processCapExceeded: true,
        startupReconciliation: {
          ambiguousProcessCount: 1,
          lastReconciledAt: "2026-06-05T10:03:00.000Z",
          orphanedProcessCount: 0,
          removedDeadProcessCount: 0,
          retainedProcessCount: 1,
          status: "ambiguous",
          terminatedOrphanedProcessCount: 0,
          terminatedProcessCount: 0,
        },
        status: "cap_exceeded",
      }),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 4, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(cleanupRan).toBe(true);
    expect(claimed).toBe(false);
    expect(status.processHealth).toMatchObject({
      canClaim: false,
      childCountsByRuntimeProfile: { "codex:default": 2 },
      processCapExceeded: true,
      startupReconciliation: {
        ambiguousProcessCount: 1,
        lastReconciledAt: "2026-06-05T10:03:00.000Z",
        orphanedProcessCount: 0,
        removedDeadProcessCount: 0,
        retainedProcessCount: 1,
        status: "ambiguous",
        terminatedOrphanedProcessCount: 0,
        terminatedProcessCount: 0,
      },
      status: "cap_exceeded",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.queue.claim_skipped",
        reason: "process_health_unsafe",
      }),
    );
    expect(buildHeartbeatStatusPayload(status).processHealth).toMatchObject({
      status: "cap_exceeded",
      canClaim: false,
      startupReconciliation: {
        ambiguousProcessCount: 1,
        lastReconciledAt: "2026-06-05T10:03:00.000Z",
        removedDeadProcessCount: 0,
        retainedProcessCount: 1,
        status: "unsafe",
        terminatedProcessCount: 0,
      },
    });
    expect(
      buildHeartbeatStatusPayload(status).processHealth?.startupReconciliation,
    ).not.toHaveProperty("orphanedProcessCount");
    expect(
      buildHeartbeatStatusPayload(status).processHealth?.startupReconciliation,
    ).not.toHaveProperty("terminatedOrphanedProcessCount");
  });

  test("continues queue claims when stale cleanup stalls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
    };
    let cleanupStarted = false;
    let releaseCleanup: (() => void) | undefined;
    const cleanupResult = new Promise<Record<string, unknown>>((resolve) => {
      releaseCleanup = () => resolve({ inspected: 0, released: 0 });
    });
    let claimed = false;

    const run = runBridgeLoopIteration({
      claimCommands: async () => {
        claimed = true;
        return [];
      },
      cleanupStaleClaims: async () => {
        cleanupStarted = true;
        return await cleanupResult;
      },
      config: bridgeRegistration(),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 30, 2, 47, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      staleCleanupTimeoutMs: 5,
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cleanupStarted).toBe(true);
      expect(claimed).toBe(true);
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: "bridge.queue.cleanup_stale_timeout",
        }),
      );
    } finally {
      releaseCleanup?.();
      await run;
    }
  });

  test("reports unavailable runtime conformance without globally skipping claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    let cleanupRan = false;
    let claimed = false;
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
    };

    await runBridgeLoopIteration({
      canClaimWork: () => true,
      claimCommands: async () => {
        claimed = true;
        return [];
      },
      cleanupStaleClaims: async () => {
        cleanupRan = true;
        return { inspected: 0, released: 0 };
      },
      config: bridgeRegistration(),
      getRuntimeConformance: () => ({
        canClaim: false,
        profiles: {
          "codex:default": {
            canClaim: false,
            checkedAt: Date.UTC(2026, 5, 14, 0, 0, 0),
            diagnostics: [{ reasonCode: "acp_session_create_failed" }],
            reasonCode: "runtime_conformance_failed",
            runtimeId: "codex:default",
            state: "failing",
            strength: "none",
          },
        },
        status: "unavailable",
      }),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 14, 0, 1, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status,
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(cleanupRan).toBe(true);
    expect(claimed).toBe(true);
    expect(status.runtimeConformance).toMatchObject({
      canClaim: false,
      status: "unavailable",
    });
    expect(status.availability).toEqual({
      canClaim: false,
      reasonCode: "runtime_conformance_unavailable",
      status: "unavailable",
    });
    expect(logs).not.toContainEqual(
      expect.objectContaining({
        event: "bridge.queue.claim_skipped",
        reason: "runtime_conformance_unavailable",
      }),
    );
  });

  test("claims control-lane work when runtime conformance is degraded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    let claimed = false;
    const handled: Array<Record<string, unknown>> = [];

    await runBridgeLoopIteration({
      canClaimWork: () => true,
      claimCommands: async () => {
        claimed = true;
        return [
          {
            agentSessionId: "agent-session-1",
            approvalId: "permission-1",
            approvalOutcome: "approved",
            bridgeProfileId: "codex:default",
            claimId: "claim-permission",
            externalRequestId: "permission-1",
            id: "queue-permission",
            threadId: "thread-1",
            type: "permission-response",
          },
        ];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      getRuntimeConformance: () => ({
        canClaim: false,
        profiles: {
          "codex:default": {
            canClaim: false,
            checkedAt: Date.UTC(2026, 5, 14, 0, 0, 0),
            diagnostics: [],
            reasonCode: "runtime_conformance_stale",
            runtimeId: "codex:default",
            state: "passing",
            strength: "init_only",
          },
        },
        status: "degraded",
      }),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: ["session-1"],
          liveness: {
            activeSessions: [
              {
                bridgeProfileId: "codex:default",
                lastActivityAt: Date.UTC(2026, 5, 14, 0, 1, 0),
                lastMeaningfulEventAt: Date.UTC(2026, 5, 14, 0, 1, 0),
                providerActivitySeen: true,
                queueItemId: "queue-active",
                sessionKey: "session-1",
                startedAt: Date.UTC(2026, 5, 14, 0, 0, 0),
                state: "active",
              },
            ],
          },
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async (item) => {
          handled.push(item as unknown as Record<string, unknown>);
        },
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 14, 0, 1, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: ["session-1"],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(claimed).toBe(true);
    expect(handled).toEqual([
      expect.objectContaining({
        id: "queue-permission",
        type: "permission-response",
      }),
    ]);
  });

  test("claims control-lane work when prompt capacity is saturated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const claimInputs: unknown[] = [];
    const handled: Array<Record<string, unknown>> = [];
    const inFlightCommands = new Map<string, Promise<void>>();
    inFlightCommands.set("queue-active", new Promise(() => {}));

    await runBridgeLoopIteration({
      canClaimWork: () => true,
      claimCommands: async (_config, input) => {
        claimInputs.push(input ?? {});
        return [
          {
            agentSessionId: "agent-session-1",
            approvalId: "permission-1",
            approvalOutcome: "approved",
            bridgeProfileId: "codex:default",
            claimId: "claim-permission",
            externalRequestId: "permission-1",
            id: "queue-permission",
            threadId: "thread-1",
            type: "permission-response",
          },
        ];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      getRuntimeConformance: () => ({
        canClaim: true,
        profiles: {
          "codex:default": {
            canClaim: true,
            checkedAt: Date.UTC(2026, 5, 14, 0, 1, 0),
            diagnostics: [],
            runtimeId: "codex:default",
            state: "passing",
            strength: "init_only",
          },
        },
        status: "healthy",
      }),
      inFlightCommandMetadata: new Map(),
      inFlightCommands,
      lastStaleCleanupAt: Date.UTC(2026, 5, 14, 0, 1, 0),
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: ["session-1"],
          liveness: {
            activeSessions: [
              {
                bridgeProfileId: "codex:default",
                lastActivityAt: Date.UTC(2026, 5, 14, 0, 1, 0),
                lastMeaningfulEventAt: Date.UTC(2026, 5, 14, 0, 1, 0),
                providerActivitySeen: true,
                queueItemId: "queue-active",
                sessionKey: "session-1",
                startedAt: Date.UTC(2026, 5, 14, 0, 0, 0),
                state: "active",
              },
            ],
          },
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async (item) => {
          handled.push(item as unknown as Record<string, unknown>);
        },
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 14, 0, 1, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: ["session-1"],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(claimInputs).toEqual([{ lane: "control", limit: 1 }]);
    expect(handled).toEqual([
      expect.objectContaining({
        id: "queue-permission",
        type: "permission-response",
      }),
    ]);
  });

  test("runs claimed prompt work for a stale passing runtime profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const results: Array<{
      command: Record<string, unknown>;
      result: Record<string, unknown>;
    }> = [];
    const handled: Array<Record<string, unknown>> = [];

    await runBridgeLoopIteration({
      canClaimWork: () => true,
      claimCommands: async () => [
        {
          agentSessionId: "agent-session-1",
          bridgeProfileId: "codex:stale",
          claimId: "claim-stale",
          id: "queue-stale-prompt",
          prompt: "do not run",
          threadId: "thread-1",
          type: "prompt",
        },
      ],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      getRuntimeConformance: () => ({
        canClaim: true,
        profiles: {
          "codex:healthy": {
            canClaim: true,
            checkedAt: Date.UTC(2026, 5, 14, 0, 1, 0),
            diagnostics: [],
            runtimeId: "codex:healthy",
            state: "passing",
            strength: "init_only",
          },
          "codex:stale": {
            canClaim: false,
            checkedAt: Date.UTC(2026, 5, 14, 0, 0, 0),
            diagnostics: [],
            reasonCode: "runtime_conformance_stale",
            runtimeId: "codex:stale",
            state: "passing",
            strength: "init_only",
          },
        },
        status: "degraded",
      }),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async (item) => {
          handled.push(item as unknown as Record<string, unknown>);
        },
      },
      markCommandResult: async (_config, command, result) => {
        results.push({
          command: command as unknown as Record<string, unknown>,
          result: result as Record<string, unknown>,
        });
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 14, 0, 1, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(handled).toEqual([
      expect.objectContaining({
        bridgeProfileId: "codex:stale",
        id: "queue-stale-prompt",
      }),
    ]);
    expect(results).toEqual([]);
  });

  test("rejects claimed Hermes profile work without exact launch-spec conformance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const results: Array<{
      command: Record<string, unknown>;
      result: Record<string, unknown>;
    }> = [];
    let handled = false;

    await runBridgeLoopIteration({
      canClaimWork: () => true,
      claimCommands: async () => [
        {
          agentSessionId: "agent-session-1",
          bridgeProfileId: "hermes:default",
          claimId: "claim-hermes-profile",
          hermesProfileName: "nextpay-chief-of-staff",
          id: "queue-hermes-profile",
          prompt: "do not run",
          threadId: "thread-1",
          type: "prompt",
        },
      ],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      getRuntimeConformance: () => ({
        canClaim: true,
        profiles: {
          "hermes:default": {
            canClaim: true,
            checkedAt: Date.UTC(2026, 5, 14, 0, 1, 0),
            diagnostics: [],
            runtimeId: "hermes:default",
            state: "passing",
            strength: "init_only",
          },
        },
        status: "healthy",
      }),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: 0,
      log: Object.assign(() => {}, { flush: async () => {} }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {
          handled = true;
        },
      },
      markCommandResult: async (_config, command, result) => {
        results.push({
          command: command as unknown as Record<string, unknown>,
          result: result as Record<string, unknown>,
        });
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 14, 0, 1, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(handled).toBe(false);
    expect(results).toEqual([
      {
        command: expect.objectContaining({
          bridgeProfileId: "hermes:default",
          hermesProfileName: "nextpay-chief-of-staff",
          id: "queue-hermes-profile",
        }),
        result: expect.objectContaining({
          launchSpecKey:
            "hermes:default|hermes-profile:nextpay-chief-of-staff",
          ok: false,
          reasonCode: "runtime_launch_spec_missing",
          retryable: true,
        }),
      },
    ]);
  });

  test("describes startup reconciliation separately from process health", () => {
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      processHealth: {
        ambiguousProcessCount: 1,
        canClaim: false,
        childCount: 1,
        childCountsByRuntimeProfile: { "codex:default": 1 },
        processCap: 1,
        processCapExceeded: true,
        startupReconciliation: {
          ambiguousProcessCount: 1,
          lastReconciledAt: "2026-06-05T10:03:00.000Z",
          orphanedProcessCount: 0,
          removedDeadProcessCount: 0,
          retainedProcessCount: 1,
          status: "ambiguous",
          terminatedOrphanedProcessCount: 0,
          terminatedProcessCount: 0,
        },
        status: "ambiguous",
      },
      recentErrors: [],
    };

    expect(describeStatus(status, true)).toContain(
      "startup reconciliation: ambiguous at 2026-06-05T10:03:00.000Z",
    );
    expect(
      buildHeartbeatStatusPayload(status).processHealth?.startupReconciliation,
    ).toMatchObject({
      ambiguousProcessCount: 1,
      status: "unsafe",
    });
    expect(
      buildHeartbeatStatusPayload(status).processHealth?.startupReconciliation,
    ).not.toHaveProperty("orphanedProcessCount");
    expect(
      buildHeartbeatStatusPayload(status).processHealth?.startupReconciliation,
    ).not.toHaveProperty("terminatedOrphanedProcessCount");
  });

  test("heartbeat payload reports runtime conformance, liveness, and availability", () => {
    const status: BridgeStatus = {
      activeSessions: ["session-1"],
      availability: {
        canClaim: false,
        reasonCode: "runtime_conformance_unavailable",
        status: "degraded",
      },
      connected: true,
      liveness: {
        activeSessions: [
          {
            bridgeProfileId: "codex:default",
            currentState: "active",
            lastMeaningfulEventAt: 2_000,
            queueItemId: "queue-1",
          },
        ],
      },
      recentErrors: [],
      runtimeConformance: {
        canClaim: false,
        profiles: {
          "codex:default": {
            canClaim: false,
            checkedAt: 1_000,
            diagnostics: [{ reasonCode: "acp_session_create_failed" }],
            reasonCode: "runtime_conformance_stale",
            runtimeId: "codex:default",
            state: "passing",
            strength: "init_only",
          },
        },
        status: "degraded",
      },
    };

    const payload = buildHeartbeatStatusPayload(status) as Record<string, unknown>;
    expect(payload.activeQueueItemIds).toBeUndefined();
    expect(payload).toMatchObject({
      availability: { canClaim: false, status: "degraded" },
      liveness: {
        activeSessions: [{ currentState: "active", queueItemId: "queue-1" }],
      },
      runtimeConformance: {
        canClaim: false,
        profiles: {
          "codex:default": {
            reasonCode: "runtime_conformance_stale",
            state: "passing",
          },
        },
        status: "degraded",
      },
    });
    expect(
      bridgeHeartbeatSignature({
        ...status,
        liveness: {
          activeSessions: [
            {
              currentState: "active",
              queueItemId: "queue-2",
            },
          ],
        },
      }),
    ).not.toBe(bridgeHeartbeatSignature(status));
  });

  test("heartbeat payload omits bridge-local update start timestamps", () => {
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      updateState: {
        available: false,
        channel: "stable",
        currentVersion: "0.1.32",
        lastCheckedAt: Date.UTC(2026, 5, 30, 10, 0, 0),
        latestVersion: "0.1.32",
        requestedAt: Date.UTC(2026, 5, 30, 9, 59, 0),
        required: false,
        startedAt: Date.UTC(2026, 5, 30, 10, 0, 1),
        status: "restarting",
        targetVersion: "0.1.32",
      },
    };

    expect(buildHeartbeatStatusPayload(status).updateState).toEqual({
      available: false,
      channel: "stable",
      currentVersion: "0.1.32",
      lastCheckedAt: Date.UTC(2026, 5, 30, 10, 0, 0),
      latestVersion: "0.1.32",
      requestedAt: Date.UTC(2026, 5, 30, 9, 59, 0),
      required: false,
      status: "restarting",
      targetVersion: "0.1.32",
    });
  });

  test("successful runtime work refreshes profile and launch-spec conformance records", () => {
    expect(
      runtimeConformanceRecordsForSuccessfulCommand(
        {
          agentSessionId: "agent-session-1",
          bridgeProfileId: "hermes:default",
          claimId: "claim-hermes",
          hermesProfileName: "ops",
          id: "queue-hermes-prompt",
          prompt: "hello",
          threadId: "thread-1",
          type: "prompt",
        },
        Date.UTC(2026, 5, 30, 10, 0, 0),
      ),
    ).toEqual({
      "hermes:default": {
        checkedAt: Date.UTC(2026, 5, 30, 10, 0, 0),
        diagnostics: [],
        runtimeId: "hermes:default",
        state: "passing",
        strength: "init_only",
      },
      "hermes:default|hermes-profile:ops": {
        checkedAt: Date.UTC(2026, 5, 30, 10, 0, 0),
        diagnostics: [],
        runtimeId: "hermes:default|hermes-profile:ops",
        state: "passing",
        strength: "init_only",
      },
    });
  });

  test("heartbeat payload separates retained idle sessions from active work", () => {
    const status: BridgeStatus = {
      activeSessions: [],
      capacity: { totalInFlight: 0 },
      connected: true,
      inFlightCommands: [],
      recentErrors: [],
      retainedSessions: [
        {
          lastUsedAt: Date.UTC(2026, 5, 5, 10, 0, 0),
          queueDepth: 0,
          runtimeProfileId: "codex:default",
          sessionKey: "provider-session",
          threadId: "thread-1",
        },
      ],
      sessionQueues: [
        {
          lastUsedAt: Date.UTC(2026, 5, 5, 10, 0, 0),
          queueDepth: 0,
          runtimeProfileId: "codex:default",
          sessionKey: "provider-session",
          threadId: "thread-1",
        },
      ],
    };

    expect(buildHeartbeatStatusPayload(status)).toMatchObject({
      activeSessions: [],
      capacity: { totalInFlight: 0 },
      inFlightCommands: [],
      retainedSessions: [
        {
          queueDepth: 0,
          sessionKey: "provider-session",
          threadId: "thread-1",
        },
      ],
      sessionQueues: [
        {
          queueDepth: 0,
          sessionKey: "provider-session",
          threadId: "thread-1",
        },
      ],
    });
    expect(describeStatus(status, true)).toContain("retained sessions: 1");
    expect(describeStatus(status, true)).toContain("active sessions: 0");
  });

  test("heartbeat payload and signature include runtime identity", () => {
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      runtimeIdentity: {
        bridgeVersion: BRIDGE_VERSION,
        gitSha: "abc123def456",
        instanceId: "instance-1",
        mcpManifestHash: "manifest-a",
        pid: 4242,
        processStartedAt: "2026-06-22T00:00:00.000Z",
        toolPolicyHash: "policy-a",
      },
    };

    expect(buildHeartbeatStatusPayload(status)).toMatchObject({
      runtimeIdentity: {
        bridgeVersion: BRIDGE_VERSION,
        gitSha: "abc123def456",
        instanceId: "instance-1",
        mcpManifestHash: "manifest-a",
        pid: 4242,
        processStartedAt: "2026-06-22T00:00:00.000Z",
        toolPolicyHash: "policy-a",
      },
    });
    expect(
      bridgeHeartbeatSignature({
        ...status,
        runtimeIdentity: {
          ...status.runtimeIdentity!,
          toolPolicyHash: "policy-b",
        },
      }),
    ).not.toBe(bridgeHeartbeatSignature(status));
  });

  test("cloud heartbeat forwards bridge instance id and version from runtime identity", async () => {
    const status: BridgeStatus = {
      activeSessions: [],
      connected: true,
      recentErrors: [],
      runtimeIdentity: {
        bridgeVersion: BRIDGE_VERSION,
        instanceId: "instance-bridge-1",
        mcpManifestHash: "manifest-a",
        pid: 4242,
        processStartedAt: "2026-06-22T00:00:00.000Z",
        toolPolicyHash: "policy-a",
      },
    };
    let heartbeatInput: Record<string, unknown> | undefined;

    await sendHeartbeatWithClient(bridgeRegistration(), status, {
      heartbeat: async <TResponse = Record<string, unknown>>(
        input: BridgeHeartbeatInput,
      ) => {
        heartbeatInput = input as Record<string, unknown>;
        return {} as TResponse;
      },
    });

    expect(heartbeatInput).toMatchObject({
      bridgeInstanceId: "instance-bridge-1",
      version: BRIDGE_VERSION,
    });
  });

  test("dispatches claimed lifecycle queue commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const handled: Array<Record<string, unknown>> = [];
    const inFlightCommandMetadata = new Map();
    const backendClaimedAtMs = Date.parse("2026-06-30T12:00:00.250Z");
    const localDispatchAtMs = Date.parse("2026-06-30T12:00:01.000Z");

    await runBridgeLoopIteration({
      claimCommands: async () => [
        {
          agentSessionId: "agent-session-1",
          claimId: "claim-1",
          claimedAt: "2026-06-30T12:00:00.250Z",
          createdAt: "2026-06-30T12:00:00.000Z",
          id: "queue-cancel-1",
          kind: "cancel-session",
          threadId: "thread-1",
          type: "cancel-session",
        },
      ],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata,
      inFlightCommands: new Map(),
      lastStaleCleanupAt: Date.now(),
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async (item) => {
          handled.push(item as unknown as Record<string, unknown>);
          expect(inFlightCommandMetadata.get("queue-cancel-1")).toMatchObject({
            claimedAt: "2026-06-30T12:00:00.250Z",
            claimedAtMs: backendClaimedAtMs,
            createdAt: "2026-06-30T12:00:00.000Z",
            createdAtMs: Date.parse("2026-06-30T12:00:00.000Z"),
            id: "queue-cancel-1",
          });
        },
      },
      maxInFlight: 1,
      now: () => localDispatchAtMs,
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(handled).toEqual([
      expect.objectContaining({
        id: "queue-cancel-1",
        type: "cancel-session",
        claimedAt: "2026-06-30T12:00:00.250Z",
        claimedAtMs: backendClaimedAtMs,
        createdAt: "2026-06-30T12:00:00.000Z",
        createdAtMs: Date.parse("2026-06-30T12:00:00.000Z"),
      }),
    ]);
    expect(inFlightCommandMetadata.size).toBe(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.queue_item.in_flight",
        queueId: "queue-cancel-1",
        queueType: "cancel-session",
      }),
    );
  });

  test("closes retained idle sessions under ACP process pressure before claiming work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const handled: Array<Record<string, unknown>> = [];
    const pressureRequests: Array<Record<string, unknown>> = [];
    let cleanupRan = false;

    await runBridgeLoopIteration({
      claimCommands: async () => [
        {
          agentSessionId: "agent-session-1",
          claimId: "claim-1",
          id: "queue-prompt-1",
          kind: "prompt",
          prompt: "hello",
          threadId: "thread-1",
          type: "prompt",
        },
      ],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      getProcessHealth: () => ({
        ambiguousProcessCount: 0,
        canClaim: true,
        childCount: cleanupRan ? 6 : 7,
        childCountsByRuntimeProfile: {
          "codex:codex-acp": cleanupRan ? 6 : 7,
        },
        processCap: 8,
        processCapExceeded: false,
        startupReconciliation: {
          ambiguousProcessCount: 0,
          lastReconciledAt: "2026-06-05T10:03:00.000Z",
          orphanedProcessCount: 0,
          removedDeadProcessCount: 0,
          retainedProcessCount: cleanupRan ? 6 : 7,
          status: "healthy",
          terminatedOrphanedProcessCount: 0,
          terminatedProcessCount: 0,
        },
        status: "healthy",
      }),
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: Date.now(),
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        closeIdleSessionsForProcessPressure: async (request) => {
          pressureRequests.push(request);
          cleanupRan = true;
          return 1;
        },
        getStatus: () => ({
          activeSessions: [],
          retainedSessions: [
            {
              lastUsedAt: Date.now() - 60_000,
              queueDepth: 0,
              sessionKey: "idle-session",
              threadId: "thread-idle",
            },
          ],
          terminalInteractionSessionKeyCount: 0,
          sessions: [
            {
              lastUsedAt: Date.now() - 60_000,
              queueDepth: 0,
              sessionKey: "idle-session",
              threadId: "thread-idle",
            },
          ],
        }),
        handleQueueItem: async (item) => {
          handled.push(item as unknown as Record<string, unknown>);
        },
      },
      maxInFlight: 1,
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(pressureRequests).toEqual([
      {
        maxSessionsToClose: 1,
        targetFreeProcessSlots: 2,
      },
    ]);
    expect(handled).toEqual([
      expect.objectContaining({
        id: "queue-prompt-1",
        type: "prompt",
      }),
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.lifecycle.idle_pressure_close",
        closedSessionCount: 1,
        childCountBefore: 7,
        childCountAfter: 6,
      }),
    );
  });

  test("closes enough retained idle sessions when ACP processes already exceed the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const handled: Array<Record<string, unknown>> = [];
    const pressureRequests: Array<Record<string, unknown>> = [];
    let closedSessions = 0;

    await runBridgeLoopIteration({
      claimCommands: async () => [
        {
          agentSessionId: "agent-session-1",
          claimId: "claim-1",
          id: "queue-prompt-1",
          kind: "prompt",
          prompt: "hello",
          threadId: "thread-1",
          type: "prompt",
        },
      ],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      getProcessHealth: () => {
        const childCount = 10 - closedSessions;
        return {
          ambiguousProcessCount: 0,
          canClaim: childCount < 8,
          childCount,
          childCountsByRuntimeProfile: {
            "codex:codex-acp": childCount,
          },
          processCap: 8,
          processCapExceeded: childCount >= 8,
          startupReconciliation: {
            ambiguousProcessCount: 0,
            lastReconciledAt: "2026-06-05T10:03:00.000Z",
            orphanedProcessCount: 0,
            removedDeadProcessCount: 0,
            retainedProcessCount: childCount,
            status: childCount >= 8 ? "blocked" : "healthy",
            terminatedOrphanedProcessCount: 0,
            terminatedProcessCount: 0,
          },
          status: childCount >= 8 ? "cap_exceeded" : "healthy",
        };
      },
      inFlightCommandMetadata: new Map(),
      inFlightCommands: new Map(),
      lastStaleCleanupAt: Date.now(),
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        closeIdleSessionsForProcessPressure: async (request) => {
          pressureRequests.push(request);
          closedSessions += request.maxSessionsToClose ?? 0;
          return request.maxSessionsToClose ?? 0;
        },
        getStatus: () => ({
          activeSessions: [],
          retainedSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async (item) => {
          handled.push(item as unknown as Record<string, unknown>);
        },
      },
      maxInFlight: 1,
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      writeStatus: async () => {},
    });

    expect(pressureRequests).toEqual([
      {
        maxSessionsToClose: 4,
        targetFreeProcessSlots: 2,
      },
    ]);
    expect(handled).toEqual([
      expect.objectContaining({
        id: "queue-prompt-1",
        type: "prompt",
      }),
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.lifecycle.idle_pressure_close",
        closedSessionCount: 4,
        childCountBefore: 10,
        childCountAfter: 6,
      }),
    );
  });

  test("terminalizes watchdog-failed in-flight commands before claiming more work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const inFlightCommands = new Map<string, Promise<void>>([
      ["queue-timeout", new Promise<void>(() => {})],
    ]);
    const inFlightCommandMetadata = new Map([
      [
        "queue-timeout",
        {
          id: "queue-timeout",
          startedAt: "2026-06-05T10:00:00.000Z",
          threadId: "thread-1",
          type: "prompt",
        },
      ],
    ]);
    const terminalized: Array<Record<string, unknown>> = [];
    let claimLimit: number | undefined;

    await runBridgeLoopIteration({
      claimCommands: async (_config, limit) => {
        claimLimit = typeof limit === "number" ? limit : limit?.limit;
        return [];
      },
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata,
      inFlightCommands,
      lastStaleCleanupAt: Date.now(),
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        failActiveQueueItem: async (queueItemId, reasonCode) => {
          terminalized.push({ queueItemId, reasonCode });
          return true;
        },
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 5, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      watchdogFailures: [
        {
          checkpoint: "failed",
          queueItemId: "queue-timeout",
          reasonCode: "provider_silent_timeout",
        },
      ],
      writeStatus: async () => {},
    });

    expect(terminalized).toEqual([
      { queueItemId: "queue-timeout", reasonCode: "provider_silent_timeout" },
    ]);
    expect(inFlightCommands.has("queue-timeout")).toBe(false);
    expect(inFlightCommandMetadata.has("queue-timeout")).toBe(false);
    expect(claimLimit).toBe(1);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.queue_item.settled",
        queueId: "queue-timeout",
        reason: "provider_silent_timeout",
      }),
    );
  });

  test("preserves structured tool timeout metadata when terminalizing watchdog-failed commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const inFlightCommands = new Map<string, Promise<void>>([
      ["queue-tool-timeout", new Promise<void>(() => {})],
    ]);
    const inFlightCommandMetadata = new Map([
      [
        "queue-tool-timeout",
        {
          id: "queue-tool-timeout",
          ageMs: 31_000,
          failureClass: "tool_result_timeout",
          startedAt: "2026-06-05T10:00:00.000Z",
          threadId: "thread-1",
          timeoutMs: 30_000,
          toolCallId: "tool-1",
          toolClass: "standard",
          toolName: "databases.get",
          toolPolicyId: "standard-tool-result-timeout",
          type: "prompt",
        },
      ],
    ]);
    const terminalized: Array<{
      metadata?: Record<string, unknown>;
      queueItemId: string;
      reasonCode: string;
    }> = [];

    await runBridgeLoopIteration({
      claimCommands: async () => [],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata,
      inFlightCommands,
      lastStaleCleanupAt: Date.now(),
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        failActiveQueueItem: async (queueItemId, reasonCode, metadata) => {
          terminalized.push({ queueItemId, reasonCode, metadata });
          return true;
        },
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 0, 31),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      watchdogFailures: [
        {
          checkpoint: "failed",
          queueItemId: "queue-tool-timeout",
          reasonCode: "tool_result_timeout",
        },
      ],
      writeStatus: async () => {},
    });

    const metadata = {
      ageMs: 31_000,
      failureClass: "tool_result_timeout",
      reasonCode: "tool_result_timeout",
      timeoutMs: 30_000,
      toolCallId: "tool-1",
      toolClass: "standard",
      toolName: "databases.get",
      toolPolicyId: "standard-tool-result-timeout",
    };
    expect(terminalized).toEqual([
      {
        metadata,
        queueItemId: "queue-tool-timeout",
        reasonCode: "tool_result_timeout",
      },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.queue_item.settled",
        queueId: "queue-tool-timeout",
        reason: "tool_result_timeout",
        ...metadata,
      }),
    );
  });

  test("keeps quiet watchdog in-flight instead of terminalizing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const logs: Array<Record<string, unknown>> = [];
    const inFlightCommands = new Map<string, Promise<void>>([
      ["queue-quiet", new Promise<void>(() => {})],
    ]);
    const inFlightCommandMetadata = new Map([
      [
        "queue-quiet",
        {
          id: "queue-quiet",
          startedAt: "2026-06-05T10:00:00.000Z",
          threadId: "thread-1",
          type: "prompt",
        },
      ],
    ]);
    const terminalized: Array<Record<string, unknown>> = [];

    await runBridgeLoopIteration({
      claimCommands: async () => [],
      cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
      config: bridgeRegistration(),
      inFlightCommandMetadata,
      inFlightCommands,
      lastStaleCleanupAt: Date.now(),
      log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
        flush: async () => {},
      }),
      manager: {
        failActiveQueueItem: async (queueItemId, reasonCode) => {
          terminalized.push({ queueItemId, reasonCode });
          return true;
        },
        getStatus: () => ({
          activeSessions: [],
          terminalInteractionSessionKeyCount: 0,
          sessions: [],
        }),
        handleQueueItem: async () => {},
      },
      maxInFlight: 1,
      now: () => Date.UTC(2026, 5, 5, 10, 5, 0),
      recordLoopError: async (error) => {
        throw error;
      },
      sendHeartbeat: async () => ({ ok: true }),
      setLastStaleCleanupAt: () => {},
      status: {
        activeSessions: [],
        connected: true,
        recentErrors: [],
      },
      statusPath: join(dir, "status.json"),
      watchdogFailures: [
        {
          checkpoint: "quiet",
          queueItemId: "queue-quiet",
          reasonCode: "provider_quiet",
          silenceMs: 120_000,
        },
      ],
      writeStatus: async () => {},
    });

    expect(terminalized).toEqual([]);
    expect(inFlightCommands.has("queue-quiet")).toBe(true);
    expect(inFlightCommandMetadata.has("queue-quiet")).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.watchdog.quiet",
        queueId: "queue-quiet",
        reason: "provider_quiet",
      }),
    );
  });
});

function bridgeRegistration(): BridgeRegistration {
  return {
    appUrl: "https://app.example.com",
    bridgeApiUrl: "https://app.example.com/api/agent-bridge",
    bridgeToken: "secret",
    deviceId: "device-1",
    deviceName: "dev box",
    pairedAt: "2026-06-04T00:00:00.000Z",
  };
}
