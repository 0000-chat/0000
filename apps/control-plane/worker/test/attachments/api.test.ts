import { env, runInDurableObject } from "cloudflare:test";
import {
  AttachmentMetadataSchema,
  ApiErrorResponseSchema,
  MessagePageResultSchema,
  type ProjectionEventEnvelope,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import type { AttachmentProvider } from "../../attachments/provider";
import { sha256Hex } from "../../archive/codec";
import {
  auth,
  bindingFor,
  event,
  initialize,
} from "../projection/projector-test-support";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const identityId = "identity_human";
const accountId = "account_human";
const connectionId = "connection_human_whatsapp";
const conversationId = "conversation_attachment";
const messageId = "message_attachment";
const attachmentId = "attachment_fixture_image";
const bytes = new TextEncoder().encode("fixture attachment bytes");

const createTestApp = (provider: AttachmentProvider) =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        }
        if (token === "agent-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "agent-subject",
            token_id: "agent-token-id",
          };
        }
        throw new Error("invalid local test token");
      },
    }),
    createAttachmentProvider: () => provider,
  });

const request = async (
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
) =>
  app.request(
    `http://example.test${path}`,
    {
      ...init,
      headers: {
        Authorization: "Bearer human-token",
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    workerEnv,
  );

const fixtureEvents = async (
  attachmentOverrides: Record<string, unknown> = {},
): Promise<ProjectionEventEnvelope[]> => {
  const sha256 = await sha256Hex(bytes);
  return [
    event(
      "event_attachment_shell",
      { title: "Attachment conversation", archived: false, muted: false },
      "conversation.updated",
      {
        tenant_id: tenantId,
        identity_id: identityId,
        account_id: accountId,
        conversation_id: conversationId,
        occurred_at: "2026-09-07T01:00:00.000Z",
        observed_at: "2026-09-07T01:00:01.000Z",
      },
    ),
    event(
      "event_attachment_message",
      {
        message_id: messageId,
        direction: "inbound",
        sender_participant_id: null,
        sender_label: "Fixture sender",
        body: "incoming image",
        reply_to_message_id: null,
        delivery_status: "delivered",
        unread: true,
      },
      "message.created",
      {
        tenant_id: tenantId,
        identity_id: identityId,
        account_id: accountId,
        conversation_id: conversationId,
        occurred_at: "2026-09-07T02:00:00.000Z",
        observed_at: "2026-09-07T02:00:01.000Z",
      },
    ),
    event(
      "event_attachment_observed",
      {
        attachment_id: attachmentId,
        message_id: messageId,
        file_name: "fixture.png",
        mime_type: "image/png",
        size_bytes: bytes.byteLength,
        sha256,
        r2_key: `media/${tenantId}/${sha256}`,
        expires_at: null,
        ...attachmentOverrides,
      },
      "attachment.observed",
      {
        tenant_id: tenantId,
        identity_id: identityId,
        account_id: accountId,
        conversation_id: conversationId,
        occurred_at: "2026-09-07T02:00:00.000Z",
        observed_at: "2026-09-07T02:00:02.000Z",
      },
    ),
  ];
};

const seedProjection = async (
  attachmentOverrides: Record<string, unknown> = {},
) => {
  const stub = workerEnv.TENANT_PROJECTION.getByName(tenantId);
  await initialize(tenantId);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE projection_meta SET state = 'ready'");
  });
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: auth(["projection.write"], [identityId], tenantId),
    mode: "live",
    rebuild_id: null,
    connections: [bindingFor(accountId, connectionId, identityId)],
    events: await fixtureEvents(attachmentOverrides),
    checkpoint: null,
  });
};

const applyAttachmentEvent = async (
  attachmentEvent: ProjectionEventEnvelope,
): Promise<void> => {
  const stub = workerEnv.TENANT_PROJECTION.getByName(tenantId);
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: auth(["projection.write"], [identityId], tenantId),
    mode: "live",
    rebuild_id: null,
    connections: [bindingFor(accountId, connectionId, identityId)],
    events: [attachmentEvent],
    checkpoint: null,
  });
};

describe("authenticated attachment reads", () => {
  beforeEach(async () => {
    await clearDirectory(workerEnv.CONTROL_DB);
    await seedDirectory(workerEnv.CONTROL_DB);
    await seedAccountAccess(workerEnv.CONTROL_DB);
    await runInDurableObject(
      workerEnv.TENANT_PROJECTION.getByName(tenantId),
      async (_instance, state) => {
        const tables = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_sql_schema_migrations'",
          )
          .toArray();
        for (const table of tables) {
          if (!/^[A-Za-z0-9_]+$/u.test(table.name)) {
            throw new Error("unexpected projection table name");
          }
          state.storage.sql.exec(`DELETE FROM "${table.name}"`);
        }
      },
    );
    await workerEnv.CONTROL_DB.prepare(
      "DELETE FROM attachment_download_grants",
    ).run();
  });

  it("issues scoped metadata and returns the bounded fixture bytes", async () => {
    await seedProjection();
    const provider: AttachmentProvider = {
      read: vi.fn(async (input) => ({
        status: "available" as const,
        bytes,
        mime_type: input.expected_mime_type ?? "application/octet-stream",
        sha256: input.expected_sha256 ?? (await sha256Hex(bytes)),
      })),
    };
    const app = createTestApp(provider);

    const metadataResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    expect(metadataResponse.status).toBe(200);
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    expect(metadata).toMatchObject({
      attachment_id: attachmentId,
      message_id: messageId,
      mime_type: "image/png",
      file_name: "fixture.png",
      size_bytes: bytes.byteLength,
      availability: "available",
    });
    expect(metadata.download_grant).toEqual(expect.any(String));

    const downloadResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(bytes);
    expect(provider.read).toHaveBeenCalledTimes(1);

    const messageResponse = await request(
      app,
      `/api/v1/conversations/${conversationId}/messages?identity_id=${identityId}`,
    );
    expect(messageResponse.status).toBe(200);
    const messagePage = MessagePageResultSchema.parse(
      await messageResponse.json(),
    );
    expect(messagePage.items[0]?.attachments).toMatchObject([
      {
        attachment_id: attachmentId,
        availability: "available",
        download_grant: expect.any(String),
      },
    ]);
  });

  it("denies a delegated reader without the human account grant", async () => {
    await seedProjection();
    const provider: AttachmentProvider = {
      read: vi.fn(),
    };
    const app = createTestApp(provider);
    const response = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=identity_agent&account_id=${accountId}`,
      { headers: { Authorization: "Bearer agent-token" } },
    );
    expect(response.status).toBe(403);
    expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "forbidden",
    );
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("reports expired stored metadata without issuing a grant", async () => {
    await seedProjection({
      expires_at: "2026-09-06T23:59:59.000Z",
      r2_key: null,
    });
    const app = createTestApp({ read: vi.fn() });
    const response = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attachment_id: attachmentId,
      availability: "expired",
      download_grant: null,
      download_grant_expires_at: null,
    });
  });

  it("reports malformed stored metadata without issuing a grant", async () => {
    await seedProjection({ r2_key: null });
    const app = createTestApp({ read: vi.fn() });
    const response = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attachment_id: attachmentId,
      availability: "unavailable",
      download_grant: null,
      download_grant_expires_at: null,
    });
  });

  it("keeps a raw attachment deferred until gateway verification supplies plaintext metadata", async () => {
    await seedProjection({ sha256: null, r2_key: null });
    const provider: AttachmentProvider = {
      read: vi.fn(async (input) => ({
        status: "available" as const,
        bytes,
        mime_type: input.expected_mime_type ?? "application/octet-stream",
        sha256: input.expected_sha256 ?? (await sha256Hex(bytes)),
      })),
    };
    const app = createTestApp(provider);

    const pendingResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    expect(pendingResponse.status).toBe(200);
    expect(await pendingResponse.json()).toMatchObject({
      attachment_id: attachmentId,
      availability: "unavailable",
      download_grant: null,
      download_grant_expires_at: null,
    });
    expect(provider.read).not.toHaveBeenCalled();

    const resolvedSha256 = await sha256Hex(bytes);
    await applyAttachmentEvent(
      event(
        "event_attachment_gateway_resolved",
        {
          attachment_id: attachmentId,
          message_id: messageId,
          file_name: "resolved.png",
          mime_type: "image/png",
          size_bytes: bytes.byteLength,
          sha256: resolvedSha256,
          r2_key: `media/${tenantId}/${resolvedSha256}`,
          expires_at: null,
        },
        "attachment.observed",
        {
          tenant_id: tenantId,
          identity_id: identityId,
          account_id: accountId,
          conversation_id: conversationId,
          occurred_at: "2026-09-07T02:30:00.000Z",
          observed_at: "2026-09-07T02:30:01.000Z",
        },
      ),
    );

    const metadataResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    expect(metadata).toMatchObject({
      attachment_id: attachmentId,
      file_name: "resolved.png",
      sha256: resolvedSha256,
      availability: "available",
      download_grant: expect.any(String),
    });

    const downloadResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
    );
    expect(downloadResponse.status).toBe(200);
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(bytes);
    expect(provider.read).toHaveBeenCalledWith(
      expect.objectContaining({
        media_key: `media/${tenantId}/${resolvedSha256}`,
        expected_sha256: resolvedSha256,
      }),
    );
  });

  it("returns a stable unavailable result when the provider rejects media", async () => {
    await seedProjection();
    const provider: AttachmentProvider = {
      read: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "provider_rejected" as const,
      })),
    };
    const app = createTestApp(provider);
    const metadataResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    const response = await request(
      app,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
    );
    expect(response.status).toBe(410);
    expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "attachment_unavailable",
    );
    expect(provider.read).toHaveBeenCalledTimes(1);
  });

  it("rechecks the stored revision before releasing a previously granted file", async () => {
    await seedProjection();
    const provider: AttachmentProvider = {
      read: vi.fn(async () => ({
        status: "available" as const,
        bytes,
        mime_type: "image/png",
        sha256: await sha256Hex(bytes),
      })),
    };
    const app = createTestApp(provider);
    const metadataResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    const sha256 = await sha256Hex(bytes);
    await applyAttachmentEvent(
      event(
        "event_attachment_revision",
        {
          attachment_id: attachmentId,
          message_id: messageId,
          file_name: "fixture-revised.png",
          mime_type: "image/png",
          size_bytes: bytes.byteLength,
          sha256,
          r2_key: `media/${tenantId}/${sha256}`,
          expires_at: null,
        },
        "attachment.observed",
        {
          tenant_id: tenantId,
          identity_id: identityId,
          account_id: accountId,
          conversation_id: conversationId,
          occurred_at: "2026-09-07T03:00:00.000Z",
          observed_at: "2026-09-07T03:00:01.000Z",
        },
      ),
    );
    const response = await request(
      app,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
    );
    expect(response.status).toBe(409);
    expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "attachment_unavailable",
    );
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("does not release bytes after an attachment is tombstoned", async () => {
    await seedProjection();
    const provider: AttachmentProvider = {
      read: vi.fn(async () => ({
        status: "available" as const,
        bytes,
        mime_type: "image/png",
        sha256: await sha256Hex(bytes),
      })),
    };
    const app = createTestApp(provider);
    const metadataResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    await applyAttachmentEvent(
      event(
        "event_attachment_deleted",
        {
          resource_type: "attachment",
          resource_id: attachmentId,
          reason_code: "removed",
        },
        "deletion.tombstone",
        {
          tenant_id: tenantId,
          identity_id: identityId,
          account_id: accountId,
          conversation_id: conversationId,
          occurred_at: "2026-09-07T03:00:00.000Z",
          observed_at: "2026-09-07T03:00:01.000Z",
        },
      ),
    );
    const response = await request(
      app,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
    );
    expect(response.status).toBe(410);
    expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "attachment_removed",
    );
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("does not return bytes when the grant is expired", async () => {
    await seedProjection();
    const provider: AttachmentProvider = {
      read: vi.fn(async () => ({
        status: "available" as const,
        bytes,
        mime_type: "image/png",
        sha256: await sha256Hex(bytes),
      })),
    };
    const clock = new Date("2026-09-07T00:00:00.000Z");
    const clockedApp = createApp({
      createTokenVerifier: () => ({
        verify: async (): Promise<VerifiedSubject> => ({
          issuer: "https://issuer.example/",
          subject: "human-subject",
        }),
      }),
      createAttachmentProvider: () => provider,
      attachmentNow: () => clock,
    });
    const metadataResponse = await request(
      clockedApp,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    clock.setTime(clock.getTime() + 6 * 60 * 1000);
    const response = await request(
      clockedApp,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
    );
    expect(response.status).toBe(403);
    expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "forbidden",
    );
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("rechecks the grant after a provider response crosses its expiry", async () => {
    await seedProjection();
    const clock = new Date("2026-09-07T00:00:00.000Z");
    const provider: AttachmentProvider = {
      read: vi.fn(async () => {
        clock.setTime(clock.getTime() + 6 * 60 * 1000);
        return {
          status: "available" as const,
          bytes,
          mime_type: "image/png",
          sha256: await sha256Hex(bytes),
        };
      }),
    };
    const clockedApp = createApp({
      createTokenVerifier: () => ({
        verify: async (): Promise<VerifiedSubject> => ({
          issuer: "https://issuer.example/",
          subject: "human-subject",
        }),
      }),
      createAttachmentProvider: () => provider,
      attachmentNow: () => clock,
    });
    const metadataResponse = await request(
      clockedApp,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    const response = await request(
      clockedApp,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
    );
    expect(response.status).toBe(403);
    const errorBody = ApiErrorResponseSchema.parse(await response.json());
    expect(errorBody.error.code).toBe("forbidden");
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorBody)).not.toContain("fixture attachment bytes");
  });

  it("revalidates account identity state after provider I/O", async () => {
    await seedProjection();
    const provider: AttachmentProvider = {
      read: vi.fn(async () => {
        await workerEnv.CONTROL_DB.prepare(
          "UPDATE identities SET status = 'disabled' WHERE tenant_id = ? AND id = ?",
        )
          .bind(tenantId, identityId)
          .run();
        return {
          status: "available" as const,
          bytes,
          mime_type: "image/png",
          sha256: await sha256Hex(bytes),
        };
      }),
    };
    const app = createTestApp(provider);
    const metadataResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=${identityId}`,
    );
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    const response = await request(
      app,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
    );
    expect(response.status).toBe(403);
    expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "forbidden",
    );
    expect(provider.read).toHaveBeenCalledTimes(1);
  });

  it("keeps delegated actor and human-owned resource identities separate", async () => {
    await seedProjection();
    await workerEnv.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'conversation.read', 'all_chats', 'active', ?, ?)",
    )
      .bind(
        "grant_fixture_agent_human_account",
        tenantId,
        "membership_agent",
        "identity_agent",
        accountId,
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      )
      .run();
    const provider: AttachmentProvider = {
      read: vi.fn(async (input) => ({
        status: "available" as const,
        bytes,
        mime_type: input.expected_mime_type ?? "application/octet-stream",
        sha256: input.expected_sha256 ?? (await sha256Hex(bytes)),
      })),
    };
    const app = createTestApp(provider);
    const metadataResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}?identity_id=identity_agent&account_id=${accountId}`,
      { headers: { Authorization: "Bearer agent-token" } },
    );
    expect(metadataResponse.status).toBe(200);
    const metadata = AttachmentMetadataSchema.parse(
      await metadataResponse.json(),
    );
    const downloadResponse = await request(
      app,
      `/api/v1/attachments/${attachmentId}/download?download_grant=${encodeURIComponent(metadata.download_grant ?? "")}`,
      { headers: { Authorization: "Bearer agent-token" } },
    );
    expect(downloadResponse.status).toBe(200);
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(bytes);
    expect(provider.read).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_id: identityId,
        account_id: accountId,
      }),
    );
  });
});
