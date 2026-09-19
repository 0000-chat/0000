import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireMiniflareTestLock } from "./miniflare-test-lock";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = join(appDirectory, ".miniflare-tests");
const workerEntry = fileURLToPath(new URL("../src/worker-entry.ts", import.meta.url));
const nodeRuntimeEntry = fileURLToPath(new URL("./msg-worker.node-runtime.mjs", import.meta.url));
const bunWorkerBundleEntry = fileURLToPath(new URL("./bun-worker-bundle.mjs", import.meta.url));
const bunWorkerBundleTimeoutMs = 20_000;
const bunWorkerBundleKillGraceMs = 1_000;
const bunWorkerBundleOutputLimit = 16 * 1024;
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
}

export interface MsgMiniflareFixture {
  readonly miniflare: MsgMiniflareRuntime;
  dispose(): Promise<void>;
}

export interface BunWorkerBundleOptions {
  entrypoint: string;
  external: string[];
  format: string;
  naming: string;
  target: string;
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
  script: string;
}

interface NodeRuntimeProcess {
  readonly dispatchFetch: MsgMiniflareRuntime["dispatchFetch"];
  readonly ready: Promise<URL>;
  dispose(): Promise<void>;
}

export async function createMsgMiniflareTempDirectory(label: string): Promise<string> {
  await mkdir(temporaryDirectory, { recursive: true });
  return mkdtemp(join(temporaryDirectory, `${label}-`));
}

function captureChildOutput(stream: NodeJS.ReadableStream | null): { text(): string; byteLength(): number } {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let capturedByteLength = 0;
  stream?.on("data", (chunk: unknown) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    byteLength += buffer.byteLength;
    const remaining = bunWorkerBundleOutputLimit - capturedByteLength;
    if (remaining > 0) {
      const captured = buffer.subarray(0, remaining);
      chunks.push(captured);
      capturedByteLength += captured.byteLength;
    }
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    byteLength: () => byteLength,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

interface ChildExit {
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<ChildExit> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutMarker = Symbol("child-timeout");
  const closed = new Promise<ChildExit>((resolveExit) => {
    let settled = false;
    const settle = (result: ChildExit) => {
      if (settled) return;
      settled = true;
      resolveExit(result);
    };
    child.once("error", (error: Error) => settle({ code: null, error, signal: null }));
    child.once("close", (code, signal) => settle({ code, signal }));
  });
  const timeout = new Promise<typeof timeoutMarker>((resolveTimeout) => {
    timeoutId = setTimeout(() => resolveTimeout(timeoutMarker), bunWorkerBundleTimeoutMs);
  });
  const result = await Promise.race([closed, timeout]);
  if (result !== timeoutMarker) {
    if (timeoutId) clearTimeout(timeoutId);
    return result;
  }

  child.kill("SIGTERM");
  const graceful = await Promise.race([closed, delay(bunWorkerBundleKillGraceMs)]);
  if (graceful === undefined) child.kill("SIGKILL");
  await Promise.race([closed, delay(bunWorkerBundleKillGraceMs)]);
  return { code: null, signal: "SIGKILL", timedOut: true };
}

function childBundleMessage(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) return value;
    } catch {
      // Keep the bounded child output for the error below.
    }
  }
  return undefined;
}

function childFailureMessage(exit: ChildExit, stdout: { text(): string; byteLength(): number }, stderr: { text(): string; byteLength(): number }, message: Record<string, unknown> | undefined): string {
  if (exit.timedOut) return `Bun Worker bundle child timed out after ${bunWorkerBundleTimeoutMs}ms.`;
  if (exit.error) return `Bun Worker bundle child could not start: ${exit.error.message}`;
  const childMessage = typeof message?.message === "string" ? message.message : undefined;
  const stderrMessage = stderr.text().trim().split("\n")[0];
  const detail = childMessage ?? (stderrMessage || undefined);
  const result = exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `exit ${exit.code}`;
  const output = detail ? `: ${detail}` : ".";
  return `Bun Worker bundle child failed (${result}, stdout ${stdout.byteLength()} bytes, stderr ${stderr.byteLength()} bytes)${output}`;
}

/** Builds a Worker bundle in a separate pinned Bun process and returns its script. */
export async function buildWorkerBundleInChild(options: BunWorkerBundleOptions): Promise<string> {
  const buildDirectory = await createMsgMiniflareTempDirectory("bun-worker-build");
  let script: string | undefined;
  let failure: unknown;
  try {
    const child = spawn(process.execPath, [bunWorkerBundleEntry, JSON.stringify({ ...options, outdir: buildDirectory })], {
      cwd: appDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = captureChildOutput(child.stdout);
    const stderr = captureChildOutput(child.stderr);
    const exit = await waitForChildExit(child);
    const message = childBundleMessage(stdout.text());
    if (exit.timedOut || exit.error || exit.code !== 0 || message?.type !== "success") {
      throw new Error(childFailureMessage(exit, stdout, stderr, message));
    }
    if (typeof message.outputPath !== "string") throw new Error("Bun Worker bundle child returned no output path.");
    const outputRoot = resolve(buildDirectory);
    const outputPath = resolve(message.outputPath);
    if (!outputPath.startsWith(`${outputRoot}${sep}`)) throw new Error("Bun Worker bundle child returned an invalid output path.");
    script = await readFile(outputPath, "utf8");
  } catch (error) {
    failure = error;
  }
  try {
    await rm(buildDirectory, { force: true, recursive: true });
  } catch (error) {
    if (!failure) failure = error;
  }
  if (failure) throw failure;
  if (script === undefined) throw new Error("The Bun Worker bundle child returned no script.");
  return script;
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
  let disposal: Promise<void> | undefined;

  return {
    ready: Promise.resolve(workerUrl),
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
  extraBindings: Record<string, string> = {},
  useTestLimits = true,
  useOperations = false,
): Promise<MsgMiniflareFixture> {
  const releaseRuntime = await acquireMiniflareTestLock();
  let runtime: NodeRuntimeProcess | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const script = await workerScript();
    runtime = await startNodeRuntime({
      bindings: {
        ...(useTestLimits ? { MSG_TEST_MODE: "1", MSG_TEST_ROOM_LIMITS: JSON.stringify(limits) } : {}),
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
