import { execFile as execFileCallback, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { acquireMiniflareTestLock } from "./miniflare-test-lock";
import {
  buildMsgMiniflareRateLimits,
  type MsgMiniflareRateLimitBinding,
  type MsgRateLimitPolicy,
} from "../../scripts/msg-rate-limit-policy";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = join(appDirectory, ".miniflare-tests");
const workerEntry = fileURLToPath(new URL("../src/worker-entry.ts", import.meta.url));
const nodeRuntimeEntry = fileURLToPath(new URL("./msg-worker.node-runtime.mjs", import.meta.url));
const bunWorkerBundleTimeoutMs = 20_000;
const bunWorkerBundleOutputLimit = 16 * 1024;
const execFile = promisify(execFileCallback);
let workerScriptPromise: Promise<string> | undefined;

export const TEST_ROOM_LIMITS = {
  maxMessages: 4,
  tombstoneTtlMs: 100,
};

// Reuses the RFC 8291 receiver vector only inside the local fake push service.
export const TEST_VAPID_PUBLIC_KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
export const TEST_VAPID_PRIVATE_KEY = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
export const TEST_VAPID_SUBJECT = "mailto:push@example.com";

export const SHORT_LIVED_TEST_ROOM_LIMITS = {
  ...TEST_ROOM_LIMITS,
  inactivityTtlMs: 100,
  tombstoneTtlMs: 100,
};

/** Generous local bindings keep auth/integration fixtures focused on their own behavior. */
export const TEST_MSG_RATE_LIMIT_POLICY: MsgRateLimitPolicy = {
  creation: { limit: 100, namespace_id: "913001" },
  reads: { limit: 1_000, namespace_id: "913002" },
  posts: { limit: 100, namespace_id: "913003" },
  live: { limit: 100, namespace_id: "913004" },
};

export interface MsgMiniflareRuntime {
  readonly ready: Promise<URL>;
  dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  inspectOutboundRequests(): Promise<readonly CapturedOutboundRequest[]>;
  inspectPendingPushes(): Promise<readonly CapturedOutboundRequest[]>;
  clearOutboundRequests(): Promise<void>;
  setOutboundResponse(status: number, location?: string, delayMs?: number): Promise<void>;
  triggerAlarm(room: string): Promise<void>;
  armPushSendGate(room: string): Promise<void>;
  advancePushSendClock(room: string, nowMs: number): Promise<void>;
  waitForPushSendGate(room: string): Promise<void>;
  releasePushSendGate(room: string): Promise<void>;
  markWebhookDeliverySending(room: string, eventId: string): Promise<void>;
  deleteWebhookSource(room: string, messageId: string): Promise<void>;
}

export interface CapturedOutboundRequest {
  readonly body: string;
  readonly body_base64: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly url: string;
}

export interface MsgMiniflareFixture {
  readonly miniflare: MsgMiniflareRuntime;
  dispose(): Promise<void>;
}

interface NodeRuntimeReadyMessage {
  dispatchUrl: string;
  type: "ready";
  workerUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface NodeRuntimeConfiguration {
  bindings: Record<string, string>;
  compatibilityDate: string;
  d1Databases?: Record<string, string>;
  d1MigrationPaths?: string[];
  d1Persist?: string;
  durableObjects: { ConversationRoom: { className: string; useSQLite: boolean } };
  persistenceDirectory: string;
  ratelimits: Readonly<Record<string, MsgMiniflareRateLimitBinding>>;
  script: string;
}

interface NodeRuntimeProcess {
  readonly clearOutboundRequests: MsgMiniflareRuntime["clearOutboundRequests"];
  readonly dispatchFetch: MsgMiniflareRuntime["dispatchFetch"];
  readonly inspectOutboundRequests: MsgMiniflareRuntime["inspectOutboundRequests"];
  readonly inspectPendingPushes: MsgMiniflareRuntime["inspectPendingPushes"];
  readonly ready: Promise<URL>;
  readonly setOutboundResponse: MsgMiniflareRuntime["setOutboundResponse"];
  readonly triggerAlarm: MsgMiniflareRuntime["triggerAlarm"];
  readonly armPushSendGate: MsgMiniflareRuntime["armPushSendGate"];
  readonly advancePushSendClock: MsgMiniflareRuntime["advancePushSendClock"];
  readonly waitForPushSendGate: MsgMiniflareRuntime["waitForPushSendGate"];
  readonly releasePushSendGate: MsgMiniflareRuntime["releasePushSendGate"];
  readonly markWebhookDeliverySending: MsgMiniflareRuntime["markWebhookDeliverySending"];
  readonly deleteWebhookSource: MsgMiniflareRuntime["deleteWebhookSource"];
  dispose(): Promise<void>;
}

export async function createMsgMiniflareTempDirectory(label: string): Promise<string> {
  await mkdir(temporaryDirectory, { recursive: true });
  return mkdtemp(join(temporaryDirectory, `${label}-`));
}

/** Builds a Worker bundle in a separate pinned Bun process and returns its script. */
export async function buildWorkerBundleInChild(entrypoint: string): Promise<string> {
  const buildDirectory = await createMsgMiniflareTempDirectory("bun-worker-build");
  const outputPath = join(buildDirectory, "worker.js");
  try {
    await execFile(process.execPath, [
      "build",
      entrypoint,
      "--external",
      "cloudflare:workers",
      "--format",
      "esm",
      "--target",
      "browser",
      "--outfile",
      outputPath,
    ], {
      cwd: appDirectory,
      killSignal: "SIGKILL",
      maxBuffer: bunWorkerBundleOutputLimit,
      timeout: bunWorkerBundleTimeoutMs,
    });
    return await readFile(outputPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Bun Worker bundle failed: ${detail}`, { cause: error });
  } finally {
    await rm(buildDirectory, { force: true, recursive: true });
  }
}

function workerScript(): Promise<string> {
  if (workerScriptPromise) return workerScriptPromise;
  workerScriptPromise = buildWorkerScript();
  return workerScriptPromise;
}

async function buildWorkerScript(): Promise<string> {
  const buildDirectory = await createMsgMiniflareTempDirectory("build");
  let script: string | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const result = await Bun.build({
      entrypoints: [workerEntry],
      external: ["cloudflare:workers"],
      format: "esm",
      naming: "worker.js",
      outdir: buildDirectory,
      target: "browser",
    });
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
    const entry = result.outputs.find((output) => output.kind === "entry-point");
    if (!entry) throw new Error("The Miniflare test build did not emit an entry point.");
    script = await entry.text();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await rm(buildDirectory, { force: true, recursive: true });
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  if (script === undefined) throw new Error("The Miniflare test build output was unavailable.");
  return script;
}

async function startNodeRuntime(configurationPath: string): Promise<NodeRuntimeProcess> {
  const startupLine = `${JSON.stringify({ type: "start", configurationPath })}\n`;
  if (Buffer.byteLength(startupLine, "utf8") > 4_096) {
    throw new Error("Node-owned Miniflare startup control message exceeded its size limit.");
  }
  const child = spawn("node", [nodeRuntimeEntry], {
    cwd: appDirectory,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const readyMessage = await new Promise<NodeRuntimeReadyMessage>((resolve, reject) => {
    let settled = false;
    const lines = createInterface({ input: child.stdout });
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      lines.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (!settled) fail(new Error(`Node-owned Miniflare exited before ready (code=${code}, signal=${signal}).`));
    });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail(error);
        return;
      }
      if (!isRecord(message) || typeof message.type !== "string") {
        fail(new Error("Node-owned Miniflare returned an invalid startup message."));
        return;
      }
      if (message.type === "error") {
        fail(new Error(typeof message.message === "string" ? message.message : "Node-owned Miniflare failed to start."));
        return;
      }
      if (message.type !== "ready" || typeof message.dispatchUrl !== "string" || typeof message.workerUrl !== "string" || settled) return;
      settled = true;
      lines.close();
      resolve({ type: "ready", dispatchUrl: message.dispatchUrl, workerUrl: message.workerUrl });
    });
    child.stdin.write(startupLine, (error) => {
      if (error) fail(error);
    });
  }).catch(async (error: unknown) => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    throw error;
  });

  const dispatchUrl = new URL(readyMessage.dispatchUrl);
  const workerUrl = new URL(readyMessage.workerUrl);
  const controlUrl = new URL("/__test/", dispatchUrl);
  async function control(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(new URL(path, controlUrl), { redirect: "manual", ...init });
    if (!response.ok) throw new Error(`Miniflare test control returned HTTP ${response.status}.`);
    return response;
  }
  let disposal: Promise<void> | undefined;

  return {
    async clearOutboundRequests() {
      await control("outbound", { method: "DELETE" });
    },
    ready: Promise.resolve(workerUrl),
    async inspectOutboundRequests() {
      return await (await control("outbound")).json() as CapturedOutboundRequest[];
    },
    async inspectPendingPushes() {
      return await (await control("pending-pushes")).json() as CapturedOutboundRequest[];
    },
    async dispatchFetch(input, init) {
      const request = new Request(input, init);
      const hasBody = request.body !== null;
      const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
      const descriptor = {
        url: request.url,
        method: request.method,
        headers: [...request.headers.entries()],
        hasBody,
      };
      const response = await fetch(dispatchUrl, {
        method: "POST",
        headers: { "x-msg-test-request": Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url") },
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
      });
      if (response.headers.get("x-msg-test-runtime-error") === "1") {
        const result: unknown = await response.json();
        const message = isRecord(result) && typeof result.error === "string" ? result.error : "Node-owned Miniflare dispatch failed.";
        throw new Error(message);
      }
      return response;
    },
    async setOutboundResponse(status, location, delayMs) {
      await control("outbound", {
        body: JSON.stringify({ status, ...(location === undefined ? {} : { location }), ...(delayMs === undefined ? {} : { delay_ms: delayMs }) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    },
    async triggerAlarm(room) {
      await control("alarm", {
        body: JSON.stringify({ room }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    },
    async armPushSendGate(room) {
      await control("push-send-gate", { body: JSON.stringify({ action: "arm", room }), headers: { "content-type": "application/json" }, method: "POST" });
    },
    async advancePushSendClock(room, nowMs) {
      await control("push-send-gate", { body: JSON.stringify({ action: "advance", now_ms: nowMs, room }), headers: { "content-type": "application/json" }, method: "POST" });
    },
    async waitForPushSendGate(room) {
      await control("push-send-gate", { body: JSON.stringify({ action: "wait", room }), headers: { "content-type": "application/json" }, method: "POST" });
    },
    async releasePushSendGate(room) {
      await control("push-send-gate", { body: JSON.stringify({ action: "release", room }), headers: { "content-type": "application/json" }, method: "POST" });
    },
    async markWebhookDeliverySending(room, eventId) {
      await control("mark-webhook-sending", {
        body: JSON.stringify({ room, event_id: eventId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    },
    async deleteWebhookSource(room, messageId) {
      await control("delete-webhook-source", {
        body: JSON.stringify({ room, message_id: messageId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    },
    dispose() {
      if (disposal) return disposal;
      disposal = (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
            child.stdin.end();
          } catch {
            child.kill("SIGTERM");
          }
        }
        const result = await closed;
        if (result.code !== 0) {
          throw new Error(`Node-owned Miniflare exited with code ${result.code ?? result.signal ?? "unknown"}.`);
        }
      })();
      return disposal;
    },
  };
}

async function startNodeRuntimeWithConfiguration(configuration: NodeRuntimeConfiguration): Promise<NodeRuntimeProcess> {
  const configurationDirectory = await createMsgMiniflareTempDirectory("node-runtime-config");
  const configurationPath = join(configurationDirectory, "configuration.json");
  let runtime: NodeRuntimeProcess | undefined;
  let failed = false;
  let failure: unknown;
  try {
    await writeFile(configurationPath, JSON.stringify(configuration), { encoding: "utf8", flag: "wx", mode: 0o600 });
    runtime = await startNodeRuntime(configurationPath);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await rm(configurationDirectory, { force: true, recursive: true });
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) {
    try {
      await runtime?.dispose();
    } catch {
      // Preserve the startup or temporary-file cleanup error.
    }
    throw failure;
  }
  if (!runtime) throw new Error("Node-owned Miniflare startup returned no runtime.");
  return runtime;
}

/** Builds the production entry and starts it in an isolated Node-owned workerd process. */
export async function startMsgMiniflare(
  persistenceDirectory: string,
  limits = TEST_ROOM_LIMITS,
  extraBindingsOrOptions: Record<string, string> | { readonly nowMs?: number; readonly testMode?: boolean } = {},
  useTestLimits = true,
  useOperations = false,
  rateLimitPolicy: MsgRateLimitPolicy = TEST_MSG_RATE_LIMIT_POLICY,
): Promise<MsgMiniflareFixture> {
  const options = isStartOptions(extraBindingsOrOptions) ? extraBindingsOrOptions : {};
  const extraBindings = isStartOptions(extraBindingsOrOptions) ? {} : extraBindingsOrOptions;
  const testMode = isStartOptions(extraBindingsOrOptions) ? options.testMode !== false : useTestLimits;
  if (!testMode && options.nowMs !== undefined) throw new Error("The test clock requires explicit test mode.");
  const releaseRuntime = await acquireMiniflareTestLock();
  let runtime: NodeRuntimeProcess | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const script = await workerScript();
    runtime = await startNodeRuntimeWithConfiguration({
      bindings: {
        ...(testMode ? { MSG_TEST_MODE: "1", MSG_TEST_ROOM_LIMITS: JSON.stringify(limits) } : {}),
        ...(options.nowMs === undefined ? {} : { MSG_TEST_NOW_MS: String(options.nowMs) }),
        MSG_VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
        MSG_VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
        MSG_VAPID_SUBJECT: TEST_VAPID_SUBJECT,
        ...extraBindings,
      },
      compatibilityDate: "2026-05-15",
      ...(useOperations ? {
        d1Databases: { MSG_DB: "msg-operations" },
        d1MigrationPaths: [
          fileURLToPath(new URL("../migrations/0001_operations.sql", import.meta.url)),
          fileURLToPath(new URL("../migrations/0002_operations_retention.sql", import.meta.url)),
          fileURLToPath(new URL("../migrations/0003_creation_plan.sql", import.meta.url)),
        ],
        d1Persist: `${persistenceDirectory}-d1`,
      } : {}),
      durableObjects: {
        ConversationRoom: { className: "ConversationRoom", useSQLite: true },
      },
      persistenceDirectory,
      ratelimits: buildMsgMiniflareRateLimits(rateLimitPolicy),
      script,
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (failed || !runtime) {
    try {
      await releaseRuntime();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    throw failure;
  }

  let disposed = false;
  return {
    miniflare: {
      ready: runtime.ready,
      inspectOutboundRequests: runtime.inspectOutboundRequests,
      inspectPendingPushes: runtime.inspectPendingPushes,
      clearOutboundRequests: runtime.clearOutboundRequests,
      setOutboundResponse: runtime.setOutboundResponse,
      triggerAlarm: runtime.triggerAlarm,
      armPushSendGate: runtime.armPushSendGate,
      advancePushSendClock: runtime.advancePushSendClock,
      waitForPushSendGate: runtime.waitForPushSendGate,
      releasePushSendGate: runtime.releasePushSendGate,
      markWebhookDeliverySending: runtime.markWebhookDeliverySending,
      deleteWebhookSource: runtime.deleteWebhookSource,
      dispatchFetch: runtime.dispatchFetch,
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      let disposeFailed = false;
      let disposeFailure: unknown;
      try {
        await runtime?.dispose();
      } catch (error) {
        disposeFailed = true;
        disposeFailure = error;
      }
      try {
        await releaseRuntime();
      } catch (error) {
        if (!disposeFailed) {
          disposeFailed = true;
          disposeFailure = error;
        }
      }
      if (disposeFailed) throw disposeFailure;
    },
  };
}

function isStartOptions(value: Record<string, string> | { readonly nowMs?: number; readonly testMode?: boolean }): value is { readonly nowMs?: number; readonly testMode?: boolean } {
  return Object.hasOwn(value, "nowMs") || Object.hasOwn(value, "testMode");
}
