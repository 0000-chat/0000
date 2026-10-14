/// <reference types="node" />

import { promises as dns } from "node:dns";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SecureWebhookConnection {
  write(value: Uint8Array): Promise<void>;
  read(): Promise<Uint8Array | null>;
  close(): void;
}

export interface SecureWebhookTransport {
  resolve(hostname: string): Promise<readonly string[]>;
  connect(input: { readonly hostname: string; readonly address: string; readonly port: number; readonly signal: AbortSignal }): Promise<SecureWebhookConnection>;
}

export interface SecureWebhookFetchOptions {
  readonly transport?: SecureWebhookTransport;
  readonly timeoutMs?: number;
}

/**
 * Returns true only for globally routable unicast IPv4 and IPv6 addresses.
 * This is deliberately conservative: a resolver result outside the accepted
 * ranges rejects the whole resolution set rather than selecting another name.
 */
export function isPublicIpAddress(value: string): boolean {
  if (isIpv4(value)) return isPublicIpv4(value);
  const words = parseIpv6(value);
  if (!words) return false;
  if (isIpv4Mapped(words)) return isPublicIpv4(wordsToIpv4(words.slice(6)));
  const first = words[0]!;
  const second = words[1]!;
  if (words.every((word) => word === 0)) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return false;
  // RFC 4193 ULA, RFC 4291 link-local, multicast, and non-global space.
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
  // Accept only global-unicast space (2000::/3), excluding special-use and
  // documentation ranges that must never become callback destinations.
  return first >= 0x2000
    && first <= 0x3fff
    && !(first === 0x2001 && (second === 0x0000 || second === 0x0002 || second === 0x0010 || second === 0x0020 || second === 0x0db8))
    && !(first === 0x2002);
}

export function createSecureWebhookFetch(options: SecureWebhookFetchOptions = {}): typeof fetch {
  const transport = options.transport ?? nodeTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async function secureWebhookFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = validateTargetUrl(request.url);
    const body = await readRequestBody(request, MAX_REQUEST_BODY_BYTES);
    const signal = request.signal;
    if (signal.aborted) throw new Error("The webhook request was aborted.");
    const operationController = new AbortController();
    const relayAbort = () => operationController.abort();
    signal.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(() => operationController.abort(), timeoutMs);
    try {
      const addresses = isIpLiteral(url.hostname)
        ? [stripBrackets(url.hostname)]
        : await withTimeout(transport.resolve(url.hostname), timeoutMs, operationController.signal);
      const validatedAddresses = validateResolution(addresses);

      const connection = await withTimeout(
        transport.connect({ hostname: url.hostname, address: validatedAddresses[0]!, port: Number(url.port || 443), signal: operationController.signal }),
        timeoutMs,
        operationController.signal,
      );
      try {
        const requestBytes = serializeRequest(request, url, body);
        await withTimeout(connection.write(requestBytes), timeoutMs, operationController.signal);
        const response = await withTimeout(readHttpResponse(connection), timeoutMs, operationController.signal);
        return response;
      } finally {
        connection.close();
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relayAbort);
    }
  };
}

// Construct lazily so the module can load in test and tooling environments
// where the Node-compatible socket adapter is not initialized yet.
export const secureWebhookFetch: typeof fetch = (input, init) => createSecureWebhookFetch()(input, init);

function validateTargetUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The webhook URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) throw new Error("The webhook URL is invalid.");
  if (isIpLiteral(url.hostname)) {
    if (!isPublicIpAddress(stripBrackets(url.hostname))) throw new Error("The webhook destination is not public.");
  }
  return url;
}

function validateResolution(addresses: readonly string[]): readonly string[] {
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(stripBrackets(address)))) {
    throw new Error("The webhook destination did not resolve to public addresses.");
  }
  return addresses.map(stripBrackets);
}

async function readRequestBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximum) throw new Error("The webhook request body is too large.");
    chunks.push(result.value);
  }
  return joinChunks(chunks, length);
}

function serializeRequest(request: Request, url: URL, body: Uint8Array): Uint8Array {
  const lines = [`${request.method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`, "Connection: close"];
  request.headers.forEach((value, name) => {
    if (name === "connection" || name === "content-length" || name === "host" || name === "transfer-encoding") return;
    lines.push(`${name}: ${value}`);
  });
  lines.push(`Content-Length: ${body.byteLength}`, "", "");
  const header = new TextEncoder().encode(lines.join("\r\n"));
  if (header.byteLength + body.byteLength > MAX_REQUEST_BODY_BYTES + MAX_HEADER_BYTES) throw new Error("The webhook request is too large.");
  return joinChunks([header, body], header.byteLength + body.byteLength);
}

async function readHttpResponse(connection: SecureWebhookConnection): Promise<Response> {
  const reader = new BufferedReader(connection);
  const head = await reader.takeUntil(new Uint8Array([13, 10, 13, 10]), MAX_HEADER_BYTES);
  const headerText = new TextDecoder("ascii", { fatal: true }).decode(head);
  const lines = headerText.slice(0, -4).split("\r\n");
  const status = parseStatusLine(lines.shift() ?? "");
  // The relay only supports one complete HTTP response. An informational
  // response (including 101 protocol switching) must not be surfaced as the
  // final callback result or passed to Response, which rejects 1xx statuses.
  if (status < 200) throw new Error("Unexpected informational webhook response.");
  const headers = new Headers();
  const contentLengths: string[] = [];
  let transferEncoding: string | undefined;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("Malformed webhook response headers.");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || /[\r\n]/u.test(value)) throw new Error("Malformed webhook response headers.");
    if (name === "content-length") contentLengths.push(value);
    if (name === "transfer-encoding") transferEncoding = transferEncoding === undefined ? value : `${transferEncoding},${value}`;
    headers.append(name, value);
  }
  const bodyless = status === 204 || status === 304;
  if (bodyless) return new Response(null, { status, headers });
  if (contentLengths.length > 1 && new Set(contentLengths).size !== 1) throw new Error("Conflicting webhook response lengths.");
  if (contentLengths.length > 0 && transferEncoding !== undefined) throw new Error("Ambiguous webhook response framing.");
  let body: Uint8Array;
  if (transferEncoding !== undefined) {
    if (transferEncoding.toLowerCase().trim() !== "chunked") throw new Error("Unsupported webhook response transfer encoding.");
    body = await readChunkedBody(reader);
  } else if (contentLengths.length > 0) {
    const length = parseBodyLength(contentLengths[0]!);
    if (length > MAX_RESPONSE_BODY_BYTES) throw new Error("The webhook response body is too large.");
    body = await reader.takeExact(length);
  } else {
    body = await reader.readUntilEnd(MAX_RESPONSE_BODY_BYTES);
  }
  return new Response(body.byteLength === 0 ? null : body as unknown as BodyInit, { status, headers });
}

async function readChunkedBody(reader: BufferedReader): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const line = new TextDecoder("ascii", { fatal: true }).decode(await reader.readLine(MAX_LINE_BYTES));
    const sizeText = line.split(";", 1)[0]!.trim();
    if (!/^[0-9a-f]+$/iu.test(sizeText)) throw new Error("Malformed webhook chunk.");
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size) || size > MAX_RESPONSE_BODY_BYTES - length) throw new Error("The webhook response body is too large.");
    if (size === 0) {
      while (true) {
        const trailer = await reader.readLine(MAX_LINE_BYTES);
        if (trailer.byteLength === 0) break;
        const separator = trailer.indexOf(58);
        if (separator <= 0) throw new Error("Malformed webhook trailers.");
      }
      return joinChunks(chunks, length);
    }
    chunks.push(await reader.takeExact(size));
    length += size;
    const terminator = await reader.takeExact(2);
    if (terminator[0] !== 13 || terminator[1] !== 10) throw new Error("Malformed webhook chunk terminator.");
  }
}

function parseStatusLine(line: string): number {
  const match = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/u.exec(line);
  if (!match) throw new Error("Malformed webhook response status.");
  const status = Number(match[1]);
  if (status < 100 || status > 599) throw new Error("Malformed webhook response status.");
  return status;
}

function parseBodyLength(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("Malformed webhook response length.");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new Error("Malformed webhook response length.");
  return length;
}

class BufferedReader {
  private buffer = new Uint8Array();
  private ended = false;

  constructor(private readonly connection: SecureWebhookConnection) {}

  async takeUntil(marker: Uint8Array, maximum: number): Promise<Uint8Array> {
    while (true) {
      const index = indexOf(this.buffer, marker);
      if (index >= 0) {
        const end = index + marker.byteLength;
        if (end > maximum) throw new Error("The webhook response headers are too large.");
        const result = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        return result;
      }
      if (this.buffer.byteLength > maximum) throw new Error("The webhook response headers are too large.");
      await this.readMore();
    }
  }

  async readLine(maximum: number): Promise<Uint8Array> {
    return (await this.takeUntil(new Uint8Array([13, 10]), maximum)).slice(0, -2);
  }

  async takeExact(length: number): Promise<Uint8Array> {
    while (this.buffer.byteLength < length) await this.readMore();
    const result = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return result;
  }

  async readUntilEnd(maximum: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [this.buffer];
    let length = this.buffer.byteLength;
    this.buffer = new Uint8Array();
    while (!this.ended) {
      const chunk = await this.connection.read();
      if (chunk === null) { this.ended = true; break; }
      length += chunk.byteLength;
      if (length > maximum) throw new Error("The webhook response body is too large.");
      chunks.push(chunk);
    }
    return joinChunks(chunks, length);
  }

  private async readMore(): Promise<void> {
    if (this.ended) throw new Error("Unexpected end of webhook response.");
    const chunk = await this.connection.read();
    if (chunk === null) { this.ended = true; throw new Error("Unexpected end of webhook response."); }
    if (chunk.byteLength === 0) return this.readMore();
    this.buffer = joinChunks([this.buffer, chunk], this.buffer.byteLength + chunk.byteLength);
  }
}

const nodeTransport: SecureWebhookTransport = {
  async resolve(hostname) {
    const results = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
    if (results.some((result) => result.status === "rejected" && !isNoDataDnsError(result.reason))) throw new Error("The webhook hostname could not be resolved.");
    const addresses = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (addresses.length === 0) throw new Error("The webhook hostname could not be resolved.");
    return addresses;
  },
  async connect({ hostname, address, port, signal }) {
    const tcp = await connectTcp(address, port, signal);
    try {
      const tls = await connectTls(tcp, hostname, signal);
      return new NodeConnection(tls);
    } catch (error) {
      tcp.destroy();
      throw error;
    }
  },
};

function isNoDataDnsError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENODATA";
}

function connectTcp(address: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port });
    const cleanup = () => { signal.removeEventListener("abort", abort); socket.removeListener("error", onError); };
    const abort = () => { cleanup(); socket.destroy(); reject(new Error("The webhook connection was aborted.")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", onError);
    socket.once("connect", () => { cleanup(); resolve(socket); });
  });
}

function connectTls(socket: Socket, hostname: string, signal: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const servername = isIpLiteral(hostname) ? undefined : hostname;
    // Cloudflare's node:tls implementation rejects ALPNProtocols. Omitting it
    // leaves the TLS socket in its default mode, after which this adapter uses
    // only HTTP/1.1 framing.
    const tls = tlsConnect({ socket, host: hostname, ...(servername === undefined ? {} : { servername }) });
    const cleanup = () => { signal.removeEventListener("abort", abort); tls.removeListener("error", onError); };
    const abort = () => { cleanup(); tls.destroy(); reject(new Error("The webhook TLS connection was aborted.")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    tls.once("error", onError);
    tls.once("secureConnect", () => { cleanup(); resolve(tls); });
  });
}

class NodeConnection implements SecureWebhookConnection {
  private readonly chunks: Uint8Array[] = [];
  private waiting: ((value: Uint8Array | null) => void) | undefined;
  private failure: Error | undefined;
  private ended = false;

  constructor(private readonly socket: TLSSocket) {
    socket.on("data", (chunk: Uint8Array) => {
      if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting(new Uint8Array(chunk)); }
      else this.chunks.push(new Uint8Array(chunk));
    });
    socket.on("error", (error: Error) => {
      this.failure = error;
      this.waiting?.(null);
      this.waiting = undefined;
    });
    socket.on("end", () => { this.ended = true; this.waiting?.(null); this.waiting = undefined; });
    socket.on("close", () => { this.ended = true; this.waiting?.(null); this.waiting = undefined; });
  }

  write(value: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(value, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }

  read(): Promise<Uint8Array | null> {
    if (this.failure) return Promise.reject(this.failure);
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiting = resolve; });
  }

  close(): void { this.socket.destroy(); }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("The webhook request timed out.")); }, timeoutMs);
    const abort = () => { cleanup(); reject(new Error("The webhook request was aborted.")); };
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function indexOf(value: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= value.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) if (value[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  return -1;
}

function joinChunks(chunks: readonly Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function stripBrackets(value: string): string { return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value; }
function isIpLiteral(value: string): boolean { return isIpv4(value) || parseIpv6(value) !== undefined; }

function isPublicIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  const [first = 0, second = 0, third = 0] = parts;
  return first !== 0
    && first !== 10
    && !(first === 100 && second >= 64 && second <= 127)
    && first !== 127
    && !(first === 169 && second === 254)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && (second === 168 || second === 0 && (third === 0 || third === 2)))
    && !(first === 192 && second === 88 && third === 99)
    && !(first === 198 && (second === 18 || second === 19 || second === 51))
    && !(first === 203 && second === 0 && third === 113)
    && first < 224;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255);
}

function parseIpv6(value: string): number[] | undefined {
  let address = stripBrackets(value);
  if (address.includes("%")) return undefined;
  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    if (separator < 0 || !isIpv4(address.slice(separator + 1))) return undefined;
    address = `${address.slice(0, separator)}:${ipv4ToHex(address.slice(separator + 1))}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0]!.split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  const parseWord = (word: string): number | undefined => /^[0-9a-f]{1,4}$/iu.test(word) ? Number.parseInt(word, 16) : undefined;
  const parsedLeft = left.map(parseWord);
  const parsedRight = right.map(parseWord);
  if (parsedLeft.some((word) => word === undefined) || parsedRight.some((word) => word === undefined)) return undefined;
  const zeros = 8 - parsedLeft.length - parsedRight.length;
  if (halves.length === 1 ? zeros !== 0 : zeros < 1) return undefined;
  return [...parsedLeft, ...Array.from({ length: zeros }, () => 0), ...parsedRight] as number[];
}

function ipv4ToHex(value: string): string {
  const parts = value.split(".").map(Number);
  return `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
}

function isIpv4Mapped(words: readonly number[]): boolean {
  return words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
}

function wordsToIpv4(words: readonly number[]): string {
  return `${words[0]! >>> 8}.${words[0]! & 0xff}.${words[1]! >>> 8}.${words[1]! & 0xff}`;
}
