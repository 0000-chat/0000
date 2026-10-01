#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import markdown from "@eslint/markdown";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

const scriptPath = fileURLToPath(import.meta.url);
const supportedStatuses = new Set(["current", "draft", "accepted", "superseded", "archived"]);
const markdownExtension = /\.(?:md|markdown)$/iu;
const markdownOrMdxExtension = /\.(?:md|markdown|mdx)$/iu;
const repoSlugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

function diagnostic(code, filePath, message, line = 1, column = 1) {
  return { code, path: normalizeRelative(filePath), message, line, column };
}

function normalizeRelative(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
}

function isSafeRelativePath(value) {
  const normalized = normalizeRelative(value);
  return normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/u.test(normalized) &&
    !normalized.split("/").some((segment) => segment === ".." || segment === "");
}

function policyError(code, message) {
  return diagnostic(code, ".docs-policy.json", message);
}

function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return [policyError("POLICY_INVALID", "policy must be a JSON object")];
  }
  if (policy.schemaVersion !== 1) {
    errors.push(policyError("POLICY_SCHEMA", "schemaVersion must be 1"));
  }
  if (typeof policy.expectedRepo !== "string" || !repoSlugPattern.test(policy.expectedRepo)) {
    errors.push(policyError("POLICY_REPOSITORY", "expectedRepo must be a canonical owner/repository slug"));
  }
  if (typeof policy.namingBaseline !== "string" || !shaPattern.test(policy.namingBaseline)) {
    errors.push(policyError("POLICY_BASELINE", "namingBaseline must be a full commit object ID"));
  }
  if (policy.publicationBase !== undefined &&
      (typeof policy.publicationBase !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/u.test(policy.publicationBase))) {
    errors.push(policyError("POLICY_PUBLICATION_BASE", "publicationBase must be a remote tracking ref such as origin/main"));
  }
  for (const field of ["privatePathSegments", "deniedPaths", "excludedPaths"]) {
    if (policy[field] !== undefined && !Array.isArray(policy[field])) {
      errors.push(policyError("POLICY_FIELD", `${field} must be an array`));
    }
  }
  for (const segment of Array.isArray(policy.privatePathSegments) ? policy.privatePathSegments : []) {
    if (typeof segment !== "string" || segment.length === 0 || segment.includes("/") || segment === "." || segment === "..") {
      errors.push(policyError("POLICY_PRIVATE_SEGMENT", "privatePathSegments entries must be single path segments"));
    }
  }
  for (const field of ["deniedPaths", "excludedPaths"]) {
    for (const entry of Array.isArray(policy[field]) ? policy[field] : []) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
          !isSafeRelativePath(entry.path) || typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
        errors.push(policyError("POLICY_PATH_ENTRY", `${field} entries need one safe exact path and a nonempty reason`));
        continue;
      }
      if (/[?*{}[\]]/u.test(entry.path)) {
        errors.push(policyError("POLICY_GLOB", `${field} only accepts exact paths, not globs`));
      }
    }
  }
  return errors;
}

export function parsePolicy(text, policyPath = ".docs-policy.json") {
  const errors = [];
  let policy;
  try {
    policy = JSON.parse(text);
  } catch (error) {
    return {
      policy: null,
      diagnostics: [diagnostic("POLICY_JSON", policyPath, `policy is not valid JSON: ${error.message}`)],
    };
  }

  const yamlDocument = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
    logLevel: "silent",
  });
  if (yamlDocument.errors.length > 0) {
    errors.push(diagnostic("POLICY_DUPLICATE_KEY", policyPath, yamlDocument.errors.map((item) => item.message).join("; ")));
  }
  errors.push(...validatePolicy(policy).map((item) => ({ ...item, path: normalizeRelative(policyPath) })));
  return { policy, diagnostics: errors };
}

function walkYaml(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  if (isMap(node)) {
    for (const pair of node.items) {
      walkYaml(pair.key, visit);
      walkYaml(pair.value, visit);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) walkYaml(item, visit);
  }
}

function frontmatterFor(text) {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (!match) return { source, yaml: null, lineOffset: 1 };
  return { source, yaml: match[1], lineOffset: 1 };
}

function keyIs(pair, name) {
  return isScalar(pair.key) && typeof pair.key.value === "string" && pair.key.value === name;
}

function isReadmeIndex(relative) {
  return path.posix.basename(relative).toLowerCase() === "readme.md" ||
    path.posix.basename(relative).toLowerCase() === "readme.markdown";
}

function pathSegments(relative) {
  return normalizeRelative(relative).split("/").filter(Boolean);
}

function isServiceDocumentation(relative) {
  const parts = pathSegments(relative);
  return parts.length >= 4 && parts[0] === "services" && parts[2] === "docs";
}

function isCalendarDate(yearText, monthText, dayText) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isDatedKebabFilename(relative) {
  const name = path.posix.basename(relative);
  const match = /^(\d{4})-(\d{2})-(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.(?:md|markdown)$/u.exec(name);
  return Boolean(match && isCalendarDate(match[1], match[2], match[3]));
}

function isKebabFilename(relative) {
  const name = path.posix.basename(relative);
  if (name !== name.toLowerCase()) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:md|markdown)$/u.test(name);
}

function isNumberedAdrFilename(relative) {
  const name = path.posix.basename(relative);
  return /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:md|markdown)$/u.test(name);
}

function validatePathPolicy(relative, policy) {
  const errors = [];
  const normalized = normalizeRelative(relative);
  const parts = pathSegments(normalized);
  const privateSegments = new Set((policy.privatePathSegments ?? []).map((segment) => segment.toLowerCase()));
  for (const part of parts) {
    if (privateSegments.has(part.toLowerCase())) {
      errors.push(diagnostic("PRIVATE_PATH", normalized, `path contains private segment ${part}`));
    }
  }
  if (path.posix.basename(normalized).toLowerCase() === "agents.override.md") {
    errors.push(diagnostic("PRIVATE_OVERRIDE", normalized, "AGENTS.override.md is not allowed in this repository"));
  }
  const denied = (policy.deniedPaths ?? []).find((entry) => normalizeRelative(entry.path) === normalized);
  if (denied) errors.push(diagnostic("PATH_DENIED", normalized, denied.reason));
  return errors;
}

function validateNaming(relative, policy) {
  const normalized = normalizeRelative(relative);
  const baselinePaths = policy.baselinePaths instanceof Set ? policy.baselinePaths : new Set(policy.baselinePaths ?? []);
  if (baselinePaths.has(normalized)) return [];
  const parts = pathSegments(normalized).map((item) => item.toLowerCase());
  const basename = path.posix.basename(normalized).toLowerCase();
  const readme = isReadmeIndex(normalized);
  const hasPlanSegment = parts.includes("plans");
  const hasAdrSegment = parts.includes("adr") || parts.includes("architecture-decisions");
  const errors = [];

  if (hasPlanSegment && !readme && !isDatedKebabFilename(normalized)) {
    errors.push(diagnostic("PLAN_FILENAME", normalized, "new plan documents must use YYYY-MM-DD-kebab-case.md"));
  }
  if (hasAdrSegment && !readme && !isNumberedAdrFilename(normalized)) {
    errors.push(diagnostic("ADR_FILENAME", normalized, "new ADR documents must use NNNN-kebab-case.md"));
  }
  if (!hasPlanSegment && !hasAdrSegment && isServiceDocumentation(normalized) && !readme &&
      !isKebabFilename(normalized) && !isDatedKebabFilename(normalized)) {
    errors.push(diagnostic("SERVICE_DOC_FILENAME", normalized, "new service documentation files must use kebab-case names"));
  }
  return errors;
}

function parseFrontmatter(text, filePath) {
  const { yaml } = frontmatterFor(text);
  if (yaml === null) {
    return {
      document: null,
      diagnostics: [diagnostic("FRONTMATTER_MISSING", filePath, "Markdown must begin with YAML frontmatter delimited by ---")],
    };
  }
  const document = parseDocument(yaml, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
    logLevel: "silent",
    maxAliasCount: 0,
  });
  const parserIssues = [...document.errors, ...document.warnings];
  if (parserIssues.length > 0) {
    return {
      document,
      diagnostics: parserIssues.map((error) => diagnostic(
        error.code === "DUPLICATE_KEY" ? "FRONTMATTER_DUPLICATE_KEY" :
          error.code === "TAG_RESOLVE_FAILED" ? "FRONTMATTER_TAG" : "FRONTMATTER_YAML",
        filePath,
        error.code === "TAG_RESOLVE_FAILED" ? "frontmatter contains an unsupported YAML tag" :
          `invalid YAML frontmatter (${error.code ?? "parse error"})`,
        error.linePos?.[0]?.line ?? 1,
        error.linePos?.[0]?.col ?? 1,
      )),
    };
  }
  let aliasFound = false;
  walkYaml(document.contents, (node) => {
    if (isAlias(node)) aliasFound = true;
  });
  if (aliasFound) {
    return {
      document,
      diagnostics: [diagnostic("FRONTMATTER_ALIAS", filePath, "YAML aliases are not allowed in document frontmatter")],
    };
  }
  if (!isMap(document.contents)) {
    return {
      document,
      diagnostics: [diagnostic("FRONTMATTER_MAPPING", filePath, "frontmatter must be a YAML mapping")],
    };
  }
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      return {
        document,
        diagnostics: [diagnostic("FRONTMATTER_KEY", filePath, "frontmatter keys must be scalar strings")],
      };
    }
    if (pair.key.value === "<<") {
      return {
        document,
        diagnostics: [diagnostic("FRONTMATTER_MERGE", filePath, "YAML merge keys are not allowed")],
      };
    }
  }
  return { document, diagnostics: [] };
}

export function validateDocument({ path: filePath, text, expectedRepo, policy }) {
  const normalized = normalizeRelative(filePath);
  const errors = [...validatePolicy(policy), ...validatePathPolicy(normalized, policy ?? {})];
  if (!isSafeRelativePath(normalized)) {
    errors.push(diagnostic("PATH_UNSAFE", normalized, "document path must be repository-relative and may not contain parent traversal"));
  }
  if (!markdownExtension.test(normalized)) {
    if (/\.mdx$/iu.test(normalized)) {
      errors.push(diagnostic("MDX_UNSUPPORTED", normalized, "MDX is unsupported by the repository documentation policy"));
    }
    return errors;
  }
  const excluded = (policy?.excludedPaths ?? []).find((entry) => normalizeRelative(entry.path) === normalized);
  if (excluded) return errors;
  if (typeof expectedRepo !== "string" || !repoSlugPattern.test(expectedRepo)) {
    errors.push(diagnostic("EXPECTED_REPO", normalized, "expectedRepo must be supplied as a canonical owner/repository slug"));
  }

  const { document, diagnostics: frontmatterErrors } = parseFrontmatter(String(text), normalized);
  errors.push(...frontmatterErrors);
  if (!document || frontmatterErrors.length > 0 || !isMap(document.contents)) return errors;

  let repositoryValue;
  let statusValue;
  let repositoryPresent = false;
  let statusPresent = false;
  for (const pair of document.contents.items) {
    if (keyIs(pair, "repo")) {
      repositoryPresent = true;
      repositoryValue = pair.value;
    } else if (keyIs(pair, "status")) {
      statusPresent = true;
      statusValue = pair.value;
    }
  }
  if (!repositoryPresent) {
    errors.push(diagnostic("REPO_MISSING", normalized, "frontmatter requires the reserved repo key"));
  } else if (!isScalar(repositoryValue) || typeof repositoryValue.value !== "string") {
    errors.push(diagnostic("REPO_SCALAR", normalized, "repo must be a scalar string"));
  } else if (repositoryValue.value !== expectedRepo) {
    errors.push(diagnostic("REPO_MISMATCH", normalized, `repo must equal the configured repository ${expectedRepo}`));
  }
  if (!statusPresent) {
    errors.push(diagnostic("STATUS_MISSING", normalized, "frontmatter requires the reserved status key"));
  } else if (!isScalar(statusValue) || typeof statusValue.value !== "string") {
    errors.push(diagnostic("STATUS_SCALAR", normalized, "status must be a scalar string"));
  } else {
    const status = statusValue.value;
    if (!supportedStatuses.has(status)) {
      errors.push(diagnostic("STATUS_VALUE", normalized, `status must be one of: ${[...supportedStatuses].join(", ")}`));
    } else {
      const parts = pathSegments(normalized).map((part) => part.toLowerCase());
      const readme = isReadmeIndex(normalized);
      if (parts.includes("history") && status !== "archived" && !(readme && status === "current")) {
        errors.push(diagnostic("STATUS_HISTORY", normalized, "history documents must be archived; README indexes may be current"));
      }
      if (parts.includes("plans") && !["draft", "archived", "superseded"].includes(status) &&
          !(readme && status === "current")) {
        errors.push(diagnostic("STATUS_PLAN", normalized, "plan documents must be draft, archived, or superseded; README indexes may be current"));
      }
      if (status === "accepted" && !parts.some((part) => ["decisions", "adr", "architecture-decisions"].includes(part))) {
        errors.push(diagnostic("STATUS_ACCEPTED", normalized, "accepted status is reserved for decisions, ADRs, and architecture-decisions directories"));
      }
    }
  }
  errors.push(...validateNaming(normalized, policy ?? {}));
  return errors;
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitText(root, args) {
  return git(root, args, { encoding: "utf8" });
}

function splitNul(buffer) {
  const value = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  return value.split("\0").filter(Boolean);
}

function parseIndexEntries(root) {
  const records = splitNul(git(root, ["ls-files", "--stage", "-z"]));
  const entries = [];
  const errors = [];
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab === -1) {
      errors.push(diagnostic("INDEX_RECORD", ".", "unable to parse a Git index record"));
      continue;
    }
    const [mode, oid, stageText] = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    const stage = Number(stageText);
    if (stage !== 0) {
      errors.push(diagnostic("INDEX_UNMERGED", filePath, "Git index contains an unmerged entry"));
      continue;
    }
    entries.push({ mode, oid, path: normalizeRelative(filePath) });
  }
  return { entries, diagnostics: errors };
}

function parseTreeEntries(root, commit) {
  const records = splitNul(git(root, ["ls-tree", "-r", "-z", "--full-tree", commit]));
  const entries = [];
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    entries.push({ mode, type, oid, path: normalizeRelative(record.slice(tab + 1)) });
  }
  return entries;
}

function readBlob(root, oid) {
  return git(root, ["cat-file", "blob", oid]);
}

function readPolicyFromBlob(root, entries, sourceName, policyPath = ".docs-policy.json") {
  if (!isSafeRelativePath(policyPath)) {
    return { policy: null, diagnostics: [diagnostic("POLICY_PATH", policyPath, "policy path must remain inside the repository")] };
  }
  const entry = entries.find((item) => item.path === normalizeRelative(policyPath));
  if (!entry) {
    return {
      policy: null,
      diagnostics: [diagnostic("POLICY_MISSING", policyPath, `${sourceName} has no ${policyPath}`)],
    };
  }
  if (entry.mode === "120000") {
    return {
      policy: null,
      diagnostics: [diagnostic("POLICY_SYMLINK", policyPath, `${policyPath} must be a regular ${sourceName} file`)],
    };
  }
  return parsePolicy(readBlob(root, entry.oid).toString("utf8"), policyPath);
}

function readPolicyFromWorktree(root, policyPath) {
  if (!isSafeRelativePath(policyPath)) {
    return { policy: null, diagnostics: [diagnostic("POLICY_PATH", policyPath, "policy path must remain inside the repository")] };
  }
  const absolute = path.resolve(root, policyPath);
  if (!isWithinRoot(root, absolute)) {
    return { policy: null, diagnostics: [diagnostic("POLICY_PATH", policyPath, "policy path must remain inside the repository")] };
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { policy: null, diagnostics: [diagnostic("POLICY_FILE", policyPath, "policy must be a regular worktree file")] };
    }
    return parsePolicy(fs.readFileSync(absolute, "utf8"), policyPath);
  } catch (error) {
    return { policy: null, diagnostics: [diagnostic("POLICY_READ", policyPath, `unable to read policy: ${error.message}`)] };
  }
}

function validateExpectedIdentity(policy, identity, source) {
  const errors = [];
  if (typeof identity !== "string" || !repoSlugPattern.test(identity)) {
    errors.push(diagnostic("EXPECTED_REPO", ".docs-policy.json", `${source} must provide a full owner/repository slug`));
  } else if (identity !== policy.expectedRepo) {
    errors.push(diagnostic("POLICY_IDENTITY_MISMATCH", ".docs-policy.json", `${source} repository ${identity} does not match policy expectedRepo ${policy.expectedRepo}`));
  }
  return errors;
}

function getBaselinePaths(root, policy) {
  const baseline = policy.namingBaseline;
  try {
    git(root, ["cat-file", "-e", `${baseline}^{commit}`]);
    return { paths: new Set(splitNul(git(root, ["ls-tree", "-r", "-z", "--name-only", baseline]))), diagnostics: [] };
  } catch (error) {
    return {
      paths: new Set(),
      diagnostics: [diagnostic("NAMING_BASELINE_MISSING", ".docs-policy.json", `namingBaseline ${baseline} is unavailable: ${String(error.stderr ?? error.message).trim()}`)],
    };
  }
}

function policyWithBaseline(policy, baselinePaths) {
  return { ...policy, baselinePaths };
}

function inspectSymlinkTree(entries) {
  const links = new Map(entries.filter((item) => item.mode === "120000").map((item) => [item.path, item.target]));
  const diagnostics = [];
  for (const item of entries) {
    if (item.mode !== "120000") continue;
    const start = item.path;
    const target = String(item.target ?? "");
    const resolved = resolveTreeLink(start, target, links, new Set());
    if (resolved.kind === "cycle") {
      diagnostics.push(diagnostic("SYMLINK_CYCLE", start, "tracked symlink resolution contains a cycle"));
    } else if (resolved.kind === "external") {
      diagnostics.push(diagnostic("SYMLINK_EXTERNAL", start, "tracked symlink resolves outside the repository"));
    }
    if (markdownOrMdxExtension.test(start)) {
      diagnostics.push(diagnostic("MARKDOWN_SYMLINK", start, "Markdown and MDX files may not be symlinks"));
    }
  }
  return diagnostics;
}

function resolveTreeLink(linkPath, target, links, seen, state = { steps: 0 }) {
  if (seen.has(linkPath)) return { kind: "cycle" };
  if (target.startsWith("/")) return { kind: "external" };
  const stack = path.posix.dirname(linkPath).split("/").filter((segment) => segment && segment !== ".");
  return resolveTreeSegments(stack, target.split("/"), links, new Set([...seen, linkPath]), state);
}

function resolveTreeSegments(initialStack, initialSegments, links, activeLinks, state) {
  let stack = [...initialStack];
  const pending = [...initialSegments];
  while (pending.length > 0) {
    if (++state.steps > 10000) return { kind: "cycle" };
    const segment = pending.shift();
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return { kind: "external" };
      stack.pop();
      continue;
    }
    stack.push(segment);
    const prefix = stack.join("/");
    const nestedTarget = links.get(prefix);
    if (nestedTarget !== undefined) {
      if (activeLinks.has(prefix)) return { kind: "cycle" };
      stack.pop();
      const resolution = resolveTreeLink(prefix, nestedTarget, links, activeLinks, state);
      if (resolution.kind !== "internal") return resolution;
      stack = resolution.path ? resolution.path.split("/") : [];
    }
  }
  return { kind: "internal", path: stack.join("/") };
}

function resolveWorktreeSymlink(root, absolutePath) {
  const realRoot = fs.realpathSync(root);
  const realParent = fs.realpathSync(path.dirname(absolutePath));
  if (!isWithinRoot(realRoot, realParent)) return { kind: "external" };
  const parentRelative = path.relative(realRoot, realParent).split(path.sep).filter(Boolean);
  const stack = [...parentRelative];
  const initialTarget = fs.readlinkSync(absolutePath);
  if (path.isAbsolute(initialTarget)) {
    const relativeTarget = absoluteTargetSegments(realRoot, initialTarget);
    if (relativeTarget === null) return { kind: "external" };
    return resolveWorktreeSegments(realRoot, [], relativeTarget, new Set([normalizeRelative(path.relative(root, absolutePath))]));
  }
  return resolveWorktreeSegments(realRoot, stack, initialTarget.split("/"), new Set([normalizeRelative(path.relative(root, absolutePath))]));
}

function absoluteTargetSegments(realRoot, target) {
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (target === realRoot) return [];
  if (target.startsWith(rootPrefix)) return target.slice(rootPrefix.length).split(path.sep);
  return null;
}

function resolveWorktreeSegments(realRoot, initialStack, initialSegments, seenLinks) {
  let stack = [...initialStack];
  const pending = [...initialSegments];
  const state = { steps: 0 };
  return resolveWorktreeSegmentsInState(realRoot, stack, pending, seenLinks, state);
}

function resolveWorktreeSegmentsInState(realRoot, initialStack, initialSegments, activeLinks, state) {
  let stack = [...initialStack];
  const pending = [...initialSegments];
  while (pending.length > 0) {
    if (++state.steps > 10000) return { kind: "cycle" };
    const segment = pending.shift();
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return { kind: "external" };
      stack.pop();
      continue;
    }
    stack.push(segment);
    const candidate = path.join(realRoot, ...stack);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      return { kind: "unresolved" };
    }
    if (!stat.isSymbolicLink()) continue;
    const relativeLink = stack.join("/");
    if (activeLinks.has(relativeLink)) return { kind: "cycle" };
    const target = fs.readlinkSync(candidate);
    stack.pop();
    let targetStack = stack;
    let targetSegments;
    if (path.isAbsolute(target)) {
      const relativeTarget = absoluteTargetSegments(realRoot, target);
      if (relativeTarget === null) return { kind: "external" };
      targetStack = [];
      targetSegments = relativeTarget;
    } else {
      targetSegments = target.split("/");
    }
    const resolution = resolveWorktreeSegmentsInState(
      realRoot,
      targetStack,
      targetSegments,
      new Set([...activeLinks, relativeLink]),
      state,
    );
    if (resolution.kind !== "internal") return resolution;
    stack = resolution.path ? resolution.path.split("/") : [];
  }
  return { kind: "internal", path: stack.join("/") };
}

function treeEntriesWithTargets(root, entries) {
  return entries.map((item) => ({
    ...item,
    target: item.mode === "120000" ? readBlob(root, item.oid).toString("utf8") : undefined,
  }));
}

function checkPathSafety(entries, policy) {
  const errors = [];
  for (const entry of entries) errors.push(...validatePathPolicy(entry.path, policy));
  return errors;
}

function validateSourceEntries({ root, entries, policy, expectedRepo, sourceName, readEntry }) {
  const errors = [];
  const baseline = getBaselinePaths(root, policy);
  errors.push(...baseline.diagnostics);
  const effectivePolicy = policyWithBaseline(policy, baseline.paths);
  errors.push(...checkPathSafety(entries, policy));
  errors.push(...inspectSymlinkTree(treeEntriesWithTargets(root, entries)));

  for (const entry of entries) {
    if (!markdownOrMdxExtension.test(entry.path)) continue;
    if (entry.mode === "120000") continue;
    if (!markdownExtension.test(entry.path)) {
      errors.push(...validateDocument({ path: entry.path, text: "", expectedRepo, policy: effectivePolicy }));
      continue;
    }
    if (entry.mode === "160000") {
      errors.push(diagnostic("MARKDOWN_SUBMODULE", entry.path, "Markdown paths may not be Git submodules"));
      continue;
    }
    let contents;
    try {
      contents = readEntry(entry).toString("utf8");
    } catch (error) {
      errors.push(diagnostic("DOCUMENT_READ", entry.path, `unable to read ${sourceName} content: ${error.message}`));
      continue;
    }
    errors.push(...validateDocument({ path: entry.path, text: contents, expectedRepo, policy: effectivePolicy }));
  }
  return errors;
}

function resolveIdentity(args, policy) {
  const envRepo = process.env.GITHUB_REPOSITORY;
  const repo = args.repo ?? envRepo;
  const source = args.repo ? "--repo" : "GITHUB_REPOSITORY";
  const diagnostics = [];
  if (args.repo && envRepo && args.repo !== envRepo) {
    diagnostics.push(diagnostic("IDENTITY_SOURCE_MISMATCH", ".docs-policy.json", `--repo ${args.repo} disagrees with GITHUB_REPOSITORY ${envRepo}`));
  }
  if (!repo) {
    diagnostics.push(diagnostic("EXPECTED_REPO", ".docs-policy.json", "supply --repo owner/repository or set GITHUB_REPOSITORY; policy is not an identity source"));
  }
  return { repo, source, diagnostics };
}

function ruleDiagnostic(context, args) {
  const filename = context.physicalFilename || context.filename;
  const root = context.cwd ?? process.cwd();
  const filePath = path.relative(root, filename).split(path.sep).join("/");
  const options = context.options?.[0] ?? {};
  const policy = options.policy;
  const expectedRepo = options.expectedRepo ?? process.env.GITHUB_REPOSITORY;
  const diagnostics = validateDocument({
    path: filePath,
    text: context.sourceCode.text,
    expectedRepo,
    policy,
  });
  for (const item of diagnostics) {
    context.report({
      loc: { line: item.line ?? 1, column: item.column ?? 1 },
      message: `[${item.code}] ${item.message}`,
    });
  }
}

const frontmatterRule = {
  meta: {
    type: "problem",
    docs: { description: "Validate repository-owned Markdown frontmatter and path policy" },
    schema: [{
      type: "object",
      properties: {
        expectedRepo: { type: "string" },
        policy: { type: "object" },
      },
      additionalProperties: false,
    }],
    messages: {},
  },
  create(context) {
    return {
      root() {
        ruleDiagnostic(context);
      },
    };
  },
};

export const eslintPlugin = {
  meta: { name: "@0000/documentation-tools" },
  rules: { frontmatter: frontmatterRule },
};

export default eslintPlugin;

async function runWorktree(args, root, policy, expectedRepo) {
  const tracked = splitNul(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
  const entries = [];
  const errors = [];
  for (const filePath of tracked) {
    const absolute = path.join(root, filePath);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      continue;
    }
    errors.push(...validatePathPolicy(filePath, policy));
    errors.push(...inspectWorktreeAncestors(root, filePath));
    if (stat.isSymbolicLink()) {
      const extension = markdownOrMdxExtension.test(filePath);
      if (extension) errors.push(diagnostic("MARKDOWN_SYMLINK", filePath, "Markdown and MDX files may not be symlinks"));
      try {
        const resolved = resolveWorktreeSymlink(root, absolute);
        if (resolved.kind === "external") errors.push(diagnostic("SYMLINK_EXTERNAL", filePath, "tracked symlink resolves outside the repository"));
        else if (resolved.kind !== "internal") errors.push(diagnostic("SYMLINK_UNRESOLVED", filePath, "tracked symlink could not be resolved safely"));
      } catch {
        errors.push(diagnostic("SYMLINK_UNRESOLVED", filePath, "tracked symlink could not be resolved safely"));
      }
      continue;
    }
    entries.push({ mode: stat.isFile() ? "100644" : "040000", path: normalizeRelative(filePath), absolute });
  }
  errors.push(...checkPathSafety(entries, policy));
  const baseline = getBaselinePaths(root, policy);
  errors.push(...baseline.diagnostics);
  const effectivePolicy = policyWithBaseline(policy, baseline.paths);
  const documents = [];
  for (const entry of entries) {
    if (!markdownOrMdxExtension.test(entry.path)) continue;
    if (!markdownExtension.test(entry.path)) {
      errors.push(...validateDocument({ path: entry.path, text: "", expectedRepo, policy: effectivePolicy }));
      continue;
    }
    let contents;
    try {
      contents = fs.readFileSync(entry.absolute, "utf8");
    } catch (error) {
      errors.push(diagnostic("DOCUMENT_READ", entry.path, `unable to read worktree content: ${error.message}`));
      continue;
    }
    const documentErrors = validateDocument({ path: entry.path, text: contents, expectedRepo, policy: effectivePolicy });
    errors.push(...documentErrors);
    documents.push({ path: entry.path, text: contents });
  }
  if (args.lint) errors.push(...await lintResults(root, documents, expectedRepo, effectivePolicy));
  return errors;
}

function inspectWorktreeAncestors(root, filePath) {
  const errors = [];
  const parts = normalizeRelative(filePath).split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = parts.slice(0, index).join("/");
    const absolute = path.join(root, ancestor);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    try {
      const resolution = resolveWorktreeSymlink(root, absolute);
      if (resolution.kind === "external") {
        errors.push(diagnostic("SYMLINK_EXTERNAL", ancestor, "tracked path traverses a symlink that resolves outside the repository"));
      } else if (resolution.kind !== "internal") {
        errors.push(diagnostic("SYMLINK_UNRESOLVED", ancestor, "tracked path traverses a symlink that could not be resolved safely"));
      }
    } catch {
      errors.push(diagnostic("SYMLINK_UNRESOLVED", ancestor, "tracked path traverses a symlink that could not be resolved safely"));
    }
  }
  return errors;
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function lintResults(root, documents, expectedRepo, policy) {
  if (documents.length === 0) return [];
  const engine = new ESLint({
    cwd: root,
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
  const results = (await Promise.all(documents.map((document) => engine.lintText(document.text, {
    filePath: path.resolve(root, document.path),
  })))).flat();
  return results.flatMap((result) => result.messages.map((message) => diagnostic(
    message.ruleId === "documentation-tools/frontmatter" ? "ESLINT_FRONTMATTER" : "ESLINT",
    path.relative(root, result.filePath).split(path.sep).join("/"),
    message.message,
    message.line ?? 1,
    message.column ?? 1,
  )));
}

function loadPolicyForMode(args, root, entries, sourceName) {
  const policyPath = args.policy ?? ".docs-policy.json";
  if (sourceName === "worktree") return readPolicyFromWorktree(root, policyPath);
  return readPolicyFromBlob(root, entries, sourceName, policyPath);
}

function ensureRepoMatchesPolicy(policy, args) {
  const identity = resolveIdentity(args, policy);
  return { ...identity, diagnostics: [...identity.diagnostics, ...validateExpectedIdentity(policy, identity.repo, identity.source)] };
}

async function validateWorktreeMode(args, root) {
  const policyResult = readPolicyFromWorktree(root, args.policy ?? ".docs-policy.json");
  if (!policyResult.policy) return policyResult.diagnostics;
  const identity = ensureRepoMatchesPolicy(policyResult.policy, args);
  if (identity.diagnostics.length > 0) return identity.diagnostics;
  return [...policyResult.diagnostics, ...await runWorktree(args, root, policyResult.policy, identity.repo)];
}

async function validateIndexMode(args, root) {
  const { entries, diagnostics } = parseIndexEntries(root);
  if (diagnostics.length > 0) return diagnostics;
  const policyResult = loadPolicyForMode(args, root, entries, "Git index");
  if (!policyResult.policy) return policyResult.diagnostics;
  const identity = ensureRepoMatchesPolicy(policyResult.policy, args);
  if (identity.diagnostics.length > 0) return identity.diagnostics;
  return [...policyResult.diagnostics, ...validateSourceEntries({
    root,
    entries,
    policy: policyResult.policy,
    expectedRepo: identity.repo,
    sourceName: "Git index",
    readEntry: (entry) => readBlob(root, entry.oid),
  })];
}

async function validateCommitMode(args, root) {
  if (!args.commit) return [diagnostic("COMMIT_REQUIRED", ".", "--mode commit requires --commit SHA")];
  try {
    git(root, ["cat-file", "-e", `${args.commit}^{commit}`]);
  } catch {
    return [diagnostic("COMMIT_MISSING", ".", `commit ${args.commit} is unavailable`)];
  }
  const entries = parseTreeEntries(root, args.commit);
  const policyResult = loadPolicyForMode(args, root, entries, `commit ${args.commit}`);
  if (!policyResult.policy) return policyResult.diagnostics;
  const identity = ensureRepoMatchesPolicy(policyResult.policy, args);
  if (identity.diagnostics.length > 0) return identity.diagnostics;
  return [...policyResult.diagnostics, ...validateSourceEntries({
    root,
    entries,
    policy: policyResult.policy,
    expectedRepo: identity.repo,
    sourceName: `commit ${args.commit}`,
    readEntry: (entry) => readBlob(root, entry.oid),
  })];
}

function isZeroOid(value) {
  return typeof value === "string" && /^0+$/u.test(value);
}

function parsePrePushInput(input) {
  const updates = [];
  const errors = [];
  for (const [index, line] of input.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4) {
      errors.push(diagnostic("PRE_PUSH_INPUT", ".", `pre-push line ${index + 1} must contain four fields`));
      continue;
    }
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    updates.push({ localRef, localOid, remoteRef, remoteOid });
  }
  return { updates, diagnostics: errors };
}

function getCommitsAheadOf(root, head, baseRef) {
  const output = git(root, ["rev-list", "--reverse", "--topo-order", head, "--not", baseRef]);
  return splitNul(Buffer.from(output.toString("utf8").replaceAll("\n", "\0")));
}

function fetchBase(root, baseRef) {
  const match = /^([^/]+)\/(.+)$/u.exec(baseRef);
  if (!match) throw new Error(`publication base ${baseRef} must be remote/branch`);
  const [, remote, branch] = match;
  const refspec = `refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  execFileSync("git", ["fetch", "--quiet", "--no-tags", remote, refspec], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  git(root, ["cat-file", "-e", `${baseRef}^{commit}`]);
}

async function validatePublishedHeads(args, root, heads) {
  const worktreePolicy = readPolicyFromWorktree(root, args.policy ?? ".docs-policy.json");
  let baseRef = args.baseRef ?? worktreePolicy.policy?.publicationBase ?? "origin/main";
  if (heads.length === 0) return [];
  try {
    if (gitText(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
      return [diagnostic("SHALLOW_REPOSITORY", ".", "publication history validation requires a non-shallow checkout (fetch-depth 0)")];
    }
  } catch (error) {
    return [diagnostic("GIT_REPOSITORY", ".", `unable to inspect repository history: ${String(error.stderr ?? error.message).trim()}`)];
  }
  try {
    if (isZeroOid(baseRef)) {
      baseRef = worktreePolicy.policy?.namingBaseline;
      if (!baseRef) throw new Error("zero publication base requires the configured namingBaseline");
    }
    if (args.mode === "pre-push" && !args.noFetch && !args.baseRef) fetchBase(root, baseRef);
    else if (args.mode === "pre-push" && !args.noFetch && !shaPattern.test(baseRef)) fetchBase(root, baseRef);
    else git(root, ["cat-file", "-e", `${baseRef}^{commit}`]);
  } catch (error) {
    return [diagnostic("PUBLICATION_BASE_UNAVAILABLE", ".", `publication base ${baseRef ?? "<unset>"} is unavailable: ${String(error.stderr ?? error.message).trim()}`)];
  }

  const errors = [];
  const commits = new Set();
  for (const head of heads) {
    try {
      git(root, ["cat-file", "-e", `${head}^{commit}`]);
      for (const commit of getCommitsAheadOf(root, head, baseRef)) commits.add(commit);
    } catch (error) {
      errors.push(diagnostic("PUBLISHED_HEAD", ".", `unable to enumerate published history at ${head}: ${String(error.stderr ?? error.message).trim()}`));
    }
  }
  for (const commit of commits) errors.push(...await validateCommitMode({ ...args, mode: "commit", commit }, root));
  return errors;
}

async function validatePrePushMode(args, root) {
  const input = fs.readFileSync(0, "utf8");
  const { updates, diagnostics } = parsePrePushInput(input);
  if (diagnostics.length > 0) return diagnostics;
  const heads = updates.filter((update) => !isZeroOid(update.localOid)).map((update) => update.localOid);
  return validatePublishedHeads(args, root, heads);
}

async function validatePublishedMode(args, root) {
  if (!args.head) return [diagnostic("PUBLISHED_HEAD_REQUIRED", ".", "--mode published requires --head SHA")];
  return validatePublishedHeads(args, root, [args.head]);
}

function parseArgs(argv) {
  const args = { mode: "worktree", lint: false, noFetch: false, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--lint") args.lint = true;
    else if (arg === "--no-fetch") args.noFetch = true;
    else if (["--mode", "--root", "--policy", "--repo", "--commit", "--head", "--base-ref"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      const key = {
        "--mode": "mode",
        "--root": "root",
        "--policy": "policy",
        "--repo": "repo",
        "--commit": "commit",
        "--head": "head",
        "--base-ref": "baseRef",
      }[arg];
      args[key] = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

function findGitRoot(cwd) {
  try {
    return gitText(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return cwd;
  }
}

function printHelp() {
  console.log(`Usage: docs-check [options]

Options:
  --root PATH                 Target checkout (default: Git root of cwd)
  --policy PATH               Policy file relative to root (default: .docs-policy.json)
  --repo OWNER/REPO           Expected repository identity
  --mode worktree|index|commit|published|pre-push
  --commit SHA                Commit tree for --mode commit
  --base-ref REF_OR_COMMIT    Publication baseline (default: policy publicationBase)
  --head SHA                  Published head for --mode published
  --lint                      Run the exported ESLint rule on worktree Markdown
  --no-fetch                  Use the local base ref without fetching (tests/CI only)
`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const root = path.resolve(args.root ?? findGitRoot(process.cwd()));
  const modes = {
    worktree: validateWorktreeMode,
    index: validateIndexMode,
    commit: validateCommitMode,
    published: validatePublishedMode,
    "pre-push": validatePrePushMode,
  };
  if (!modes[args.mode]) throw new Error(`unknown mode ${args.mode}`);
  const errors = await modes[args.mode](args, root);
  if (errors.length > 0) {
    console.error(errors.map((item) => `- ${item.path}:${item.line ?? 1}:${item.column ?? 1} [${item.code}] ${item.message}`).join("\n"));
    return 1;
  }
  console.log(`documentation check passed (${args.mode})`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(scriptPath).href) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`documentation check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
