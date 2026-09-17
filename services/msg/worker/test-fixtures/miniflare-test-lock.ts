import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const lockDirectory = join(import.meta.dir, ".miniflare-tests", "workerd.lock");
const retryDelayMs = 25;
const lockTimeoutMs = 10_000;
const diagnosticsEnabled = process.env.CI === "true" || process.env.MSG_TEST_DIAGNOSTICS === "1";
const diagnosticsStartedAt = Date.now();
let lockRequestSequence = 0;

export function miniflareTestDiagnostic(stage: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): void {
  if (!diagnosticsEnabled) return;
  console.info(JSON.stringify({
    ...details,
    event: "msg.miniflare.test_diagnostic",
    stage,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - diagnosticsStartedAt,
  }));
}

/**
 * workerd can lose its control pipe when D1 and Durable Object Miniflare
 * runtimes start at the same time. Keep those integration runtimes separate.
 */
export async function acquireMiniflareTestLock(): Promise<() => Promise<void>> {
  const requestedAt = Date.now();
  const requestDetails = diagnosticsEnabled
    ? { request: ++lockRequestSequence, requester: lockRequester() }
    : {};
  miniflareTestDiagnostic("lock.acquire.begin", requestDetails);
  await mkdir(dirname(lockDirectory), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  let reportedWait = false;
  for (;;) {
    try {
      await mkdir(lockDirectory, { recursive: false });
      await writeFile(join(lockDirectory, "owner"), String(process.pid));
      const acquiredAt = Date.now();
      miniflareTestDiagnostic("lock.acquire.done", { ...requestDetails, ownerPid: process.pid, waitedMs: acquiredAt - requestedAt });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        miniflareTestDiagnostic("lock.release.begin", { ...requestDetails, ownerPid: process.pid, heldMs: Date.now() - acquiredAt });
        await rm(lockDirectory, { force: true, recursive: true });
        miniflareTestDiagnostic("lock.release.done", { ...requestDetails, ownerPid: process.pid });
      };
    } catch (error) {
      if (!isAlreadyLocked(error)) throw error;
      if (!reportedWait) {
        reportedWait = true;
        miniflareTestDiagnostic("lock.wait", { ...requestDetails, ownerPid: await readLockOwnerPid() });
      }
      if (await removeStaleLock()) continue;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Miniflare test runtime.");
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function lockRequester(): string {
  const frame = new Error().stack?.split("\n")[3] ?? "";
  return frame.match(/at ([^( ]+)/)?.[1] ?? "unknown";
}

async function readLockOwnerPid(): Promise<number | null> {
  try {
    const owner = Number.parseInt(await readFile(join(lockDirectory, "owner"), "utf8"), 10);
    return Number.isSafeInteger(owner) ? owner : null;
  } catch {
    return null;
  }
}

function isAlreadyLocked(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function removeStaleLock(): Promise<boolean> {
  try {
    const owner = Number.parseInt(await readFile(join(lockDirectory, "owner"), "utf8"), 10);
    if (Number.isSafeInteger(owner) && processIsRunning(owner)) return false;
    await rm(lockDirectory, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
