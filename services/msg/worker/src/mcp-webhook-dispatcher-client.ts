const MAX_DISPATCHER_RESPONSE_BYTES = 96 * 1024;
const MAX_RELAY_BODY_BYTES = 256 * 1024;
const DEFAULT_DISPATCHER_TIMEOUT_MS = 10_000;
const DEFAULT_DISPATCHER_USER_AGENT = "0000-msg-dispatcher-client/1";
const RESPONSE_HEADER_ALLOWLIST = new Set(["content-type", "location"]);

export interface McpWebhookDispatcherClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface McpWebhookDispatchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Returns a fetch-compatible callback sender that contacts only the fixed,
 * administrator-configured dispatcher endpoint. The attacker-controlled
 * callback URL remains data inside the relay body and is never fetched here.
 */
export function createMcpWebhookDispatcherClient(options: McpWebhookDispatcherClientOptions): typeof fetch {
  const endpoint = validateDispatcherEndpoint(options.endpoint);
  if (!options.token) throw new Error("The webhook dispatcher token is required.");
  const requestFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISPATCHER_TIMEOUT_MS;
  return async function dispatcherFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const target = new Request(input, { ...init, redirect: "manual" });
    if (target.method !== "POST") throw new Error("The webhook dispatcher only supports POST callbacks.");
    const relayBody = target.body === null ? "" : await boundedRequestText(target, MAX_RELAY_BODY_BYTES);
    const headers: Record<string, string> = {};
    target.headers.forEach((value, name) => { headers[name] = value; });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await requestFetch(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          "user-agent": DEFAULT_DISPATCHER_USER_AGENT,
        },
        body: JSON.stringify({ url: target.url, method: "POST", headers, body: relayBody }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error("The webhook dispatcher request failed.");
    const value = await boundedJson(response, MAX_DISPATCHER_RESPONSE_BYTES);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("The webhook dispatcher response is invalid.");
    const envelope = value as Record<string, unknown>;
    if (!Number.isSafeInteger(envelope.status) || (envelope.status as number) < 100 || (envelope.status as number) > 599 || typeof envelope.body !== "string" || !isHeaderRecord(envelope.headers)) {
      throw new Error("The webhook dispatcher response is invalid.");
    }
    const status = envelope.status as number;
    const responseBody = status === 204 || status === 304 ? null : envelope.body;
    return new Response(responseBody, { status, headers: envelope.headers as Record<string, string> });
  };
}

function validateDispatcherEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The webhook dispatcher endpoint is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("The webhook dispatcher endpoint is invalid.");
  return url.toString();
}

async function boundedRequestText(request: Request, maximum: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximum) throw new Error("The webhook body is too large.");
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("The webhook body is not valid UTF-8."); }
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximum) throw new Error("The webhook dispatcher response is too large.");
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { throw new Error("The webhook dispatcher response is invalid."); }
}

function isHeaderRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([name, header]) => RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase()) && /^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(name) && typeof header === "string" && header.length <= 16_384 && !/[\r\n]/u.test(header));
}
