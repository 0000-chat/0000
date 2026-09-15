import {
  ApiErrorResponseSchema,
  AttachmentMetadataSchema,
  MAX_ATTACHMENT_BYTES,
  type AttachmentMetadata,
  type ProjectionAttachment,
  type ProjectionAuthorizationContext,
  type SessionResponse,
} from "@communicator/contracts";
import {
  requireAuthorizedIdentity,
  toGrantedAccountReadAuthorization,
  toGrantedProjectionReadAuthorization,
} from "../read/authorization";
import { ReadError } from "../read/errors";
import { issueAttachmentGrant, readAttachmentGrant } from "./grants";
import { AttachmentProviderError, type AttachmentProvider } from "./provider";
import {
  readAuthorizedMessageRemoval,
  readAuthorizedResourceRemoval,
} from "../removals/service";

type ReadableAttachment = ProjectionAttachment & {
  file_name: string | null;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  media_key: string;
};

export type AttachmentServiceContext = {
  env: Cloudflare.Env;
  authorization: SessionResponse;
  /** Identity selected by the caller; may differ from the resource owner. */
  requestedIdentityId?: string;
  delegated?: boolean;
  now?: () => Date;
  provider: AttachmentProvider;
};

type AttachmentProjection = {
  getAttachment(input: {
    schema_version: 1;
    tenant_id: string;
    identity_id: string;
    attachment_id: string;
    account_id?: string;
    authorization: ProjectionAuthorizationContext;
  }): Promise<ProjectionAttachment | null>;
};

export class AttachmentServiceError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "forbidden"
      | "not_found"
      | "attachment_unavailable"
      | "attachment_removed"
      | "service_unavailable",
    readonly status: 400 | 403 | 404 | 409 | 410 | 503,
    readonly cause?: unknown,
  ) {
    super(code);
    this.name = "AttachmentServiceError";
  }
}

const nowFor = (context: AttachmentServiceContext): Date =>
  context.now?.() ?? new Date();

const projection = (
  context: AttachmentServiceContext,
): AttachmentProjection => {
  const namespace = context.env.TENANT_PROJECTION;
  if (namespace === undefined || typeof namespace.getByName !== "function") {
    throw new AttachmentServiceError("service_unavailable", 503);
  }
  try {
    return namespace.getByName(
      context.authorization.tenant.id,
    ) as unknown as AttachmentProjection;
  } catch (error) {
    throw new AttachmentServiceError("service_unavailable", 503, error);
  }
};

const mapAuthorizationFailure = (error: unknown): AttachmentServiceError => {
  if (error instanceof AttachmentServiceError) return error;
  if (error instanceof ReadError) {
    return new AttachmentServiceError(
      error.code === "service_unavailable"
        ? "service_unavailable"
        : "forbidden",
      error.code === "service_unavailable" ? 503 : 403,
      error,
    );
  }
  return new AttachmentServiceError("service_unavailable", 503, error);
};

const isExpired = (attachment: ProjectionAttachment, now: Date): boolean =>
  attachment.expires_at !== null &&
  Date.parse(attachment.expires_at) <= now.getTime();

const hasReadableMetadata = (
  attachment: ProjectionAttachment,
): attachment is ReadableAttachment =>
  attachment.deleted_at === null &&
  attachment.mime_type !== null &&
  attachment.size_bytes !== null &&
  attachment.sha256 !== null &&
  attachment.media_key !== null &&
  attachment.size_bytes <= MAX_ATTACHMENT_BYTES;

const removalForAttachment = async (
  context: AttachmentServiceContext,
  attachment: ProjectionAttachment,
): Promise<boolean> => {
  const database = context.env.CONTROL_DB;
  if (database === undefined) {
    throw new AttachmentServiceError("service_unavailable", 503);
  }
  try {
    const attachmentRemoval = await readAuthorizedResourceRemoval(database, {
      tenantId: context.authorization.tenant.id,
      resourceType: "attachment",
      resourceId: attachment.attachment_id,
      accountId: attachment.account_id,
      conversationId: attachment.conversation_id,
    });
    if (attachmentRemoval !== null) return true;
    const messageRemoval = await readAuthorizedMessageRemoval(database, {
      tenantId: context.authorization.tenant.id,
      messageId: attachment.message_id,
      accountId: attachment.account_id,
      conversationId: attachment.conversation_id,
    });
    return messageRemoval !== null;
  } catch (error) {
    throw new AttachmentServiceError("service_unavailable", 503, error);
  }
};

const removedMetadata = (
  attachment: ProjectionAttachment,
): AttachmentMetadata =>
  AttachmentMetadataSchema.parse({
    attachment_id: attachment.attachment_id,
    message_id: attachment.message_id,
    mime_type: null,
    file_name: null,
    size_bytes: null,
    sha256: null,
    revision: attachment.revision,
    availability: "removed",
    download_grant: null,
    download_grant_expires_at: null,
  });

export const metadataFor = async (
  context: AttachmentServiceContext,
  attachment: ProjectionAttachment,
): Promise<AttachmentMetadata> => {
  const now = nowFor(context);
  if (await removalForAttachment(context, attachment)) {
    return removedMetadata(attachment);
  }
  if (attachment.deleted_at !== null) {
    return removedMetadata(attachment);
  }
  if (isExpired(attachment, now)) {
    return AttachmentMetadataSchema.parse({
      attachment_id: attachment.attachment_id,
      message_id: attachment.message_id,
      mime_type: attachment.mime_type,
      file_name: attachment.file_name,
      size_bytes: attachment.size_bytes,
      sha256: attachment.sha256,
      revision: attachment.revision,
      availability: "expired",
      download_grant: null,
      download_grant_expires_at: null,
    });
  }
  if (!hasReadableMetadata(attachment)) {
    return AttachmentMetadataSchema.parse({
      attachment_id: attachment.attachment_id,
      message_id: attachment.message_id,
      mime_type: attachment.mime_type,
      file_name: attachment.file_name,
      size_bytes: attachment.size_bytes,
      sha256: attachment.sha256,
      revision: attachment.revision,
      availability: "unavailable",
      download_grant: null,
      download_grant_expires_at: null,
    });
  }
  try {
    const grant = await issueAttachmentGrant(
      context.env.CONTROL_DB,
      context.authorization.tenant.id,
      context.requestedIdentityId ?? attachment.identity_id,
      attachment,
      now,
    );
    if (await removalForAttachment(context, attachment)) {
      return removedMetadata(attachment);
    }
    return AttachmentMetadataSchema.parse({
      attachment_id: attachment.attachment_id,
      message_id: attachment.message_id,
      mime_type: attachment.mime_type,
      file_name: attachment.file_name,
      size_bytes: attachment.size_bytes,
      sha256: attachment.sha256,
      revision: attachment.revision,
      availability: "available",
      download_grant: grant.token,
      download_grant_expires_at: grant.expires_at,
    });
  } catch (error) {
    throw new AttachmentServiceError("service_unavailable", 503, error);
  }
};

const resolveAttachment = async (
  context: AttachmentServiceContext,
  input: { attachment_id: string; identity_id?: string; account_id?: string },
): Promise<ProjectionAttachment> => {
  if (input.identity_id === undefined) {
    throw new AttachmentServiceError("invalid_request", 400);
  }
  let resourceIdentityId = input.identity_id;
  let authorization: ProjectionAuthorizationContext;
  try {
    if (input.account_id === undefined) {
      requireAuthorizedIdentity(
        context.authorization,
        input.identity_id,
        "conversation.read",
      );
      authorization = await toGrantedProjectionReadAuthorization(
        context.env,
        context.authorization,
        input.identity_id,
        context.delegated,
      );
    } else {
      const resolved = await toGrantedAccountReadAuthorization(
        context.env,
        context.authorization,
        input.identity_id,
        input.account_id,
        context.delegated,
      );
      resourceIdentityId = resolved.resourceIdentityId;
      authorization = resolved.authorization;
    }
  } catch (error) {
    throw mapAuthorizationFailure(error);
  }
  const row = await projection(context).getAttachment({
    schema_version: 1,
    tenant_id: context.authorization.tenant.id,
    identity_id: resourceIdentityId,
    attachment_id: input.attachment_id,
    ...(input.account_id === undefined ? {} : { account_id: input.account_id }),
    authorization,
  });
  if (row === null) throw new AttachmentServiceError("not_found", 404);
  return row;
};

/** Resolve the row through the same account/chat grant as stored message reads. */
export const getAttachmentMetadata = async (
  context: AttachmentServiceContext,
  input: { attachment_id: string; identity_id: string; account_id?: string },
): Promise<AttachmentMetadata> => {
  let row: ProjectionAttachment;
  try {
    row = await resolveAttachment(context, input);
  } catch (error) {
    throw error instanceof AttachmentServiceError
      ? error
      : mapAuthorizationFailure(error);
  }
  return metadataFor(
    { ...context, requestedIdentityId: input.identity_id },
    row,
  );
};

const assertCurrentAuthorization = async (
  context: AttachmentServiceContext,
  grant: Awaited<ReturnType<typeof readAttachmentGrant>>,
): Promise<ReadableAttachment> => {
  if (grant === null) throw new AttachmentServiceError("forbidden", 403);
  let resolved: Awaited<ReturnType<typeof toGrantedAccountReadAuthorization>>;
  try {
    resolved = await toGrantedAccountReadAuthorization(
      context.env,
      context.authorization,
      grant.actor_identity_id,
      grant.account_id,
      context.delegated,
    );
  } catch (error) {
    throw mapAuthorizationFailure(error);
  }
  const row = await projection(context).getAttachment({
    schema_version: 1,
    tenant_id: context.authorization.tenant.id,
    identity_id: resolved.resourceIdentityId,
    attachment_id: grant.attachment_id,
    account_id: grant.account_id,
    authorization: resolved.authorization,
  });
  if (row === null) throw new AttachmentServiceError("not_found", 404);
  if (
    row.identity_id !== grant.identity_id ||
    row.account_id !== grant.account_id ||
    row.connection_id !== grant.connection_id ||
    row.conversation_id !== grant.conversation_id ||
    row.message_id !== grant.message_id
  ) {
    throw new AttachmentServiceError("forbidden", 403);
  }
  if (row.revision !== grant.revision) {
    throw new AttachmentServiceError("attachment_unavailable", 409);
  }
  if (await removalForAttachment(context, row)) {
    throw new AttachmentServiceError("attachment_removed", 410);
  }
  if (row.deleted_at !== null) {
    throw new AttachmentServiceError("attachment_removed", 410);
  }
  if (isExpired(row, nowFor(context))) {
    throw new AttachmentServiceError("attachment_unavailable", 410);
  }
  if (!hasReadableMetadata(row)) {
    throw new AttachmentServiceError("attachment_unavailable", 410);
  }
  return row;
};

export const downloadAttachment = async (
  context: AttachmentServiceContext,
  token: string | undefined,
  expectedAttachmentId?: string,
): Promise<Response> => {
  if (token === undefined || token.length === 0) {
    throw new AttachmentServiceError("forbidden", 403);
  }
  let grant: Awaited<ReturnType<typeof readAttachmentGrant>>;
  try {
    grant = await readAttachmentGrant(
      context.env.CONTROL_DB,
      context.authorization.tenant.id,
      token,
      nowFor(context),
    );
  } catch (error) {
    throw new AttachmentServiceError("service_unavailable", 503, error);
  }
  if (
    grant !== null &&
    expectedAttachmentId !== undefined &&
    grant.attachment_id !== expectedAttachmentId
  ) {
    throw new AttachmentServiceError("forbidden", 403);
  }
  const before = await assertCurrentAuthorization(context, grant);
  let result;
  try {
    result = await context.provider.read({
      tenant_id: context.authorization.tenant.id,
      account_id: before.account_id,
      connection_id: before.connection_id,
      identity_id: before.identity_id,
      conversation_id: before.conversation_id,
      message_id: before.message_id,
      attachment_id: before.attachment_id,
      revision: before.revision,
      provider: before.platform,
      media_key: before.media_key,
      expected_size_bytes: before.size_bytes,
      expected_sha256: before.sha256,
      expected_mime_type: before.mime_type,
    });
  } catch (error) {
    if (error instanceof AttachmentProviderError) {
      throw new AttachmentServiceError("attachment_unavailable", 410, error);
    }
    throw new AttachmentServiceError("service_unavailable", 503, error);
  }
  // This second read is the authorization/removal race fence. No provider
  // result is released until the grant and latest projection still match.
  let currentGrant: Awaited<ReturnType<typeof readAttachmentGrant>>;
  try {
    currentGrant = await readAttachmentGrant(
      context.env.CONTROL_DB,
      context.authorization.tenant.id,
      token,
      nowFor(context),
    );
  } catch (error) {
    throw new AttachmentServiceError("service_unavailable", 503, error);
  }
  const after = await assertCurrentAuthorization(context, currentGrant);
  if (result.status === "unavailable") {
    throw new AttachmentServiceError("attachment_unavailable", 410);
  }
  if (
    result.bytes.byteLength !== before.size_bytes ||
    result.sha256 !== before.sha256 ||
    result.mime_type !== before.mime_type
  ) {
    throw new AttachmentServiceError("attachment_unavailable", 410);
  }
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": after.mime_type,
    "content-length": String(result.bytes.byteLength),
    etag: `"${result.sha256}"`,
    "x-content-type-options": "nosniff",
  });
  if (after.file_name !== null) {
    const safeName = after.file_name.replace(/[\r\n"\\]/gu, "_").slice(0, 255);
    headers.set("content-disposition", `attachment; filename="${safeName}"`);
  }
  const body = new ArrayBuffer(result.bytes.byteLength);
  new Uint8Array(body).set(result.bytes);
  return new Response(body, {
    status: 200,
    headers,
  });
};

export const attachmentErrorBody = (error: AttachmentServiceError) =>
  ApiErrorResponseSchema.parse({
    error: {
      code: error.code,
      message:
        error.code === "attachment_removed"
          ? "Attachment removed"
          : error.code === "attachment_unavailable"
            ? "Attachment unavailable"
            : error.code === "forbidden"
              ? "Forbidden"
              : error.code === "not_found"
                ? "Resource not found"
                : error.code === "invalid_request"
                  ? "Invalid request"
                  : "Service unavailable",
    },
  });
