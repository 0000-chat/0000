import { expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installMachineMcpClient,
  parseHostedMcpConnectorArgs,
  provisionMachineMcpInstallation,
  readMachineMcpCredential,
  writeMachineMcpCredential,
} from "./machine-mcp";
import { resolveHostedMcpConnectorConfig } from "./hosted-mcp-connector";

test("stores each machine MCP credential in an owner-only target file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "0000-machine-mcp-"));
  const credentialsDirectory = join(directory, "mcp-targets");

  await writeMachineMcpCredential({
    credentialsDirectory,
    credential: "credential-value",
    credentialVersion: 2,
    targetId: "target_123",
  });

  await expect(
    readMachineMcpCredential({
      credentialsDirectory,
      targetId: "target_123",
    }),
  ).resolves.toEqual({ credential: "credential-value", credentialVersion: 2 });
  expect((await stat(credentialsDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(credentialsDirectory, "target_123.json"))).mode & 0o777).toBe(0o600);
});

test("does not accept an unsafe target identifier for credential storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "0000-machine-mcp-"));

  await expect(
    writeMachineMcpCredential({
      credentialsDirectory: join(directory, "mcp-targets"),
      credential: "credential-value",
      credentialVersion: 1,
      targetId: "../outside",
    }),
  ).rejects.toThrow("invalid machine MCP target id");
});

test("adds a managed stdio MCP to a named Hermes profile", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = await installMachineMcpClient({
    connectorScript: "/opt/0000/scripts/hosted-mcp-connector.ts",
    profileIdentity: "work",
    runtimeId: "hermes",
    run: async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, stderr: "", stdout: "No MCP servers configured." };
    },
    targetId: "target_123",
  });

  expect(result).toEqual({ status: "installed" });
  expect(calls).toEqual([
    { command: "hermes", args: ["-p", "work", "mcp", "list"] },
    {
      command: "hermes",
      args: [
        "-p",
        "work",
        "mcp",
        "add",
        "0000",
        "--command",
        "bun",
        "--args",
        "/opt/0000/scripts/hosted-mcp-connector.ts",
        "--target",
        "target_123",
        "--managed-by-0000-machine",
      ],
    },
  ]);
});

test("uses the default Hermes home only for the default profile", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  await installMachineMcpClient({
    connectorScript: "/opt/0000/scripts/hosted-mcp-connector.ts",
    profileIdentity: "default",
    runtimeId: "hermes",
    run: async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    targetId: "target_default",
  });

  expect(calls).toEqual([
    { command: "hermes", args: ["mcp", "list"] },
    {
      command: "hermes",
      args: [
        "mcp",
        "add",
        "0000",
        "--command",
        "bun",
        "--args",
        "/opt/0000/scripts/hosted-mcp-connector.ts",
        "--target",
        "target_default",
        "--managed-by-0000-machine",
      ],
    },
  ]);
});

test("does not replace an unrelated MCP named 0000", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = await installMachineMcpClient({
    connectorScript: "/opt/0000/scripts/hosted-mcp-connector.ts",
    runtimeId: "codex",
    run: async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, stderr: "", stdout: '{"name":"0000","transport":{"type":"streamable_http"}}' };
    },
    targetId: "target_123",
  });

  expect(result).toEqual({ status: "mcp_name_conflict" });
  expect(calls).toEqual([
    { command: "codex", args: ["mcp", "get", "0000", "--json"] },
  ]);
});

test("uses user-scoped commands for Codex and Claude Code", async () => {
  const codexCalls: Array<{ command: string; args: string[] }> = [];
  const claudeCalls: Array<{ command: string; args: string[] }> = [];
  const runAbsent = (calls: Array<{ command: string; args: string[] }>) =>
    async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { exitCode: calls.length === 1 ? 1 : 0, stderr: "", stdout: "" };
    };

  await expect(
    installMachineMcpClient({
      connectorScript: "/opt/0000/scripts/hosted-mcp-connector.ts",
      runtimeId: "codex",
      run: runAbsent(codexCalls),
      targetId: "target_codex",
    }),
  ).resolves.toEqual({ status: "installed" });
  await expect(
    installMachineMcpClient({
      connectorScript: "/opt/0000/scripts/hosted-mcp-connector.ts",
      runtimeId: "claude_code",
      run: runAbsent(claudeCalls),
      targetId: "target_claude",
    }),
  ).resolves.toEqual({ status: "installed" });

  expect(codexCalls[1]).toEqual({
    command: "codex",
    args: [
      "mcp",
      "add",
      "0000",
      "--",
      "bun",
      "/opt/0000/scripts/hosted-mcp-connector.ts",
      "--target",
      "target_codex",
      "--managed-by-0000-machine",
    ],
  });
  expect(claudeCalls[1]).toEqual({
    command: "claude",
    args: [
      "mcp",
      "add",
      "--scope",
      "user",
      "0000",
      "--",
      "bun",
      "/opt/0000/scripts/hosted-mcp-connector.ts",
      "--target",
      "target_claude",
      "--managed-by-0000-machine",
    ],
  });
});

test("updates an older managed entry without touching an unrelated entry", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await installMachineMcpClient({
    connectorScript: "/opt/0000/scripts/hosted-mcp-connector.ts",
    managedTargetId: "target_old",
    runtimeId: "codex",
    run: async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, stderr: "", stdout: '{"name":"0000"}' };
    },
    targetId: "target_new",
  });

  expect(result).toEqual({ status: "installed" });
  expect(calls.map((call) => call.args)).toEqual([
    ["mcp", "get", "0000", "--json"],
    ["mcp", "remove", "0000"],
    [
      "mcp",
      "add",
      "0000",
      "--",
      "bun",
      "/opt/0000/scripts/hosted-mcp-connector.ts",
      "--target",
      "target_new",
      "--managed-by-0000-machine",
    ],
  ]);
});

test("accepts only a safe connector target and ignores the managed marker", () => {
  expect(
    parseHostedMcpConnectorArgs([
      "--target",
      "target_123",
      "--managed-by-0000-machine",
    ]),
  ).toEqual({ targetId: "target_123" });
  expect(() => parseHostedMcpConnectorArgs(["--target", "../outside"])).toThrow(
    "invalid machine MCP target id",
  );
});

test("uses the hosted MCP endpoint and bridge-owned credential directory", () => {
  expect(
    resolveHostedMcpConnectorConfig({
      argv: ["--target", "target_123"],
      homeDirectory: "/home/don",
    }),
  ).toEqual({
    credentialsDirectory: "/home/don/.0000/mcp-targets",
    endpoint: "https://api.0000.chat/mcp",
    targetId: "target_123",
  });
});

test("claims, installs, and reports a Machine MCP target without exposing its credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "0000-machine-mcp-"));
  const reported: unknown[] = [];

  const result = await provisionMachineMcpInstallation({
    claimCredential: async () => ({
      credential: "credential-value",
      credentialVersion: 1,
      targetId: "target_123",
    }),
    connectorScript: "/opt/0000/scripts/hosted-mcp-connector.ts",
    credentialsDirectory: join(directory, "mcp-targets"),
    installation: {
      profileIdentity: "work",
      runtimeId: "hermes",
      targetId: "target_123",
    },
    reportInstallation: async (report) => {
      reported.push(report);
    },
    run: async () => ({ exitCode: 0, stderr: "", stdout: "No MCP servers configured." }),
  });

  expect(result).toEqual({ status: "installed" });
  expect(reported).toEqual([
    {
      credentialVersion: 1,
      restartRequired: false,
      status: "ready",
      targetId: "target_123",
    },
  ]);
  expect(JSON.stringify(reported)).not.toContain("credential-value");
});
