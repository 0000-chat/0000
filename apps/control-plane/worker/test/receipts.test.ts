import { env as runtimeEnv } from "cloudflare:workers";
import {
  ApiErrorResponseSchema,
  ReadReceiptOperationSchema,
  ReadReceiptResultSchema,
  type ReceiptTarget,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  ReceiptProviderError,
  type ReceiptAdapterResult,
  type ReceiptDispatchPayload,
} from "../receipts/provider";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const identityId = "identity_human";
const accountId = "account_human";
const conversationId = "conversation_receipt";
const messageId = "message_receipt";
const timestamp = "2026-09-14T00:00:00.000Z";

type ReceiptProjection = {
  resolveConversationOwner: (input: unknown) => Promise<{
    tenant_id: string;
    conversation_id: string;
    identity_id: string;
    account_id: string;
    connection_id: string;
    platform: string;
  } | null>;
  resolveReceiptTarget: (input: unknown) => Promise<ReceiptTarget | null>;
};

const targetFor = (overrides: Partial<ReceiptTarget> = {}): ReceiptTarget => ({
  schema_version: 1,
  tenant_id: tenantId,
  identity_id: identityId,
  account_id: accountId,
  connection_id: "connection_human_whatsapp",
  conversation_id: conversationId,
  message_id: messageId,
  platform: "whatsapp",
  event_id: "event_receipt",
  matrix_room_id: "!receipt:example.test",
  matrix_event_id: "$receipt:example.test",
  occurred_at: timestamp,
  deleted_at: null,
  ...overrides,
});

const projectionFor = (
  target: ReceiptTarget | null = targetFor(),
): ReceiptProjection => ({
  resolveConversationOwner: async () => ({
    tenant_id: tenantId,
    conversation_id: conversationId,
    identity_id: target?.identity_id ?? identityId,
    account_id: target?.account_id ?? accountId,
    connection_id: target?.connection_id ?? "connection_human_whatsapp",
    platform: target?.platform ?? "whatsapp",
  }),
  resolveReceiptTarget: async () => target,
});

const requestEnvironment = (projection: ReceiptProjection) => {
  const value = Object.create(env) as Record<string, unknown>;
  Object.defineProperty(value, "TENANT_PROJECTION", {
    enumerable: true,
    value: { getByName: () => projection },
  });
  return value as unknown as Cloudflare.Env;
};

const createTestApp = (
  projection: ReceiptProjection,
  dispatchReceipt?: (
    payload: ReceiptDispatchPayload,
  ) => Promise<ReceiptAdapterResult>,
  beforeFinalAuthorization?: () => void | Promise<void>,
) =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token")
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        throw new Error("invalid local test token");
      },
    }),
    receiptServices: {
      ...(dispatchReceipt === undefined ? {} : { dispatchReceipt }),
      ...(beforeFinalAuthorization === undefined
        ? {}
        : { beforeFinalAuthorization }),
    },
  });

const request = async (
  app: ReturnType<typeof createTestApp>,
  projection: ReceiptProjection,
  path: string,
  init: RequestInit = {},
) =>
  app.request(
    `https://example.test${path}`,
    {
      ...init,
      headers: {
        Authorization: "Bearer human-token",
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    requestEnvironment(projection),
  );

const requestBody = (
  idempotencyKey: string,
  overrides: { account_id?: string; identity_id?: string } = {},
) =>
  JSON.stringify({
    schema_version: 1,
    identity_id: overrides.identity_id ?? identityId,
    account_id: overrides.account_id ?? accountId,
    message_id: messageId,
    idempotency_key: idempotencyKey,
  });

async function insertReceiptAuthority() {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, provider_login_id, connection_id, link_session_id, created_at) VALUES (?, 'whatsapp', ?, ?, ?, ?, ?)",
    ).bind(
      tenantId,
      "a".repeat(64),
      "login-receipt",
      "connection_human_whatsapp",
      "link-receipt",
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'receipt.send', 'all_chats', 'active', ?, ?)",
    ).bind(
      "grant_receipt_send",
      tenantId,
      "membership_human",
      identityId,
      accountId,
      timestamp,
      timestamp,
    ),
  ]);
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await seedAccountAccess(env.CONTROL_DB);
  await insertReceiptAuthority();
});

describe("explicit read receipt API", () => {
  it("durably requests one account-bound receipt and preserves all evidence stages", async () => {
    const dispatchReceipt = vi.fn(async (payload: ReceiptDispatchPayload) => {
      expect(payload.route.account_id).toBe(accountId);
      expect(payload.route.provider_login_id).toBe("login-receipt");
      expect(payload.matrix_event_id).toBe("$receipt:example.test");
      return {
        status: "observed" as const,
        matrix_stage: "accepted" as const,
        bridge_stage: "observed" as const,
        provider_stage: "unknown" as const,
        evidence: [
          {
            source: "matrix" as const,
            status: "accepted" as const,
            evidence_id: "matrix:$receipt:example.test",
          },
          {
            source: "bridge" as const,
            status: "observed" as const,
            evidence_id: "bridge:receipt-operation",
          },
        ],
      };
    });
    const projection = projectionFor();
    const app = createTestApp(projection, dispatchReceipt);
    const response = await request(
      app,
      projection,
      `/${"api/v1/conversations"}/${conversationId}/receipts/read`,
      { method: "POST", body: requestBody("receipt-idempotency-1") },
    );

    expect(response.status).toBe(200);
    const result = ReadReceiptResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      status: "observed",
      matrix_stage: "accepted",
      bridge_stage: "observed",
      provider_stage: "unknown",
      conversation_id: conversationId,
      message_id: messageId,
      replayed: false,
    });
    expect(result.evidence).toHaveLength(2);
    expect(dispatchReceipt).toHaveBeenCalledTimes(1);

    const stored = await env.CONTROL_DB.prepare(
      "SELECT status, matrix_stage, bridge_stage, provider_stage FROM receipt_operations WHERE operation_id = ?",
    )
      .bind(result.operation_id)
      .first();
    expect(stored).toEqual({
      status: "observed",
      matrix_stage: "accepted",
      bridge_stage: "observed",
      provider_stage: "unknown",
    });
  });

  it("replays an idempotent operation without a second provider call", async () => {
    const dispatchReceipt = vi.fn(async () => ({
      status: "accepted" as const,
      matrix_stage: "accepted" as const,
      bridge_stage: "unknown" as const,
      provider_stage: "unknown" as const,
      evidence: [],
    }));
    const projection = projectionFor();
    const app = createTestApp(projection, dispatchReceipt);
    const first = await request(
      app,
      projection,
      `/api/v1/conversations/${conversationId}/receipts/read`,
      { method: "POST", body: requestBody("receipt-idempotency-replay") },
    );
    const firstResult = ReadReceiptResultSchema.parse(await first.json());
    const second = await request(
      app,
      projection,
      `/api/v1/conversations/${conversationId}/receipts/read`,
      { method: "POST", body: requestBody("receipt-idempotency-replay") },
    );
    const secondResult = ReadReceiptResultSchema.parse(await second.json());

    expect(secondResult.operation_id).toBe(firstResult.operation_id);
    expect(secondResult.replayed).toBe(true);
    expect(dispatchReceipt).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the final receipt grant is revoked", async () => {
    const dispatchReceipt = vi.fn();
    const projection = projectionFor();
    await env.CONTROL_DB.prepare(
      "UPDATE memberships SET role = 'member', updated_at = ? WHERE id = 'membership_human'",
    )
      .bind(timestamp)
      .run();
    const app = createTestApp(projection, dispatchReceipt, async () => {
      await env.CONTROL_DB.prepare(
        "UPDATE account_grants SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?",
      )
        .bind(timestamp, timestamp, "grant_receipt_send")
        .run();
    });
    const response = await request(
      app,
      projection,
      `/api/v1/conversations/${conversationId}/receipts/read`,
      { method: "POST", body: requestBody("receipt-idempotency-revoked") },
    );

    expect(response.status).toBe(200);
    const result = ReadReceiptResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      status: "rejected",
      failure_code: "authorization_revoked",
      matrix_stage: "unknown",
      bridge_stage: "unknown",
      provider_stage: "unknown",
    });
    expect(dispatchReceipt).not.toHaveBeenCalled();
  });

  it("returns an explicit stale-message operation without provider I/O", async () => {
    const dispatchReceipt = vi.fn();
    const projection = projectionFor(targetFor({ deleted_at: timestamp }));
    const app = createTestApp(projection, dispatchReceipt);
    const response = await request(
      app,
      projection,
      `/api/v1/conversations/${conversationId}/receipts/read`,
      { method: "POST", body: requestBody("receipt-idempotency-stale") },
    );

    expect(response.status).toBe(200);
    const result = ReadReceiptResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      status: "rejected",
      failure_code: "stale_message",
    });
    expect(dispatchReceipt).not.toHaveBeenCalled();
  });

  it("rejects an unsupported account provider with durable capability evidence", async () => {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, 'telegram', ?, 'ready', ?, ?)",
      ).bind(
        "connection_human_telegram",
        tenantId,
        identityId,
        "Human Telegram",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "connection_human_telegram",
        "gateway_route_human",
        "bridge-telegram",
        "route-user-human-telegram",
        "route-room-human-telegram",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      ).bind(
        "account_human_telegram",
        "connection_human_telegram",
        timestamp,
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_capabilities (tenant_id, connection_id, capability, created_at) VALUES (?, ?, 'receipt.read', ?)",
      ).bind(tenantId, "connection_human_telegram", timestamp),
      env.CONTROL_DB.prepare(
        "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, provider_login_id, connection_id, link_session_id, created_at) VALUES (?, 'telegram', ?, ?, ?, ?, ?)",
      ).bind(
        tenantId,
        "b".repeat(64),
        "login-telegram",
        "connection_human_telegram",
        "link-telegram",
        timestamp,
      ),
      env.CONTROL_DB.prepare(
        "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'receipt.send', 'all_chats', 'active', ?, ?)",
      ).bind(
        "grant_receipt_telegram",
        tenantId,
        "membership_human",
        identityId,
        "account_human_telegram",
        timestamp,
        timestamp,
      ),
    ]);
    const dispatchReceipt = vi.fn();
    const unsupportedAccount = "account_human_telegram";
    const projection = projectionFor(
      targetFor({
        account_id: unsupportedAccount,
        connection_id: "connection_human_telegram",
        platform: "telegram",
      }),
    );
    const app = createTestApp(projection, dispatchReceipt);
    const response = await request(
      app,
      projection,
      `/api/v1/conversations/${conversationId}/receipts/read`,
      {
        method: "POST",
        body: requestBody("receipt-idempotency-unsupported", {
          account_id: unsupportedAccount,
        }),
      },
    );

    expect(response.status).toBe(200);
    const result = ReadReceiptResultSchema.parse(await response.json());
    expect(result).toMatchObject({
      status: "rejected",
      failure_code: "missing_capability",
    });
    expect(dispatchReceipt).not.toHaveBeenCalled();
  });

  it("keeps a provider timeout unknown and exposes it to a later read", async () => {
    const dispatchReceipt = vi.fn(async () => {
      throw new ReceiptProviderError("timeout");
    });
    const projection = projectionFor();
    const app = createTestApp(projection, dispatchReceipt);
    const response = await request(
      app,
      projection,
      `/api/v1/conversations/${conversationId}/receipts/read`,
      { method: "POST", body: requestBody("receipt-idempotency-timeout") },
    );
    const result = ReadReceiptResultSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      status: "unknown",
      failure_code: "provider_timeout",
      matrix_stage: "unknown",
      bridge_stage: "unknown",
      provider_stage: "unknown",
    });

    const getResponse = await request(
      app,
      projection,
      `/api/v1/receipts/${result.operation_id}`,
      { method: "GET" },
    );
    expect(getResponse.status).toBe(200);
    expect(
      ReadReceiptOperationSchema.parse(await getResponse.json()),
    ).toMatchObject({ status: "unknown", failure_code: "provider_timeout" });
  });

  it("rejects a mismatched account before creating or dispatching an operation", async () => {
    const dispatchReceipt = vi.fn();
    const projection: ReceiptProjection = {
      ...projectionFor(),
      resolveConversationOwner: async () => ({
        tenant_id: tenantId,
        conversation_id: conversationId,
        identity_id: identityId,
        account_id: "account_other",
        connection_id: "connection_human_whatsapp",
        platform: "whatsapp",
      }),
    };
    const app = createTestApp(projection, dispatchReceipt);
    const response = await request(
      app,
      projection,
      `/api/v1/conversations/${conversationId}/receipts/read`,
      { method: "POST", body: requestBody("receipt-idempotency-mismatch") },
    );

    const body = ApiErrorResponseSchema.parse(await response.json());
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
    expect(dispatchReceipt).not.toHaveBeenCalled();
    const operationCount = await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM receipt_operations",
    ).first<{ count: number }>();
    expect(operationCount?.count).toBe(0);
  });
});
