import fs from "node:fs";
import path from "node:path";
import { globToRegExp, normalisePath, sha256 } from "./lib.mjs";

const IMPORT_SPECIFIER = /\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g;

function relativeModulePath(outputDirectory, currentPath, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const resolved = path.resolve(outputDirectory, path.dirname(currentPath), specifier);
  const relative = path.relative(outputDirectory, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`generated Worker module import escapes Wrangler output: ${specifier}`);
  }
  return normalisePath(relative.split(path.sep).join("/"));
}

function ruleType(relativePath, rules) {
  const rule = rules.find((candidate) => candidate.globs.some((glob) => globToRegExp(glob).test(relativePath)));
  if (!rule) {
    throw new Error(`generated Worker module has no matching Wrangler rule: ${relativePath}`);
  }
  return rule.type;
}

function emittedFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`generated Wrangler output contains a symlink: ${child}`);
    if (entry.isDirectory()) files.push(...emittedFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`generated Wrangler output contains a special file: ${child}`);
  }
  return files;
}

/**
 * Copy every relative module imported by a generated Wrangler entrypoint and
 * return the content-addressed module metadata embedded in the artifact.
 */
export function copyGeneratedModules({ outputDirectory, generatedEntrypoint, artifactRoot, rules = [] }) {
  const entrypoint = normalisePath(path.relative(outputDirectory, generatedEntrypoint).split(path.sep).join("/"));
  const pending = [entrypoint];
  const visited = new Set();
  const modules = new Map();

  while (pending.length > 0) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const currentPath = path.join(outputDirectory, current);
    const currentStat = fs.lstatSync(currentPath);
    if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
      throw new Error(`generated Wrangler output module is not a regular file: ${current}`);
    }
    const source = fs.readFileSync(currentPath);
    const text = source.toString("utf8");
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const relative = relativeModulePath(outputDirectory, current, match[1]);
      if (!relative || relative === entrypoint) continue;
      if (modules.has(relative)) {
        if (["ESModule", "CommonJS"].includes(modules.get(relative).type)) pending.push(relative);
        continue;
      }
      const modulePath = path.join(outputDirectory, relative);
      let moduleStat;
      try {
        moduleStat = fs.lstatSync(modulePath);
      } catch {
        throw new Error(`generated Worker module import is missing from Wrangler output: ${relative}`);
      }
      if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) {
        throw new Error(`generated Worker module import is not a regular file: ${relative}`);
      }
      const bytes = fs.readFileSync(modulePath);
      const destination = path.join(artifactRoot, relative);
      if (fs.existsSync(destination)) {
        const existing = fs.readFileSync(destination);
        if (!existing.equals(bytes)) {
          throw new Error(`generated Worker module collides with an artifact path: ${relative}`);
        }
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes);
      }
      const type = ruleType(relative, rules);
      modules.set(relative, {
        name: relative,
        type,
        digest: `sha256:${sha256(bytes)}`
      });
      if (["ESModule", "CommonJS"].includes(type)) pending.push(relative);
    }
  }

  const supported = new Set([entrypoint, ...modules.keys()]);
  for (const emitted of emittedFiles(outputDirectory)) {
    if (supported.has(emitted) || emitted === "README.md" || emitted.endsWith(".map")) continue;
    throw new Error(`generated Wrangler output contains an unsupported file: ${emitted}`);
  }

  return [...modules.values()].sort((left, right) => left.name.localeCompare(right.name));
}
