// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runGit(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

try {
  runGit(["rev-parse", "--show-toplevel"]);
} catch {
  console.log("documentation hooks are skipped outside a Git checkout");
  process.exit(0);
}

function localHookPath() {
  try {
    return runGit(["config", "--local", "--get", "core.hooksPath"]);
  } catch {
    return "";
  }
}

const configured = localHookPath();
function verifyHookFiles() {
  const hooks = ["pre-commit", "pre-push"];
  const missing = hooks.filter((name) => {
    const hookPath = path.join(root, ".githooks", name);
    try {
      return !fs.statSync(hookPath).isFile() || (fs.statSync(hookPath).mode & 0o111) === 0;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    console.error(`documentation hook files are missing or not executable: ${missing.join(", ")}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

if (configured === ".githooks") {
  if (verifyHookFiles()) console.log("documentation hooks are already installed");
} else if (configured.length > 0) {
  console.error(`core.hooksPath is already set to ${configured}; it was left unchanged`);
  console.error("chain the documentation hooks from the existing hook path to install them");
  process.exitCode = 1;
} else {
  if (verifyHookFiles()) {
    execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log("installed repository-local documentation hooks at .githooks");
  }
}
