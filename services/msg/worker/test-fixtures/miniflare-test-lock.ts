import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const lockDirectory = join(import.meta.dir, ".miniflare-tests", "workerd.lock");
const retryDelayMs = 25;
// The full Worker suite serializes several long-lived DO and D1 runtimes
// through this lock. Keep queued tests alive for the longest fixture instead
// of turning normal cross-file contention into a false test failure.
const lockTimeoutMs = 120_000;

export interface MiniflareTestLockOptions {
  readonly directory?: string;
  readonly timeoutMs?: number;
}

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

/**
 * workerd can lose its control pipe when D1 and Durable Object Miniflare
 * runtimes start at the same time. Keep those integration runtimes separate.
 */
export async function acquireMiniflareTestLock(options: MiniflareTestLockOptions = {}): Promise<() => Promise<void>> {
  const directory = options.directory ?? lockDirectory;
  const timeout = options.timeoutMs ?? lockTimeoutMs;
  await mkdir(dirname(directory), { recursive: true });
  const deadline = Date.now() + timeout;
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  for (;;) {
    try {
      await mkdir(directory, { recursive: false });
      await writeFile(join(directory, "owner"), JSON.stringify(owner));
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const currentOwner = await readLockOwner(directory);
        if (!currentOwner || currentOwner.pid !== owner.pid || currentOwner.token !== owner.token) return;
        await rm(directory, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isAlreadyLocked(error)) throw error;
      if (await removeStaleLock(directory)) continue;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Miniflare test runtime.");
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function isAlreadyLocked(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function readLockOwner(directory: string): Promise<LockOwner | undefined> {
  try {
    const contents = await readFile(join(directory, "owner"), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      const legacyPid = Number.parseInt(contents, 10);
      return Number.isSafeInteger(legacyPid) ? { pid: legacyPid, token: "legacy" } : undefined;
    }
    if (typeof parsed === "number") return Number.isSafeInteger(parsed) ? { pid: parsed, token: "legacy" } : undefined;
    if (typeof parsed !== "object" || parsed === null || !Number.isSafeInteger((parsed as { pid?: unknown }).pid) || typeof (parsed as { token?: unknown }).token !== "string") return undefined;
    const owner = parsed as LockOwner;
    return owner.token.length > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

async function removeStaleLock(directory: string): Promise<boolean> {
  try {
    const owner = await readLockOwner(directory);
    if (!owner || processIsRunning(owner.pid)) return false;
    await rm(directory, { force: true, recursive: true });
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
