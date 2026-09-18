import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireMiniflareTestLock } from "./miniflare-test-lock";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = join(appDirectory, ".miniflare-tests");
const workerEntry = fileURLToPath(new URL("../src/worker-entry.ts", import.meta.url));
const nodeRuntimeEntry = fileURLToPath(new URL("./msg-worker.node-runtime.mjs", import.meta.url));
let workerScriptPromise: Promise<string> | undefined;

export const TEST_ROOM_LIMITS = {
  maxMessages: 4,
  tombstoneTtlMs: 100,
};

export const SHORT_LIVED_TEST_ROOM_LIMITS = {
  ...TEST_ROOM_LIMITS,
  inactivityTtlMs: 100,
  tombstoneTtlMs: 100,
};

export interface MsgMiniflareRuntime {
  readonly ready: Promise<URL>;
  dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  inspectOutboundRequests(): Promise<readonly CapturedOutboundRequest[]>;
  clearOutboundRequests(): Promise<void>;
  setOutboundResponse(status: number, location?: string, delayMs?: number): Promise<void>;
  triggerAlarm(room: string): Promise<void>;
}

export interface CapturedOutboundRequest {
  readonly body: string;
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
  bindings: { MSG_TEST_MODE: string; MSG_TEST_NOW_MS?: string; MSG_TEST_ROOM_LIMITS: string };
  compatibilityDate: string;
  durableObjects: { ConversationRoom: { className: string; useSQLite: boolean } };
  persistenceDirectory: string;
  script: string;
}

interface NodeRuntimeProcess {
  readonly clearOutboundRequests: MsgMiniflareRuntime["clearOutboundRequests"];
  readonly dispatchFetch: MsgMiniflareRuntime["dispatchFetch"];
  readonly inspectOutboundRequests: MsgMiniflareRuntime["inspectOutboundRequests"];
  readonly ready: Promise<URL>;
  readonly setOutboundResponse: MsgMiniflareRuntime["setOutboundResponse"];
  readonly triggerAlarm: MsgMiniflareRuntime["triggerAlarm"];
  dispose(): Promise<void>;
}

export async function createMsgMiniflareTempDirectory(label: string): Promise<string> {
  await mkdir(temporaryDirectory, { recursive: true });
  return mkdtemp(join(temporaryDirectory, `${label}-`));
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

async function startNodeRuntime(configuration: NodeRuntimeConfiguration): Promise<NodeRuntimeProcess> {
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
    child.stdin.write(`${JSON.stringify({ type: "start", configuration })}\n`, (error) => {
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

/** Builds the production entry and starts it in an isolated Node-owned workerd process. */
export async function startMsgMiniflare(
  persistenceDirectory: string,
  limits = TEST_ROOM_LIMITS,
  options: { readonly nowMs?: number } = {},
): Promise<MsgMiniflareFixture> {
  const releaseRuntime = await acquireMiniflareTestLock();
  let runtime: NodeRuntimeProcess | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const script = await workerScript();
    runtime = await startNodeRuntime({
      bindings: {
        MSG_TEST_MODE: "1",
        ...(options.nowMs === undefined ? {} : { MSG_TEST_NOW_MS: String(options.nowMs) }),
        MSG_TEST_ROOM_LIMITS: JSON.stringify(limits),
      },
      compatibilityDate: "2026-05-15",
      durableObjects: {
        ConversationRoom: { className: "ConversationRoom", useSQLite: true },
      },
      persistenceDirectory,
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
      clearOutboundRequests: runtime.clearOutboundRequests,
      setOutboundResponse: runtime.setOutboundResponse,
      triggerAlarm: runtime.triggerAlarm,
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
