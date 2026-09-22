import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const publicWorkspaceRoots = new Set(["apps", "services", "packages"]);
const ignoredDirectories = new Set([".git", "node_modules", ".turbo", "coverage", "dist"]);
const dependencyManifestNames = new Set([
  "Cargo.toml",
  "Gemfile",
  "go.mod",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "turbo.json",
]);
const lockfileNames = new Set([
  "bun.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);
const sourceExtensions = new Set([
  ".cjs",
  ".go",
  ".js",
  ".jsx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
]);
const sourceSpecifierPatterns = [
  /\b(?:import|export)\b[^\n;]*?\bfrom\s*["'`]/,
  /\bimport\s*["'`]/,
  /\b(?:import|require)\s*\(\s*["'`]/,
  /\brequire\s*\(\s*["'`]/,
  /\bimport\b[^\n;]*?["'`]/,
  /\b(?:source|\.)\s+["'`]/,
  /\b(?:use|extern\s+crate)\s+[A-Za-z0-9_:.@/-]+/,
];
const expectedDependencies = new Map([
  ["0000-platform", []],
  ["0000-gateway", ["0000-platform"]],
  ["0000-database", ["0000-platform"]],
  ["0000-streams", ["0000-platform", "0000-database"]],
  ["0000-brain", ["0000-platform"]],
  ["0000-communicator", ["0000-platform"]],
]);
const forbiddenReferences = [
  {
    label: "services/cloud",
    pattern: /(?:^|[^A-Za-z0-9_])services[\\/]cloud(?:$|[^A-Za-z0-9_])/,
  },
  {
    label: "@0000/cloud",
    pattern: /@0000[\\/]cloud(?:$|[^A-Za-z0-9_-])/,
  },
  {
    label: "@0000-cloud",
    pattern: /@0000-cloud(?:$|[^A-Za-z0-9_-])/,
  },
  {
    label: "0000-cloud",
    pattern: /(?:^|[^A-Za-z0-9_])0000-cloud(?:$|[^A-Za-z0-9_-])/,
  },
];

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/") || ".";
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readJson(filePath, errors, root) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath(root, filePath)} is not valid JSON: ${error.message}`);
    return null;
  }
}

function walk(root, current = root, files = [], symlinks = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const filePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks.push(filePath);
      continue;
    }
    if (entry.isDirectory()) {
      walk(root, filePath, files, symlinks);
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return { files, symlinks };
}

function shouldScanForPrivateReferences(root, filePath) {
  const relative = relativePath(root, filePath);
  if (relative === "scripts/check-topology.mjs" || relative === "scripts/check-topology-fixtures.mjs") {
    return false;
  }
  const basename = path.basename(filePath);
  const isWorkflow = relative.startsWith(".github/workflows/") || relative.includes("/.github/workflows/");
  const isManifest = dependencyManifestNames.has(basename);
  const isLockfile = lockfileNames.has(basename);
  const isSource = sourceExtensions.has(path.extname(filePath).toLowerCase());
  return { isWorkflow, isManifest, isLockfile, isSource };
}

function stripSourceComments(contents) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[\s;])\/\/.*$/gm, "$1")
    .replace(/(^|\s)#.*$/gm, "$1");
}

function containsPrivateSourceSpecifier(contents, forbidden) {
  const lines = stripSourceComments(contents).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const context = lines.slice(index, index + 3).join(" ");
    if (sourceSpecifierPatterns.some((pattern) => pattern.test(context)) && forbidden.pattern.test(context)) {
      return true;
    }
  }
  return false;
}

function checkWorkspaceDeclarations(root, errors) {
  const manifestPath = path.join(root, "package.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push("package.json is missing");
    return;
  }

  const manifest = readJson(manifestPath, errors, root);
  if (!manifest) return;
  if (!Array.isArray(manifest.workspaces)) {
    errors.push("package.json workspaces must be an array");
    return;
  }

  for (const workspacePattern of manifest.workspaces) {
    if (typeof workspacePattern !== "string") {
      errors.push(`workspace declaration ${JSON.stringify(workspacePattern)} is not a string`);
      continue;
    }

    const normalized = workspacePattern.replaceAll("\\", "/");
    const segments = normalized.split("/");
    const topLevel = segments[0];
    const child = segments[1];
    const directGlob = segments.length === 2 && child === "*";
    const explicitPath =
      segments.length === 2 &&
      Boolean(child) &&
      child !== "*" &&
      !child.includes("*") &&
      !child.includes("?");
    const supported =
      !normalized.startsWith("/") &&
      !normalized.includes(":") &&
      !segments.includes("..") &&
      publicWorkspaceRoots.has(topLevel) &&
      (directGlob || explicitPath);
    if (!supported) {
      errors.push(
        `workspace path ${workspacePattern} is outside apps/*, services/*, and packages/*`
      );
    }
  }
}

function checkEscapingSymlinks(root, symlinks, errors) {
  for (const symlink of symlinks) {
    const relative = relativePath(root, symlink);
    const linkTarget = fs.readlinkSync(symlink);
    const lexicalTarget = path.resolve(path.dirname(symlink), linkTarget);
    let resolvedTarget = lexicalTarget;
    try {
      resolvedTarget = fs.realpathSync(symlink);
    } catch {
      // A broken link still has a useful lexical target for boundary checking.
    }
    if (!isWithinRoot(root, resolvedTarget)) {
      errors.push(`${relative} resolves outside the repository to ${resolvedTarget}`);
    }
  }
}

function checkPrivateReferences(root, files, errors) {
  for (const filePath of files) {
    const scanKind = shouldScanForPrivateReferences(root, filePath);
    if (!scanKind || (!scanKind.isWorkflow && !scanKind.isManifest && !scanKind.isLockfile && !scanKind.isSource)) continue;
    let contents;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const forbidden of forbiddenReferences) {
      const matches =
        scanKind.isWorkflow || scanKind.isManifest || scanKind.isLockfile
          ? forbidden.pattern.test(contents)
          : containsPrivateSourceSpecifier(contents, forbidden);
      if (matches) {
        errors.push(`${relativePath(root, filePath)} contains forbidden private reference ${forbidden.label}`);
      }
    }
  }
}

function checkProductDependencies(root, files, errors) {
  for (const filePath of files) {
    if (path.basename(filePath) !== "0000-product.json") continue;
    const metadata = readJson(filePath, errors, root);
    if (!metadata || !expectedDependencies.has(metadata.name)) continue;
    const expected = expectedDependencies.get(metadata.name);
    if (JSON.stringify(metadata.dependencies) !== JSON.stringify(expected)) {
      errors.push(
        `${relativePath(root, filePath)} dependencies ${JSON.stringify(metadata.dependencies)} do not match ${JSON.stringify(expected)}`
      );
    }
  }
}

export function validateTopology(repositoryRoot = defaultRoot) {
  const root = path.resolve(repositoryRoot);
  const errors = [];
  checkWorkspaceDeclarations(root, errors);
  if (!fs.existsSync(root)) {
    errors.push(`repository root ${root} is missing`);
    return errors;
  }
  const { files, symlinks } = walk(root);
  checkEscapingSymlinks(root, symlinks, errors);
  checkPrivateReferences(root, files, errors);
  checkProductDependencies(root, files, errors);
  return errors;
}

function main() {
  const errors = validateTopology(process.argv[2] ?? defaultRoot);
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log("public topology check passed");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === scriptPath) main();
