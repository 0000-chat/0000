import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ESLint } from "eslint";
import markdown from "@eslint/markdown";
import { eslintPlugin, validateDocument } from "../cli.mjs";

const expectedRepo = "0000-chat/0000";
const policy = {
  schemaVersion: 1,
  expectedRepo,
  namingBaseline: "a".repeat(40),
  privatePathSegments: [],
  deniedPaths: [],
  excludedPaths: [],
};

function frontmatter(fields, body = "Body.\n") {
  return `---\n${fields}\n---\n${body}`;
}

function codes(filePath, text) {
  return validateDocument({ path: filePath, text, expectedRepo, policy }).map((item) => item.code);
}

test("validates required repository fields and keeps unrelated frontmatter valid", () => {
  const valid = frontmatter([
    `repo: ${expectedRepo}`,
    "status: current",
    "title: Agent onboarding",
    "owner: platform",
    "skills:",
    "  - name: review",
    "    path: .agents/skills/review/SKILL.md",
  ].join("\n"));

  assert.deepEqual(codes("README.md", valid), []);
  assert.deepEqual(codes("README.md", frontmatter("status: current")), ["REPO_MISSING"]);
  assert.deepEqual(codes("README.md", frontmatter(`repo: [${expectedRepo}]\nstatus: current`)), ["REPO_SCALAR"]);
  assert.deepEqual(codes("README.md", frontmatter("repo: another/project\nstatus: current")), ["REPO_MISMATCH"]);
  assert.deepEqual(codes("README.md", frontmatter(`repo: ${expectedRepo}`)), ["STATUS_MISSING"]);
  assert.deepEqual(codes("README.md", frontmatter(`repo: ${expectedRepo}\nstatus: [current]`)), ["STATUS_SCALAR"]);
  assert.deepEqual(codes("README.md", frontmatter(`repo: ${expectedRepo}\nstatus: published`)), ["STATUS_VALUE"]);
});

test("rejects duplicate keys, custom tags, and aliases in frontmatter", () => {
  assert.deepEqual(codes("README.md", frontmatter(`repo: ${expectedRepo}\nrepo: ${expectedRepo}\nstatus: current`)), [
    "FRONTMATTER_DUPLICATE_KEY",
  ]);
  assert.deepEqual(codes("README.md", frontmatter(`repo: !secret ${expectedRepo}\nstatus: current`)), [
    "FRONTMATTER_TAG",
  ]);
  assert.deepEqual(codes("README.md", frontmatter(`repo: ${expectedRepo}\nstatus: current\nextra: &shared value\ncopy: *shared`)), [
    "FRONTMATTER_ALIAS",
  ]);
});

test("enforces status rules from the document location", () => {
  const make = (status) => frontmatter(`repo: ${expectedRepo}\nstatus: ${status}`);

  assert.deepEqual(codes("docs/history/decision.md", make("current")), ["STATUS_HISTORY"]);
  assert.deepEqual(codes("docs/history/decision.md", make("archived")), []);
  assert.deepEqual(codes("docs/history/README.md", make("current")), []);
  assert.deepEqual(codes("docs/plans/2026-10-01-migration.md", make("current")), ["STATUS_PLAN"]);
  assert.deepEqual(codes("docs/plans/2026-10-01-migration.md", make("draft")), []);
  assert.deepEqual(codes("docs/plans/README.md", make("current")), []);
  assert.deepEqual(codes("docs/guide.md", make("accepted")), ["STATUS_ACCEPTED"]);
  assert.deepEqual(codes("docs/decisions/0001-auth.md", make("accepted")), []);
});

test("the exported ESLint rule reports the validator's diagnostics", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "documentation-eslint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const text = frontmatter(`repo: other/project\nstatus: current`);
  const expectedCodes = codes("docs/guide.md", text);
  const eslint = new ESLint({
    cwd: directory,
    overrideConfigFile: true,
    ignore: false,
    overrideConfig: [{
      files: ["**/*.md", "**/*.markdown"],
      plugins: { markdown, "documentation-tools": eslintPlugin },
      language: "markdown/gfm",
      languageOptions: { frontmatter: "yaml" },
      linterOptions: { noInlineConfig: true },
      rules: { "documentation-tools/frontmatter": ["error", { expectedRepo, policy }] },
    }],
  });
  const [result] = await eslint.lintText(text, { filePath: path.join(directory, "docs/guide.md") });
  const eslintCodes = result.messages
    .filter((message) => message.ruleId === "documentation-tools/frontmatter")
    .map((message) => message.message.match(/^\[([A-Z_]+)\]/u)?.[1]);

  assert.deepEqual(eslintCodes, expectedCodes);
});

test("inline ESLint directives cannot disable frontmatter validation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "documentation-inline-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const eslint = new ESLint({
    cwd: directory,
    overrideConfigFile: true,
    ignore: false,
    overrideConfig: [{
      files: ["**/*.md", "**/*.markdown"],
      plugins: { markdown, "documentation-tools": eslintPlugin },
      language: "markdown/gfm",
      languageOptions: { frontmatter: "yaml" },
      linterOptions: { noInlineConfig: true },
      rules: { "documentation-tools/frontmatter": ["error", { expectedRepo, policy }] },
    }],
  });
  const text = `${frontmatter("repo: wrong/project\nstatus: current")}\n<!-- eslint-disable documentation-tools/frontmatter -->\n`;
  const [result] = await eslint.lintText(text, { filePath: path.join(directory, "README.md") });
  const ruleCodes = result.messages
    .filter((message) => message.ruleId === "documentation-tools/frontmatter")
    .map((message) => message.message.match(/^\[([A-Z_]+)\]/u)?.[1]);

  assert.deepEqual(ruleCodes, ["REPO_MISMATCH"]);
});
