import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_VERSION,
  buildBridgeDoctorReport,
  buildBridgeRegistrationFailure,
  buildHeartbeatStatusPayload,
  type BridgeStatus,
  bridgeHeartbeatSignature,
  describeStatus,
  deriveConvexCloudUrl,
  appendBridgeRegistration,
  ensureSecureBridgeConfigFile,
  buildAgentToolsMcpServers,
  buildStartupSecuritySummary,
  getAllowRemoteCwd,
  getAcpIdleTtlMs,
  getLocalHardMaxInFlight,
  getConvexUrl,
  normalizeBridgeConfigFile,
  normalizeQueueCommand,
  parseHermesProfileListOutput,
  parseBridgeArgs,
  preparePendingAgentConnectionRequest,
  refreshRuntimeConformanceProfilesForTest,
  reconcileBridgeStartupControlCommandStatus,
  runBridgeLoopIteration,
  sendHeartbeatWithClient,
  upsertBridgeRegistration,
  waitForRestartShutdownTask,
  writeBridgeConfigFile,
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
          text: "enable_drive",
        },
        threadId: "thread-1",
      }),
    ).toMatchObject({
      approvalOutcome: "enable_drive",
      externalRequestId: "agent-choice:agent-session-1:123",
      prompt:
        "The user selected an option for this pending multiple-choice prompt.",
      type: "choice-response",
    });
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

describe("bridge control command lifecycle", () => {
  test("persists accepted and waiting_for_idle for restartWhenIdle while work is still active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"));
    const writes: BridgeStatus[] = [];
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
      claimCommands: async () => [],
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
          { name: "ZERO_CHAT_BRIDGE_TOKEN", value: "token-a" },
        ],
        name: "0000",
      },
    ]);
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

  test("rejects claimed prompt work for a stale runtime profile before execution", async () => {
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
          bridgeProfileId: "codex:stale",
          id: "queue-stale-prompt",
        }),
        result: expect.objectContaining({
          error: "runtime_conformance_stale",
          ok: false,
          retryable: true,
        }),
      },
    ]);
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

    await runBridgeLoopIteration({
      claimCommands: async () => [
        {
          agentSessionId: "agent-session-1",
          claimId: "claim-1",
          id: "queue-cancel-1",
          kind: "cancel-session",
          threadId: "thread-1",
          type: "cancel-session",
        },
      ],
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

    expect(handled).toEqual([
      expect.objectContaining({
        id: "queue-cancel-1",
        type: "cancel-session",
      }),
    ]);
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
        claimLimit = limit;
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

function bridgeRegistration() {
  return {
    appUrl: "https://app.example.com",
    bridgeApiUrl: "https://app.example.com/api/agent-bridge",
    bridgeToken: "secret",
    deviceId: "device-1",
    deviceName: "dev box",
    pairedAt: "2026-06-04T00:00:00.000Z",
  };
}
