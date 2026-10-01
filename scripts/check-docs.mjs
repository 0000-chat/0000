// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "documentation-tools", "cli.mjs");
const result = spawnSync(process.execPath, [cli, "--root", root, "--repo", "0000-chat/0000", "--mode", "worktree", "--lint"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
