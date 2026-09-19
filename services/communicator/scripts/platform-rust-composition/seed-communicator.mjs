import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { openSync } from "node:fs";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const controlPlaneRoot = resolve(here, "../../apps/control-plane");
const statePath = process.env.T11_COMMUNICATOR_STATE_PATH;
const infoPath =
  process.env.T11_PLATFORM_INFO_PATH ??
  "/tmp/platform-t11-rust-composition.json";
const issuedPath =
  process.env.T11_ISSUED_SERVICE_PATH ??
  "/tmp/platform-t11-rust-composition-issued.json";
if (!statePath) throw new Error("T11_COMMUNICATOR_STATE_PATH is required");

const info = JSON.parse(await readFile(infoPath, "utf8"));
const issued = JSON.parse(await readFile(issuedPath, "utf8"));
const templatePath = join(here, "communicator-seed.sql.template");
const template = await readFile(templatePath, "utf8");
const sql = template
  .replaceAll("__PLATFORM_AUTHORITY__", info.authority)
  .replaceAll("__PLATFORM_SUBJECT_ID__", issued.subjectId)
  .replaceAll("__PLATFORM_ORGANIZATION_ID__", issued.organizationId)
  .replaceAll("__PLATFORM_GRANT_ID__", issued.grantId);
await mkdir(statePath, { recursive: true });
const seedPath = join(statePath, "platform-rust-composition-seed.sql");
await writeFile(seedPath, sql, { mode: 0o600 });

const logPath =
  process.env.T11_COMMUNICATOR_SEED_LOG ??
  join(statePath, "platform-rust-composition-seed.log");

function runWrangler(args) {
  return new Promise((resolveRun, rejectRun) => {
    const output = openSync(logPath, "a");
    const child = spawn("pnpm", ["exec", "wrangler", ...args], {
      cwd: controlPlaneRoot,
      stdio: ["ignore", output, output],
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`wrangler exited ${code ?? signal}`));
    });
  });
}

const common = [
  "--local",
  "--persist-to",
  statePath,
  "--config",
  "wrangler.jsonc",
];
await runWrangler(["d1", "migrations", "apply", "CONTROL_DB", ...common]);
await runWrangler([
  "d1",
  "execute",
  "CONTROL_DB",
  ...common,
  "--file",
  seedPath,
  "--yes",
]);
console.log(JSON.stringify({ seeded: true, statePath, logPath }));
