import { validateConversationUrl } from "./wait.js";

const USAGE = "Usage: msg webhooks <conversation-url> list | create <https-url> | remove <endpoint-id> | disable <endpoint-id> | enable <endpoint-id> | rotate <endpoint-id> | redeliver <endpoint-id> <event-id>";

export type WebhooksCommand =
  | { readonly conversationUrl: string; readonly operation: "list" }
  | { readonly conversationUrl: string; readonly operation: "create"; readonly destinationUrl: string }
  | { readonly conversationUrl: string; readonly endpointId: string; readonly operation: "remove" | "disable" | "enable" | "rotate" }
  | { readonly conversationUrl: string; readonly endpointId: string; readonly eventId: string; readonly operation: "redeliver" };

export type WebhooksOptions = WebhooksCommand & {
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly serviceOrigin?: string;
};

export class WebhooksSignalError extends Error {
  constructor() { super("The msg webhooks command was interrupted."); }
}

export function parseWebhooksCommand(args: readonly string[], serviceOrigin?: string): WebhooksCommand {
  if (args[0] !== "webhooks" || args.length < 3) throw new Error(USAGE);
  const conversationUrl = validateConversationUrl(args[1] ?? "", serviceOrigin);
  const operation = args[2];
  if (operation === "list" && args.length === 3) return { conversationUrl, operation };
  if (operation === "create" && args.length === 4 && args[3]) {
    return { conversationUrl, destinationUrl: args[3], operation };
  }
  const endpointId = args[3];
  if ((operation === "remove" || operation === "disable" || operation === "enable" || operation === "rotate")
    && args.length === 4 && endpointId && /^[0-9a-f-]{36}$/iu.test(endpointId)) {
    return { conversationUrl, endpointId, operation };
  }
  const eventId = args[4];
  if (operation === "redeliver" && args.length === 5 && endpointId && eventId
    && /^[0-9a-f-]{36}$/iu.test(endpointId) && /^[0-9a-f-]{36}$/iu.test(eventId)) {
    return { conversationUrl, endpointId, eventId, operation };
  }
  throw new Error(USAGE);
}

export async function manageWebhooks(options: WebhooksOptions): Promise<unknown> {
  if (options.signal?.aborted) throw new WebhooksSignalError();
  const endpoint = webhooksUrl(options.conversationUrl, options.serviceOrigin);
  let method: "DELETE" | "GET" | "POST";
  let body: string | undefined;
  if (options.operation === "remove") {
    endpoint.pathname += `/${encodeURIComponent(options.endpointId)}`;
    method = "DELETE";
  } else if (options.operation === "create") {
    method = "POST";
    body = JSON.stringify({ url: options.destinationUrl });
  } else if (options.operation === "disable" || options.operation === "enable" || options.operation === "rotate") {
    endpoint.pathname += `/${encodeURIComponent(options.endpointId)}/${options.operation === "rotate" ? "rotate-secret" : options.operation}`;
    method = "POST";
  } else if (options.operation === "redeliver") {
    endpoint.pathname += `/${encodeURIComponent(options.endpointId)}/deliveries/${encodeURIComponent(options.eventId)}/redeliver`;
    method = "POST";
  } else {
    method = "GET";
  }

  try {
    const response = await options.fetch(endpoint, {
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      method,
      redirect: "error",
      signal: options.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    if (!response.ok) throw new Error(responseErrorMessage(response.status, value));
    if (value === undefined) throw new Error("The msg service returned an invalid webhook response.");
    return value;
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw new WebhooksSignalError();
    throw error;
  }
}

function webhooksUrl(conversationUrl: string, serviceOrigin?: string): URL {
  const url = new URL(validateConversationUrl(conversationUrl, serviceOrigin));
  url.pathname = `${url.pathname}/webhooks`;
  return url;
}

function responseErrorMessage(status: number, value: unknown): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message;
  }
  return `The msg service returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
    || error instanceof Error && error.name === "AbortError";
}
