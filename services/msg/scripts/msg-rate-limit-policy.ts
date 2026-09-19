export const MSG_RATE_LIMIT_PERIOD_SECONDS = 60;

export const MSG_RATE_LIMIT_BINDING_NAMES = {
  creation: "MSG_RATE_LIMIT_CREATION",
  reads: "MSG_RATE_LIMIT_READS",
  posts: "MSG_RATE_LIMIT_POSTS",
  live: "MSG_RATE_LIMIT_LIVE",
} as const;

export type MsgRateLimitAction = keyof typeof MSG_RATE_LIMIT_BINDING_NAMES;

export interface MsgRateLimitPolicyAction {
  readonly limit: number;
  readonly namespace_id: string;
  readonly period?: typeof MSG_RATE_LIMIT_PERIOD_SECONDS;
}

export type MsgRateLimitPolicy = Readonly<Record<MsgRateLimitAction, MsgRateLimitPolicyAction>>;

export interface MsgWranglerRateLimitBinding {
  readonly name: string;
  readonly namespace_id: string;
  readonly simple: {
    readonly limit: number;
    readonly period: typeof MSG_RATE_LIMIT_PERIOD_SECONDS;
  };
}

export interface MsgMiniflareRateLimitBinding {
  readonly namespace_id: string;
  readonly simple: {
    readonly limit: number;
    readonly period: typeof MSG_RATE_LIMIT_PERIOD_SECONDS;
  };
}

export const DEFAULT_MSG_RATE_LIMIT_POLICY: MsgRateLimitPolicy = Object.freeze({
  creation: Object.freeze({ limit: 6, namespace_id: "2026080901" }),
  reads: Object.freeze({ limit: 60, namespace_id: "2026080902" }),
  posts: Object.freeze({ limit: 20, namespace_id: "2026080903" }),
  live: Object.freeze({ limit: 10, namespace_id: "2026080904" }),
});

const ACTIONS = Object.keys(MSG_RATE_LIMIT_BINDING_NAMES) as MsgRateLimitAction[];
const ACTION_KEYS = ["limit", "namespace_id", "period"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPolicy(message: string): never {
  throw new Error(`Invalid msg rate-limit policy: ${message}`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalidPolicy(`${path}.${key} is unknown.`);
  }
}

function parseAction(value: unknown, action: MsgRateLimitAction): MsgRateLimitPolicyAction {
  if (!isRecord(value)) invalidPolicy(`${action} must be an object.`);
  assertExactKeys(value, ACTION_KEYS, action);

  const limit = value.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
    invalidPolicy(`${action}.limit must be a finite positive integer.`);
  }
  const namespaceId = value.namespace_id;
  if (typeof namespaceId !== "string" || !/^[1-9][0-9]*$/u.test(namespaceId)) {
    invalidPolicy(`${action}.namespace_id must be a positive-integer string.`);
  }
  if (value.period !== undefined && value.period !== MSG_RATE_LIMIT_PERIOD_SECONDS) {
    invalidPolicy(`${action}.period must be ${MSG_RATE_LIMIT_PERIOD_SECONDS}.`);
  }

  return Object.freeze({
    limit,
    namespace_id: namespaceId,
    ...(value.period === undefined ? {} : { period: MSG_RATE_LIMIT_PERIOD_SECONDS }),
  });
}

/** Validates the complete deployment policy; partial overrides are rejected. */
export function validateMsgRateLimitPolicy(value: unknown): MsgRateLimitPolicy {
  if (!isRecord(value)) invalidPolicy("the root value must be an object.");
  assertExactKeys(value, ACTIONS, "policy");
  const policy = {} as Record<MsgRateLimitAction, MsgRateLimitPolicyAction>;
  const namespaceIds = new Set<string>();
  for (const action of ACTIONS) {
    if (!(action in value)) invalidPolicy(`${action} is required.`);
    const parsed = parseAction(value[action], action);
    if (namespaceIds.has(parsed.namespace_id)) invalidPolicy(`namespace IDs must be distinct; ${parsed.namespace_id} is repeated.`);
    namespaceIds.add(parsed.namespace_id);
    policy[action] = parsed;
  }
  return Object.freeze(policy) as MsgRateLimitPolicy;
}

export function parseMsgRateLimitPolicyJson(contents: string): MsgRateLimitPolicy {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    invalidPolicy("the policy file must contain valid JSON.");
  }
  return validateMsgRateLimitPolicy(value);
}

export function buildMsgWranglerRateLimits(policy: unknown = DEFAULT_MSG_RATE_LIMIT_POLICY): readonly MsgWranglerRateLimitBinding[] {
  const validated = validateMsgRateLimitPolicy(policy);
  return ACTIONS.map((action) => ({
    name: MSG_RATE_LIMIT_BINDING_NAMES[action],
    namespace_id: validated[action].namespace_id,
    simple: {
      limit: validated[action].limit,
      period: MSG_RATE_LIMIT_PERIOD_SECONDS,
    },
  }));
}

export function buildMsgMiniflareRateLimits(policy: unknown = DEFAULT_MSG_RATE_LIMIT_POLICY): Readonly<Record<string, MsgMiniflareRateLimitBinding>> {
  const validated = validateMsgRateLimitPolicy(policy);
  return Object.fromEntries(ACTIONS.map((action) => [
    MSG_RATE_LIMIT_BINDING_NAMES[action],
    {
      namespace_id: validated[action].namespace_id,
      simple: {
        limit: validated[action].limit,
        period: MSG_RATE_LIMIT_PERIOD_SECONDS,
      },
    },
  ]));
}
