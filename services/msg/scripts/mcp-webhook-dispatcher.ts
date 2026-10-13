import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { secureWebhookFetch } from "../worker/src/mcp-webhook-transport";

export const MCP_WEBHOOK_DISPATCH_PATH = "/dispatch";
export const MCP_WEBHOOK_DISPATCH_HEALTH_PATH = "/healthz";
export const MCP_WEBHOOK_DISPATCH_MAX_REQUEST_BYTES = 384 * 1024;
export const MCP_WEBHOOK_DISPATCH_MAX_BODY_BYTES = 256 * 1024;
export const MCP_WEBHOOK_DISPATCH_MAX_RESPONSE_BYTES = 64 * 1024;
export const MCP_WEBHOOK_DISPATCH_TIMEOUT_MS = 10_000;
export const MCP_WEBHOOK_DISPATCH_MAX_ACTIVE = 32;
export const MCP_WEBHOOK_DISPATCH_RATE_WINDOW_MS = 60_000;
export const MCP_WEBHOOK_DISPATCH_RATE_LIMIT = 120;

const RELAY_HEADER_ALLOWLIST = new Set([
  "content-type",
  "webhook-id",
  "webhook-signature",
  "webhook-timestamp",
  "x-mcp-subscription-id",
]);
const RESPONSE_HEADER_ALLOWLIST = new Set(["content-type", "location"]);

export interface McpWebhookDispatchEnvelope {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface McpWebhookDispatchPayload {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface McpWebhookDispatcherOptions {
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxActive?: number;
  readonly rateLimit?: number;
  readonly rateWindowMs?: number;
}

export interface McpWebhookDispatcherServerOptions extends McpWebhookDispatcherOptions {
  readonly path?: string;
}

export interface McpWebhookDispatcherListenerSecurity {
  readonly host: string;
  readonly hasTls: boolean;
  /** Explicitly permits plain HTTP only when a private HTTPS proxy fronts the listener. */
  readonly trustedInternalProxy: boolean;
}

/**
 * Dispatches one already-authenticated relay payload. The target URL is only
 * consumed by secureWebhookFetch, which resolves and pins the recipient IP.
 */
export async function dispatchWebhookPayload(
  value: unknown,
  options: Pick<McpWebhookDispatcherOptions, "fetch" | "timeoutMs"> = {},
): Promise<McpWebhookDispatchEnvelope> {
  const payload = validatePayload(value);
  const fetcher = options.fetch ?? secureWebhookFetch;
  const timeoutMs = options.timeoutMs ?? MCP_WEBHOOK_DISPATCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetcher(payload.url, {
        method: payload.method,
        redirect: "error",
        signal: controller.signal,
        body: payload.body,
        headers: payload.headers,
      });
    } catch {
      return { status: 599, headers: {}, body: "" };
    }
    try {
      return {
        status: response.status,
        headers: responseHeaders(response),
        body: await boundedResponseText(response, MCP_WEBHOOK_DISPATCH_MAX_RESPONSE_BYTES),
      };
    } catch (error) {
      return { status: error instanceof DispatchHttpError ? error.status : 599, headers: {}, body: "" };
    }
  } finally {
    clearTimeout(timer);
  }
}

export function createMcpWebhookDispatcherServer(options: McpWebhookDispatcherServerOptions): Server {
  if (!options.token) throw new Error("MSG_MCP_WEBHOOK_DISPATCH_TOKEN is required.");
  return createServer(createRequestHandler(options));
}

export function createMcpWebhookDispatcherHttpsServer(options: McpWebhookDispatcherServerOptions, tls: HttpsServerOptions): Server {
  if (!options.token) throw new Error("MSG_MCP_WEBHOOK_DISPATCH_TOKEN is required.");
  return createHttpsServer(tls, createRequestHandler(options));
}

export function validateDispatcherListenerSecurity(value: McpWebhookDispatcherListenerSecurity): void {
  if (value.trustedInternalProxy && value.hasTls) throw new Error("Trusted internal proxy mode must terminate HTTPS before the dispatcher.");
  if (!value.hasTls && !value.trustedInternalProxy && !isLoopbackHost(value.host)) throw new Error("TLS certificate and key files are required for a non-loopback dispatcher.");
}

function createRequestHandler(options: McpWebhookDispatcherServerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const path = options.path ?? MCP_WEBHOOK_DISPATCH_PATH;
  const maxActive = options.maxActive ?? MCP_WEBHOOK_DISPATCH_MAX_ACTIVE;
  const rateLimit = options.rateLimit ?? MCP_WEBHOOK_DISPATCH_RATE_LIMIT;
  const rateWindowMs = options.rateWindowMs ?? MCP_WEBHOOK_DISPATCH_RATE_WINDOW_MS;
  let active = 0;
  const rates = new Map<string, { count: number; startedAt: number }>();

  return (request, response) => {
    void handleRequest(request, response, { ...options, maxActive, path, rateLimit, rateWindowMs }, () => active, (value) => { active = value; }, rates);
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: McpWebhookDispatcherServerOptions & { readonly maxActive: number; readonly path: string; readonly rateLimit: number; readonly rateWindowMs: number },
  readActive: () => number,
  setActive: (value: number) => void,
  rates: Map<string, { count: number; startedAt: number }>,
): Promise<void> {
  request.setTimeout(options.timeoutMs ?? MCP_WEBHOOK_DISPATCH_TIMEOUT_MS, () => request.destroy());
  const isHealthRequest = request.url === MCP_WEBHOOK_DISPATCH_HEALTH_PATH;
  if (request.url !== options.path && !isHealthRequest) {
    request.resume();
    writeJson(response, { error: "not_found" }, request.method === "POST" ? 404 : 405);
    return;
  }
  if (!authorized(request.headers.authorization, options.token)) {
    request.resume();
    writeJson(response, { error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    return;
  }
  if (isHealthRequest) {
    request.resume();
    if (request.method !== "GET") {
      writeJson(response, { error: "method_not_allowed" }, 405, { allow: "GET" });
      return;
    }
    writeJson(response, { ok: true, service: "msg-webhook-dispatcher" }, 200);
    return;
  }
  if (request.method !== "POST") {
    request.resume();
    writeJson(response, { error: "method_not_allowed" }, 405, { allow: "POST" });
    return;
  }
  if (!allowRate(request.socket.remoteAddress ?? "unknown", rates, options.rateLimit, options.rateWindowMs)) {
    request.resume();
    writeJson(response, { error: "rate_limited" }, 429, { "retry-after": "60" });
    return;
  }
  if (readActive() >= options.maxActive) {
    request.resume();
    writeJson(response, { error: "busy" }, 429, { "retry-after": "1" });
    return;
  }
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MCP_WEBHOOK_DISPATCH_MAX_REQUEST_BYTES) {
    writeJson(response, { error: "request_too_large" }, 413);
    request.resume();
    return;
  }
  setActive(readActive() + 1);
  try {
    const bytes = await readRequestBody(request, MCP_WEBHOOK_DISPATCH_MAX_REQUEST_BYTES);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { throw new DispatchHttpError(400, "invalid_json"); }
    const envelope = await dispatchWebhookPayload(value, options);
    writeJson(response, envelope, 200);
  } catch (error) {
    const failure = error instanceof DispatchHttpError ? error : new DispatchHttpError(400, "invalid_request");
    request.resume();
    writeJson(response, { error: failure.code }, failure.status);
  } finally {
    setActive(readActive() - 1);
  }
}

export function validatePayload(value: unknown): McpWebhookDispatchPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DispatchHttpError(400, "invalid_payload");
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.length === 0 || record.url.length > 2_048 || record.method !== "POST" || typeof record.body !== "string") {
    throw new DispatchHttpError(400, "invalid_payload");
  }
  try {
    const target = new URL(record.url);
    if (target.protocol !== "https:" || target.username || target.password || target.hash) throw new Error();
  } catch {
    throw new DispatchHttpError(400, "invalid_url");
  }
  if (new TextEncoder().encode(record.body).byteLength > MCP_WEBHOOK_DISPATCH_MAX_BODY_BYTES) throw new DispatchHttpError(413, "body_too_large");
  if (record.headers === null || typeof record.headers !== "object" || Array.isArray(record.headers)) throw new DispatchHttpError(400, "invalid_headers");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(record.headers as Record<string, unknown>)) {
    const normalized = name.toLowerCase();
    if (!RELAY_HEADER_ALLOWLIST.has(normalized) || typeof value !== "string" || value.length > 16_384 || /[\r\n]/u.test(value) || headers[normalized] !== undefined) throw new DispatchHttpError(400, "invalid_headers");
    headers[normalized] = value;
  }
  return { url: record.url, method: "POST", headers, body: record.body };
}

export function authorized(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice("Bearer ".length), token);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(paddedLeft, paddedRight);
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) headers[name.toLowerCase()] = value; });
  return headers;
}

async function boundedResponseText(response: Response, maximum: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximum) throw new DispatchHttpError(502, "response_too_large");
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new DispatchHttpError(502, "invalid_response"); }
}

function allowRate(key: string, rates: Map<string, { count: number; startedAt: number }>, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = rates.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    if (rates.size >= 4_096) rates.clear();
    rates.set(key, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

async function readRequestBody(request: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.byteLength;
    if (length > maximum) throw new DispatchHttpError(413, "request_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

function writeJson(response: ServerResponse, value: unknown, status: number, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "content-length": body.byteLength, ...headers });
  response.end(body);
}

class DispatchHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  void startDispatcherProcess();
}

async function startDispatcherProcess(): Promise<void> {
  const token = process.env.MSG_MCP_WEBHOOK_DISPATCH_TOKEN;
  if (!token) throw new Error("MSG_MCP_WEBHOOK_DISPATCH_TOKEN is required.");
  const host = process.env.MSG_MCP_WEBHOOK_DISPATCH_HOST ?? "127.0.0.1";
  const port = Number(process.env.MSG_MCP_WEBHOOK_DISPATCH_PORT ?? "8787");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("The dispatcher port is invalid.");
  const certificatePath = process.env.MSG_MCP_WEBHOOK_DISPATCH_TLS_CERT_FILE;
  const keyPath = process.env.MSG_MCP_WEBHOOK_DISPATCH_TLS_KEY_FILE;
  if (Boolean(certificatePath) !== Boolean(keyPath)) throw new Error("Both dispatcher TLS certificate and key files are required.");
  const trustedInternalProxy = process.env.MSG_MCP_WEBHOOK_DISPATCH_TRUSTED_INTERNAL_PROXY === "1";
  validateDispatcherListenerSecurity({ host, hasTls: Boolean(certificatePath && keyPath), trustedInternalProxy });
  const options = { token };
  const server = certificatePath && keyPath
    ? createMcpWebhookDispatcherHttpsServer(options, { cert: await readFile(certificatePath), key: await readFile(keyPath) })
    : createMcpWebhookDispatcherServer(options);
  server.listen(port, host, () => process.stdout.write(`mcp-webhook-dispatcher listening on ${host}:${port}${MCP_WEBHOOK_DISPATCH_PATH}\n`));
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
