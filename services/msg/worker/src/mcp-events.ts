/** MCP 2.0 event contracts and signing helpers used by the Msg Worker. */

export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const MCP_SERVER_VERSION = "1.0.0" as const;
export const MCP_MESSAGE_EVENT = "message.created" as const;
export const MCP_EVENT_PREVIEW_BYTES = 512;
export const MCP_EVENT_MAX_BYTES = 256 * 1024;
export const MCP_SUBSCRIPTION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const MCP_DELIVERY_RETRY_WINDOW_MS = MCP_SUBSCRIPTION_MAX_TTL_MS;
export const MCP_DELIVERY_TIMEOUT_MS = 10_000;
/** Keep the prior callback key only long enough for in-flight deliveries to rotate. */
export const MCP_SECRET_ROTATION_WINDOW_MS = 5 * 60 * 1_000;
export const MCP_MAX_ACTIVE_SUBSCRIPTIONS_PER_THREAD = 32;
export const MCP_MAX_ACTIVE_SUBSCRIPTIONS_PER_PRINCIPAL_THREAD = 8;

export interface McpEventData {
  readonly thread_id: string;
  readonly thread_url: string;
  readonly message_id: string;
  readonly sequence: number;
  readonly author: string;
  readonly display_name?: string;
  readonly preview: string;
}

export interface McpMessageEvent {
  readonly eventId: string;
  readonly name: typeof MCP_MESSAGE_EVENT;
  readonly timestamp: string;
  readonly data: McpEventData;
  readonly cursor: string;
}

export interface McpCallbackDelivery {
  readonly mode: "webhook";
  readonly url: string;
  readonly secret: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function boundedPreview(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MCP_EVENT_PREVIEW_BYTES) return value;
  let end = MCP_EVENT_PREVIEW_BYTES;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  while (end > 0) {
    const preview = decoder.decode(bytes.slice(0, end));
    if (encoder.encode(preview).byteLength <= MCP_EVENT_PREVIEW_BYTES) return preview;
    end -= 1;
  }
  return "";
}

export function validateCallbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("The callback URL is invalid.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The callback URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port === "0") throw new Error("The callback URL is invalid.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" || host.endsWith(".local")) throw new Error("The callback URL is invalid.");
  if (/^(?:10|127)\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/u.test(host) || /^(?:192\.168|169\.254)\.(?:[0-9]{1,3}\.)[0-9]{1,3}$/u.test(host)) throw new Error("The callback URL is invalid.");
  return url.toString();
}

function decodeSecret(value: string): Uint8Array {
  if (!value.startsWith("whsec_")) throw new Error("The callback signing secret is invalid.");
  let decoded: Uint8Array;
  try {
    const raw = atob(value.slice("whsec_".length));
    decoded = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch { throw new Error("The callback signing secret is invalid."); }
  if (decoded.byteLength < 24 || decoded.byteLength > 64) throw new Error("The callback signing secret is invalid.");
  return decoded;
}

export function validateCallbackSecret(value: unknown): string {
  if (typeof value !== "string") throw new Error("The callback signing secret is invalid.");
  decodeSecret(value);
  return value;
}

function base64(value: ArrayBuffer): string {
  let output = "";
  for (const byte of new Uint8Array(value)) output += String.fromCharCode(byte);
  return btoa(output);
}

export async function standardWebhookSignature(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", decodeSecret(secret) as unknown as ArrayBuffer, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${base64(signature)}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) result |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return result === 0;
}

export function mcpEventDefinition() {
  return {
    name: MCP_MESSAGE_EVENT,
    description: "A new message was added to the selected Msg Thread.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: { room_url: { type: "string", format: "uri", description: "Canonical public URL of the Thread to monitor." } },
      required: ["room_url"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" }, thread_url: { type: "string", format: "uri" }, message_id: { type: "string" },
        sequence: { type: "integer" }, author: { type: "string" }, display_name: { type: "string" }, preview: { type: "string" },
        response_context: { type: "object", properties: { subscription_id: { type: "string" }, event_id: { type: "string" } }, required: ["subscription_id", "event_id"], additionalProperties: false },
      },
      required: ["thread_id", "thread_url", "message_id", "sequence", "author", "preview", "response_context"],
      additionalProperties: false,
    },
  };
}
