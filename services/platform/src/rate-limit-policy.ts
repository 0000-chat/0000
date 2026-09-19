export const PLATFORM_RATE_LIMIT_PERIOD_SECONDS = 60;

export const PLATFORM_RATE_LIMIT_BINDING_NAMES = {
  login: "PLATFORM_RATE_LIMIT_LOGIN",
  issuance: "PLATFORM_RATE_LIMIT_ISSUANCE",
  management: "PLATFORM_RATE_LIMIT_MANAGEMENT",
  verification: "PLATFORM_RATE_LIMIT_VERIFICATION",
  guestControl: "PLATFORM_RATE_LIMIT_GUEST_CONTROL",
} as const;

export type PlatformRateLimitGroup =
  keyof typeof PLATFORM_RATE_LIMIT_BINDING_NAMES;

export interface PlatformRateLimitPolicyAction {
  readonly limit: number;
  readonly namespace_id: string;
  readonly period?: typeof PLATFORM_RATE_LIMIT_PERIOD_SECONDS;
}

export type PlatformRateLimitPolicy = Readonly<
  Record<PlatformRateLimitGroup, PlatformRateLimitPolicyAction>
>;

export interface PlatformWranglerRateLimitBinding {
  readonly name: string;
  readonly namespace_id: string;
  readonly simple: {
    readonly limit: number;
    readonly period: typeof PLATFORM_RATE_LIMIT_PERIOD_SECONDS;
  };
}

export interface PlatformMiniflareRateLimitBinding {
  readonly namespace_id: string;
  readonly simple: {
    readonly limit: number;
    readonly period: typeof PLATFORM_RATE_LIMIT_PERIOD_SECONDS;
  };
}

export const DEFAULT_PLATFORM_RATE_LIMIT_POLICY: PlatformRateLimitPolicy =
  Object.freeze({
    login: Object.freeze({ limit: 30, namespace_id: "2026092001" }),
    issuance: Object.freeze({ limit: 60, namespace_id: "2026092002" }),
    management: Object.freeze({ limit: 60, namespace_id: "2026092003" }),
    verification: Object.freeze({ limit: 600, namespace_id: "2026092004" }),
    guestControl: Object.freeze({ limit: 120, namespace_id: "2026092005" }),
  });

export const PLATFORM_TEST_RATE_LIMIT_BUDGET = 10_000;

const PLATFORM_RATE_LIMIT_GROUPS = Object.keys(
  PLATFORM_RATE_LIMIT_BINDING_NAMES,
) as PlatformRateLimitGroup[];
const PLATFORM_RATE_LIMIT_ACTION_KEYS = [
  "limit",
  "namespace_id",
  "period",
] as const;

/** Build the explicit generous policy used by long-running local fixtures. */
export function buildPlatformTestRateLimitPolicy(
  limit = PLATFORM_TEST_RATE_LIMIT_BUDGET,
): PlatformRateLimitPolicy {
  return validatePlatformRateLimitPolicy(
    Object.fromEntries(
      Object.entries(DEFAULT_PLATFORM_RATE_LIMIT_POLICY).map(
        ([group, action]) => [group, { ...action, limit }],
      ),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPolicy(message: string): never {
  throw new Error(`Invalid Platform rate-limit policy: ${message}`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalidPolicy(`${path}.${key} is unknown.`);
  }
}

function parseAction(
  value: unknown,
  group: PlatformRateLimitGroup,
): PlatformRateLimitPolicyAction {
  if (!isRecord(value)) invalidPolicy(`${group} must be an object.`);
  assertExactKeys(value, PLATFORM_RATE_LIMIT_ACTION_KEYS, group);

  const limit = value.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
    invalidPolicy(`${group}.limit must be a positive safe integer.`);
  }
  const namespaceId = value.namespace_id;
  if (typeof namespaceId !== "string" || !/^[1-9][0-9]*$/u.test(namespaceId)) {
    invalidPolicy(`${group}.namespace_id must be a positive-integer string.`);
  }
  if (
    value.period !== undefined &&
    value.period !== PLATFORM_RATE_LIMIT_PERIOD_SECONDS
  ) {
    invalidPolicy(
      `${group}.period must be ${PLATFORM_RATE_LIMIT_PERIOD_SECONDS}.`,
    );
  }

  return Object.freeze({
    limit,
    namespace_id: namespaceId,
    ...(value.period === undefined
      ? {}
      : { period: PLATFORM_RATE_LIMIT_PERIOD_SECONDS }),
  });
}

/** Validate the complete deployment policy; partial overrides are rejected. */
export function validatePlatformRateLimitPolicy(
  value: unknown,
): PlatformRateLimitPolicy {
  if (!isRecord(value)) invalidPolicy("the root value must be an object.");
  assertExactKeys(value, PLATFORM_RATE_LIMIT_GROUPS, "policy");

  const policy = {} as Record<
    PlatformRateLimitGroup,
    PlatformRateLimitPolicyAction
  >;
  const namespaceIds = new Set<string>();
  for (const group of PLATFORM_RATE_LIMIT_GROUPS) {
    if (!(group in value)) invalidPolicy(`${group} is required.`);
    const parsed = parseAction(value[group], group);
    if (namespaceIds.has(parsed.namespace_id)) {
      invalidPolicy(
        `namespace IDs must be distinct; ${parsed.namespace_id} is repeated.`,
      );
    }
    namespaceIds.add(parsed.namespace_id);
    policy[group] = parsed;
  }
  return Object.freeze(policy) as PlatformRateLimitPolicy;
}

export function parsePlatformRateLimitPolicyJson(
  contents: string,
): PlatformRateLimitPolicy {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    invalidPolicy("the policy value must contain valid JSON.");
  }
  return validatePlatformRateLimitPolicy(value);
}

/** Resolve the optional deployment value; no value means the reviewed defaults. */
export function resolvePlatformRateLimitPolicy(
  value: unknown,
): PlatformRateLimitPolicy {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_PLATFORM_RATE_LIMIT_POLICY;
  }
  if (typeof value === "string") return parsePlatformRateLimitPolicyJson(value);
  return validatePlatformRateLimitPolicy(value);
}

export function buildPlatformWranglerRateLimits(
  policy: unknown = DEFAULT_PLATFORM_RATE_LIMIT_POLICY,
): readonly PlatformWranglerRateLimitBinding[] {
  const validated = resolvePlatformRateLimitPolicy(policy);
  return PLATFORM_RATE_LIMIT_GROUPS.map((group) => ({
    name: PLATFORM_RATE_LIMIT_BINDING_NAMES[group],
    namespace_id: validated[group].namespace_id,
    simple: {
      limit: validated[group].limit,
      period: PLATFORM_RATE_LIMIT_PERIOD_SECONDS,
    },
  }));
}

export function buildPlatformMiniflareRateLimits(
  policy: unknown = DEFAULT_PLATFORM_RATE_LIMIT_POLICY,
): Readonly<Record<string, PlatformMiniflareRateLimitBinding>> {
  const validated = resolvePlatformRateLimitPolicy(policy);
  return Object.fromEntries(
    PLATFORM_RATE_LIMIT_GROUPS.map((group) => [
      PLATFORM_RATE_LIMIT_BINDING_NAMES[group],
      {
        namespace_id: validated[group].namespace_id,
        simple: {
          limit: validated[group].limit,
          period: PLATFORM_RATE_LIMIT_PERIOD_SECONDS,
        },
      },
    ]),
  );
}
