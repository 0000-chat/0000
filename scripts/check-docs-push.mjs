// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "documentation-tools", "cli.mjs");
const result = spawnSync(process.execPath, [cli, "--root", root, "--repo", "0000-chat/0000", "--mode", "pre-push"], {
  cwd: root,
  input: fs.readFileSync(0),
  stdio: ["pipe", "inherit", "inherit"],
  env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
