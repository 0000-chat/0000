export type CapacityPolicyBindings = {
  CAPACITY_POLICY_REVISION?: string;
  CAPACITY_MAX_DATABASES?: string;
  CAPACITY_MAX_LOGICAL_BYTES?: string;
  CAPACITY_MAX_REPLAY_BYTES?: string;
  CAPACITY_MAX_PHYSICAL_BYTES?: string;
  CAPACITY_MAX_PHYSICAL_BYTES_PER_DATABASE?: string;
  CAPACITY_MAX_DAILY_REQUESTS?: string;
  CAPACITY_MAX_REQUESTS_PER_MINUTE?: string;
  CAPACITY_MAX_DAILY_MUTATIONS?: string;
  CAPACITY_MAX_EXPORT_BYTES?: string;
  CAPACITY_MAX_CONTROL_BYTES?: string;
  SERVICE_SUSPENDED?: string;
};

export type CapacityPolicy = {
  revision: number;
  maxDatabases: number;
  maxLogicalBytes: number;
  maxReplayBytes: number;
  maxPhysicalBytes: number;
  maxPhysicalBytesPerDatabase: number;
  maxDailyRequests: number;
  maxRequestsPerMinute: number;
  maxDailyMutations: number;
  maxExportBytes: number;
  maxControlBytes: number;
  serviceSuspended: boolean;
};

export class CapacityPolicyError extends Error {
  constructor() {
    super("The service capacity policy is missing or invalid");
    this.name = "CapacityPolicyError";
  }
}

const MAX_DATABASES = 100_000;
const MAX_DAILY_REQUESTS = 1_000_000_000;
const MAX_REQUESTS_PER_MINUTE = 10_000_000;
const MAX_DAILY_MUTATIONS = 100_000_000;
const MAX_PHYSICAL_BYTES_PER_DATABASE = 10_000_000_000;

function positiveInteger(
  bindings: CapacityPolicyBindings,
  key: keyof CapacityPolicyBindings,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = bindings[key];
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new CapacityPolicyError();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new CapacityPolicyError();
  }
  return parsed;
}

export function parseCapacityPolicy(
  bindings: CapacityPolicyBindings,
): CapacityPolicy {
  const suspended = bindings.SERVICE_SUSPENDED;
  if (suspended !== "true" && suspended !== "false") {
    throw new CapacityPolicyError();
  }

  const policy: CapacityPolicy = {
    revision: positiveInteger(bindings, "CAPACITY_POLICY_REVISION"),
    maxDatabases: positiveInteger(
      bindings,
      "CAPACITY_MAX_DATABASES",
      MAX_DATABASES,
    ),
    maxLogicalBytes: positiveInteger(bindings, "CAPACITY_MAX_LOGICAL_BYTES"),
    maxReplayBytes: positiveInteger(bindings, "CAPACITY_MAX_REPLAY_BYTES"),
    maxPhysicalBytes: positiveInteger(bindings, "CAPACITY_MAX_PHYSICAL_BYTES"),
    maxPhysicalBytesPerDatabase: positiveInteger(
      bindings,
      "CAPACITY_MAX_PHYSICAL_BYTES_PER_DATABASE",
      MAX_PHYSICAL_BYTES_PER_DATABASE,
    ),
    maxDailyRequests: positiveInteger(
      bindings,
      "CAPACITY_MAX_DAILY_REQUESTS",
      MAX_DAILY_REQUESTS,
    ),
    maxRequestsPerMinute: positiveInteger(
      bindings,
      "CAPACITY_MAX_REQUESTS_PER_MINUTE",
      MAX_REQUESTS_PER_MINUTE,
    ),
    maxDailyMutations: positiveInteger(
      bindings,
      "CAPACITY_MAX_DAILY_MUTATIONS",
      MAX_DAILY_MUTATIONS,
    ),
    maxExportBytes: positiveInteger(bindings, "CAPACITY_MAX_EXPORT_BYTES"),
    maxControlBytes: positiveInteger(bindings, "CAPACITY_MAX_CONTROL_BYTES"),
    serviceSuspended: suspended === "true",
  };

  if (policy.maxPhysicalBytesPerDatabase > policy.maxPhysicalBytes) {
    throw new CapacityPolicyError();
  }

  return policy;
}

export function capacityPolicyFingerprint(policy: CapacityPolicy): string {
  return JSON.stringify({
    maxDatabases: policy.maxDatabases,
    maxLogicalBytes: policy.maxLogicalBytes,
    maxReplayBytes: policy.maxReplayBytes,
    maxPhysicalBytes: policy.maxPhysicalBytes,
    maxPhysicalBytesPerDatabase: policy.maxPhysicalBytesPerDatabase,
    maxDailyRequests: policy.maxDailyRequests,
    maxRequestsPerMinute: policy.maxRequestsPerMinute,
    maxDailyMutations: policy.maxDailyMutations,
    maxExportBytes: policy.maxExportBytes,
    maxControlBytes: policy.maxControlBytes,
    serviceSuspended: policy.serviceSuspended,
  });
}
