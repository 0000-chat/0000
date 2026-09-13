import {
  createExecutionContext,
  createMessageBatch,
  env as runtimeEnv,
  getQueueResult,
} from "cloudflare:test";
import type {
  CommittedArchivePointer,
  IngestionBatchRequest,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import { encodeCanonicalEventBatch } from "../../archive/codec";
import { recomputeBatchId } from "../../ingestion/prepare";
import { createApp } from "../../app";
import worker from "../../index";
import type { IngestionQueueSender } from "../../ingestion/route";
import { clearDirectory } from "../support/directory-fixtures";
import { expect } from "vitest";

export const env = runtimeEnv as Cloudflare.Env & {
  CONTROL_DB: D1Database;
  EVENT_ARCHIVE: R2Bucket;
};

export const INGESTION_QUEUE_NAME = "communicator-ingestion-local";
export const TEST_ISSUER = "https://ingestion-e2e.example/";
export const TEST_TIMESTAMP = "2026-09-08T00:00:00.000Z";

export type IngestionFixture = {
  suffix: string;
  tenantId: string;
  otherTenantId: string;
  servicePrincipalId: string;
  issuer: string;
  subject: string;
  tokenId: string;
  routes: {
    human: string;
    agent: string;
    telegram: string;
    otherTenant: string;
  };
  identities: {
    human: string;
    agent: string;
    otherTenantHuman: string;
  };
  connections: {
    humanWhatsapp: string;
    agentWhatsapp: string;
    humanTelegram: string;
    otherTenantWhatsapp: string;
  };
  accounts: {
    humanWhatsapp: string;
    agentWhatsapp: string;
    humanTelegram: string;
    otherTenantWhatsapp: string;
  };
};

export type CapturedQueueMessage = {
  body: CommittedArchivePointer;
  options: { contentType: "json" };
};

export type CapturingQueue = {
  messages: CapturedQueueMessage[];
  send: IngestionQueueSender;
};

export type ArchiveObjectSnapshot = {
  key: string;
  bytes: Uint8Array;
  size: number;
  etag: string;
  httpMetadata: R2HTTPMetadata | undefined;
  customMetadata: Record<string, string> | undefined;
};

export type ArchivePairSnapshot = {
  data: ArchiveObjectSnapshot;
  manifest: ArchiveObjectSnapshot;
};

let fixtureSequence = 0;

const safeSuffix = (label: string): string => {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${normalized || "run"}_${++fixtureSequence}`;
};

/** Seed only the D1 rows needed by the real authenticated ingress path. */
export async function seedIngestionFixture(
  label = "e2e",
): Promise<IngestionFixture> {
  const suffix = safeSuffix(label);
  const fixture: IngestionFixture = {
    suffix,
    tenantId: `tenant_${suffix}`,
    otherTenantId: `tenant_other_${suffix}`,
    servicePrincipalId: `principal_ingestion_${suffix}`,
    issuer: TEST_ISSUER,
    subject: `service_${suffix}`,
    tokenId: `token_${suffix}`,
    routes: {
      human: `gateway_route_human_${suffix}`,
      agent: `gateway_route_agent_${suffix}`,
      telegram: `gateway_route_telegram_${suffix}`,
      otherTenant: `gateway_route_other_${suffix}`,
    },
    identities: {
      human: `identity_human_${suffix}`,
      agent: `identity_agent_${suffix}`,
      otherTenantHuman: `identity_other_${suffix}`,
    },
    connections: {
      humanWhatsapp: `connection_human_whatsapp_${suffix}`,
      agentWhatsapp: `connection_agent_whatsapp_${suffix}`,
      humanTelegram: `connection_human_telegram_${suffix}`,
      otherTenantWhatsapp: `connection_other_whatsapp_${suffix}`,
    },
    accounts: {
      humanWhatsapp: `account_human_whatsapp_${suffix}`,
      agentWhatsapp: `account_agent_whatsapp_${suffix}`,
      humanTelegram: `account_human_telegram_${suffix}`,
      otherTenantWhatsapp: `account_other_whatsapp_${suffix}`,
    },
  };

  await clearDirectory(env.CONTROL_DB);
  const timestamp = TEST_TIMESTAMP;
  const db = env.CONTROL_DB;
  await db.batch([
    db
      .prepare(
        "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.tenantId,
        `ingestion-${suffix}`,
        "Ingestion tenant",
        "active",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.otherTenantId,
        `ingestion-other-${suffix}`,
        "Other ingestion tenant",
        "active",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.servicePrincipalId,
        fixture.issuer,
        fixture.subject,
        "service",
        "Ingestion service",
        "active",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, 'active', ?, ?)",
      )
      .bind(
        `principal_reader_${suffix}`,
        fixture.issuer,
        `reader_${suffix}`,
        "Reader",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
      )
      .bind(
        `membership_reader_${suffix}`,
        fixture.tenantId,
        `principal_reader_${suffix}`,
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.identities.human,
        fixture.tenantId,
        "human",
        "Human inbox",
        "active",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.identities.agent,
        fixture.tenantId,
        "agent",
        "Agent inbox",
        "active",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.identities.otherTenantHuman,
        fixture.otherTenantId,
        "human",
        "Other inbox",
        "active",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, 'conversation.read', ?)",
      )
      .bind(
        fixture.tenantId,
        `membership_reader_${suffix}`,
        fixture.identities.human,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.connections.humanWhatsapp,
        fixture.tenantId,
        fixture.identities.human,
        "whatsapp",
        "Human WhatsApp",
        "ready",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.connections.agentWhatsapp,
        fixture.tenantId,
        fixture.identities.agent,
        "whatsapp",
        "Agent WhatsApp",
        "ready",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.connections.humanTelegram,
        fixture.tenantId,
        fixture.identities.human,
        "telegram",
        "Human Telegram",
        "ready",
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        fixture.connections.otherTenantWhatsapp,
        fixture.otherTenantId,
        fixture.identities.otherTenantHuman,
        "whatsapp",
        "Other WhatsApp",
        "ready",
        timestamp,
        timestamp,
      ),
    ...[
      [fixture.routes.human, fixture.servicePrincipalId],
      [fixture.routes.agent, fixture.servicePrincipalId],
      [fixture.routes.telegram, fixture.servicePrincipalId],
      [fixture.routes.otherTenant, fixture.servicePrincipalId],
    ].map(([routeId, principalId]) =>
      db
        .prepare(
          "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(routeId, principalId, "active", timestamp, timestamp, null),
    ),
    ...[
      [fixture.connections.humanWhatsapp, fixture.routes.human],
      [fixture.connections.agentWhatsapp, fixture.routes.agent],
      [fixture.connections.humanTelegram, fixture.routes.telegram],
      [fixture.connections.otherTenantWhatsapp, fixture.routes.otherTenant],
    ].map(([connectionId, routeId]) =>
      db
        .prepare(
          "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          connectionId,
          routeId,
          `bridge_${suffix}`,
          `@route_${suffix}:example`,
          `!room_${suffix}:example`,
          timestamp,
          timestamp,
        ),
    ),
    ...[
      [fixture.accounts.humanWhatsapp, fixture.connections.humanWhatsapp],
      [fixture.accounts.agentWhatsapp, fixture.connections.agentWhatsapp],
      [fixture.accounts.humanTelegram, fixture.connections.humanTelegram],
      [
        fixture.accounts.otherTenantWhatsapp,
        fixture.connections.otherTenantWhatsapp,
      ],
    ].map(([accountId, connectionId]) =>
      db
        .prepare(
          "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at, retired_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(accountId, connectionId, "active", timestamp, timestamp, null),
    ),
  ]);

  return fixture;
}

export async function cleanupIngestionFixture(
  fixture: IngestionFixture,
): Promise<void> {
  for (const tenantId of [fixture.tenantId, fixture.otherTenantId]) {
    for (const prefix of [`events/${tenantId}/`, `manifests/${tenantId}/`]) {
      let cursor: string | undefined;
      do {
        const page = await env.EVENT_ARCHIVE.list({
          prefix,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (page.objects.length > 0) {
          await env.EVENT_ARCHIVE.delete(
            page.objects.map((object) => object.key),
          );
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    }
  }
}

export function createCapturingQueue(): CapturingQueue {
  const messages: CapturedQueueMessage[] = [];
  return {
    messages,
    send: async (pointer, options) => {
      messages.push({ body: structuredClone(pointer), options });
    },
  };
}

export function requestEnvironment(
  overrides: Record<string, unknown> = {},
): Cloudflare.Env {
  const value = Object.create(env) as Record<string, unknown>;
  Object.defineProperty(value, "COMMUNICATOR_INGRESS_ENABLED", {
    enumerable: true,
    value: "true",
  });
  for (const [key, override] of Object.entries(overrides)) {
    Object.defineProperty(value, key, { enumerable: true, value: override });
  }
  return value as unknown as Cloudflare.Env;
}

export function createIngestionApp(
  fixture: IngestionFixture,
  queue: CapturingQueue,
) {
  return createApp({
    createIngestionTokenVerifier: () => ({
      verify: async () => ({
        issuer: fixture.issuer,
        subject: fixture.subject,
        token_id: fixture.tokenId,
      }),
    }),
    sendIngestionQueue: queue.send,
  });
}

export async function postIngestionBatch(
  fixture: IngestionFixture,
  request: IngestionBatchRequest,
  queue = createCapturingQueue(),
  environmentOverrides: Record<string, unknown> = {},
): Promise<{ response: Response; queue: CapturingQueue }> {
  const response = await createIngestionApp(fixture, queue).request(
    "https://example.test/internal/v1/ingestion/batches",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer e2e-test-token",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(request),
    },
    requestEnvironment(environmentOverrides),
  );
  return { response, queue };
}

export async function snapshotArchiveObject(
  key: string,
): Promise<ArchiveObjectSnapshot> {
  const object = await env.EVENT_ARCHIVE.get(key);
  if (object === null) throw new Error(`archive object missing: ${key}`);
  return {
    key: object.key,
    bytes: new Uint8Array(await object.arrayBuffer()),
    size: object.size,
    etag: object.etag,
    httpMetadata:
      object.httpMetadata === undefined
        ? undefined
        : { ...object.httpMetadata },
    customMetadata:
      object.customMetadata === undefined
        ? undefined
        : { ...object.customMetadata },
  };
}

export async function snapshotArchivePair(
  pointer: Pick<CommittedArchivePointer, "manifest_key">,
  dataKey?: string,
): Promise<ArchivePairSnapshot> {
  const manifest = await snapshotArchiveObject(pointer.manifest_key);
  const manifestValue =
    dataKey === undefined
      ? (JSON.parse(new TextDecoder().decode(manifest.bytes)) as {
          data_key?: unknown;
        })
      : undefined;
  const resolvedDataKey = dataKey ?? manifestValue?.data_key;
  if (typeof resolvedDataKey !== "string") {
    throw new Error("archive manifest data key missing in test fixture");
  }
  return {
    manifest,
    data: await snapshotArchiveObject(resolvedDataKey),
  };
}

export async function expectArchivePairUnchanged(
  pointer: Pick<CommittedArchivePointer, "manifest_key">,
  before: ArchivePairSnapshot,
  dataKey?: string,
): Promise<void> {
  await expect(snapshotArchivePair(pointer, dataKey)).resolves.toEqual(before);
}

export const messageEvent = (
  fixture: IngestionFixture,
  options: {
    eventId: string;
    identityId?: string;
    accountId?: string;
    connectionId?: string;
    platform?: "whatsapp" | "telegram";
    conversationId?: string;
    messageId?: string;
    body?: string;
    tenantId?: string;
    observedAt?: string;
    occurredAt?: string;
    remoteMessageId?: string | null;
    matrixRoomId?: string | null;
    matrixEventId?: string | null;
  },
): ProjectionEventEnvelope => ({
  schema_version: 1,
  event_id: options.eventId,
  event_type: "message.created",
  event_source: "live",
  tenant_id: options.tenantId ?? fixture.tenantId,
  identity_id: options.identityId ?? fixture.identities.human,
  platform: options.platform ?? "whatsapp",
  account_id: options.accountId ?? fixture.accounts.humanWhatsapp,
  conversation_id: options.conversationId ?? `conversation_${fixture.suffix}`,
  matrix_room_id:
    options.matrixRoomId === undefined
      ? `!room_${fixture.suffix}:example`
      : options.matrixRoomId,
  matrix_event_id:
    options.matrixEventId === undefined
      ? `$matrix_${fixture.suffix}:example`
      : options.matrixEventId,
  remote_message_id:
    options.remoteMessageId === undefined
      ? `remote_${fixture.suffix}`
      : options.remoteMessageId,
  occurred_at: options.occurredAt ?? "2026-09-08T01:00:00.000Z",
  observed_at: options.observedAt ?? "2026-09-08T01:00:01.000Z",
  payload: {
    message_id: options.messageId ?? `message_${fixture.suffix}`,
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "E2E sender",
    body: options.body ?? "E2E message",
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: true,
  },
});

export async function requestForEvents(
  fixture: IngestionFixture,
  events: readonly ProjectionEventEnvelope[],
  overrides: Partial<Omit<IngestionBatchRequest, "batch_id" | "events">> = {},
): Promise<IngestionBatchRequest> {
  const requestWithoutBatch = {
    schema_version: 1 as const,
    gateway_route_id: fixture.routes.human,
    tenant_id: fixture.tenantId,
    archived_at: "2026-09-08T02:00:00.000Z",
    producer_version: "ingestion-e2e/1",
    source_checkpoint: {
      kind: "matrix_sync_token_sha256" as const,
      value: `sha256:${"a".repeat(64)}`,
    },
    ...overrides,
    events: [...events],
  };
  const encoded = await encodeCanonicalEventBatch({
    tenantId: requestWithoutBatch.tenant_id,
    events,
  });
  return {
    ...requestWithoutBatch,
    batch_id: await recomputeBatchId(
      requestWithoutBatch,
      encoded.canonicalSha256,
    ),
  };
}

type QueueMessage = { id: string; body: unknown; attempts?: number };

export async function deliverQueueMessages(
  messages: readonly QueueMessage[],
  queueName = INGESTION_QUEUE_NAME,
) {
  const batch = createMessageBatch(
    queueName,
    messages.map((message) => ({
      id: message.id,
      timestamp: new Date("2026-09-08T03:00:00.000Z"),
      body: message.body,
      attempts: message.attempts ?? 1,
    })),
  );
  const retryOptions = new Map<string, QueueRetryOptions | undefined>();
  for (const message of batch.messages) {
    const originalRetry = message.retry.bind(message);
    Object.defineProperty(message, "retry", {
      configurable: true,
      value: (options?: QueueRetryOptions) => {
        retryOptions.set(message.id, options);
        return originalRetry(options);
      },
    });
  }
  const context = createExecutionContext();
  const queueHandler = (
    worker as {
      queue?: (
        queueBatch: MessageBatch<unknown>,
        environment: Cloudflare.Env,
        executionContext: ExecutionContext,
      ) => void | Promise<void>;
    }
  ).queue;
  if (typeof queueHandler !== "function")
    throw new Error("worker queue handler is missing");
  await queueHandler(batch, env, context);
  return {
    batch,
    result: await getQueueResult(batch, context),
    retryOptions,
  };
}

export async function listTenantArchiveKeys(
  tenantId: string,
): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of [`events/${tenantId}/`, `manifests/${tenantId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await env.EVENT_ARCHIVE.list({
        prefix,
        ...(cursor === undefined ? {} : { cursor }),
      });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }
  return keys.sort();
}
