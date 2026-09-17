import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import { acquireMiniflareTestLock } from "./miniflare-test-lock";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = join(appDirectory, ".miniflare-tests");
const workerEntry = fileURLToPath(new URL("../src/worker-entry.ts", import.meta.url));
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

export interface MsgMiniflareFixture {
  readonly miniflare: Miniflare;
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

/** Builds the production entry and starts it in an isolated workerd process. */
export async function startMsgMiniflare(persistenceDirectory: string, limits = TEST_ROOM_LIMITS): Promise<MsgMiniflareFixture> {
  const releaseRuntime = await acquireMiniflareTestLock();
  let miniflare: Miniflare | undefined;
  try {
    const script = await workerScript();

    miniflare = new Miniflare({
      bindings: {
        MSG_TEST_MODE: "1",
        MSG_TEST_ROOM_LIMITS: JSON.stringify(limits),
      },
      compatibilityDate: "2026-05-15",
      durableObjects: {
        ConversationRoom: { className: "ConversationRoom", useSQLite: true },
      },
      durableObjectsPersist: persistenceDirectory,
      host: "127.0.0.1",
      modules: true,
      script,
    });
    await miniflare.ready;
    return {
      miniflare,
      async dispose() {
        let failed = false;
        let failure: unknown;
        try {
          await miniflare.dispose();
        } catch (error) {
          failed = true;
          failure = error;
        }
        try {
          await releaseRuntime();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
        if (failed) throw failure;
      },
    };
  } catch (error) {
    try {
      await miniflare?.dispose();
    } catch {
      // Keep the original build or startup failure.
    }
    await releaseRuntime();
    throw error;
  }
}
