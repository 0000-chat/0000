import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function expect(condition, message) {
  if (!condition) errors.push(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(root, filePath)} is not valid JSON: ${error.message}`);
    return null;
  }
}

function isPinnedVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

const rootManifest = readJson(path.join(root, "package.json"));
const workspaceDirs = [];
const publicWorkspaceRoots = new Set(["apps", "services", "packages"]);

if (rootManifest) {
  expect(rootManifest.private === true, "root package.json must be private");
  expect(
    typeof rootManifest.packageManager === "string" &&
      /^[a-z][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(rootManifest.packageManager),
    "root package.json must pin a package manager to an exact semantic version"
  );
  expect(Array.isArray(rootManifest.workspaces), "root package.json must declare workspaces as an array");
  expect(
    rootManifest.workspaces?.includes("services/*") && rootManifest.workspaces?.includes("packages/*"),
    "root package.json must include services/* and packages/* workspaces"
  );
  expect(
    isPinnedVersion(rootManifest.devDependencies?.turbo),
    "root package.json must pin turbo to an exact semantic version"
  );
  for (const scriptName of ["check", "check:turbo", "check:turbo:dry"]) {
    expect(
      typeof rootManifest.scripts?.[scriptName] === "string" && rootManifest.scripts[scriptName].length > 0,
      `root package.json must expose ${scriptName}`
    );
  }

  if (Array.isArray(rootManifest.workspaces)) {
    for (const workspacePattern of rootManifest.workspaces) {
      expect(typeof workspacePattern === "string", `unsupported workspace pattern ${workspacePattern}`);
      if (typeof workspacePattern !== "string") continue;

      const normalizedPattern = workspacePattern.replaceAll("\\", "/");
      const segments = normalizedPattern.split("/");
      const workspaceRootName = segments[0];
      const workspaceName = segments[1];
      const isDirectGlob = segments.length === 2 && workspaceName === "*";
      const isExplicitWorkspace =
        segments.length === 2 &&
        workspaceName &&
        workspaceName !== "*" &&
        !workspaceName.includes("*") &&
        !workspaceName.includes("?");

      const isSupportedPattern =
        !normalizedPattern.startsWith("/") &&
        !normalizedPattern.includes(":") &&
        !segments.includes("..") &&
        publicWorkspaceRoots.has(workspaceRootName) &&
        (isDirectGlob || isExplicitWorkspace);
      expect(
        isSupportedPattern,
        `unsupported workspace pattern ${workspacePattern}; use apps/*, services/*, packages/*, or an explicit path below one of those roots`
      );
      if (!isSupportedPattern) continue;

      const workspacePath = path.join(root, isDirectGlob ? workspaceRootName : normalizedPattern);
      if (isDirectGlob) {
        expect(fs.existsSync(workspacePath), `workspace directory ${normalizedPattern.slice(0, -2)} is missing`);
        if (!fs.existsSync(workspacePath)) continue;

        for (const entry of fs.readdirSync(workspacePath, { withFileTypes: true })) {
          if (entry.isDirectory()) workspaceDirs.push(path.join(workspacePath, entry.name));
        }
        continue;
      }

      expect(fs.existsSync(workspacePath), `explicit workspace path ${normalizedPattern} is missing`);
      if (fs.existsSync(workspacePath)) workspaceDirs.push(workspacePath);
    }
  }
}

const manifests = [];
const names = new Map();
for (const workspaceDir of workspaceDirs) {
  const relativeDir = path.relative(root, workspaceDir);
  const manifestPath = path.join(workspaceDir, "package.json");
  expect(fs.existsSync(path.join(workspaceDir, ".gitkeep")), `${relativeDir}/.gitkeep must be retained`);
  expect(fs.existsSync(manifestPath), `${relativeDir}/package.json is missing`);
  if (!fs.existsSync(manifestPath)) continue;

  const manifest = readJson(manifestPath);
  if (!manifest) continue;
  manifests.push({ manifest, manifestPath, relativeDir });

  expect(typeof manifest.name === "string" && manifest.name.length > 0, `${relativeDir}/package.json must have a nonempty name`);
  if (typeof manifest.name === "string" && manifest.name.length > 0) {
    const previous = names.get(manifest.name);
    expect(!previous, `${relativeDir}/package.json duplicates workspace name ${manifest.name}`);
    names.set(manifest.name, relativeDir);
  }
  expect(manifest.private === true, `${relativeDir}/package.json must be private until it has a publication decision`);
  expect(typeof manifest.scripts?.check === "string" && manifest.scripts.check.length > 0, `${relativeDir}/package.json must expose check`);
}

const workspaceFlagIndex = process.argv.indexOf("--workspace");
const requestedWorkspace = workspaceFlagIndex === -1 ? undefined : process.argv[workspaceFlagIndex + 1];
if (requestedWorkspace) {
  expect(names.has(requestedWorkspace), `unknown workspace ${requestedWorkspace}`);
}

const lockfiles = ["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
expect(fs.existsSync(path.join(root, "bun.lock")), "bun.lock must be present");
for (const lockfile of lockfiles.filter((name) => name !== "bun.lock")) {
  expect(!fs.existsSync(path.join(root, lockfile)), `${lockfile} must not be present in a Bun workspace`);
}

const turboConfig = readJson(path.join(root, "turbo.json"));
if (turboConfig) {
  expect(typeof turboConfig.$schema === "string" && turboConfig.$schema.startsWith("https://"), "turbo.json must declare an HTTPS schema");
  expect(turboConfig.tasks?.check && typeof turboConfig.tasks.check === "object", "turbo.json must define the check task");
  for (const input of [
    "$TURBO_ROOT$/scripts/check-workspace.mjs",
    "$TURBO_ROOT$/package.json",
    "$TURBO_ROOT$/turbo.json",
    "$TURBO_ROOT$/bun.lock"
  ]) {
    expect(turboConfig.tasks?.check?.inputs?.includes(input), `turbo.json check inputs must include ${input}`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  const selected = requestedWorkspace ? 1 : manifests.length;
  console.log(`workspace scaffold check passed (${selected} workspace manifest${selected === 1 ? "" : "s"})`);
}
