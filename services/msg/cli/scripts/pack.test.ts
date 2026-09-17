import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
  expect(manifest.description).toBe("Read, post to, and wait for messages in a 0000 msg conversation.");
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

test("packed archive contains the binary and excludes sources, tests, and caches", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const jsonStart = result.stdout.lastIndexOf("\n[\n") + 1;
  const output = JSON.parse(result.stdout.slice(jsonStart)) as [{ files: { path: string }[]; name: string }];
  const files = output[0]?.files.map((file) => file.path).sort();

  expect(output[0]?.name).toBe("@0000chat/msg");
  expect(files).toEqual(["LICENSE", "README.md", "dist/cli.js", "package.json"]);
  expect(files?.some((path) => path.includes(".turbo") || path.includes("src/") || path.endsWith(".test.ts"))).toBe(false);
});

test("built binary reports package version and parser help", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const binary = join(packageRoot, "dist/cli.js");
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const help = spawnSync(binary, ["--help"], { encoding: "utf8" });

  expect(version.status, version.stderr).toBe(0);
  expect(version.stdout.trim()).toBe(manifest.version);
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain("Usage: msg join");
  expect(help.stdout).toContain("Usage: msg wait");
  expect(help.stdout).toContain("Usage: msg post");
});
