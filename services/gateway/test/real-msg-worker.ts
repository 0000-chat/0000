import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { buildWorkerScript } from "./build-worker";

const msgWorkerEntry = fileURLToPath(
  new URL("../../msg/worker/src/worker-entry.ts", import.meta.url),
);
const gatewayWorkerRoot = fileURLToPath(new URL("../", import.meta.url));
const msgRuntimeEntry = fileURLToPath(
  new URL("./real-msg-runtime.mjs", import.meta.url),
);
const migrationEntries = [
  "0001_operations.sql",
  "0002_operations_retention.sql",
  "0003_creation_plan.sql",
] as const;

const TEST_ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const TEST_VAPID_PRIVATE_KEY = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const TEST_VAPID_PUBLIC_KEY = "BCVxsr7N_eNgXwH0bfk7Vd8pZGH6SRpkNtoIAiw4";
const TEST_VAPID_SUBJECT = "mailto:push@example.com";
const MSG_OPERATION_IDS = [
  "msg.create_room",
  "msg.create_webhook",
  "msg.disable_webhook",
  "msg.enable_webhook",
  "msg.export_room",
  "msg.get_room_status",
  "msg.list_webhooks",
  "msg.manage_room",
  "msg.post_message",
  "msg.read_room",
  "msg.redeliver_webhook",
  "msg.remove_webhook",
  "msg.rotate_webhook_secret",
  "msg.wait_for_messages",
] as const;

interface RealMsgWorker {
  readonly dispatchFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly ready: Promise<URL>;
  dispose(): Promise<void>;
}

interface ReadyMessage {
  readonly dispatchUrl: string;
  readonly type: "ready";
  readonly workerUrl: string;
}

interface RuntimeConfiguration {
  readonly bindings: Record<string, string>;
  readonly compatibilityDate: string;
  readonly durableObjects: {
    readonly ConversationRoom: {
      readonly className: string;
      readonly useSQLite: boolean;
    };
  };
  readonly d1PersistenceDirectory: string;
  readonly gatewayD1PersistenceDirectory: string;
  readonly gatewayMigrations: readonly string[];
  readonly gatewayScript: string;
  readonly gatewayScriptPath: string;
  readonly gatewaySetup: readonly string[];
  readonly migrations: readonly string[];
  readonly persistenceDirectory: string;
  readonly script: string;
  readonly scriptPath: string;
}

let workerScript: Promise<string> | undefined;
let gatewayScript: Promise<string> | undefined;

async function buildMsgWorkerScript(): Promise<string> {
  if (workerScript) return workerScript;
  workerScript = (async () => {
    // The Msg Worker source lives below a service package while this proof is
    // launched from the Gateway package. Resolve its existing package
    // dependencies explicitly so the isolated worktree does not depend on a
    // particular workspace hoisting layout.
    const msgDependencies = fileURLToPath(
      new URL("../../msg/node_modules", import.meta.url),
    );
    return buildWorkerScript({
      aliases: {
        "@modelcontextprotocol/server": join(
          msgDependencies,
          "@modelcontextprotocol/server/dist/index.mjs",
        ),
        zod: join(msgDependencies, "zod/index.js"),
        "zod/v4": join(msgDependencies, "zod/v4/index.js"),
      },
      entrypoint: msgWorkerEntry,
    });
  })();
  return workerScript;
}

async function buildGatewayWorkerScript(): Promise<string> {
  if (gatewayScript) return gatewayScript;
  gatewayScript = (async () => {
    const source = `
import gatewayWorker from "../src/worker.ts";

const principals = new Map([
  ["agent-a", { kind: "agent", agentId: "agent-a", organizationId: "org-a", profileId: "profile-a" }],
  ["agent-b", { kind: "agent", agentId: "agent-b", organizationId: "org-a", profileId: "profile-b" }],
  ["agent-managed", { kind: "agent", agentId: "agent-managed", organizationId: "org-a", profileId: "profile-managed" }],
]);
const platform = {
  inspectAgentCredential(rawCredential) {
    return principals.get(rawCredential) ?? null;
  },
  inspectHumanSession(rawSession, organizationId) {
    if (rawSession !== "admin-session" || organizationId !== "org-a") return null;
    return { kind: "human", userId: "human-admin", organizationId };
  },
  canManageProfile(rawSession, organizationId, profileId) {
    return rawSession === "admin-session" && organizationId === "org-a" && profileId === "profile-managed";
  },
};

export default {
  fetch(request, environment) {
    return gatewayWorker.fetch(request, { ...environment, PLATFORM_VERIFICATION: platform });
  },
};
`;
    const alias = fileURLToPath(
      new URL("../src/mcp-use-client-unavailable.ts", import.meta.url),
    );
    const buildDirectory = await mkdtemp(
      join(gatewayWorkerRoot, ".real-gateway-build-"),
    );
    try {
      const entrypoint = join(buildDirectory, "worker.ts");
      await writeFile(entrypoint, source, { encoding: "utf8", mode: 0o600 });
      return await buildWorkerScript({
        aliases: {
          "@mcp-use/client": alias,
          "fs/promises": alias,
          path: alias,
        },
        entrypoint,
      });
    } finally {
      await rm(buildDirectory, { recursive: true, force: true });
    }
  })();
  return gatewayScript;
}

async function readMigrations(): Promise<readonly string[]> {
  return Promise.all(
    migrationEntries.map((entry) =>
      readFile(
        fileURLToPath(
          new URL(`../../msg/worker/migrations/${entry}`, import.meta.url),
        ),
        "utf8",
      ),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export async function startRealMsgWorker(): Promise<RealMsgWorker> {
  const directory = await mkdtemp("/tmp/gateway-real-msg-");
  let child: ReturnType<typeof spawn> | undefined;
  let closed:
    | Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>
    | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const [script, gateway, migrations, gatewayMigration] = await Promise.all([
      buildMsgWorkerScript(),
      buildGatewayWorkerScript(),
      readMigrations(),
      readFile(
        fileURLToPath(
          new URL("../migrations/0001_gateway_profiles.sql", import.meta.url),
        ),
        "utf8",
      ),
    ]);
    const gatewaySetup = [
      "INSERT INTO gateway_profiles (organization_id, profile_id) VALUES ('org-a', 'profile-a'), ('org-a', 'profile-b')",
      ...MSG_OPERATION_IDS.map(
        (operationId) =>
          `INSERT INTO gateway_profile_tool_grants (organization_id, profile_id, operation_id) VALUES ('org-a', 'profile-a', '${operationId}')`,
      ),
    ];
    const configuration: RuntimeConfiguration = {
      bindings: {
        MSG_DATA_ENCRYPTION_KEY_V1: TEST_ENCRYPTION_KEY,
        MSG_PUBLIC_ORIGIN: "https://msg.0000.chat",
        MSG_VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
        MSG_VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
        MSG_VAPID_SUBJECT: TEST_VAPID_SUBJECT,
      },
      compatibilityDate: "2026-05-15",
      d1PersistenceDirectory: join(directory, "d1"),
      durableObjects: {
        ConversationRoom: { className: "ConversationRoom", useSQLite: true },
      },
      gatewayD1PersistenceDirectory: join(directory, "gateway-d1"),
      gatewayMigrations: [gatewayMigration],
      gatewayScript: gateway,
      gatewayScriptPath: join(directory, "gateway.js"),
      gatewaySetup,
      migrations,
      persistenceDirectory: join(directory, "durable-objects"),
      script,
      scriptPath: join(directory, "msg.js"),
    };
    await writeFile(configuration.gatewayScriptPath, gateway, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(configuration.scriptPath, script, {
      encoding: "utf8",
      mode: 0o600,
    });
    const configurationPath = join(directory, "configuration.json");
    await writeFile(configurationPath, JSON.stringify(configuration), {
      encoding: "utf8",
      mode: 0o600,
    });
    child = spawn("node", [msgRuntimeEntry, configurationPath], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["ignore", "pipe", "inherit"],
    });
    closed = new Promise((resolve) => {
      child?.once("close", (code, signal) => resolve({ code, signal }));
    });
    const ready = await new Promise<ReadyMessage>((resolve, reject) => {
      let settled = false;
      const lines = createInterface({ input: child!.stdout! });
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              "Real Msg Worker did not become ready within 30 seconds.",
            ),
          ),
        30_000,
      );
      const settle = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        lines.close();
        return true;
      };
      const fail = (error: unknown) => {
        if (!settle()) return;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      child!.once("error", fail);
      child!.once("close", (code, signal) => {
        if (!settled)
          fail(
            new Error(
              `Real Msg Worker exited before ready (code=${code}, signal=${signal}).`,
            ),
          );
      });
      lines.on("line", (line) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (error) {
          fail(error);
          return;
        }
        if (!isRecord(value) || typeof value.type !== "string") {
          fail(
            new Error("Real Msg Worker returned an invalid startup message."),
          );
          return;
        }
        if (value.type === "error") {
          fail(
            new Error(
              typeof value.message === "string"
                ? value.message
                : "Real Msg Worker failed to start.",
            ),
          );
          return;
        }
        if (
          value.type !== "ready" ||
          typeof value.dispatchUrl !== "string" ||
          typeof value.workerUrl !== "string"
        ) {
          fail(new Error("Real Msg Worker returned an invalid ready message."));
          return;
        }
        if (!settle()) return;
        resolve({
          type: "ready",
          dispatchUrl: value.dispatchUrl,
          workerUrl: value.workerUrl,
        });
      });
    });
    const dispatchUrl = ready.dispatchUrl;
    let disposed = false;
    return {
      ready: Promise.resolve(new URL(ready.workerUrl)),
      async dispatchFetch(input, init) {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input, init);
        const hasBody = request.body !== null;
        const body = hasBody
          ? new Uint8Array(await request.arrayBuffer())
          : undefined;
        const descriptor = {
          hasBody,
          headers: [...request.headers.entries()],
          method: request.method,
          url: request.url,
        };
        const response = await fetch(dispatchUrl, {
          body,
          headers: { "x-real-msg-test-request": encode(descriptor) },
          method: "POST",
        });
        if (response.headers.get("x-real-msg-test-runtime-error") === "1") {
          const error = await response.text();
          throw new Error(error || "Real Msg Worker dispatch failed.");
        }
        return new Response(await response.arrayBuffer(), {
          headers: response.headers,
          status: response.status,
        });
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        try {
          child!.kill("SIGTERM");
        } catch {
          child!.kill("SIGTERM");
        }
        let forced = false;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          closed!,
          new Promise<{
            readonly code: number | null;
            readonly signal: NodeJS.Signals | null;
          }>((resolve) => {
            forceTimer = setTimeout(() => {
              forced = true;
              child!.kill("SIGKILL");
              resolve({ code: null, signal: "SIGKILL" });
            }, 5_000);
          }),
        ]);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        await rm(directory, { recursive: true, force: true });
        const requestedSignal =
          result.signal === "SIGTERM" || result.code === 143;
        if (!forced && result.code !== 0 && !requestedSignal) {
          throw new Error(
            `Real Msg Worker exited with code ${result.code ?? result.signal ?? "unknown"}.`,
          );
        }
      },
    };
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await closed;
  } catch {
    // Preserve the startup error.
  }
  await rm(directory, { recursive: true, force: true });
  if (failed) throw failure;
  throw new Error("Real Msg Worker startup returned no runtime.");
}
