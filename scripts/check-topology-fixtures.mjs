import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateTopology } from "./check-topology.mjs";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "0000-topology-"));
}

function assertContains(errors, text, description) {
  assert(
    errors.some((error) => error.includes(text)),
    `${description}: expected an error containing ${JSON.stringify(text)}, got ${JSON.stringify(errors)}`
  );
}

const privateWorkspaceRoot = makeFixtureRoot();
const symlinkRoot = makeFixtureRoot();
const sourceImportRoot = makeFixtureRoot();
const documentationRoot = makeFixtureRoot();
try {
  writeJson(path.join(privateWorkspaceRoot, "package.json"), {
    name: "fixture",
    workspaces: ["services/*", "services/cloud"],
  });
  writeJson(path.join(privateWorkspaceRoot, "services/cloud/package.json"), {
    name: "@0000/cloud",
  });
  const privateWorkspaceErrors = validateTopology(privateWorkspaceRoot);
  assertContains(
    privateWorkspaceErrors,
    "services/cloud",
    "private workspace fixture must fail at the private repository boundary"
  );
  assertContains(
    privateWorkspaceErrors,
    "@0000/cloud",
    "private package fixture must fail at the private namespace boundary"
  );

  writeJson(path.join(symlinkRoot, "package.json"), {
    name: "fixture",
    workspaces: ["services/*", "packages/*"],
  });
  fs.mkdirSync(path.join(symlinkRoot, "services"), { recursive: true });
  const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), "0000-topology-outside-"));
  try {
    fs.symlinkSync(outsideTarget, path.join(symlinkRoot, "services/external"));
    const symlinkErrors = validateTopology(symlinkRoot);
    assertContains(
      symlinkErrors,
      "resolves outside the repository",
      "escaping symlink fixture must fail at the repository boundary"
    );
  } finally {
    fs.rmSync(outsideTarget, { recursive: true, force: true });
  }

  writeJson(path.join(sourceImportRoot, "package.json"), {
    name: "fixture",
    workspaces: ["services/*", "packages/*"],
  });
  const sourcePath = path.join(sourceImportRoot, "services/app/src/index.js");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, 'import cloud from "@0000/cloud";\n');
  const sourceImportErrors = validateTopology(sourceImportRoot);
  assertContains(
    sourceImportErrors,
    "@0000/cloud",
    "source import fixture must fail at the private import boundary"
  );

  writeJson(path.join(documentationRoot, "package.json"), {
    name: "fixture",
    workspaces: ["services/*", "packages/*"],
  });
  fs.writeFileSync(
    path.join(documentationRoot, "README.md"),
    "This prose may mention the private 0000-cloud repository without importing it.\n"
  );
  assert.deepEqual(
    validateTopology(documentationRoot),
    [],
    "documentation mentions must not be treated as dependency references"
  );
} finally {
  fs.rmSync(privateWorkspaceRoot, { recursive: true, force: true });
  fs.rmSync(symlinkRoot, { recursive: true, force: true });
  fs.rmSync(sourceImportRoot, { recursive: true, force: true });
  fs.rmSync(documentationRoot, { recursive: true, force: true });
}

console.log("public topology fixtures passed (private workspace, escaping symlink)");
