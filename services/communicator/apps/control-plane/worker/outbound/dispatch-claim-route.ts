import {
  OutboundCapabilitySchema,
  CommunicatorIdSchema,
} from "@communicator/contracts";
import type { Context } from "hono";
import { z } from "zod";
import { claimOutboundDispatch } from "./authority";
import type {
  ClaimOutboundDispatchInput,
  ClaimOutboundDispatchResult,
  OutboundCapability,
  PrivateAuthorityClaimInput,
  PrivateAuthorityClaimResult,
} from "./authority-types";
import { claimPrivateAuthority } from "./private-authority";

const MAX_CLAIM_BODY_BYTES = 64 * 1024;
const MAX_CLAIM_CLOCK_SKEW_MS = 30_000;
const MAX_CLAIM_LIFETIME_MS = 60_000;
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const TimestampSchema = z.string().datetime({ offset: true });
const TupleSchema = z.object({
  schema_version: z.literal(1),
  tenant_id: CommunicatorIdSchema,
  membership_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  account_id: CommunicatorIdSchema,
  conversation_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  reservation_id: CommunicatorIdSchema,
  operation_id: CommunicatorIdSchema,
  request_hash: DigestSchema,
  capability: OutboundCapabilitySchema,
  now: TimestampSchema,
  expires_at: TimestampSchema,
});

const MessageClaimSchema = TupleSchema.extend({
  operation: z.literal("message.send"),
  command_id: CommunicatorIdSchema,
  dispatch_id: CommunicatorIdSchema,
  transaction_id: CommunicatorIdSchema,
  request_digest: DigestSchema,
  body_digest: DigestSchema,
  claim_id: CommunicatorIdSchema.optional(),
}).strict();

const OperationClaimSchema = TupleSchema.extend({
  operation: z.enum([
    "conversation.create",
    "receipt.send",
    "group.create",
    "group.manage",
  ]),
  session_generation: TimestampSchema,
  claim_id: CommunicatorIdSchema.optional(),
}).strict();

const DispatchClaimSchema = z.discriminatedUnion("operation", [
  MessageClaimSchema,
  OperationClaimSchema,
]);

type DispatchClaim = z.infer<typeof DispatchClaimSchema>;

type RuntimeEnvironment = Cloudflare.Env & {
  CONNECTION_GATEWAY_TOKEN?: string;
};

type BoundedBody =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "too_large" };

const readBoundedBody = async (request: Request): Promise<BoundedBody> => {
  if (request.body === null) return { status: "ok", bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_CLAIM_BODY_BYTES) {
        await reader.cancel();
        return { status: "too_large" };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", bytes };
};

const validClaimWindow = (
  now: string,
  expiresAt: string,
  clock: () => Date,
): boolean => {
  const requestedNow = Date.parse(now);
  const requestedExpiry = Date.parse(expiresAt);
  const workerNow = clock().getTime();
  return (
    Number.isFinite(requestedNow) &&
    Number.isFinite(requestedExpiry) &&
    requestedNow >= workerNow - MAX_CLAIM_CLOCK_SKEW_MS &&
    requestedNow <= workerNow + MAX_CLAIM_CLOCK_SKEW_MS &&
    requestedExpiry > workerNow &&
    requestedExpiry <= workerNow + MAX_CLAIM_LIFETIME_MS &&
    requestedExpiry > requestedNow
  );
};

const unauthorized = (context: Context): Response =>
  context.json({ error: "unauthorized" }, 401, {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });

const jsonResponse = (
  context: Context,
  body: unknown,
  status: 200 | 400 | 403 | 413 | 500 | 503,
): Response =>
  context.json(body, status, {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
  });

const capabilityInput = (capability: OutboundCapability): OutboundCapability =>
  capability;

const claimMessage = async (
  database: D1Database,
  value: Extract<DispatchClaim, { operation: "message.send" }>,
): Promise<ClaimOutboundDispatchResult> => {
  const input: ClaimOutboundDispatchInput = {
    tenant_id: value.tenant_id,
    membership_id: value.membership_id,
    identity_id: value.identity_id,
    account_id: value.account_id,
    conversation_id: value.conversation_id,
    connection_id: value.connection_id,
    grant_id:
      value.capability.kind === "account_grant"
        ? value.capability.grant_id
        : null,
    capability: capabilityInput(value.capability),
    reservation_id: value.reservation_id,
    command_id: value.command_id,
    dispatch_id: value.dispatch_id,
    transaction_id: value.transaction_id,
    request_digest: value.request_digest,
    body_digest: value.body_digest,
    ...(value.claim_id === undefined ? {} : { claim_id: value.claim_id }),
    now: value.now,
    expires_at: value.expires_at,
  };
  return claimOutboundDispatch(database, input);
};

const claimOperation = async (
  database: D1Database,
  value: Exclude<DispatchClaim, { operation: "message.send" }>,
): Promise<PrivateAuthorityClaimResult> => {
  const input: PrivateAuthorityClaimInput = {
    tenant_id: value.tenant_id,
    membership_id: value.membership_id,
    identity_id: value.identity_id,
    account_id: value.account_id,
    conversation_id: value.conversation_id,
    connection_id: value.connection_id,
    grant_id:
      value.capability.kind === "account_grant"
        ? value.capability.grant_id
        : null,
    capability: capabilityInput(value.capability),
    operation_scope: value.operation,
    reservation_id: value.reservation_id,
    operation_id: value.operation_id,
    request_hash: value.request_hash,
    session_generation: value.session_generation,
    ...(value.claim_id === undefined ? {} : { claim_id: value.claim_id }),
    now: value.now,
    expires_at: value.expires_at,
  };
  return claimPrivateAuthority(database, input);
};

/** Private, bearer-authenticated provider claim boundary. */
export const dispatchClaimHandlerAt = async (
  context: Context<any>,
  clock: () => Date = () => new Date(),
): Promise<Response> => {
  const runtime = context.env as RuntimeEnvironment;
  const secret = runtime.CONNECTION_GATEWAY_TOKEN ?? "";
  const authorization = context.req.header("Authorization");
  if (secret.length < 16 || authorization !== `Bearer ${secret}`) {
    return unauthorized(context);
  }
  const contentLength = context.req.header("Content-Length");
  if (
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > MAX_CLAIM_BODY_BYTES)
  ) {
    return jsonResponse(context, { error: "body_too_large" }, 413);
  }
  const body = await readBoundedBody(context.req.raw);
  if (body.status === "too_large")
    return jsonResponse(context, { error: "body_too_large" }, 413);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
  } catch {
    return jsonResponse(context, { error: "invalid_request" }, 400);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return jsonResponse(context, { error: "invalid_request" }, 400);
  }
  const parsed = DispatchClaimSchema.safeParse(parsedJson);
  if (!parsed.success)
    return jsonResponse(context, { error: "invalid_request" }, 400);
  const workerClock = clock();
  if (
    !validClaimWindow(
      parsed.data.now,
      parsed.data.expires_at,
      () => workerClock,
    )
  )
    return jsonResponse(context, { error: "invalid_request" }, 400);
  const workerNow = workerClock.toISOString();
  const workerExpiry = new Date(
    Math.min(
      Date.parse(parsed.data.expires_at),
      workerClock.getTime() + MAX_CLAIM_LIFETIME_MS,
    ),
  ).toISOString();
  const normalized = {
    ...parsed.data,
    now: workerNow,
    expires_at: workerExpiry,
  } as DispatchClaim;
  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function")
    return jsonResponse(context, { error: "service_unavailable" }, 503);
  try {
    const result =
      normalized.operation === "message.send"
        ? await claimMessage(database, normalized)
        : await claimOperation(database, normalized);
    return jsonResponse(
      context,
      result,
      result.status === "denied" ? 403 : 200,
    );
  } catch {
    return jsonResponse(context, { error: "service_unavailable" }, 503);
  }
};

export const dispatchClaimHandler = (context: Context): Promise<Response> =>
  dispatchClaimHandlerAt(context);
