import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface StoredCookie {
  readonly domain: string;
  readonly expiresAt?: number;
  readonly hostOnly: boolean;
  readonly name: string;
  readonly path: string;
  readonly secure: boolean;
  readonly value: string;
}

export interface CookieJarOptions {
  readonly filePath?: string;
  readonly serviceOrigin: string;
}

/** A small private-file jar with browser-like host/path/Secure filtering. */
export class PersistentCookieJar {
  private cookies: StoredCookie[];
  readonly filePath: string;
  readonly serviceOrigin: URL;

  constructor(options: CookieJarOptions) {
    this.filePath = options.filePath ?? process.env.MSG_COOKIE_JAR ?? `${homedir()}/.config/0000/msg/cookies.json`;
    this.serviceOrigin = new URL(options.serviceOrigin);
    this.cookies = load(this.filePath);
    this.purge(Date.now());
  }

  cookieHeader(value: string | URL): string | undefined {
    const url = cookieRequestUrl(value);
    if (!sameOrigin(url, this.serviceOrigin) || url.protocol !== "https:") return undefined;
    this.cookies = load(this.filePath);
    const now = Date.now();
    this.purge(now);
    return cookieHeaderFor(this.cookies, url, this.serviceOrigin);
  }

  store(urlValue: string | URL, response: Response): void {
    const url = new URL(urlValue);
    if (!sameOrigin(url, this.serviceOrigin)) return;
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
    if (values.length === 0) return;
    const lock = acquireFileLock(this.filePath);
    try {
      this.storeLocked(url, response, load(this.filePath));
    } finally {
      releaseFileLock(lock);
    }
  }

  wrapFetch(baseFetch: typeof fetch): typeof fetch {
    const request = async (input: RequestInfo | URL, init?: RequestInit, lockHeld = false): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      for (const [name, value] of new Headers(init?.headers).entries()) headers.set(name, value);
      const cookie = this.cookieHeader(url);
      if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
      const response = await baseFetch(input, { ...init, headers, redirect: "manual" });
      const location = response.headers.get("location");
      if (location) {
        const redirected = new URL(location, url);
        if (!sameOrigin(redirected, this.serviceOrigin)) throw new Error("The msg service returned an unexpected cross-origin redirect.");
      }
      if (lockHeld) this.storeLocked(cookieRequestUrl(url), response, load(this.filePath));
      else this.store(url, response);
      return response;
    };
    return async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const existing = this.cookieHeader(url);
      if (existing?.split("; ").some((cookie) => cookie.startsWith(`${CONTROL_COOKIE}=`))) return request(input, init);
      const lock = acquireFileLock(this.filePath);
      try {
        return await request(input, init, true);
      } finally {
        releaseFileLock(lock);
      }
    };
  }

  websocketHeaders(value: string | URL): Record<string, string> {
    const cookie = this.cookieHeader(value);
    return cookie ? { Cookie: cookie } : {};
  }

  private purge(now: number): void {
    this.cookies = this.cookies.filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now);
  }

  private storeLocked(url: URL, response: Response, cookies: StoredCookie[]): void {
    for (const value of responseCookies(response)) storeSetCookie(cookies, url, value, this.serviceOrigin);
    this.cookies = cookies;
    this.purge(Date.now());
    writeAtomic(this.filePath, this.cookies);
  }
}

interface FileLock {
  readonly owner: string;
  readonly path: string;
}

function storeSetCookie(cookies: StoredCookie[], url: URL, header: string, serviceOrigin: URL): void {
  const parts = header.split(";").map((part) => part.trim());
  const first = parts.shift();
  if (!first) return;
  const separator = first.indexOf("=");
  if (separator <= 0) return;
  const name = first.slice(0, separator).trim();
  const value = decodeCookieValue(first.slice(separator + 1).trim());
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) return;
  let domain = url.hostname;
  let hostOnly = true;
  let path = defaultPath(url.pathname);
  let secure = false;
  let expiresAt: number | undefined;
  for (const attribute of parts) {
    const split = attribute.indexOf("=");
    const key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
    const attributeValue = split < 0 ? "" : attribute.slice(split + 1).trim();
    if (key === "domain") {
      const candidate = attributeValue.replace(/^\./u, "").toLowerCase();
      if (!candidate || !domainMatchesHost(candidate, url.hostname) || candidate !== serviceOrigin.hostname) return;
      domain = candidate;
      hostOnly = false;
    } else if (key === "path" && attributeValue.startsWith("/")) path = attributeValue;
    else if (key === "secure") secure = true;
    else if (key === "max-age" && /^-?\d+$/u.test(attributeValue)) expiresAt = Date.now() + Number(attributeValue) * 1_000;
    else if (key === "expires") {
      const parsed = Date.parse(attributeValue);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }
  const index = cookies.findIndex((cookie) => cookie.name === name && cookie.domain === domain && cookie.path === path);
  if (index >= 0) cookies.splice(index, 1);
  if (expiresAt !== undefined && expiresAt <= Date.now()) return;
  cookies.push({ name, value, domain, hostOnly, path, secure, ...(expiresAt === undefined ? {} : { expiresAt }) });
}

function responseCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.();
  if (values && values.length > 0) return values;
  const value = response.headers.get("set-cookie");
  return value ? [value] : [];
}

function cookieRequestUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  return url;
}

function acquireFileLock(path: string): FileLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const started = Date.now();
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const owner = randomUUID();
  while (true) {
    try {
      const candidate = `${lockPath}.${owner}.tmp`;
      mkdirSync(candidate, { mode: 0o700 });
      writeFileSync(join(candidate, "owner.json"), JSON.stringify({ owner, pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
      renameSync(candidate, lockPath);
      return { owner, path: lockPath };
    } catch (error) {
      removeLockDirectory(`${lockPath}.${owner}.tmp`);
      if (!isLockExistsError(error)) throw error;
    }
    removeDeadLock(lockPath);
    if (Date.now() - started > 5_000) throw new Error("The msg cookie jar is locked by another process.");
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
}

function releaseFileLock(lock: FileLock): void {
  const ownsLock = readLock(lock.path)?.owner === lock.owner;
  if (ownsLock) {
    removeLockDirectory(lock.path);
  }
}

interface LockRecord {
  readonly owner: string;
  readonly pid: number;
  readonly startedAt: number;
}

function readLock(path: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    return typeof record.owner === "string" && record.owner.length > 0 && typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 && typeof record.startedAt === "number" && Number.isFinite(record.startedAt)
      ? { owner: record.owner, pid: record.pid, startedAt: record.startedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

function removeDeadLock(path: string): void {
  const lock = readLock(path);
  if (!lock || processAlive(lock.pid)) return;
  const quarantine = `${path}.${lock.owner}.${randomUUID()}.reclaim`;
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (!isPathRace(error)) throw error;
    return;
  }
  removeLockDirectory(quarantine);
}

function removeLockDirectory(path: string): void {
  try { rmSync(path, { force: true, recursive: true }); } catch { /* Another waiter completed reclamation. */ }
}

function isLockExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function isPathRace(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code !== "ESRCH";
  }
}

function writeAtomic(path: string, cookies: readonly StoredCookie[]): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(cookies, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try { unlinkSync(temporary); } catch { /* The atomic rename already removed it. */ }
  }
}

function load(path: string): StoredCookie[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCookie) as StoredCookie[];
  } catch {
    return [];
  }
}

function isCookie(value: unknown): value is StoredCookie {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cookie = value as Record<string, unknown>;
  return typeof cookie.name === "string" && typeof cookie.value === "string" && typeof cookie.domain === "string" && typeof cookie.path === "string" && typeof cookie.hostOnly === "boolean" && typeof cookie.secure === "boolean" && (cookie.expiresAt === undefined || typeof cookie.expiresAt === "number");
}

function decodeCookieValue(value: string): string {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function sameOrigin(left: URL, right: URL): boolean { return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port; }
function domainMatchesHost(domain: string, host: string): boolean { return host === domain || host.endsWith(`.${domain}`); }
function pathMatches(cookiePath: string, requestPath: string): boolean { return requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`); }
function defaultPath(path: string): string { const slash = path.lastIndexOf("/"); return slash <= 0 ? "/" : path.slice(0, slash); }
function cookieHeaderFor(cookies: readonly StoredCookie[], url: URL, serviceOrigin: URL): string | undefined {
  if (!sameOrigin(url, serviceOrigin) || url.protocol !== "https:") return undefined;
  const matches = cookies.filter((cookie) => {
    const domainMatches = cookie.hostOnly ? cookie.domain === url.hostname : domainMatchesHost(cookie.domain, url.hostname);
    return domainMatches && pathMatches(cookie.path, url.pathname) && (!cookie.secure || url.protocol === "https:");
  });
  return matches.length === 0 ? undefined : matches.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
}

const CONTROL_COOKIE = "msg_guest_control";
