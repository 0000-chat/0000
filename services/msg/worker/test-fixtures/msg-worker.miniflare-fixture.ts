import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import { acquireMiniflareTestLock, miniflareTestDiagnostic } from "./miniflare-test-lock";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = join(appDirectory, ".miniflare-tests");
const workerEntry = fileURLToPath(new URL("../src/worker-entry.ts", import.meta.url));
let fixtureSequence = 0;

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
  miniflareTestDiagnostic("temp_dir.create.begin", { label });
  await mkdir(temporaryDirectory, { recursive: true });
  const directory = await mkdtemp(join(temporaryDirectory, `${label}-`));
  miniflareTestDiagnostic("temp_dir.create.done", { label });
  return directory;
}

/** Builds the production entry and starts it in an isolated workerd process. */
export async function startMsgMiniflare(persistenceDirectory: string, limits = TEST_ROOM_LIMITS): Promise<MsgMiniflareFixture> {
  const fixtureId = `${process.pid}-${++fixtureSequence}`;
  const startedAt = Date.now();
  miniflareTestDiagnostic("fixture.start.begin", { fixtureId });
  miniflareTestDiagnostic("fixture.lock.acquire.begin", { fixtureId });
  const releaseRuntime = await acquireMiniflareTestLock();
  miniflareTestDiagnostic("fixture.lock.acquire.done", { fixtureId, elapsedMs: Date.now() - startedAt });
  miniflareTestDiagnostic("fixture.build_dir.create.begin", { fixtureId });
  const buildDirectory = await createMsgMiniflareTempDirectory("build");
  miniflareTestDiagnostic("fixture.build_dir.create.done", { fixtureId, elapsedMs: Date.now() - startedAt });
  let miniflare: Miniflare | undefined;
  try {
    miniflareTestDiagnostic("fixture.bundle.begin", { fixtureId });
    const result = await Bun.build({
      entrypoints: [workerEntry],
      external: ["cloudflare:workers"],
      format: "esm",
      naming: "worker.js",
      outdir: buildDirectory,
      target: "browser",
    });
    miniflareTestDiagnostic("fixture.bundle.done", { fixtureId, success: result.success, elapsedMs: Date.now() - startedAt });
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));

    miniflareTestDiagnostic("fixture.miniflare.construct.begin", { fixtureId });
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
    miniflareTestDiagnostic("fixture.miniflare.construct.done", { fixtureId, elapsedMs: Date.now() - startedAt });
    miniflareTestDiagnostic("fixture.miniflare.ready.begin", { fixtureId });
    await miniflare.ready;
    miniflareTestDiagnostic("fixture.miniflare.ready.done", { fixtureId, elapsedMs: Date.now() - startedAt });
    return {
      miniflare,
      async dispose() {
        miniflareTestDiagnostic("fixture.dispose.begin", { fixtureId });
        let failed = false;
        let failure: unknown;
        try {
          try {
            miniflareTestDiagnostic("fixture.miniflare.dispose.begin", { fixtureId });
            await miniflare.dispose();
            miniflareTestDiagnostic("fixture.miniflare.dispose.done", { fixtureId, elapsedMs: Date.now() - startedAt });
          } catch (error) {
            failed = true;
            failure = error;
          }
        } finally {
          try {
            miniflareTestDiagnostic("fixture.build_dir.remove.begin", { fixtureId });
            await rm(buildDirectory, { force: true, recursive: true });
            miniflareTestDiagnostic("fixture.build_dir.remove.done", { fixtureId, elapsedMs: Date.now() - startedAt });
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
        }
        try {
          miniflareTestDiagnostic("fixture.lock.release.begin", { fixtureId });
          await releaseRuntime();
          miniflareTestDiagnostic("fixture.lock.release.done", { fixtureId, elapsedMs: Date.now() - startedAt });
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
        if (failed) throw failure;
        miniflareTestDiagnostic("fixture.dispose.done", { fixtureId, elapsedMs: Date.now() - startedAt });
      },
    };
  } catch (error) {
    miniflareTestDiagnostic("fixture.start.error", { fixtureId, errorName: error instanceof Error ? error.name : "unknown" });
    try {
      try {
        miniflareTestDiagnostic("fixture.start_cleanup.miniflare.dispose.begin", { fixtureId });
        await miniflare?.dispose();
        miniflareTestDiagnostic("fixture.start_cleanup.miniflare.dispose.done", { fixtureId });
      } finally {
        miniflareTestDiagnostic("fixture.start_cleanup.build_dir.remove.begin", { fixtureId });
        await rm(buildDirectory, { force: true, recursive: true });
        miniflareTestDiagnostic("fixture.start_cleanup.build_dir.remove.done", { fixtureId });
      }
    } catch {
      // Keep the original build or startup failure.
    }
    miniflareTestDiagnostic("fixture.start_cleanup.lock.release.begin", { fixtureId });
    await releaseRuntime();
    miniflareTestDiagnostic("fixture.start_cleanup.lock.release.done", { fixtureId });
    throw error;
  }
}
