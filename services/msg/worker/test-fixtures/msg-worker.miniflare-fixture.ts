import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import { acquireMiniflareTestLock } from "./miniflare-test-lock";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = join(appDirectory, ".miniflare-tests");
const workerEntry = fileURLToPath(new URL("../src/worker-entry.ts", import.meta.url));

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

/** Builds the production entry and starts it in an isolated workerd process. */
export async function startMsgMiniflare(persistenceDirectory: string, limits = TEST_ROOM_LIMITS): Promise<MsgMiniflareFixture> {
  const releaseRuntime = await acquireMiniflareTestLock();
  const buildDirectory = await createMsgMiniflareTempDirectory("build");
  let miniflare: Miniflare | undefined;
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
      scriptPath: join(buildDirectory, "worker.js"),
    });
    await miniflare.ready;
    return {
      miniflare,
      async dispose() {
        let failed = false;
        let failure: unknown;
        try {
          try {
            await miniflare.dispose();
          } catch (error) {
            failed = true;
            failure = error;
          }
        } finally {
          try {
            await rm(buildDirectory, { force: true, recursive: true });
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
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
      try {
        await miniflare?.dispose();
      } finally {
        await rm(buildDirectory, { force: true, recursive: true });
      }
    } catch {
      // Keep the original build or startup failure.
    }
    await releaseRuntime();
    throw error;
  }
}
