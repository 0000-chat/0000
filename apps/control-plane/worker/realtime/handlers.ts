import {
  ApiErrorResponseSchema,
  MAX_REALTIME_ATTACHMENT_JSON_BYTES,
  REALTIME_SUBPROTOCOL,
  RealtimeTicketResponseSchema,
  type ApiErrorResponse,
  type RealtimeTicketRequest,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  authorizeRealtimeRequest,
  RealtimeAuthorizationError,
} from "./authorization";
import { parseRealtimeUpgradeContext } from "./contracts";
import {
  consumeRealtimeTicket,
  issueRealtimeTicket,
  RealtimeTicketError,
} from "./ticket-repository";
import { isRealtimeTicket } from "./token";

export const REALTIME_INTERNAL_CONTEXT_HEADER = "X-Communicator-Realtime-Context";
export const REALTIME_INTERNAL_UPGRADE_URL = "https://tenant-projection.internal/realtime";

type RealtimeRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

type RealtimeRouteContext = Context<RealtimeRouteEnv>;
type RealtimeTicketHandlerInput = {
  out: { json: RealtimeTicketRequest };
};

type PublicErrorCode = ApiErrorResponse["error"]["code"];
type PublicErrorStatus = 400 | 401 | 404 | 503;

const PUBLIC_ERROR_MESSAGES: Record<PublicErrorCode, string> = {
  unauthenticated: "Authentication required",
  invalid_request: "Invalid request",
  not_found: "Resource not found",
  tenant_selection_required: "Select an authorized tenant",
  service_unavailable: "Service unavailable",
};

const publicError = (code: PublicErrorCode): ApiErrorResponse =>
  ApiErrorResponseSchema.parse({
    error: { code, message: PUBLIC_ERROR_MESSAGES[code] },
  });

const noStore = (response: Response): Response => {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};

const responseForError = (
  context: RealtimeRouteContext,
  code: PublicErrorCode,
  status: PublicErrorStatus,
): Response => noStore(context.json(publicError(code), status));

const ticketErrorResponse = (
  context: RealtimeRouteContext,
  error: unknown,
): Response => {
  if (error instanceof RealtimeAuthorizationError) {
    return responseForError(
      context,
      error.code === "not_found" ? "not_found" : "invalid_request",
      error.code === "not_found" ? 404 : 400,
    );
  }

  if (error instanceof RealtimeTicketError) {
    return responseForError(
      context,
      error.code === "invalid_request" ? "invalid_request" : "service_unavailable",
      error.code === "invalid_request" ? 400 : 503,
    );
  }

  return responseForError(context, "service_unavailable", 503);
};

const websocketUrl = (requestUrl: string, ticket: string): string => {
  const url = new URL("/api/v1/realtime", requestUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RealtimeTicketError("invalid_request");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.searchParams.set("ticket", ticket);
  return url.toString();
};

export const realtimeTicketHandler: Handler<
  RealtimeRouteEnv,
  string,
  RealtimeTicketHandlerInput
> = async (
  context,
) => {
  try {
    const request = context.req.valid("json");
    const authorization = authorizeRealtimeRequest(
      context.get("authorization"),
      request,
    );
    const issued = await issueRealtimeTicket(
      context.env.CONTROL_DB,
      authorization,
    );
    const response = RealtimeTicketResponseSchema.parse({
      schema_version: 1,
      ticket: issued.ticket,
      expires_at: issued.expires_at,
      websocket_url: websocketUrl(context.req.url, issued.ticket),
    });
    return noStore(context.json(response, 201));
  } catch (error) {
    return ticketErrorResponse(context, error);
  }
};

const hasExactUpgradeIntent = (request: Request): boolean =>
  request.method === "GET" &&
  request.headers.get("Upgrade") === "websocket" &&
  request.headers.get("Sec-WebSocket-Protocol") === REALTIME_SUBPROTOCOL;

type UpgradeTicketResult =
  | { kind: "invalid_request" }
  | { kind: "unauthenticated" }
  | { kind: "ticket"; value: string };

const ticketFromUpgradeUrl = (request: Request): UpgradeTicketResult => {
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  if (entries.length === 0) return { kind: "unauthenticated" };
  if (entries.length !== 1 || entries[0]?.[0] !== "ticket") {
    return { kind: "invalid_request" };
  }
  if (!isRealtimeTicket(entries[0][1])) return { kind: "unauthenticated" };
  return { kind: "ticket", value: entries[0][1] };
};

const internalUpgradeRequest = (
  contextJson: string,
): Request => new Request(REALTIME_INTERNAL_UPGRADE_URL, {
  method: "GET",
  headers: {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
    [REALTIME_INTERNAL_CONTEXT_HEADER]: contextJson,
  },
});

const projectionStub = (
  env: Cloudflare.Env,
  tenantId: string,
): DurableObjectStub => {
  const namespace = env.TENANT_PROJECTION;
  if (namespace === undefined || typeof namespace.getByName !== "function") {
    throw new Error("realtime projection unavailable");
  }
  return namespace.getByName(tenantId);
};

export const realtimeUpgradeHandler: Handler<RealtimeRouteEnv> = async (
  context,
) => {
  const request = context.req.raw;
  if (!hasExactUpgradeIntent(request)) {
    return responseForError(context, "invalid_request", 400);
  }

  const ticketResult = ticketFromUpgradeUrl(request);
  if (ticketResult.kind === "invalid_request") {
    return responseForError(context, "invalid_request", 400);
  }
  if (ticketResult.kind === "unauthenticated") {
    return responseForError(context, "unauthenticated", 401);
  }
  const ticket = ticketResult.value;

  let consumed;
  try {
    consumed = await consumeRealtimeTicket(context.env.CONTROL_DB, ticket);
  } catch {
    return responseForError(context, "service_unavailable", 503);
  }
  if (consumed === null) {
    return responseForError(context, "unauthenticated", 401);
  }

  let contextJson: string;
  try {
    contextJson = JSON.stringify(parseRealtimeUpgradeContext(consumed));
    if (
      new TextEncoder().encode(contextJson).byteLength >
      MAX_REALTIME_ATTACHMENT_JSON_BYTES
    ) {
      return responseForError(context, "service_unavailable", 503);
    }
  } catch {
    return responseForError(context, "service_unavailable", 503);
  }

  try {
    const stub = projectionStub(context.env, consumed.tenant_id);
    const response = await stub.fetch(internalUpgradeRequest(contextJson));
    if (
      response.status !== 101 ||
      response.headers.get("Sec-WebSocket-Protocol") !== REALTIME_SUBPROTOCOL
    ) {
      return responseForError(context, "service_unavailable", 503);
    }
    return response;
  } catch {
    return responseForError(context, "service_unavailable", 503);
  }
};
