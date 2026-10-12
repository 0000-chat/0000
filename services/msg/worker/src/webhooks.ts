const MAX_WEBHOOK_URL_BYTES = 2_048;
export const MAX_WEBHOOK_HEADERS = 16;
export const MAX_WEBHOOK_HEADER_NAME_BYTES = 128;
export const MAX_WEBHOOK_HEADER_VALUE_BYTES = 4 * 1024;
export const MAX_WEBHOOK_HEADER_TOTAL_BYTES = 16 * 1024;
export const MAX_WEBHOOK_PROMPT_BYTES = 4 * 1024;
export const MAX_WEBHOOK_EXCLUSIONS = 50;
const MAX_AUTHOR_CHARS = 80;
const MAX_AUTHOR_BYTES = 320;

export interface WebhookMutation {
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly prompt?: string | null;
  readonly excludeAuthors?: readonly string[];
}

export class WebhookInputError extends Error {
  constructor() {
    super("The webhook configuration is invalid.");
  }
}

const WEBHOOK_CREATE_FIELDS = new Set(["url", "headers", "prompt", "exclude_authors"]);
const WEBHOOK_UPDATE_FIELDS = WEBHOOK_CREATE_FIELDS;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const RESERVED_HEADERS = new Set([
  "connection", "content-length", "content-type", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "via", "forwarded",
  "http2-settings", "content-encoding",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto", "x-real-ip",
  "cf-connecting-ip", "cf-ray", "cf-visitor", "x-msg-signature", "x-msg-timestamp",
]);

export function parseWebhookCreateInput(value: unknown): WebhookMutation & { readonly url: string } {
  const object = webhookObject(value, WEBHOOK_CREATE_FIELDS);
  if (!Object.hasOwn(object, "url")) throw new WebhookInputError();
  const url = normalizeWebhookUrl(object.url);
  if (url === undefined) throw new WebhookInputError();
  return { url, ...parseWebhookOptions(object) };
}

export function parseWebhookUpdateInput(value: unknown): WebhookMutation {
  const object = webhookObject(value, WEBHOOK_UPDATE_FIELDS);
  if (Object.keys(object).length === 0) throw new WebhookInputError();
  const url = Object.hasOwn(object, "url") ? normalizeWebhookUrl(object.url) : undefined;
  if (Object.hasOwn(object, "url") && url === undefined) throw new WebhookInputError();
  return { ...(url === undefined ? {} : { url }), ...parseWebhookOptions(object) };
}

function webhookObject(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WebhookInputError();
  const object = Object.fromEntries(Object.entries(value));
  if (Object.keys(object).some((field) => !fields.has(field))) throw new WebhookInputError();
  return object;
}

function parseWebhookOptions(object: Record<string, unknown>): WebhookMutation {
  const options: { headers?: Readonly<Record<string, string>>; prompt?: string | null; excludeAuthors?: readonly string[] } = {};
  if (Object.hasOwn(object, "headers")) options.headers = parseWebhookHeaders(object.headers);
  if (Object.hasOwn(object, "prompt")) options.prompt = parseWebhookPrompt(object.prompt);
  if (Object.hasOwn(object, "exclude_authors")) options.excludeAuthors = parseWebhookExclusions(object.exclude_authors);
  return options;
}

function parseWebhookHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WebhookInputError();
  const result: [string, string][] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const entries = Object.entries(value);
  if (entries.length > MAX_WEBHOOK_HEADERS) throw new WebhookInputError();
  for (const [name, headerValue] of entries) {
    const normalized = name.toLowerCase();
    const nameBytes = new TextEncoder().encode(name).byteLength;
    if (!TOKEN.test(name) || nameBytes > MAX_WEBHOOK_HEADER_NAME_BYTES || seen.has(normalized) || isReservedHeader(normalized)) throw new WebhookInputError();
    if (typeof headerValue !== "string" || hasControlCharacters(headerValue) || Array.from(headerValue).some((character) => (character.codePointAt(0) ?? 0) > 0xff)) throw new WebhookInputError();
    const valueBytes = new TextEncoder().encode(headerValue).byteLength;
    if (valueBytes > MAX_WEBHOOK_HEADER_VALUE_BYTES) throw new WebhookInputError();
    totalBytes += nameBytes + valueBytes;
    if (totalBytes > MAX_WEBHOOK_HEADER_TOTAL_BYTES) throw new WebhookInputError();
    seen.add(normalized);
    result.push([name, headerValue]);
  }
  return Object.fromEntries(result);
}

function isReservedHeader(normalized: string): boolean {
  return normalized === "authorization"
    ? false
    : RESERVED_HEADERS.has(normalized)
      || normalized.startsWith("x-msg-")
      || normalized.startsWith("x-forwarded-")
      || normalized.startsWith("cf-")
      || normalized.startsWith("proxy-");
}

function parseWebhookPrompt(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_WEBHOOK_PROMPT_BYTES) throw new WebhookInputError();
  return value;
}

function parseWebhookExclusions(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_WEBHOOK_EXCLUSIONS) throw new WebhookInputError();
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0 || Array.from(entry).length > MAX_AUTHOR_CHARS || new TextEncoder().encode(entry).byteLength > MAX_AUTHOR_BYTES) throw new WebhookInputError();
    const normalized = normalizeWebhookAuthor(entry);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function normalizeWebhookAuthor(value: string): string { return value.trim().toLowerCase(); }

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function normalizeWebhookUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return undefined;
  if (new TextEncoder().encode(value).byteLength > MAX_WEBHOOK_URL_BYTES) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:"
    || (!hostname.includes(".") && !hostname.startsWith("["))
    || hostname === "localhost"
    || /\.(?:localhost|local|internal|lan|home|test|invalid|onion)$/u.test(hostname)
    || (isIpv4(hostname) && isNonPublicIpv4(hostname))
    || (hostname.startsWith("[") && isNonPublicIpv6(hostname))
    || url.hash
  ) return undefined;
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    return undefined;
  }
  return url.toString();
}

export function redactWebhookUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    url.username = "redacted";
    url.password = "redacted";
  }
  if (url.search) {
    const parameters = [...url.searchParams.entries()];
    url.search = "";
    for (const [name] of parameters) url.searchParams.append(name, "redacted");
  }
  return url.toString();
}

export function generateWebhookSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function discardWebhookResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch {}
}

export async function signWebhookPayload(secret: string, timestamp: string, body: string): Promise<string> {
  const secretBytes = decodeBase64Url(secret);
  const keyBytes = new Uint8Array(secretBytes.byteLength);
  keyBytes.set(secretBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `v1=${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function webhookRequestTarget(value: string): { readonly authorization?: string; readonly url: string } {
  const url = new URL(value);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const result: { authorization?: string; url: string } = { url: value };
  if (username || password) {
    const credentials = new TextEncoder().encode(`${username}:${password}`);
    result.authorization = `Basic ${encodeBase64(credentials)}`;
    url.username = "";
    url.password = "";
    result.url = url.toString();
  }
  return result;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255);
}

function isNonPublicIpv4(value: string): boolean {
  const [first = 0, second = 0, third = 0] = value.split(".").map(Number);
  return first === 0
    || first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 2 && third === 0 || second === 88 && third === 99 || second === 168))
    || (first === 198 && (second === 18 || second === 19 || second === 51 && third === 100))
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isNonPublicIpv6(value: string): boolean {
  const words = ipv6Words(value);
  if (!words) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const mappedIpv4 = `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`;
    return isNonPublicIpv4(mappedIpv4);
  }
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  const first = words[0]!;
  const second = words[1]!;
  // Accept only global-unicast space (2000::/3), excluding protocol-use,
  // benchmarking, 6to4, and documentation ranges.
  return first < 0x2000
    || first > 0x3fff
    || first === 0x2001 && (second <= 0x01ff || second === 0x0002 || second === 0x0db8 || second === 0x0020)
    || first === 0x2002;
}

function ipv6Words(value: string): number[] | undefined {
  let address = value.slice(1, -1);
  if (address.includes("%")) return undefined;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1);
    if (!isIpv4(ipv4)) return undefined;
    const octets = ipv4.split(".").map(Number);
    address = `${address.slice(0, lastColon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const parseWord = (word: string): number | undefined => /^[0-9a-f]{1,4}$/iu.test(word) ? Number.parseInt(word, 16) : undefined;
  const parsedLeft = left.map(parseWord);
  const parsedRight = right.map(parseWord);
  if (parsedLeft.some((word) => word === undefined) || parsedRight.some((word) => word === undefined)) return undefined;
  const zeros = 8 - parsedLeft.length - parsedRight.length;
  if (halves.length === 1 && zeros !== 0 || halves.length === 2 && zeros < 1) return undefined;
  return [...parsedLeft, ...Array.from({ length: zeros }, () => 0), ...parsedRight] as number[];
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
