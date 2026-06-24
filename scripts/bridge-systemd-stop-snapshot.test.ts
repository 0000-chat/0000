import { describe, expect, test } from "bun:test";

import {
  buildStopSnapshotEntry,
  parseStopSnapshotArgs,
  parseSystemctlShow,
  summarizeBridgeStatus,
} from "./bridge-systemd-stop-snapshot";

describe("bridge systemd stop snapshot", () => {
  test("parses args with production defaults", () => {
    expect(parseStopSnapshotArgs(["--unit", "custom.service", "--status-path", "/tmp/status.json"])).toEqual({
      statusPath: "/tmp/status.json",
      unit: "custom.service",
    });
  });

  test("parses systemctl show key-value output", () => {
    expect(
      parseSystemctlShow("ActiveState=inactive\nSubState=dead\nInvocationID=abc123\n"),
    ).toEqual({
      ActiveState: "inactive",
      InvocationID: "abc123",
      SubState: "dead",
    });
  });

  test("summarizes bridge status without copying raw identifiers or errors", () => {
    const summary = summarizeBridgeStatus(
      JSON.stringify({
        connected: false,
        deviceId: "bridge-secret-id",
        lastHeartbeatAt: "2026-06-24T07:30:38.207Z",
        lifecycle: "running",
        recentErrors: ["authorization: Bearer secret"],
        runtimeIdentity: {
          bridgeVersion: "0.1.21",
          pid: 123,
        },
        runtimeConformance: {
          canClaim: false,
          status: "unavailable",
        },
        processHealth: {
          canClaim: false,
          status: "stopped",
        },
        runtimeProfiles: [{ id: "profile-secret-id" }],
      }),
    );

    expect(summary).toEqual({
      bridgeVersion: "0.1.21",
      connected: false,
      lastHeartbeatAt: "2026-06-24T07:30:38.207Z",
      lastStartedAt: undefined,
      lifecycle: "running",
      pid: 123,
      processHealth: {
        canClaim: false,
        status: "stopped",
      },
      recentErrorCount: 1,
      runtimeConformance: {
        canClaim: false,
        status: "unavailable",
      },
      runtimeProfileCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("bridge-secret-id");
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("profile-secret-id");
  });

  test("builds stop snapshot audit entry", () => {
    expect(
      buildStopSnapshotEntry({
        env: {
          EXIT_CODE: "exited",
          EXIT_STATUS: "0",
          SERVICE_RESULT: "success",
        },
        statusSummary: { connected: false },
        systemd: {
          ActiveState: "inactive",
          InvocationID: "abc123",
          Result: "success",
          SubState: "dead",
        },
        unit: "0000-chat-bridge.service",
      }),
    ).toMatchObject({
      event: "bridge.systemd.stop_snapshot",
      exitCode: "exited",
      exitStatus: "0",
      invocationId: "abc123",
      level: "info",
      service: "bridge-systemd-stop-snapshot",
      serviceResult: "success",
      statusSummary: { connected: false },
      systemdActiveState: "inactive",
      systemdResult: "success",
      systemdSubState: "dead",
      unit: "0000-chat-bridge.service",
    });
  });
});
