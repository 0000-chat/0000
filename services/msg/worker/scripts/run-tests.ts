import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoots = ["src", "scripts"] as const;
const testFilePattern = /\.test\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;

async function findTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findTestFiles(path) : [path];
  }));
  return files.flat();
}

function displayPath(path: string): string {
  return relative(workerRoot, path).split(sep).join("/");
}

async function discoverTestFiles(): Promise<string[]> {
  const files = (await Promise.all(testRoots.map((root) => findTestFiles(join(workerRoot, root)))))
    .flat()
    .filter((path) => testFilePattern.test(path))
    .sort((left, right) => {
      const leftPath = displayPath(left);
      const rightPath = displayPath(right);
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    });
  if (files.length === 0) throw new Error("Worker test discovery found no test files under src or scripts.");
  return files;
}

function runTestFile(path: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ["test", "--no-orphans", displayPath(path)], {
      cwd: workerRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit(signal === null ? (code ?? 1) : 1));
  });
}

async function main(): Promise<void> {
  const testFiles = await discoverTestFiles();
  if (process.argv.includes("--list")) {
    for (const path of testFiles) process.stdout.write(`${displayPath(path)}\n`);
    return;
  }
  process.stdout.write(`Running ${testFiles.length} Worker test files sequentially.\n`);
  let firstFailure: number | undefined;
  for (const path of testFiles) {
    const exitCode = await runTestFile(path);
    if (exitCode !== 0) {
      firstFailure ??= exitCode;
      process.stderr.write(`Worker test file failed: ${displayPath(path)} (exit ${exitCode})\n`);
    }
  }
  if (firstFailure !== undefined) process.exitCode = firstFailure;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Worker test runner failed."}\n`);
  process.exitCode = 1;
});
