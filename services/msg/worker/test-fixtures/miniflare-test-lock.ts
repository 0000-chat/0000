import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const lockDirectory = join(import.meta.dir, ".miniflare-tests", "workerd.lock");
const retryDelayMs = 25;
const lockTimeoutMs = 10_000;

/**
 * workerd can lose its control pipe when D1 and Durable Object Miniflare
 * runtimes start at the same time. Keep those integration runtimes separate.
 */
export async function acquireMiniflareTestLock(): Promise<() => Promise<void>> {
  await mkdir(dirname(lockDirectory), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try {
      await mkdir(lockDirectory, { recursive: false });
      await writeFile(join(lockDirectory, "owner"), String(process.pid));
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockDirectory, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isAlreadyLocked(error)) throw error;
      if (await removeStaleLock()) continue;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the Miniflare test runtime.");
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
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
