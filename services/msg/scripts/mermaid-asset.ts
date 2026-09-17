import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedVersion = "11.17.2";
const packagePath = join(serviceRoot, "package.json");
const installedPackageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("mermaid"))));
const bundleSource = join(installedPackageRoot, "dist/mermaid.min.js");
const installedPackagePath = join(installedPackageRoot, "package.json");
const bundleTarget = join(serviceRoot, "worker/public/_msg/asset/mermaid-11.17.2.min.js");

export function buildMermaidAsset(): string {
  const servicePackage = readPackageJson(packagePath);
  const installedPackage = readPackageJson(installedPackagePath);
  const declaredVersion = packageDependencyVersion(servicePackage, "mermaid");
  const installedVersion = typeof installedPackage.version === "string" ? installedPackage.version : undefined;
  if (declaredVersion !== expectedVersion) {
    throw new Error(`The msg service must pin Mermaid ${expectedVersion}.`);
  }
  if (installedVersion !== expectedVersion) {
    throw new Error(`Expected Mermaid ${expectedVersion}, found ${installedVersion ?? "an unknown version"}.`);
  }
  mkdirSync(dirname(bundleTarget), { recursive: true });
  copyFileSync(bundleSource, bundleTarget);
  return bundleTarget;
}

function readPackageJson(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read a valid package manifest at ${path}.`);
  }
  if (!isRecord(value)) throw new Error(`The package manifest at ${path} must contain an object.`);
  return value;
}

function packageDependencyVersion(packageJson: Record<string, unknown>, name: string): string | undefined {
  const devDependencies = isRecord(packageJson.devDependencies) ? packageJson.devDependencies : undefined;
  const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : undefined;
  const version = devDependencies?.[name] ?? dependencies?.[name];
  return typeof version === "string" ? version : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.main) {
  try {
    buildMermaidAsset();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Mermaid asset generation failed."}\n`);
    process.exitCode = 1;
  }
}
