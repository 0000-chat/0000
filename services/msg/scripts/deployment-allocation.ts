import { readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

type DeploymentTraffic = {
  version_id: string;
  percentage: number;
};

const versionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDeploymentTraffic(status: unknown): DeploymentTraffic[] {
  if (!isJsonObject(status) || !Array.isArray(status.versions) || status.versions.length === 0) {
    throw new Error("The current msg Worker deployment has no traffic allocation.");
  }

  return status.versions.map((entry) => {
    if (!isJsonObject(entry) || typeof entry.version_id !== "string" ||
      typeof entry.percentage !== "number" || !Number.isFinite(entry.percentage)) {
      throw new Error("The current msg Worker deployment has an invalid traffic allocation.");
    }
    return { version_id: entry.version_id, percentage: entry.percentage };
  });
}

export function buildDeploymentVersionSpecs(status: unknown): string[] {
  const traffic = readDeploymentTraffic(status);
  const seenVersionIds = new Set<string>();
  let total = 0;

  for (const { version_id: versionId, percentage } of traffic) {
    if (!versionIdPattern.test(versionId)) {
      throw new Error(`The deployment version ${versionId} must be a valid UUID.`);
    }
    if (seenVersionIds.has(versionId)) {
      throw new Error(`The deployment version ${versionId} occurs more than once.`);
    }
    if (percentage < 0 || percentage > 100) {
      throw new Error(`The deployment percentage ${percentage} is outside 0-100%.`);
    }
    seenVersionIds.add(versionId);
    total += percentage;
  }

  if (Math.abs(total - 100) > 0.000001) {
    throw new Error(`The deployment traffic allocation must total 100%, got ${total}%.`);
  }

  return traffic.map(({ version_id: versionId, percentage }) => `${versionId}@${percentage}%`);
}

function main(args: readonly string[]): void {
  const [statusPath] = args;
  if (!statusPath || args.length !== 1) {
    throw new Error("Usage: bun run deployment-allocation -- <deployment-status.json>");
  }
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as unknown;
  process.stdout.write(`${JSON.stringify(buildDeploymentVersionSpecs(status))}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "msg deployment allocation failed."}\n`);
    process.exitCode = 1;
  }
}
