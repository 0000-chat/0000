import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildBridgeDoctorReport,
  buildBridgeRegistrationFailure,
  buildHeartbeatStatusPayload,
  type BridgeStatus,
  describeStatus,
  deriveConvexCloudUrl,
  ensureSecureBridgeConfigFile,
  buildAgentToolsMcpServers,
  buildStartupSecuritySummary,
  getAllowRemoteCwd,
  getConvexUrl,
  normalizeBridgeConfigFile,
  parseBridgeArgs,
  runBridgeLoopIteration,
  upsertBridgeRegistration,
  writeBridgeConfigFile,
  writeBridgeStatusFile,
} from "./acp-bridge";
import { BridgeCloudHttpError } from "./acp-bridge/convex-http";
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
        name: "0000-chat",
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
      "bunx @zed-industries/codex-acp@0.15.0",
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
          command: ["bunx", "@zed-industries/codex-acp@0.15.0"],
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
      "@zed-industries/codex-acp@0.15.0",
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
          command: ["bunx", "@zed-industries/codex-acp@0.15.0"],
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
          removedDeadProcessCount: 0,
          retainedProcessCount: 1,
          status: "ambiguous",
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
        removedDeadProcessCount: 0,
        retainedProcessCount: 1,
        status: "ambiguous",
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
        status: "ambiguous",
        terminatedProcessCount: 0,
      },
    });
  });

  test("runs cleanup but skips queue claims when runtime conformance is unavailable", async () => {
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
    expect(claimed).toBe(false);
    expect(status.runtimeConformance).toMatchObject({
      canClaim: false,
      status: "unavailable",
    });
    expect(status.availability).toEqual({
      canClaim: false,
      reasonCode: "runtime_conformance_unavailable",
      status: "unavailable",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "bridge.queue.claim_skipped",
        reason: "runtime_conformance_unavailable",
      }),
    );
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
          removedDeadProcessCount: 0,
          retainedProcessCount: 1,
          status: "ambiguous",
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
      status: "ambiguous",
    });
  });

  test("heartbeat payload reports runtime conformance, liveness, and availability", () => {
    const status: BridgeStatus = {
      activeSessions: ["session-1"],
      availability: {
        canClaim: false,
        reasonCode: "runtime_conformance_unavailable",
        status: "unavailable",
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
            reasonCode: "runtime_conformance_failed",
            runtimeId: "codex:default",
            state: "failing",
            strength: "none",
          },
        },
        status: "unavailable",
      },
    };

    expect(buildHeartbeatStatusPayload(status)).toMatchObject({
      availability: { canClaim: false, status: "unavailable" },
      liveness: {
        activeSessions: [{ currentState: "active", queueItemId: "queue-1" }],
      },
      runtimeConformance: {
        canClaim: false,
        profiles: { "codex:default": { state: "failing" } },
      },
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
