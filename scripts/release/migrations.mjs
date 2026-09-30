import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalisePath, sha256 } from "./lib.mjs";

const MIGRATION_PATTERN = /^[0-9]{4,}_[a-z0-9_]+\.sql$/;

export function migrationMetadata(directory, files) {
  if (!directory) return [];
  const names = [...files].sort((left, right) => left.localeCompare(right));
  if (names.length === 0) throw new Error("configured D1 migrations directory is empty");
  let previous = -1;
  return names.map((name) => {
    const basename = path.posix.basename(name);
    if (!MIGRATION_PATTERN.test(basename)) throw new Error(`invalid D1 migration filename: ${name}`);
    const number = Number.parseInt(basename.split("_", 1)[0], 10);
    if (number <= previous) throw new Error("D1 migrations must have strictly increasing numeric prefixes");
    previous = number;
    const bytes = fs.readFileSync(path.join(directory, name));
    return { name: path.posix.join("migrations", name), digest: `sha256:${sha256(bytes)}` };
  });
}

function gitOutput(repositoryRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`could not inspect D1 migration history (${args[0]})`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

/**
 * Reject edits or removals to migration files already present at the release
 * base. New numerically ordered files remain allowed. This protects the D1
 * apply ledger independently of Wrangler's remote bookkeeping.
 */
export function assertAppendOnlyD1Migrations({ repositoryRoot, source, baseCommit }) {
  if (!baseCommit) return;
  const normalisedSource = normalisePath(source);
  const previousPaths = gitOutput(repositoryRoot, ["ls-tree", "-r", "--name-only", baseCommit, "--", normalisedSource])
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((entry) => entry.startsWith(`${normalisedSource}/`));
  const previousMigrationNames = new Set();
  let previousMaximum = -1;
  for (const previousPath of previousPaths) {
    const relative = previousPath.slice(normalisedSource.length + 1);
    if (!MIGRATION_PATTERN.test(relative)) continue;
    previousMigrationNames.add(relative);
    previousMaximum = Math.max(previousMaximum, Number.parseInt(relative.split("_", 1)[0], 10));
    const currentPath = path.resolve(repositoryRoot, normalisedSource, relative);
    const expectedRelative = path.relative(repositoryRoot, currentPath);
    if (expectedRelative.startsWith("..") || path.isAbsolute(expectedRelative) || normalisePath(expectedRelative) !== expectedRelative) {
      throw new Error(`D1 migration history path escapes the repository: ${previousPath}`);
    }
    if (!fs.existsSync(currentPath) || !fs.lstatSync(currentPath).isFile() || fs.lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`D1 migration history is not append-only: removed ${previousPath}`);
    }
    const previousBytes = gitOutput(repositoryRoot, ["show", `${baseCommit}:${previousPath}`]);
    const currentBytes = fs.readFileSync(currentPath);
    if (Buffer.compare(Buffer.from(previousBytes), currentBytes) !== 0) {
      throw new Error(`D1 migration history is not append-only: changed ${previousPath}`);
    }
  }
  const currentDirectory = path.resolve(repositoryRoot, normalisedSource);
  if (!fs.existsSync(currentDirectory) || !fs.lstatSync(currentDirectory).isDirectory()) return;
  for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !MIGRATION_PATTERN.test(entry.name) || previousMigrationNames.has(entry.name)) continue;
    const number = Number.parseInt(entry.name.split("_", 1)[0], 10);
    if (number <= previousMaximum) {
      throw new Error(`D1 migration history is not append-only: new migration ${entry.name} precedes the release base`);
    }
  }
}
