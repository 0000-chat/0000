import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { acquireMiniflareTestLock } from "../test-fixtures/miniflare-test-lock";

test("does not release a replacement lock after ownership changes", async () => {
  const parentDirectory = await mkdtemp(join(tmpdir(), "msg-miniflare-lock-"));
  const lockDirectory = join(parentDirectory, "workerd.lock");
  let releaseOriginal: (() => Promise<void>) | undefined;
  let releaseReplacement: (() => Promise<void>) | undefined;
  try {
    releaseOriginal = await acquireMiniflareTestLock({ directory: lockDirectory, timeoutMs: 1_000 });
    await rm(lockDirectory, { force: true, recursive: true });
    releaseReplacement = await acquireMiniflareTestLock({ directory: lockDirectory, timeoutMs: 1_000 });
    const replacementOwner = await readFile(join(lockDirectory, "owner"), "utf8");

    await releaseOriginal();

    await expect(readFile(join(lockDirectory, "owner"), "utf8")).resolves.toBe(replacementOwner);
  } finally {
    await releaseReplacement?.();
    await releaseOriginal?.();
    await rm(parentDirectory, { force: true, recursive: true });
  }
});

test("reclaims a dead legacy numeric PID lock", async () => {
  const parentDirectory = await mkdtemp(join(tmpdir(), "msg-miniflare-legacy-lock-"));
  const lockDirectory = join(parentDirectory, "workerd.lock");
  try {
    await mkdir(lockDirectory);
    await writeFile(join(lockDirectory, "owner"), String(Number.MAX_SAFE_INTEGER));

    const release = await acquireMiniflareTestLock({ directory: lockDirectory, timeoutMs: 1_000 });
    await expect(readFile(join(lockDirectory, "owner"), "utf8")).resolves.toContain('"token"');
    await release();
  } finally {
    await rm(parentDirectory, { force: true, recursive: true });
  }
});
