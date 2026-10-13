import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function processFailure(
  label: string,
  result: {
    error?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
    stderr: string | Buffer | null;
  },
): string {
  const details = [
    result.error?.message,
    result.signal ? `terminated by ${result.signal}` : undefined,
    result.stderr?.toString().trim() || undefined,
  ].filter((detail): detail is string => Boolean(detail));
  const exitCode = result.status === null ? "without an exit code" : `with exit code ${result.status}`;
  return `${label} failed ${exitCode}${details.length > 0 ? `: ${details.join("; ")}` : ""}`;
}

test("package metadata builds and allowlists the public CLI files", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    description?: string;
    files?: string[];
    license?: string;
    name?: string;
    repository?: { directory?: string; type?: string; url?: string };
    bugs?: { url?: string };
    scripts?: Record<string, string>;
    version?: string;
  };

  expect(manifest.name).toBe("@0000chat/msg");
  expect(manifest.version).toBe("0.3.0");
  expect(manifest.description).toBe("Read, post to, wait for messages, and manage webhooks in a 0000 msg conversation.");
  expect(manifest.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(manifest.license).toBe("MIT");
  expect(manifest.scripts?.prepack).toBe("bun run build");
  expect(manifest.repository).toEqual({
    type: "git",
    url: "https://github.com/0000-chat/0000.git",
    directory: "services/msg/cli",
  });
  expect(manifest.bugs?.url).toBe("https://github.com/0000-chat/0000/issues?q=label%3Aservice%3Amsg");
});

test("packed archive contains the binary and excludes sources, tests, and caches", { timeout: 25_000 }, () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "msg-cli-pack-"));
  const reportPath = join(temporaryDirectory, "pack-report.json");
  const reportFd = openSync(reportPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(temporaryDirectory, "npm-cache") },
      // npm only emits the pack report when stdout is a file or terminal.
      stdio: ["ignore", reportFd, "pipe"],
      timeout: 20_000,
    });
  } finally {
    closeSync(reportFd);
  }
  const packOutput = readFileSync(reportPath, "utf8");
  rmSync(temporaryDirectory, { recursive: true, force: true });
  expect(result.status, processFailure("npm pack", result)).toBe(0);
  const jsonStart = packOutput.lastIndexOf("\n[\n") + 1;
  const output = JSON.parse(packOutput.slice(jsonStart)) as [{ files: { path: string }[]; name: string }];
  const files = output[0]?.files.map((file) => file.path).sort();

  expect(output[0]?.name).toBe("@0000chat/msg");
  expect(files).toEqual(["LICENSE", "README.md", "dist/cli.js", "package.json"]);
  expect(files?.some((path) => path.includes(".turbo") || path.includes("src/") || path.endsWith(".test.ts"))).toBe(false);
});

test("built binary reports package version and parser help", { timeout: 15_000 }, () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const binary = join(packageRoot, "dist/cli.js");
  const version = runCli(binary, ["--version"]);
  const help = runCli(binary, ["--help"]);

  expect(version.status, processFailure("msg --version", version)).toBe(0);
  expect(version.stdout.trim()).toBe(manifest.version);
  expect(help.status, processFailure("msg --help", help)).toBe(0);
  expect(help.stdout).toContain("Usage: msg join");
  expect(help.stdout).toContain("Usage: msg wait");
  expect(help.stdout).toContain("Usage: msg post");
});

function runCli(binary: string, arguments_: string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly signal: NodeJS.Signals | null; readonly error?: Error } {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "msg-cli-run-"));
  const stdoutPath = join(temporaryDirectory, "stdout");
  const stderrPath = join(temporaryDirectory, "stderr");
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(binary, arguments_, { stdio: ["ignore", stdoutFd, stderrFd], timeout: 5_000 });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  rmSync(temporaryDirectory, { recursive: true, force: true });
  return { error: result.error, signal: result.signal, status: result.status, stdout, stderr };
}
