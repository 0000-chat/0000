import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const expectedRepo = "0000-chat/0000";
const zeroOid = "0".repeat(40);
const cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function document(fields = `repo: ${expectedRepo}\nstatus: current`, body = "Body.\n") {
  return `---\n${fields}\n---\n${body}`;
}

function writeFile(root, filePath, contents) {
  const absolute = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function run(command, args, { cwd, input, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, input, env, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function git(root, args) {
  const result = run("git", args, { cwd: root });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${root}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function commitAll(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function createRepository(t, { baselineFiles = {}, policyFields = {} } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "documentation-tools-git-"));
  const root = path.join(parent, "repo");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Documentation Tests"]);
  git(root, ["config", "user.email", "documentation-tests@example.invalid"]);
  writeFile(root, "README.md", document());
  for (const [filePath, contents] of Object.entries(baselineFiles)) writeFile(root, filePath, contents);
  const namingBaseline = commitAll(root, "baseline documents");

  const policy = {
    schemaVersion: 1,
    expectedRepo,
    namingBaseline,
    publicationBase: "origin/main",
    privatePathSegments: [],
    deniedPaths: [],
    excludedPaths: [],
    ...policyFields,
  };
  writeFile(root, ".docs-policy.json", `${JSON.stringify(policy, null, 2)}\n`);
  const policyCommit = commitAll(root, "add documentation policy");
  return { parent, root, namingBaseline, policyCommit, policy };
}

function updatePolicy(root, currentPolicy, updates, { stage = true } = {}) {
  const policy = { ...currentPolicy, ...updates };
  writeFile(root, ".docs-policy.json", `${JSON.stringify(policy, null, 2)}\n`);
  if (stage) git(root, ["add", ".docs-policy.json"]);
  return policy;
}

function docsCheck(root, args, { repo = expectedRepo, input, envRepository } = {}) {
  const env = { ...process.env };
  if (envRepository === undefined) delete env.GITHUB_REPOSITORY;
  else if (envRepository === null) delete env.GITHUB_REPOSITORY;
  else env.GITHUB_REPOSITORY = envRepository;
  const identityArgs = repo === null ? [] : ["--repo", repo];
  return run(process.execPath, [cliPath, "--root", root, ...identityArgs, ...args], { cwd: root, input, env });
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function assertDiagnostic(result, code, filePath) {
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), new RegExp(`\\[${code}\\]`, "u"));
  if (filePath) assert.ok(output(result).includes(filePath), output(result));
}

test("worktree mode checks untracked Markdown with either supported extension", (t) => {
  const { root } = createRepository(t);
  writeFile(root, "guide.MD", "No frontmatter.\n");
  writeFile(root, "notes.MARKDOWN", "No frontmatter.\n");

  const result = docsCheck(root, ["--mode", "worktree"]);

  assertDiagnostic(result, "FRONTMATTER_MISSING", "guide.MD");
  assert.ok(output(result).includes("notes.MARKDOWN"), output(result));
});

test("the index identity comes from the caller and staged policy drift is rejected", (t) => {
  const { root, policy } = createRepository(t);
  const missingIdentity = docsCheck(root, ["--mode", "index"], { repo: null });
  assertDiagnostic(missingIdentity, "EXPECTED_REPO", ".docs-policy.json");

  updatePolicy(root, policy, { expectedRepo: "attacker/checkout" });
  const driftedIdentity = docsCheck(root, ["--mode", "index"]);
  assertDiagnostic(driftedIdentity, "POLICY_IDENTITY_MISMATCH", ".docs-policy.json");
});

test("an explicit repository identity cannot disagree with the CI identity", (t) => {
  const { root } = createRepository(t);

  const result = docsCheck(root, ["--mode", "index"], { envRepository: "someone-else/project" });

  assertDiagnostic(result, "IDENTITY_SOURCE_MISMATCH", ".docs-policy.json");
});

test("the naming baseline permits old filenames and rejects the same shape on a new path", (t) => {
  const legacyPath = "services/catalog/docs/Legacy Notes.MD";
  const { root } = createRepository(t, { baselineFiles: { [legacyPath]: document() } });
  const baselineResult = docsCheck(root, ["--mode", "index"]);
  assert.equal(baselineResult.status, 0, output(baselineResult));

  const newPath = "services/catalog/docs/New Notes.md";
  writeFile(root, newPath, document());
  git(root, ["add", newPath]);
  const newPathResult = docsCheck(root, ["--mode", "index"]);

  assertDiagnostic(newPathResult, "SERVICE_DOC_FILENAME", newPath);
});

test("a forced staged AGENTS.override.md remains blocked when Git ignores it", (t) => {
  const { root } = createRepository(t);
  writeFile(root, ".gitignore", "AGENTS.override.md\n");
  writeFile(root, "AGENTS.override.md", document());
  git(root, ["add", ".gitignore"]);
  git(root, ["add", "--force", "AGENTS.override.md"]);

  const result = docsCheck(root, ["--mode", "index"]);

  assertDiagnostic(result, "PRIVATE_OVERRIDE", "AGENTS.override.md");
});

test("index and commit modes reject symlink escapes through root and nested prefixes", (t) => {
  const { root } = createRepository(t);
  fs.symlinkSync(".", path.join(root, "a"));
  fs.symlinkSync("a/../outside", path.join(root, "b"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.symlinkSync("..", path.join(root, "docs", "a"));
  fs.symlinkSync("a/../../outside", path.join(root, "docs", "b"));
  fs.symlinkSync("/tmp/outside", path.join(root, "direct"));
  git(root, ["add", "-A"]);
  const commit = commitAll(root, "add symlink paths");

  for (const args of [["--mode", "index"], ["--mode", "commit", "--commit", commit]]) {
    const result = docsCheck(root, args);
    assertDiagnostic(result, "SYMLINK_EXTERNAL", "b");
    const externalPaths = output(result).split("\n")
      .map((line) => line.match(/^- (.*?):\d+:\d+ \[SYMLINK_EXTERNAL\]/u)?.[1])
      .filter(Boolean)
      .sort();
    assert.deepEqual(externalPaths, ["b", "direct", "docs/b"]);
  }
});

test("worktree symlink resolution resets at an absolute in-repository target", (t) => {
  const { root } = createRepository(t);
  fs.mkdirSync(path.join(root, "dir"));
  fs.symlinkSync(root, path.join(root, "dir", "a"));
  fs.symlinkSync("dir/a/../outside", path.join(root, "b"));

  const result = docsCheck(root, ["--mode", "worktree"]);

  assertDiagnostic(result, "SYMLINK_EXTERNAL", "b");
});

test("worktree mode accepts a finite repeated traversal through an internal link", (t) => {
  const { root } = createRepository(t);
  writeFile(root, "file", "target\n");
  fs.symlinkSync(".", path.join(root, "a"));
  fs.symlinkSync("a/a/file", path.join(root, "b"));

  const result = docsCheck(root, ["--mode", "worktree"]);

  assert.equal(result.status, 0, output(result));
});

test("index mode validates staged blobs instead of working tree contents", (t) => {
  const { root } = createRepository(t);
  writeFile(root, "README.md", document("repo: wrong/project\nstatus: current"));
  git(root, ["add", "README.md"]);
  writeFile(root, "README.md", document());

  const unsafeIndex = docsCheck(root, ["--mode", "index"]);
  assertDiagnostic(unsafeIndex, "REPO_MISMATCH", "README.md");
  const fixedWorktree = docsCheck(root, ["--mode", "worktree"]);
  assert.equal(fixedWorktree.status, 0, output(fixedWorktree));

  git(root, ["add", "README.md"]);
  writeFile(root, "README.md", document("repo: wrong/project\nstatus: current"));
  const safeIndex = docsCheck(root, ["--mode", "index"]);
  assert.equal(safeIndex.status, 0, output(safeIndex));
  const unsafeWorktree = docsCheck(root, ["--mode", "worktree"]);
  assertDiagnostic(unsafeWorktree, "REPO_MISMATCH", "README.md");
});

test("index mode fails closed when Git has unmerged document entries", (t) => {
  const { root } = createRepository(t);
  const mainBranch = git(root, ["branch", "--show-current"]);
  git(root, ["switch", "--quiet", "-c", "left-conflict"]);
  writeFile(root, "conflict.md", document(undefined, "left branch\n"));
  commitAll(root, "left document");
  const leftBranch = git(root, ["branch", "--show-current"]);
  git(root, ["switch", "--quiet", mainBranch]);
  writeFile(root, "conflict.md", document(undefined, "main branch\n"));
  commitAll(root, "main document");
  const merge = run("git", ["merge", "--no-edit", leftBranch], { cwd: root });
  assert.notEqual(merge.status, 0, "the fixture must produce a merge conflict");

  const result = docsCheck(root, ["--mode", "index"]);

  assertDiagnostic(result, "INDEX_UNMERGED", "conflict.md");
});

test("commit mode reads the committed policy and Markdown blobs", (t) => {
  const { root, policy } = createRepository(t);
  writeFile(root, "README.md", document(`repo: ${expectedRepo}\nstatus: invalid`));
  const invalidCommit = commitAll(root, "commit invalid frontmatter");

  writeFile(root, "README.md", document());
  updatePolicy(root, policy, { expectedRepo: "other/repository" }, { stage: false });
  const result = docsCheck(root, ["--mode", "commit", "--commit", invalidCommit]);

  assertDiagnostic(result, "STATUS_VALUE", "README.md");
  assert.ok(!output(result).includes("POLICY_IDENTITY_MISMATCH"), output(result));
});

test("published mode catches an unsafe commit even when a later commit deletes its file", (t) => {
  const { root, policyCommit } = createRepository(t);
  const publishedPath = "docs/private-note.md";
  writeFile(root, publishedPath, "Missing frontmatter.\n");
  commitAll(root, "add invalid published document");
  fs.rmSync(path.join(root, publishedPath));
  const deleteCommit = commitAll(root, "delete invalid document");

  const result = docsCheck(root, ["--mode", "published", "--base-ref", policyCommit, "--head", deleteCommit]);

  assertDiagnostic(result, "FRONTMATTER_MISSING", publishedPath);
});

test("published validation refuses a shallow clone before resolving a missing base", (t) => {
  const { parent, root, policyCommit } = createRepository(t);
  writeFile(root, "docs/published.md", document());
  commitAll(root, "publish a document");
  const shallow = path.join(parent, "shallow");
  const clone = run("git", ["clone", "--quiet", "--depth", "1", `file://${root}`, shallow], { cwd: parent });
  assert.equal(clone.status, 0, clone.stderr);
  assert.equal(git(shallow, ["rev-parse", "--is-shallow-repository"]), "true");

  const result = docsCheck(shallow, ["--mode", "published", "--base-ref", policyCommit, "--head", "HEAD"]);

  assertDiagnostic(result, "SHALLOW_REPOSITORY", ".");
});

test("pre-push validates supplied commit OIDs across new, updated, and deleted refs", (t) => {
  const { root, policyCommit } = createRepository(t);
  git(root, ["switch", "--quiet", "-c", "safe-topic"]);
  writeFile(root, "docs/safe.md", document());
  const safeOid = commitAll(root, "add safe document");
  git(root, ["switch", "--quiet", "-c", "unsafe-topic", policyCommit]);
  writeFile(root, "docs/unsafe.md", "Missing frontmatter.\n");
  const unsafeOid = commitAll(root, "add unsafe document");
  const input = [
    `refs/heads/not-created ${safeOid} refs/heads/new-topic ${zeroOid}`,
    `refs/heads/also-not-created ${unsafeOid} refs/heads/updated-topic ${policyCommit}`,
    `refs/heads/deleted ${zeroOid} refs/heads/removed-topic ${policyCommit}`,
  ].join("\n") + "\n";

  const result = docsCheck(root, ["--mode", "pre-push", "--base-ref", policyCommit], { input });

  assertDiagnostic(result, "FRONTMATTER_MISSING", "docs/unsafe.md");
});

test("a zero event base scans from the policy naming baseline", (t) => {
  const legacyPath = "services/catalog/docs/Legacy Notes.md";
  const { root } = createRepository(t, { baselineFiles: { [legacyPath]: document() } });
  const newPath = "services/catalog/docs/new Notes.md";
  writeFile(root, newPath, document());
  const publishedHead = commitAll(root, "add a new nonconforming path");

  const result = docsCheck(root, ["--mode", "published", "--base-ref", zeroOid, "--head", publishedHead]);

  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /\[SERVICE_DOC_FILENAME\]/u);
  assert.ok(output(result).includes(newPath), output(result));
});
