import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MACHINE_MCP_CREDENTIAL_DIRECTORY_MODE = 0o700;
const MACHINE_MCP_CREDENTIAL_FILE_MODE = 0o600;
const MACHINE_MCP_TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type MachineMcpCredential = {
  credential: string;
  credentialVersion: number;
};

export type MachineMcpClientRuntime = "codex" | "claude_code" | "hermes";
export type MachineMcpClientInstallResult =
  | { status: "installed" }
  | { status: "already_installed" }
  | { status: "mcp_name_conflict" }
  | { status: "unsupported_client" };
export type MachineMcpCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};
export type MachineMcpCommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<MachineMcpCommandResult>;

export type MachineMcpInstallation = {
  profileIdentity?: string;
  runtimeId: string;
  targetId: string;
};

export function parseHostedMcpConnectorArgs(args: string[]): { targetId: string } {
  const targetIndex = args.indexOf("--target");
  const targetId = targetIndex === -1 ? undefined : args[targetIndex + 1];
  if (!targetId || !MACHINE_MCP_TARGET_ID_PATTERN.test(targetId)) {
    throw new Error("invalid machine MCP target id");
  }
  return { targetId };
}

export function machineMcpCredentialsDirectory(configPath: string): string {
  return join(dirname(configPath), "mcp-targets");
}

export async function writeMachineMcpCredential(input: {
  credentialsDirectory: string;
  credential: string;
  credentialVersion: number;
  targetId: string;
}): Promise<void> {
  const path = credentialPath(input.credentialsDirectory, input.targetId);
  if (!isCredential(input.credential) || !isCredentialVersion(input.credentialVersion)) {
    throw new Error("invalid machine MCP credential payload");
  }

  await mkdir(input.credentialsDirectory, {
    mode: MACHINE_MCP_CREDENTIAL_DIRECTORY_MODE,
    recursive: true,
  });
  await chmod(input.credentialsDirectory, MACHINE_MCP_CREDENTIAL_DIRECTORY_MODE);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const payload: MachineMcpCredential = {
    credential: input.credential,
    credentialVersion: input.credentialVersion,
  };
  await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    mode: MACHINE_MCP_CREDENTIAL_FILE_MODE,
  });
  await chmod(temporaryPath, MACHINE_MCP_CREDENTIAL_FILE_MODE);
  await rename(temporaryPath, path);
  await chmod(path, MACHINE_MCP_CREDENTIAL_FILE_MODE);
}

export async function readMachineMcpCredential(input: {
  credentialsDirectory: string;
  targetId: string;
}): Promise<MachineMcpCredential> {
  const path = credentialPath(input.credentialsDirectory, input.targetId);
  if (!existsSync(path)) {
    throw new Error("machine MCP credential is unavailable");
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("machine MCP credential is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (!isCredential(record.credential) || !isCredentialVersion(record.credentialVersion)) {
    throw new Error("machine MCP credential is invalid");
  }
  await chmod(path, MACHINE_MCP_CREDENTIAL_FILE_MODE);
  return {
    credential: record.credential,
    credentialVersion: record.credentialVersion,
  };
}

export async function installMachineMcpClient(input: {
  connectorScript: string;
  managedTargetId?: string;
  profileIdentity?: string;
  run: MachineMcpCommandRunner;
  runtimeId: string;
  targetId: string;
}): Promise<MachineMcpClientInstallResult> {
  if (!MACHINE_MCP_TARGET_ID_PATTERN.test(input.targetId)) {
    throw new Error("invalid machine MCP target id");
  }
  const runtime = normalizeRuntime(input.runtimeId);
  if (!runtime) {
    return { status: "unsupported_client" };
  }

  const command = clientCommand(runtime, input.profileIdentity);
  const probe = await input.run(command.command, command.probeArgs);
  const hasExistingEntry = probe.exitCode === 0 && hasMcp0000(probe.stdout);
  if (hasExistingEntry) {
    const managed =
      input.managedTargetId !== undefined ||
      probe.stdout.includes("--managed-by-0000-machine");
    if (!managed) {
      return { status: "mcp_name_conflict" };
    }
    if (input.managedTargetId === input.targetId) {
      return { status: "already_installed" };
    }
    const removed = await input.run(command.command, command.removeArgs);
    if (removed.exitCode !== 0) {
      throw new Error("managed machine MCP could not be updated");
    }
  }

  const added = await input.run(
    command.command,
    command.addArgs(input.connectorScript, input.targetId),
    runtime === "hermes" ? "y\n" : undefined,
  );
  if (added.exitCode !== 0) {
    throw new Error("machine MCP client configuration failed");
  }
  return { status: "installed" };
}

export async function provisionMachineMcpInstallation(input: {
  claimCredential: (targetId: string) => Promise<MachineMcpCredential & { targetId: string }>;
  connectorScript: string;
  credentialsDirectory: string;
  installation: MachineMcpInstallation;
  reportInstallation: (input: {
    credentialVersion: number;
    failureCode?: string;
    restartRequired?: boolean;
    status: "ready" | "failed";
    targetId: string;
  }) => Promise<void>;
  run: MachineMcpCommandRunner;
}): Promise<MachineMcpClientInstallResult> {
  const claimed = await input.claimCredential(input.installation.targetId);
  if (claimed.targetId !== input.installation.targetId) {
    throw new Error("Machine MCP credential target does not match");
  }
  try {
    await writeMachineMcpCredential({
      credentialsDirectory: input.credentialsDirectory,
      credential: claimed.credential,
      credentialVersion: claimed.credentialVersion,
      targetId: claimed.targetId,
    });
    const installed = await installMachineMcpClient({
      connectorScript: input.connectorScript,
      managedTargetId: await readManagedTargetId({
        credentialsDirectory: input.credentialsDirectory,
        installation: input.installation,
      }),
      profileIdentity: profileName(input.installation),
      run: input.run,
      runtimeId: input.installation.runtimeId,
      targetId: input.installation.targetId,
    });
    if (installed.status === "mcp_name_conflict" || installed.status === "unsupported_client") {
      await input.reportInstallation({
        credentialVersion: claimed.credentialVersion,
        failureCode: installed.status,
        status: "failed",
        targetId: claimed.targetId,
      });
      return installed;
    }
    await writeManagedTargetId({
      credentialsDirectory: input.credentialsDirectory,
      installation: input.installation,
    });
    await input.reportInstallation({
      credentialVersion: claimed.credentialVersion,
      restartRequired:
        input.installation.runtimeId === "codex" ||
        input.installation.runtimeId === "claude_code",
      status: "ready",
      targetId: claimed.targetId,
    });
    return installed;
  } catch (error) {
    await input.reportInstallation({
      credentialVersion: claimed.credentialVersion,
      failureCode: "configuration_failed",
      status: "failed",
      targetId: claimed.targetId,
    }).catch(() => undefined);
    throw error;
  }
}

export async function runMachineMcpCommand(
  command: string,
  args: string[],
  input?: string,
): Promise<MachineMcpCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(0, 8 * 1024);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", () => resolve({ exitCode: -1, stderr: "", stdout: "" }));
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? -1, stderr, stdout });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function normalizeRuntime(value: string): MachineMcpClientRuntime | undefined {
  if (value === "codex" || value === "claude_code" || value === "hermes") {
    return value;
  }
  return undefined;
}

function clientCommand(
  runtime: MachineMcpClientRuntime,
  profileIdentity: string | undefined,
): {
  addArgs: (connectorScript: string, targetId: string) => string[];
  command: string;
  probeArgs: string[];
  removeArgs: string[];
} {
  const connectorArgs = (connectorScript: string, targetId: string) => [
    "bun",
    connectorScript,
    "--target",
    targetId,
    "--managed-by-0000-machine",
  ];
  if (runtime === "codex") {
    return {
      addArgs: (connectorScript, targetId) => [
        "mcp",
        "add",
        "0000",
        "--",
        ...connectorArgs(connectorScript, targetId),
      ],
      command: "codex",
      probeArgs: ["mcp", "get", "0000", "--json"],
      removeArgs: ["mcp", "remove", "0000"],
    };
  }
  if (runtime === "claude_code") {
    return {
      addArgs: (connectorScript, targetId) => [
        "mcp",
        "add",
        "--scope",
        "user",
        "0000",
        "--",
        ...connectorArgs(connectorScript, targetId),
      ],
      command: "claude",
      probeArgs: ["mcp", "get", "0000"],
      removeArgs: ["mcp", "remove", "--scope", "user", "0000"],
    };
  }
  const profileArgs =
    profileIdentity && profileIdentity !== "default" ? ["-p", profileIdentity] : [];
  return {
    addArgs: (connectorScript, targetId) => [
      ...profileArgs,
      "mcp",
      "add",
      "0000",
      "--command",
      "bun",
      "--args",
      connectorScript,
      "--target",
      targetId,
      "--managed-by-0000-machine",
    ],
    command: "hermes",
    probeArgs: [...profileArgs, "mcp", "list"],
    removeArgs: [...profileArgs, "mcp", "remove", "0000"],
  };
}

function hasMcp0000(output: string): boolean {
  return /(?:^|\n)\s*0000(?:\s|$)|["']name["']\s*:\s*["']0000["']/.test(output);
}

type ManagedTargetRegistry = Record<string, string>;

async function readManagedTargetId(input: {
  credentialsDirectory: string;
  installation: MachineMcpInstallation;
}): Promise<string | undefined> {
  const registryPath = managedTargetsPath(input.credentialsDirectory);
  if (!existsSync(registryPath)) return undefined;
  const parsed: unknown = JSON.parse(await readFile(registryPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const targetId = (parsed as ManagedTargetRegistry)[managedTargetKey(input.installation)];
  return typeof targetId === "string" && MACHINE_MCP_TARGET_ID_PATTERN.test(targetId)
    ? targetId
    : undefined;
}

async function writeManagedTargetId(input: {
  credentialsDirectory: string;
  installation: MachineMcpInstallation;
}): Promise<void> {
  const registryPath = managedTargetsPath(input.credentialsDirectory);
  const existing: ManagedTargetRegistry = existsSync(registryPath)
    ? (JSON.parse(await readFile(registryPath, "utf8")) as ManagedTargetRegistry)
    : {};
  existing[managedTargetKey(input.installation)] = input.installation.targetId;
  const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(existing)}\n`, {
    encoding: "utf8",
    mode: MACHINE_MCP_CREDENTIAL_FILE_MODE,
  });
  await chmod(temporaryPath, MACHINE_MCP_CREDENTIAL_FILE_MODE);
  await rename(temporaryPath, registryPath);
  await chmod(registryPath, MACHINE_MCP_CREDENTIAL_FILE_MODE);
}

function managedTargetsPath(credentialsDirectory: string): string {
  return join(credentialsDirectory, "managed-targets.json");
}

function managedTargetKey(installation: MachineMcpInstallation): string {
  return `${installation.runtimeId}:${profileName(installation) ?? "default"}`;
}

function profileName(installation: MachineMcpInstallation): string | undefined {
  const identity = installation.profileIdentity;
  if (!identity) return undefined;
  const prefix = `${installation.runtimeId}:`;
  return identity.startsWith(prefix) ? identity.slice(prefix.length) : identity;
}

function credentialPath(credentialsDirectory: string, targetId: string): string {
  if (!MACHINE_MCP_TARGET_ID_PATTERN.test(targetId)) {
    throw new Error("invalid machine MCP target id");
  }
  return join(credentialsDirectory, `${targetId}.json`);
}

function isCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function isCredentialVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
