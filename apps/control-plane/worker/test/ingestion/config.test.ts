import { describe, expect, it } from "vitest";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import configText from "../../../wrangler.jsonc?raw";
import resourceText from "../../../../../deploy/cloudflare/ingestion-resources.json?raw";

type QueueProducer = {
  binding: string;
  queue: string;
};

type QueueConsumer = {
  queue: string;
  max_batch_size: number;
  max_batch_timeout: number;
  max_retries: number;
  retry_delay: number;
  max_concurrency: number;
  dead_letter_queue: string;
};

type D1Binding = {
  binding: string;
  database_name: string;
  database_id: string;
  preview_database_id?: string;
  migrations_dir?: string;
};

type R2Binding = {
  binding: string;
  bucket_name: string;
};

type WranglerEnvironment = {
  name: string;
  vars: Record<string, string>;
  d1_databases: D1Binding[];
  r2_buckets: R2Binding[];
  durable_objects: {
    bindings: Array<{ name: string; class_name: string }>;
  };
  queues: {
    producers: QueueProducer[];
    consumers: QueueConsumer[];
  };
};

type WranglerConfig = WranglerEnvironment & {
  assets: {
    run_worker_first: string[];
  };
  env: Record<"staging" | "production", WranglerEnvironment>;
};

type HandoffEnvironment = {
  d1: { name: string; id: string };
  r2: { name: string };
  queue: { name: string; id: string; retention_seconds: number };
  dlq: { name: string; id: string; retention_seconds: number };
};

type ResourceHandoff = {
  schema_version: number;
  cloudflare_account_id: string;
  verified_at: string;
  environments: Record<"staging" | "production", HandoffEnvironment>;
};

function parseStrictJsonc<T>(text: string): T {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || value === undefined) {
    throw new Error("Invalid JSONC configuration fixture");
  }
  return value as T;
}

const config = parseStrictJsonc<WranglerConfig>(configText);
const resources = parseStrictJsonc<ResourceHandoff>(resourceText);

const expectedNames = {
  local: {
    worker: "communicator-control-plane",
    d1: "communicator-control-directory-local",
    r2: "communicator-event-archive-local",
    queue: "communicator-ingestion-local",
    dlq: "communicator-ingestion-dlq-local",
  },
  staging: {
    worker: "communicator-control-plane-staging",
    d1: "communicator-control-directory-staging",
    r2: "communicator-event-archive-staging",
    queue: "communicator-ingestion-staging",
    dlq: "communicator-ingestion-dlq-staging",
  },
  production: {
    worker: "communicator-control-plane-production",
    d1: "communicator-control-directory-production",
    r2: "communicator-event-archive-production",
    queue: "communicator-ingestion-production",
    dlq: "communicator-ingestion-dlq-production",
  },
} as const;

const requiredBindings = {
  d1: { binding: "CONTROL_DB", migrations_dir: "migrations" },
  r2: { binding: "EVENT_ARCHIVE" },
  durableObject: { name: "TENANT_PROJECTION", class_name: "TenantProjectionDO" },
  producer: { binding: "INGESTION_QUEUE" },
} as const;

const requiredVars = {
  ingress: "COMMUNICATOR_INGRESS_ENABLED",
  issuer: "COMMUNICATOR_INGESTION_OIDC_ISSUER",
  audience: "COMMUNICATOR_INGESTION_OIDC_AUDIENCE",
  jwks: "COMMUNICATOR_INGESTION_OIDC_JWKS_URL",
  publicAudience: "COMMUNICATOR_OIDC_AUDIENCE",
} as const;

const EXPECTED_WRANGLER_VAR_KEYS = [
  "COMMUNICATOR_ENV",
  "COMMUNICATOR_DATA_MODE",
  "COMMUNICATOR_OIDC_ISSUER",
  "COMMUNICATOR_OIDC_AUDIENCE",
  "COMMUNICATOR_OIDC_JWKS_URL",
  "COMMUNICATOR_ACCESS_ISSUER",
  "COMMUNICATOR_ACCESS_AUDIENCE",
  "COMMUNICATOR_ACCESS_JWKS_URL",
  "COMMUNICATOR_INGRESS_ENABLED",
  "COMMUNICATOR_INGESTION_OIDC_ISSUER",
  "COMMUNICATOR_INGESTION_OIDC_AUDIENCE",
  "COMMUNICATOR_INGESTION_OIDC_JWKS_URL",
] as const;

const CLOUDFLARE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const MAX_QUEUE_RETENTION_SECONDS = 1_209_600;
const LOCAL_D1_SENTINELS = new Set([
  "CONTROL_DB",
  "00000000-0000-0000-0000-000000000000",
  "00000000-0000-0000-0000-000000000001",
]);
const CREDENTIAL_KEY_PATTERN = /(?:secret|token|private[_-]?key|access[_-]?key|password|cookie|credential)/i;
const CREDENTIAL_VALUE_PATTERN = /(?:-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|\b(?:bearer|basic)\s+[^\s]+|\b(?:client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|credential)\s*[:=]|\b(?:eyJ[A-Za-z0-9_-]+\.){2})/i;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function assertEnvironmentBindings(
  environment: WranglerEnvironment,
  names: (typeof expectedNames)[keyof typeof expectedNames],
  databaseId?: string,
) {
  expect(environment.name).toBe(names.worker);
  expect(environment.d1_databases).toHaveLength(1);
  expect(environment.d1_databases[0]).toMatchObject({
    ...requiredBindings.d1,
    database_name: names.d1,
    ...(databaseId === undefined ? {} : { database_id: databaseId }),
  });
  expect(environment.r2_buckets).toEqual([
    { binding: requiredBindings.r2.binding, bucket_name: names.r2 },
  ]);
  expect(environment.durable_objects).toEqual({
    bindings: [requiredBindings.durableObject],
  });
  expect(environment.queues.producers).toEqual([
    { ...requiredBindings.producer, queue: names.queue },
  ]);
  expect(environment.queues.consumers).toEqual([
    {
      queue: names.queue,
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 10,
      retry_delay: 60,
      max_concurrency: 5,
      dead_letter_queue: names.dlq,
    },
  ]);
}

function assertQueueRetention(value: number) {
  expect(Number.isSafeInteger(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
  expect(value).toBeLessThanOrEqual(MAX_QUEUE_RETENTION_SECONDS);
  expect(value).toBe(MAX_QUEUE_RETENTION_SECONDS);
}

function assertNonLocalResourceIds(handoff: HandoffEnvironment) {
  expect(handoff.d1.id).toMatch(CLOUDFLARE_UUID_PATTERN);
  expect(LOCAL_D1_SENTINELS.has(handoff.d1.id)).toBe(false);
  expect(handoff.queue.id).toMatch(QUEUE_ID_PATTERN);
  expect(handoff.dlq.id).toMatch(QUEUE_ID_PATTERN);
  expect(handoff.queue.id).not.toBe("0".repeat(32));
  expect(handoff.dlq.id).not.toBe("0".repeat(32));
  expect(handoff.queue.id).not.toBe(handoff.dlq.id);
  assertQueueRetention(handoff.queue.retention_seconds);
  assertQueueRetention(handoff.dlq.retention_seconds);
}

function assertNoCredentialMaterial(vars: Record<string, string>) {
  for (const [key, value] of Object.entries(vars)) {
    expect(key).not.toMatch(CREDENTIAL_KEY_PATTERN);
    expect(value).not.toMatch(CREDENTIAL_VALUE_PATTERN);
  }
}

function assertSafeHandoffText(text: string) {
  expect(text).not.toMatch(CREDENTIAL_KEY_PATTERN);
  expect(text).not.toMatch(CREDENTIAL_VALUE_PATTERN);
}

function assertVerifiedAt(value: string) {
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (match === null) throw new Error("verified_at must be RFC3339 UTC");

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number((fractionText ?? "").slice(0, 3).padEnd(3, "0"));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== milliseconds
  ) {
    throw new Error("verified_at must be a valid RFC3339 UTC timestamp");
  }
}

function assertIngestionVars(vars: Record<string, string>) {
  expect(Object.keys(vars).sort()).toEqual([...EXPECTED_WRANGLER_VAR_KEYS].sort());
  expect(vars[requiredVars.ingress]).toBe("false");
  expect(vars[requiredVars.issuer]).toMatch(/^https:\/\//);
  expect(vars[requiredVars.audience]).toMatch(/\S/);
  expect(vars[requiredVars.jwks]).toMatch(/^https:\/\//);
  expect(vars[requiredVars.audience]).not.toBe(vars[requiredVars.publicAudience]);
  assertNoCredentialMaterial(vars);
}

describe("ingestion Wrangler configuration", () => {
  it("declares the exact local queue, DLQ, bindings, and retry policy", () => {
    assertEnvironmentBindings(config, expectedNames.local);
    expect(config.d1_databases[0]?.database_id).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(config.d1_databases[0]?.preview_database_id).toBe("CONTROL_DB");
    assertIngestionVars(config.vars);
  });

  it("repeats complete non-local bindings and exact resources for every deployable environment", () => {
    for (const environmentName of ["staging", "production"] as const) {
      const handoff = resources.environments[environmentName];
      const environment = config.env[environmentName];

      expect(handoff.d1.name).toBe(expectedNames[environmentName].d1);
      expect(handoff.r2.name).toBe(expectedNames[environmentName].r2);
      expect(handoff.queue.name).toBe(expectedNames[environmentName].queue);
      expect(handoff.dlq.name).toBe(expectedNames[environmentName].dlq);
      assertNonLocalResourceIds(handoff);

      assertEnvironmentBindings(environment, expectedNames[environmentName], handoff.d1.id);
      expect(environment.d1_databases[0]?.database_id).toBe(handoff.d1.id);
      expect(environment.d1_databases[0]?.preview_database_id).toBeUndefined();
      expect(environment.queues.consumers[0]?.dead_letter_queue).toBe(handoff.dlq.name);
      assertIngestionVars(environment.vars);
    }

    const nonLocalResourceIds = [
      resources.environments.staging.d1.id,
      resources.environments.production.d1.id,
      resources.environments.staging.queue.id,
      resources.environments.staging.dlq.id,
      resources.environments.production.queue.id,
      resources.environments.production.dlq.id,
    ];
    expect(new Set(nonLocalResourceIds).size).toBe(nonLocalResourceIds.length);
  });

  it("keeps environment resources isolated and routes internal paths to the Worker", () => {
    expect(config.assets.run_worker_first).toEqual(expect.arrayContaining(["/api/*", "/internal/*"]));

    const resourceNames = [
      config.d1_databases[0]?.database_name,
      config.r2_buckets[0]?.bucket_name,
      config.queues.producers[0]?.queue,
      config.queues.consumers[0]?.dead_letter_queue,
      ...Object.values(config.env).flatMap((environment) => [
        environment.d1_databases[0]?.database_name,
        environment.r2_buckets[0]?.bucket_name,
        environment.queues.producers[0]?.queue,
        environment.queues.consumers[0]?.dead_letter_queue,
      ]),
    ];
    expect(new Set(resourceNames).size).toBe(resourceNames.length);
  });

  it("records a complete non-secret Cloudflare resource handoff", () => {
    expect(resources.schema_version).toBe(1);
    expect(resources.cloudflare_account_id).toMatch(/^[0-9a-f]{32}$/i);
    assertVerifiedAt(resources.verified_at);
    expect(Object.keys(resources.environments).sort()).toEqual(["production", "staging"]);
    assertSafeHandoffText(resourceText);
  });

  it("rejects credential-looking variable names and values", () => {
    const credentialKeyVars = {
      ...config.vars,
      SERVICE_PRIVATE_KEY: "opaque-test-value",
    };
    expect(() => assertIngestionVars(credentialKeyVars)).toThrow();

    const credentialValueVars = {
      ...config.vars,
      COMMUNICATOR_INGESTION_OIDC_ISSUER: "client_secret=opaque-test-value",
    };
    expect(() => assertIngestionVars(credentialValueVars)).toThrow();

    const pkcs8ValueVars = {
      ...config.vars,
      COMMUNICATOR_INGESTION_OIDC_JWKS_URL: "-----BEGIN PRIVATE KEY-----opaque",
    };
    expect(() => assertIngestionVars(pkcs8ValueVars)).toThrow();

    expect(() => assertSafeHandoffText(`${resourceText}\n-----BEGIN PRIVATE KEY-----opaque`)).toThrow();
  });

  it("rejects local D1 sentinels, malformed IDs, duplicate queue IDs, and nonmaximum retention", () => {
    const invalidHandoff = structuredClone(resources.environments.staging);
    invalidHandoff.d1.id = "00000000-0000-0000-0000-000000000000";
    expect(() => assertNonLocalResourceIds(invalidHandoff)).toThrow();

    invalidHandoff.d1.id = "not-a-uuid";
    expect(() => assertNonLocalResourceIds(invalidHandoff)).toThrow();

    invalidHandoff.d1.id = resources.environments.staging.d1.id;
    invalidHandoff.queue.id = invalidHandoff.dlq.id;
    expect(() => assertNonLocalResourceIds(invalidHandoff)).toThrow();

    expect(() => assertQueueRetention(86_400)).toThrow();
  });

  it("uses a JSONC parser for Wrangler configuration", () => {
    expect(parseStrictJsonc<{ enabled: boolean }>('{"enabled": true, // accepted JSONC comment\n}'))
      .toEqual({ enabled: true });
    expect(() => parseStrictJsonc('{"enabled": true} trailing-garbage')).toThrow();
    expect(() => parseStrictJsonc('{"enabled":')).toThrow();
  });

  it("rejects invalid or non-UTC verified-at timestamps", () => {
    expect(() => assertVerifiedAt("2026-02-30T00:00:00.000Z")).toThrow();
    expect(() => assertVerifiedAt("2026-09-07T21:33:55+00:00")).toThrow();
    expect(() => assertVerifiedAt("not-a-timestamp")).toThrow();
  });
});
