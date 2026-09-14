import { env } from "cloudflare:test";
import type {
  ProjectionEventEnvelope,
  WebhookMessage,
  WebhookSubscription,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWebhookCredentialResolver,
  deliverIncomingWebhookBatch,
  fanOutIncomingWebhookDeliveries,
  runWebhookRetryTick,
  type WebhookProjection,
} from "../webhooks/delivery";
import {
  retryWebhookDelivery,
  type WebhookActor,
} from "../control-directory/webhooks";
import { recordRemoval } from "../removals/ledger";
import { recordRemovalWithSuppression } from "../removals/service";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const fixedNow = new Date("2026-09-14T00:00:00.000Z");

const subscription = (input: {
  id: string;
  destinationUrl?: string;
  credentialRef?: string | null;
  globalEnabled?: boolean;
  accountEnabled?: boolean;
  destinationVersion?: number;
}): WebhookSubscription => ({
  id: input.id,
  tenant_id: "tenant_pilot",
  owner_installation_id: null,
  owner_principal_id: "principal_human",
  creator_principal_id: "principal_human",
  creator_membership_id: "membership_human",
  creator_identity_id: "identity_human",
  logical_agent_id: null,
  ownership_mode: "human_owner",
  destination: {
    url: input.destinationUrl ?? "https://hooks.example.test/destination",
    credential_ref: input.credentialRef ?? null,
  },
  destination_version: input.destinationVersion ?? 1,
  event_filter: { event_types: ["message.created"] },
  global_enabled: input.globalEnabled ?? true,
  account_rules: [
    { account_id: "account_human", enabled: input.accountEnabled ?? true },
  ],
  chat_rules: [],
  status: "active",
  created_at: fixedNow.toISOString(),
  updated_at: fixedNow.toISOString(),
  revoked_at: null,
});

const incomingEvent = (
  eventId = "event_incoming_1",
): Extract<ProjectionEventEnvelope, { event_type: "message.created" }> => ({
  schema_version: 1,
  event_id: eventId,
  event_type: "message.created",
  event_source: "live",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  platform: "whatsapp",
  account_id: "account_human",
  conversation_id: "conversation_one",
  matrix_room_id: "!room:example.test",
  matrix_event_id: "$event:example.test",
  remote_message_id: "remote_message_1",
  occurred_at: fixedNow.toISOString(),
  observed_at: fixedNow.toISOString(),
  payload: {
    message_id: "message_incoming_1",
    direction: "inbound",
    sender_participant_id: "participant_one",
    sender_label: "Alice",
    body: "incoming body",
    reply_to_message_id: null,
    delivery_status: "delivered",
    unread: true,
  },
});

const message = (body = "incoming body"): WebhookMessage => ({
  message_id: "message_incoming_1",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  account_id: "account_human",
  connection_id: "connection_human_whatsapp",
  conversation_id: "conversation_one",
  platform: "whatsapp",
  direction: "inbound",
  sender_participant_id: "participant_one",
  sender_label: "Alice",
  body,
  occurred_at: fixedNow.toISOString(),
  revision: body === "incoming body" ? "event_incoming_1" : "event_edited_2",
  remote_message_id: "remote_message_1",
  matrix_room_id: "!room:example.test",
  matrix_event_id: "$event:example.test",
  deleted_at: null,
  attachments: [],
});

const messageWithAttachment = (
  attachmentId = "attachment_incoming_1",
): WebhookMessage => ({
  ...message(),
  attachments: [
    {
      attachment_id: attachmentId,
      message_id: "message_incoming_1",
      identity_id: "identity_human",
      account_id: "account_human",
      connection_id: "connection_human_whatsapp",
      conversation_id: "conversation_one",
      platform: "whatsapp",
      file_name: "photo.jpg",
      mime_type: "image/jpeg",
      size_bytes: 42,
      sha256: "a".repeat(64),
      revision: "event_incoming_1",
      expires_at: null,
    },
  ],
});

const humanWebhookActor: WebhookActor = {
  tenantId: "tenant_pilot",
  principalId: "principal_human",
  principalType: "human",
  membershipId: "membership_human",
  role: "owner",
  identityIds: ["identity_human"],
  delegated: false,
};

const insertSubscription = async (
  value: WebhookSubscription,
): Promise<void> => {
  const db = workerEnv.CONTROL_DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO webhook_subscriptions
         (id, tenant_id, creation_idempotency_key, owner_installation_id,
          owner_principal_id, creator_principal_id, creator_membership_id,
          creator_identity_id, logical_agent_id, ownership_mode,
          destination_url, destination_credential_ref, destination_version,
          event_filter_json, global_enabled, status, created_at, updated_at,
          revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        value.id,
        value.tenant_id,
        `${value.id}_creation`,
        value.owner_installation_id,
        value.owner_principal_id,
        value.creator_principal_id,
        value.creator_membership_id,
        value.creator_identity_id,
        value.logical_agent_id,
        value.ownership_mode,
        value.destination.url,
        value.destination.credential_ref,
        value.destination_version,
        JSON.stringify(value.event_filter),
        value.global_enabled ? 1 : 0,
        value.status,
        value.created_at,
        value.updated_at,
        value.revoked_at,
      ),
    db
      .prepare(
        `INSERT INTO webhook_subscription_account_rules
         (tenant_id, subscription_id, account_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        value.tenant_id,
        value.id,
        "account_human",
        value.account_rules[0]?.enabled ? 1 : 0,
        value.created_at,
        value.updated_at,
      ),
    db
      .prepare(
        `INSERT INTO account_grants
         (id, tenant_id, membership_id, identity_id, account_id,
          operation_scope, chat_scope, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'webhook.manage', 'all_chats', 'active', ?, ?)
         ON CONFLICT(tenant_id, membership_id, identity_id, account_id, operation_scope)
         DO NOTHING`,
      )
      .bind(
        `${value.id}_grant`,
        value.tenant_id,
        value.creator_membership_id,
        value.creator_identity_id,
        "account_human",
        value.created_at,
        value.updated_at,
      ),
  ]);
};

const projectionFor = (
  current: () => WebhookMessage | null = () => message(),
): WebhookProjection => ({
  getWebhookMessage: async () => current(),
});

const deliveryRow = async (id: string) =>
  workerEnv.CONTROL_DB.prepare(
    `SELECT id, status, destination_version, source_revision, http_status,
            error_code, payload_json, cancellation_reason, first_pending_at,
            retry_deadline, attempt_count, next_attempt_at, last_response_body,
            uncertain_at, uncertainty_reason, provider_request_started_at
     FROM webhook_deliveries WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      status: string;
      destination_version: number;
      source_revision: string | null;
      http_status: number | null;
      error_code: string | null;
      payload_json: string | null;
      cancellation_reason: string | null;
      first_pending_at: string;
      retry_deadline: string;
      attempt_count: number;
      next_attempt_at: string | null;
      last_response_body: string | null;
      uncertain_at: string | null;
      uncertainty_reason: string | null;
      provider_request_started_at: string | null;
    }>();

beforeEach(async () => {
  await clearDirectory(workerEnv.CONTROL_DB);
  await seedDirectory(workerEnv.CONTROL_DB);
  await seedAccountAccess(workerEnv.CONTROL_DB);
});

describe("durable incoming webhook delivery", () => {
  it("commits one stable row across duplicate fan-out and records HTTP success", async () => {
    await insertSubscription(subscription({ id: "webhook_one" }));
    const event = incomingEvent();
    const first = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [event],
      now: () => fixedNow,
    });
    const second = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [event],
      now: () => fixedNow,
    });
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    await expect(
      workerEnv.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS count FROM webhook_deliveries",
      ).first<{ count: number }>(),
    ).resolves.toMatchObject({ count: 1 });

    const requests: Request[] = [];
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: first,
      services: {
        now: () => fixedNow,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 202 });
        },
      },
    });
    const row = await deliveryRow(first[0] ?? "");
    expect(row).toMatchObject({
      status: "delivered",
      http_status: 202,
      error_code: null,
    });
    expect(requests).toHaveLength(1);
    await expect(requests[0]?.json()).resolves.toMatchObject({
      type: "message.created",
      text: "incoming body",
      source_message_id: "message_incoming_1",
    });
  });

  it("keeps independent policy filters independent and excludes history/own events", async () => {
    await insertSubscription(subscription({ id: "webhook_enabled" }));
    await insertSubscription(
      subscription({ id: "webhook_disabled", accountEnabled: false }),
    );
    const eligible = incomingEvent("event_policy_1");
    const history = {
      ...eligible,
      event_id: "event_history",
      event_source: "backfill" as const,
    };
    const outbound = {
      ...eligible,
      event_id: "event_outbound",
      payload: { ...eligible.payload, direction: "outbound" as const },
    };
    const ids = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [eligible, history, outbound],
      now: () => fixedNow,
    });
    expect(ids).toHaveLength(1);
    const rows = await workerEnv.CONTROL_DB.prepare(
      "SELECT subscription_id, source_event_id FROM webhook_deliveries",
    ).all<{ subscription_id: string; source_event_id: string }>();
    expect(rows.results).toEqual([
      { subscription_id: "webhook_enabled", source_event_id: "event_policy_1" },
    ]);
  });

  it("hydrates the latest revision and cancels when authorization is revoked before HTTP", async () => {
    await insertSubscription(subscription({ id: "webhook_race" }));
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_race")],
      now: () => fixedNow,
    });
    let latest = message("edited body");
    let fetchCount = 0;
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() => latest),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        beforeFetch: async () => {
          await workerEnv.CONTROL_DB.prepare(
            "UPDATE webhook_subscriptions SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?",
          )
            .bind(
              fixedNow.toISOString(),
              fixedNow.toISOString(),
              "webhook_race",
            )
            .run();
        },
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 200 });
        },
      },
    });
    expect(fetchCount).toBe(0);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "subscription_revoked",
    });

    await insertSubscription(subscription({ id: "webhook_latest" }));
    const [latestId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_latest")],
      now: () => fixedNow,
    });
    const requests: Request[] = [];
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() => latest),
      deliveryIds: [latestId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 200 });
        },
      },
    });
    await expect(requests[0]?.json()).resolves.toMatchObject({
      text: "edited body",
    });
  });

  it("rechecks revocation after an owner credential resolver is released", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_credential_race",
        credentialRef: "owner-ref",
      }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_credential_race")],
      now: () => fixedNow,
    });
    let enteredResolver!: () => void;
    let releaseResolver!: (value: string) => void;
    const resolverEntered = new Promise<void>((resolve) => {
      enteredResolver = resolve;
    });
    const resolverRelease = new Promise<string>((resolve) => {
      releaseResolver = resolve;
    });
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        resolveCredential: async () => {
          enteredResolver();
          return resolverRelease;
        },
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 200 });
        },
      },
    });
    await resolverEntered;
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE webhook_subscriptions SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        fixedNow.toISOString(),
        fixedNow.toISOString(),
        "webhook_credential_race",
      )
      .run();
    releaseResolver("Bearer should-not-send");
    await delivery;
    expect(fetchCount).toBe(0);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "subscription_revoked",
    });
  });

  it("suppresses a tombstone and fences a destination replacement during credential resolution", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_tombstone_race",
        credentialRef: "owner-ref",
      }),
    );
    const [tombstoneId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_tombstone_race")],
      now: () => fixedNow,
    });
    let currentMessage: WebhookMessage | null = message();
    let enterTombstoneResolver!: () => void;
    let releaseTombstoneResolver!: (value: string) => void;
    const tombstoneEntered = new Promise<void>((resolve) => {
      enterTombstoneResolver = resolve;
    });
    const tombstoneRelease = new Promise<string>((resolve) => {
      releaseTombstoneResolver = resolve;
    });
    const tombstoneDelivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() => currentMessage),
      deliveryIds: [tombstoneId ?? ""],
      services: {
        now: () => fixedNow,
        resolveCredential: async () => {
          enterTombstoneResolver();
          return tombstoneRelease;
        },
        fetch: async () => new Response(null, { status: 200 }),
      },
    });
    await tombstoneEntered;
    currentMessage = {
      ...message(),
      body: "",
      sender_label: "Deleted sender",
      deleted_at: fixedNow.toISOString(),
    };
    releaseTombstoneResolver("Bearer should-not-send");
    await tombstoneDelivery;
    expect(await deliveryRow(tombstoneId ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "source_tombstoned_or_unavailable",
    });

    await insertSubscription(
      subscription({
        id: "webhook_destination_race",
        credentialRef: "owner-ref",
      }),
    );
    const [destinationId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_destination_race")],
      now: () => fixedNow,
    });
    let enterDestinationResolver!: () => void;
    let releaseDestinationResolver!: (value: string) => void;
    const destinationEntered = new Promise<void>((resolve) => {
      enterDestinationResolver = resolve;
    });
    const destinationRelease = new Promise<string>((resolve) => {
      releaseDestinationResolver = resolve;
    });
    const destinationDelivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [destinationId ?? ""],
      services: {
        now: () => fixedNow,
        resolveCredential: async () => {
          enterDestinationResolver();
          return destinationRelease;
        },
        fetch: async () => new Response(null, { status: 200 }),
      },
    });
    await destinationEntered;
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE webhook_subscriptions SET destination_url = ?, destination_version = destination_version + 1, updated_at = ? WHERE id = ?",
    )
      .bind(
        "https://hooks.example.test/replaced",
        fixedNow.toISOString(),
        "webhook_destination_race",
      )
      .run();
    releaseDestinationResolver("Bearer should-not-send");
    await destinationDelivery;
    expect(await deliveryRow(destinationId ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "destination_version_mismatch",
    });
  });

  it("fences credential resolution by owner and stores authenticated attachment refs", async () => {
    const resolver = createWebhookCredentialResolver({
      get: async () =>
        JSON.stringify({
          credentials: [
            {
              tenant_id: "tenant_pilot",
              owner_principal_id: "principal_human",
              owner_installation_id: null,
              credential_ref: "owner-ref",
              authorization: "Bearer test-webhook-token",
            },
          ],
        }),
    });
    await expect(
      resolver({
        tenantId: "tenant_pilot",
        subscriptionId: "webhook_one",
        ownerPrincipalId: "principal_other",
        ownerInstallationId: null,
        credentialRef: "owner-ref",
      }),
    ).resolves.toBeNull();

    await insertSubscription(
      subscription({ id: "webhook_attachment", credentialRef: "owner-ref" }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_attachment")],
      now: () => fixedNow,
    });
    const attachmentMessage: WebhookMessage = {
      ...message(),
      attachments: [
        {
          attachment_id: "attachment_one",
          message_id: "message_incoming_1",
          identity_id: "identity_human",
          account_id: "account_human",
          connection_id: "connection_human_whatsapp",
          conversation_id: "conversation_one",
          platform: "whatsapp",
          file_name: "photo.jpg",
          mime_type: "image/jpeg",
          size_bytes: 42,
          sha256: "a".repeat(64),
          revision: "event_attachment",
          expires_at: null,
        },
      ],
    };
    const requests: Request[] = [];
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() => attachmentMessage),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        resolveCredential: resolver,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 200 });
        },
      },
    });
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer test-webhook-token",
    );
    const payload = (await requests[0]?.json()) as {
      attachments: Array<Record<string, unknown>>;
    };
    expect(payload.attachments[0]).toMatchObject({
      download_path: "/api/v1/attachments/attachment_one/download",
    });
    expect(String(payload.attachments[0]?.download_grant)).toMatch(/^adg_/u);
    expect(payload.attachments[0]).not.toHaveProperty("media_key");
  });

  it("keeps HTTP failures durable and does not acknowledge a live lease", async () => {
    await insertSubscription(subscription({ id: "webhook_failure" }));
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_failure")],
      now: () => fixedNow,
    });
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response(null, { status: 503 }),
      },
    });
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "pending",
      http_status: 503,
      error_code: "http_503",
      first_pending_at: fixedNow.toISOString(),
      retry_deadline: new Date(
        fixedNow.getTime() + 24 * 60 * 60 * 1_000,
      ).toISOString(),
      attempt_count: 1,
    });

    const retryNow = new Date(fixedNow.getTime() + 1_000);
    let retryFetchCount = 0;
    const retryServices = {
      now: () => retryNow,
      fetch: async () => {
        retryFetchCount += 1;
        return new Response(null, { status: 503 });
      },
    };
    await expect(
      runWebhookRetryTick({
        database: workerEnv.CONTROL_DB,
        projectionForTenant: () => projectionFor(),
        services: retryServices,
      }),
    ).resolves.toEqual({ scanned: 1, attempted: 1 });
    await expect(
      runWebhookRetryTick({
        database: workerEnv.CONTROL_DB,
        projectionForTenant: () => projectionFor(),
        services: retryServices,
      }),
    ).resolves.toEqual({ scanned: 0, attempted: 0 });
    expect(retryFetchCount).toBe(1);

    const tick = await runWebhookRetryTick({
      database: workerEnv.CONTROL_DB,
      projectionForTenant: () => projectionFor(),
      services: {
        now: () => new Date(fixedNow.getTime() + 24 * 60 * 60 * 1_000),
      },
    });
    expect(tick).toEqual({ scanned: 1, attempted: 1 });
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "failed",
      error_code: "retry_deadline_exceeded",
      next_attempt_at: null,
      attempt_count: 2,
    });

    const [busyId] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_busy")],
      now: () => fixedNow,
    });
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE webhook_deliveries SET status = 'leased', lease_id = ?, lease_expires_at = ? WHERE id = ?",
    )
      .bind(
        "lease_held",
        new Date(fixedNow.getTime() + 30_000).toISOString(),
        busyId,
      )
      .run();
    await expect(
      deliverIncomingWebhookBatch({
        database: workerEnv.CONTROL_DB,
        tenantId: "tenant_pilot",
        projection: projectionFor(),
        deliveryIds: [busyId ?? ""],
        services: { now: () => fixedNow },
      }),
    ).rejects.toThrow("webhook delivery lease is active");

    await workerEnv.CONTROL_DB.prepare(
      "UPDATE webhook_deliveries SET lease_expires_at = ? WHERE id = ?",
    )
      .bind(new Date(fixedNow.getTime() - 1).toISOString(), busyId)
      .run();
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [busyId ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response(null, { status: 200 }),
      },
    });
    expect(await deliveryRow(busyId ?? "")).toMatchObject({
      status: "delivered",
      http_status: 200,
    });
  });

  it("bounds endpoint and response-body stalls while independent destinations continue", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_endpoint_timeout",
        destinationUrl: "https://hooks.example.test/endpoint-timeout",
      }),
    );
    await insertSubscription(
      subscription({
        id: "webhook_body_timeout",
        destinationUrl: "https://hooks.example.test/body-timeout",
      }),
    );
    await insertSubscription(
      subscription({
        id: "webhook_oversized_body",
        destinationUrl: "https://hooks.example.test/oversized-body",
      }),
    );
    await insertSubscription(
      subscription({
        id: "webhook_healthy_after_stalls",
        destinationUrl: "https://hooks.example.test/healthy-after-stalls",
      }),
    );
    const ids = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_stalled_destinations")],
      now: () => fixedNow,
    });
    expect(ids).toHaveLength(4);

    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const oversizedBody = new Uint8Array(16_384).fill(65);
    const requests: string[] = [];
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: ids,
      services: {
        now: () => fixedNow,
        httpTimeoutMs: 5,
        fetch: async (input) => {
          const url = String(input);
          requests.push(url);
          if (url.endsWith("/endpoint-timeout")) {
            return new Promise<Response>(() => undefined);
          }
          if (url.endsWith("/body-timeout")) {
            return new Response(stalledBody, { status: 503 });
          }
          if (url.endsWith("/oversized-body")) {
            return new Response(oversizedBody, { status: 503 });
          }
          return new Response(null, { status: 202 });
        },
      },
    });

    expect(requests).toEqual([
      "https://hooks.example.test/body-timeout",
      "https://hooks.example.test/endpoint-timeout",
      "https://hooks.example.test/healthy-after-stalls",
      "https://hooks.example.test/oversized-body",
    ]);
    const rows = await workerEnv.CONTROL_DB.prepare(
      `SELECT ws.id AS subscription_id, wd.status, wd.error_code,
              length(wd.last_response_body) AS response_size
       FROM webhook_deliveries AS wd
       JOIN webhook_subscriptions AS ws
         ON ws.id = wd.subscription_id
       ORDER BY ws.id`,
    ).all<{
      subscription_id: string;
      status: string;
      error_code: string | null;
      response_size: number | null;
    }>();
    expect(rows.results).toEqual([
      {
        subscription_id: "webhook_body_timeout",
        status: "pending",
        error_code: "http_503",
        response_size: null,
      },
      {
        subscription_id: "webhook_endpoint_timeout",
        status: "pending",
        error_code: "delivery_unavailable",
        response_size: null,
      },
      {
        subscription_id: "webhook_healthy_after_stalls",
        status: "delivered",
        error_code: null,
        response_size: null,
      },
      {
        subscription_id: "webhook_oversized_body",
        status: "pending",
        error_code: "http_503",
        response_size: 8_192,
      },
    ]);
  });

  it("rechecks cutover after a removal epoch advances during rehydration", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_removal_epoch_race",
        destinationUrl: "https://hooks.example.test/old-authority",
      }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_removal_epoch_race")],
      now: () => fixedNow,
    });

    let getMessageCount = 0;
    let enterInitialHydration!: () => void;
    let releaseInitialHydration!: () => void;
    let enterRehydration!: () => void;
    let releaseRehydration!: () => void;
    const initialHydrationEntered = new Promise<void>((resolve) => {
      enterInitialHydration = resolve;
    });
    const initialHydrationRelease = new Promise<void>((resolve) => {
      releaseInitialHydration = resolve;
    });
    const rehydrationEntered = new Promise<void>((resolve) => {
      enterRehydration = resolve;
    });
    const rehydrationRelease = new Promise<void>((resolve) => {
      releaseRehydration = resolve;
    });
    const projection: WebhookProjection = {
      getWebhookMessage: async () => {
        getMessageCount += 1;
        if (getMessageCount === 1) {
          enterInitialHydration();
          await initialHydrationRelease;
        } else {
          enterRehydration();
          await rehydrationRelease;
        }
        return message();
      },
    };
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection,
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 202 });
        },
      },
    });

    await initialHydrationEntered;
    await recordRemoval(workerEnv.CONTROL_DB, {
      tenant_id: "tenant_pilot",
      resource_type: "message",
      resource_id: "message_epoch_probe",
      content_generation: "message_epoch_probe",
      account_id: "account_human",
      conversation_id: "conversation_one",
      source_event_id: "event_epoch_probe",
      source_object_key: null,
      reason: "requested",
      removed_at: fixedNow.toISOString(),
    });
    releaseInitialHydration();

    await rehydrationEntered;
    await workerEnv.CONTROL_DB.prepare(
      `UPDATE webhook_subscriptions
       SET destination_url = ?, destination_version = destination_version + 1,
           updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        "https://hooks.example.test/new-authority",
        fixedNow.toISOString(),
        "webhook_removal_epoch_race",
      )
      .run();
    releaseRehydration();
    await delivery;

    expect(getMessageCount).toBe(2);
    expect(fetchCount).toBe(0);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "destination_version_mismatch",
    });
  });

  it("does not call a receiver when removal wins before the durable lease", async () => {
    await insertSubscription(
      subscription({ id: "webhook_removal_before_claim" }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_removal_before_claim")],
      now: () => fixedNow,
    });

    let enterClaimBarrier!: () => void;
    let releaseClaimBarrier!: () => void;
    const claimBarrierEntered = new Promise<void>((resolve) => {
      enterClaimBarrier = resolve;
    });
    const claimBarrierRelease = new Promise<void>((resolve) => {
      releaseClaimBarrier = resolve;
    });
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        beforeClaim: async () => {
          enterClaimBarrier();
          await claimBarrierRelease;
        },
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 202 });
        },
      },
    });

    await claimBarrierEntered;
    await recordRemovalWithSuppression(
      workerEnv.CONTROL_DB.withSession("first-primary"),
      {
        tenant_id: "tenant_pilot",
        resource_type: "message",
        resource_id: "message_incoming_1",
        content_generation: "message_incoming_1",
        account_id: "account_human",
        conversation_id: "conversation_one",
        source_event_id: "event_removal_before_claim",
        source_object_key: null,
        reason: "requested",
        removed_at: fixedNow.toISOString(),
      },
      fixedNow,
    );
    releaseClaimBarrier();
    await delivery;

    expect(fetchCount).toBe(0);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "source_removed",
      provider_request_started_at: null,
    });
  });

  it("does not prepare an attachment grant when attachment removal wins before delivery", async () => {
    await insertSubscription(
      subscription({ id: "webhook_attachment_removal_before_claim" }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_attachment_removal_before_claim")],
      now: () => fixedNow,
    });
    const grantsBeforeDelivery = await workerEnv.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM attachment_download_grants WHERE tenant_id = ?",
    )
      .bind("tenant_pilot")
      .first<{ count: number }>();

    let enterClaimBarrier!: () => void;
    let releaseClaimBarrier!: () => void;
    const claimBarrierEntered = new Promise<void>((resolve) => {
      enterClaimBarrier = resolve;
    });
    const claimBarrierRelease = new Promise<void>((resolve) => {
      releaseClaimBarrier = resolve;
    });
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() => messageWithAttachment()),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        beforeClaim: async () => {
          enterClaimBarrier();
          await claimBarrierRelease;
        },
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 202 });
        },
      },
    });

    await claimBarrierEntered;
    await recordRemovalWithSuppression(
      workerEnv.CONTROL_DB.withSession("first-primary"),
      {
        tenant_id: "tenant_pilot",
        resource_type: "attachment",
        resource_id: "attachment_incoming_1",
        content_generation: "attachment_incoming_1",
        account_id: "account_human",
        conversation_id: "conversation_one",
        source_event_id: "event_attachment_removal_before_claim",
        source_object_key: null,
        reason: "requested",
        removed_at: fixedNow.toISOString(),
      },
      fixedNow,
    );
    releaseClaimBarrier();
    await delivery;

    expect(fetchCount).toBe(0);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "source_removed",
      provider_request_started_at: null,
    });
    await expect(
      workerEnv.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS count FROM attachment_download_grants WHERE tenant_id = ?",
      )
        .bind("tenant_pilot")
        .first<{ count: number }>(),
    ).resolves.toEqual(grantsBeforeDelivery);
  });

  it("keeps missing credentials retryable without starting a provider request", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_missing_credential",
        credentialRef: "missing-ref",
      }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_missing_credential")],
      now: () => fixedNow,
    });
    let fetchCount = 0;
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        resolveCredential: async () => null,
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 202 });
        },
      },
    });

    expect(fetchCount).toBe(0);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "pending",
      error_code: "credential_unavailable",
      http_status: null,
      attempt_count: 1,
      first_pending_at: fixedNow.toISOString(),
      retry_deadline: new Date(
        fixedNow.getTime() + 24 * 60 * 60 * 1_000,
      ).toISOString(),
      provider_request_started_at: null,
    });
  });

  it("records removal after provider request entry as uncertain without retry", async () => {
    await insertSubscription(subscription({ id: "webhook_removal_in_flight" }));
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_removal_in_flight")],
      now: () => fixedNow,
    });

    let enterFetch!: () => void;
    let releaseFetch!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      enterFetch = resolve;
    });
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => {
          fetchCount += 1;
          enterFetch();
          await fetchRelease;
          return new Response(null, { status: 202 });
        },
      },
    });

    await fetchEntered;
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "leased",
      provider_request_started_at: fixedNow.toISOString(),
    });
    await recordRemoval(workerEnv.CONTROL_DB, {
      tenant_id: "tenant_pilot",
      resource_type: "message",
      resource_id: "message_incoming_1",
      content_generation: "message_incoming_1",
      account_id: "account_human",
      conversation_id: "conversation_one",
      source_event_id: "event_removal_in_flight",
      source_object_key: null,
      reason: "requested",
      removed_at: fixedNow.toISOString(),
    });
    releaseFetch();
    await delivery;

    expect(fetchCount).toBe(1);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "uncertain",
      http_status: 202,
      error_code: "delivery_uncertain",
      uncertainty_reason: "source_removed_in_flight",
      provider_request_started_at: fixedNow.toISOString(),
    });
    await expect(
      runWebhookRetryTick({
        database: workerEnv.CONTROL_DB,
        projectionForTenant: () => projectionFor(),
        services: {
          now: () => new Date(fixedNow.getTime() + 60 * 60 * 1_000),
          fetch: async () => {
            fetchCount += 1;
            return new Response(null, { status: 202 });
          },
        },
      }),
    ).resolves.toEqual({ scanned: 0, attempted: 0 });
    expect(fetchCount).toBe(1);
  });

  it("fences an attachment-removed uncertain delivery when manually retried", async () => {
    await insertSubscription(
      subscription({ id: "webhook_attachment_removal_retry" }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_attachment_removal_retry")],
      now: () => fixedNow,
    });

    let enterFetch!: () => void;
    let releaseFetch!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      enterFetch = resolve;
    });
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() => messageWithAttachment()),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => {
          fetchCount += 1;
          enterFetch();
          await fetchRelease;
          return new Response(null, { status: 202 });
        },
      },
    });

    await fetchEntered;
    await recordRemovalWithSuppression(
      workerEnv.CONTROL_DB.withSession("first-primary"),
      {
        tenant_id: "tenant_pilot",
        resource_type: "attachment",
        resource_id: "attachment_incoming_1",
        content_generation: "attachment_incoming_1",
        account_id: "account_human",
        conversation_id: "conversation_one",
        source_event_id: "event_attachment_removal_retry",
        source_object_key: null,
        reason: "requested",
        removed_at: fixedNow.toISOString(),
      },
      fixedNow,
    );
    releaseFetch();
    await delivery;

    expect(fetchCount).toBe(1);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "uncertain",
      error_code: "delivery_uncertain",
      uncertainty_reason: "source_removed_in_flight",
      provider_request_started_at: fixedNow.toISOString(),
    });
    const grantsBeforeRetry = await workerEnv.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM attachment_download_grants WHERE tenant_id = ?",
    )
      .bind("tenant_pilot")
      .first<{ count: number }>();

    const retryAt = new Date(fixedNow.getTime() + 1_000).toISOString();
    await expect(
      retryWebhookDelivery(
        workerEnv.CONTROL_DB,
        humanWebhookActor,
        id ?? "",
        "webhook-attachment-removal-retry",
        retryAt,
      ),
    ).resolves.toMatchObject({ status: "pending" });

    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(() => messageWithAttachment()),
      deliveryIds: [id ?? ""],
      services: {
        now: () => new Date(retryAt),
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 202 });
        },
      },
    });

    expect(fetchCount).toBe(1);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "cancelled",
      cancellation_reason: "source_removed",
      provider_request_started_at: null,
    });
    await expect(
      workerEnv.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS count FROM attachment_download_grants WHERE tenant_id = ?",
      )
        .bind("tenant_pilot")
        .first<{ count: number }>(),
    ).resolves.toEqual(grantsBeforeRetry);
  });

  it("fences the terminal write when removal wins after the response check", async () => {
    await insertSubscription(subscription({ id: "webhook_removal_terminal" }));
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_removal_terminal")],
      now: () => fixedNow,
    });

    let enterTerminal!: () => void;
    let releaseTerminal!: () => void;
    const terminalEntered = new Promise<void>((resolve) => {
      enterTerminal = resolve;
    });
    const terminalRelease = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        beforeTerminalWrite: async () => {
          enterTerminal();
          await terminalRelease;
        },
        fetch: async () => {
          fetchCount += 1;
          return new Response(null, { status: 202 });
        },
      },
    });

    await terminalEntered;
    await recordRemoval(workerEnv.CONTROL_DB, {
      tenant_id: "tenant_pilot",
      resource_type: "message",
      resource_id: "message_incoming_1",
      content_generation: "message_incoming_1",
      account_id: "account_human",
      conversation_id: "conversation_one",
      source_event_id: "event_removal_terminal",
      source_object_key: null,
      reason: "requested",
      removed_at: fixedNow.toISOString(),
    });
    releaseTerminal();
    await delivery;

    expect(fetchCount).toBe(1);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "uncertain",
      http_status: 202,
      error_code: "delivery_uncertain",
      uncertainty_reason: "source_removed_in_flight",
      provider_request_started_at: fixedNow.toISOString(),
    });
    await expect(
      runWebhookRetryTick({
        database: workerEnv.CONTROL_DB,
        projectionForTenant: () => projectionFor(),
        services: {
          now: () => new Date(fixedNow.getTime() + 60 * 60 * 1_000),
          fetch: async () => {
            fetchCount += 1;
            return new Response(null, { status: 202 });
          },
        },
      }),
    ).resolves.toEqual({ scanned: 0, attempted: 0 });
    expect(fetchCount).toBe(1);
  });

  it("marks an expired in-flight lease uncertain instead of resending", async () => {
    await insertSubscription(subscription({ id: "webhook_expired_in_flight" }));
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_expired_in_flight")],
      now: () => fixedNow,
    });

    let enterFetch!: () => void;
    let releaseFetch!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      enterFetch = resolve;
    });
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => {
          fetchCount += 1;
          enterFetch();
          await fetchRelease;
          return new Response(null, { status: 202 });
        },
      },
    });

    await fetchEntered;
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "leased",
      provider_request_started_at: fixedNow.toISOString(),
    });
    await workerEnv.CONTROL_DB.prepare(
      "UPDATE webhook_deliveries SET lease_expires_at = ? WHERE id = ?",
    )
      .bind(new Date(fixedNow.getTime() - 1).toISOString(), id)
      .run();

    await expect(
      runWebhookRetryTick({
        database: workerEnv.CONTROL_DB,
        projectionForTenant: () => projectionFor(),
        services: {
          now: () => fixedNow,
          fetch: async () => {
            fetchCount += 1;
            return new Response(null, { status: 202 });
          },
        },
      }),
    ).resolves.toEqual({ scanned: 1, attempted: 1 });
    expect(fetchCount).toBe(1);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "uncertain",
      error_code: "delivery_uncertain",
      uncertainty_reason: "delivery_lease_expired_in_flight",
      provider_request_started_at: fixedNow.toISOString(),
    });

    releaseFetch();
    await delivery;
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "uncertain",
      uncertainty_reason: "delivery_lease_expired_in_flight",
    });
    await expect(
      runWebhookRetryTick({
        database: workerEnv.CONTROL_DB,
        projectionForTenant: () => projectionFor(),
        services: {
          now: () => new Date(fixedNow.getTime() + 60 * 60 * 1_000),
          fetch: async () => {
            fetchCount += 1;
            return new Response(null, { status: 202 });
          },
        },
      }),
    ).resolves.toEqual({ scanned: 0, attempted: 0 });
    expect(fetchCount).toBe(1);
  });

  it("keeps a 4xx response retryable until the fixed deadline", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_client_failure",
        destinationUrl: "https://hooks.example.test/client-failure",
      }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_client_failure")],
      now: () => fixedNow,
    });
    await deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => new Response("rate limited", { status: 429 }),
      },
    });
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "pending",
      http_status: 429,
      error_code: "http_429",
      first_pending_at: fixedNow.toISOString(),
      retry_deadline: new Date(
        fixedNow.getTime() + 24 * 60 * 60 * 1_000,
      ).toISOString(),
      attempt_count: 1,
      last_response_body: "rate limited",
    });

    await expect(
      runWebhookRetryTick({
        database: workerEnv.CONTROL_DB,
        projectionForTenant: () => projectionFor(),
        services: {
          now: () => new Date(fixedNow.getTime() + 24 * 60 * 60 * 1_000),
        },
      }),
    ).resolves.toEqual({ scanned: 1, attempted: 1 });
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "failed",
      error_code: "retry_deadline_exceeded",
      attempt_count: 1,
      first_pending_at: fixedNow.toISOString(),
      last_response_body: "rate limited",
    });
  });

  it("records an in-flight cutover as uncertain without resending to the replacement", async () => {
    await insertSubscription(
      subscription({
        id: "webhook_inflight_cutover",
        destinationUrl: "https://hooks.example.test/inflight-old",
      }),
    );
    const [id] = await fanOutIncomingWebhookDeliveries({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      events: [incomingEvent("event_inflight_cutover")],
      now: () => fixedNow,
    });
    let enteredFetch!: () => void;
    let releaseFetch!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      enteredFetch = resolve;
    });
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchCount = 0;
    const delivery = deliverIncomingWebhookBatch({
      database: workerEnv.CONTROL_DB,
      tenantId: "tenant_pilot",
      projection: projectionFor(),
      deliveryIds: [id ?? ""],
      services: {
        now: () => fixedNow,
        fetch: async () => {
          fetchCount += 1;
          enteredFetch();
          await fetchRelease;
          return new Response(null, { status: 202 });
        },
      },
    });
    await fetchEntered;
    await workerEnv.CONTROL_DB.prepare(
      `UPDATE webhook_subscriptions
       SET destination_url = ?, destination_version = destination_version + 1,
           updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        "https://hooks.example.test/inflight-new",
        fixedNow.toISOString(),
        "webhook_inflight_cutover",
      )
      .run();
    releaseFetch();
    await delivery;

    expect(fetchCount).toBe(1);
    expect(await deliveryRow(id ?? "")).toMatchObject({
      status: "uncertain",
      http_status: 202,
      error_code: "delivery_uncertain",
      uncertainty_reason: "destination_version_changed_in_flight",
    });
    await expect(
      runWebhookRetryTick({
        database: workerEnv.CONTROL_DB,
        projectionForTenant: () => projectionFor(),
        services: {
          now: () => new Date(fixedNow.getTime() + 60 * 60 * 1_000),
          fetch: async () => {
            fetchCount += 1;
            return new Response(null, { status: 202 });
          },
        },
      }),
    ).resolves.toEqual({ scanned: 0, attempted: 0 });
    expect(fetchCount).toBe(1);
  });
});
