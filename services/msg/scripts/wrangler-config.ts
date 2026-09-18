import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildMermaidAsset } from "./mermaid-asset";

const serviceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const monorepoRoot = join(serviceRoot, "../..");
const configPath = join(serviceRoot, "wrangler.jsonc");
const placeholder = "__MSG_D1_DATABASE_ID__";
const dryRunDatabaseId = "00000000-0000-4000-8000-000000000000";
const databaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function validateMsgD1DatabaseId(value: string): string {
  if (!databaseIdPattern.test(value) || value === dryRunDatabaseId) {
    throw new Error("MSG_D1_DATABASE_ID must be a non-placeholder D1 database UUID.");
  }
  return value;
}

export function createMsgWranglerConfig(databaseId: string): string {
  const template = readFileSync(configPath, "utf8");
  if (!template.includes(placeholder)) throw new Error("The msg Wrangler config template is missing its D1 placeholder.");
  return [
    [placeholder, databaseId],
    ["../../node_modules/wrangler/config-schema.json", join(monorepoRoot, "node_modules/wrangler/config-schema.json")],
    ["worker/src/worker-entry.ts", join(serviceRoot, "worker/src/worker-entry.ts")],
    ["./worker/public", join(serviceRoot, "worker/public")],
    ["worker/migrations", join(serviceRoot, "worker/migrations")],
  ].reduce((config, [from, to]) => config.replaceAll(from, to), template);
}

export function resolveMsgWranglerArguments(args: readonly string[]): readonly string[] {
  if (args[0] !== "types" || !args[1] || args[1].startsWith("-")) return args;
  return [args[0], resolve(serviceRoot, args[1]), ...args.slice(2)];
}

function main(args: readonly string[]): void {
  const dryRun = args.includes("--dry-run");
  const localCommand = args[0] === "types";
  const databaseId = process.env.MSG_D1_DATABASE_ID
    ? validateMsgD1DatabaseId(process.env.MSG_D1_DATABASE_ID)
    : dryRun || localCommand
      ? dryRunDatabaseId
      : undefined;
  if (!databaseId) throw new Error("MSG_D1_DATABASE_ID is required for a non-dry-run msg Wrangler command.");

  buildMermaidAsset();
  const directory = mkdtempSync(join(tmpdir(), "0000-msg-wrangler-"));
  const generatedConfig = join(directory, "wrangler.msg.jsonc");
  try {
    writeFileSync(generatedConfig, createMsgWranglerConfig(databaseId), { mode: 0o600 });
    const result = spawnSync("bunx", ["wrangler", ...resolveMsgWranglerArguments(args), "--config", generatedConfig], { cwd: monorepoRoot, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "msg Wrangler configuration failed."}\n`);
    process.exitCode = 1;
  }
}
