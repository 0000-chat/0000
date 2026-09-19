import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
  readonly claimPath: string;
  readonly ticket: number;
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

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 10;
const MAX_TICKET = Number.MAX_SAFE_INTEGER - 1;
const CLAIM_SUFFIX = ".claim";

type ClaimState = "choosing" | "ready";

interface ClaimRecord {
  readonly owner: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly state: ClaimState;
  readonly ticket?: number;
}

type ClaimRead =
  | { readonly status: "missing" }
  | { readonly status: "unknown" }
  | { readonly record: ClaimRecord; readonly status: "record" };

function acquireFileLock(path: string): FileLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockDirectoryPath = lockDirectory(path);
  mkdirSync(lockDirectoryPath, { recursive: true, mode: 0o700 });

  const owner = randomUUID();
  const claimPath = join(lockDirectoryPath, `${process.pid}-${owner}${CLAIM_SUFFIX}`);
  const choosing: ClaimRecord = { owner, pid: process.pid, startedAt: Date.now(), state: "choosing" };
  publishChoosingClaim(claimPath, choosing);
  waitForTestBarrier("choosing", claimPath);

  try {
    const ticket = chooseTicket(lockDirectoryPath);
    const ready: ClaimRecord = { ...choosing, state: "ready", ticket };
    // Replacing this same unique claim path publishes the complete ready state atomically.
    publishClaim(claimPath, ready);
    waitForTestBarrier("ready", claimPath);
    const lock = { claimPath, owner, ticket };
    waitForDefinedSnapshot(lockDirectoryPath, lock);
    return lock;
  } catch (error) {
    releaseFileLock({ claimPath, owner, ticket: 0 });
    throw error;
  }
}

function releaseFileLock(lock: FileLock): void {
  const current = readClaim(lock.claimPath);
  if (current.status !== "record" || current.record.owner !== lock.owner) return;
  try {
    unlinkSync(lock.claimPath);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function lockDirectory(path: string): string {
  return `${path}.locks`;
}

function publishClaim(claimPath: string, record: ClaimRecord): void {
  const temporary = `${claimPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, claimPath);
  } finally {
    try { unlinkSync(temporary); } catch { /* The atomic rename already removed it. */ }
  }
}

function publishChoosingClaim(claimPath: string, record: ClaimRecord): void {
  const temporary = `${claimPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    // A hard-link publish is atomic and refuses to replace another unique claim.
    linkSync(temporary, claimPath);
  } finally {
    try { unlinkSync(temporary); } catch { /* The temporary name was already cleaned up. */ }
  }
}

function chooseTicket(lockDirectoryPath: string): number {
  let highest = 0;
  for (const claimPath of claimPaths(lockDirectoryPath)) {
    const claim = readClaim(claimPath);
    if (claim.status === "unknown") throw new Error("The msg cookie jar contains invalid claim metadata.");
    if (claim.status !== "record" || claim.record.state !== "ready" || claim.record.ticket === undefined) continue;
    highest = Math.max(highest, claim.record.ticket);
  }
  if (highest >= MAX_TICKET) throw new Error("The msg cookie jar ticket space is exhausted.");
  return highest + 1;
}

function waitForDefinedSnapshot(lockDirectoryPath: string, own: FileLock): void {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const snapshot = new Set(claimPaths(lockDirectoryPath).filter((claimPath) => claimPath !== own.claimPath));
  const started = Date.now();
  if (snapshot.size === 0) {
    assertNoUnknownClaims(lockDirectoryPath, own, snapshot);
    return;
  }
  while (snapshot.size > 0) {
    assertNoUnknownClaims(lockDirectoryPath, own, snapshot);
    let blocked = false;
    for (const claimPath of snapshot) {
      const claim = readClaim(claimPath);
      if (claim.status === "missing") {
        snapshot.delete(claimPath);
        continue;
      }
      if (claim.status === "unknown") {
        throw new Error("The msg cookie jar contains invalid claim metadata.");
      }
      if (claim.record.state === "choosing") {
        if (removeDeadClaim(claimPath, claim.record)) snapshot.delete(claimPath);
        else blocked = true;
        continue;
      }
      if (claimIsBefore(claim.record, own)) {
        if (removeDeadClaim(claimPath, claim.record)) snapshot.delete(claimPath);
        else blocked = true;
      } else snapshot.delete(claimPath);
    }
    if (snapshot.size === 0) {
      assertNoUnknownClaims(lockDirectoryPath, own, snapshot);
      return;
    }
    if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error("The msg cookie jar is locked by another process.");
    if (!blocked) continue;
    Atomics.wait(waitBuffer, 0, 0, LOCK_POLL_MS);
  }
}

function assertNoUnknownClaims(lockDirectoryPath: string, own: FileLock, snapshot: ReadonlySet<string>): void {
  for (const claimPath of claimPaths(lockDirectoryPath)) {
    if (claimPath === own.claimPath || snapshot.has(claimPath)) continue;
    if (readClaim(claimPath).status === "unknown") throw new Error("The msg cookie jar contains invalid claim metadata.");
  }
}

function claimPaths(lockDirectoryPath: string): string[] {
  try {
    return readdirSync(lockDirectoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(CLAIM_SUFFIX))
      .map((entry) => join(lockDirectoryPath, entry.name));
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

function readClaim(claimPath: string): ClaimRead {
  let text: string;
  try {
    text = readFileSync(claimPath, "utf8");
  } catch (error) {
    return isMissingPath(error) ? { status: "missing" } : { status: "unknown" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "unknown" };
    const record = parsed as Record<string, unknown>;
    if (typeof record.owner !== "string" || record.owner.length === 0 || typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0 || typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return { status: "unknown" };
    if (record.state !== "choosing" && record.state !== "ready") return { status: "unknown" };
    if (record.state === "ready" && (typeof record.ticket !== "number" || !Number.isSafeInteger(record.ticket) || record.ticket < 1 || record.ticket > MAX_TICKET)) return { status: "unknown" };
    return {
      record: {
        owner: record.owner,
        pid: record.pid,
        startedAt: record.startedAt,
        state: record.state,
        ...(record.state === "ready" ? { ticket: record.ticket as number } : {}),
      },
      status: "record",
    };
  } catch {
    return { status: "unknown" };
  }
}

function removeDeadClaim(claimPath: string, expected: ClaimRecord): boolean {
  const current = readClaim(claimPath);
  if (current.status !== "record" || current.record.owner !== expected.owner || processAlive(current.record.pid)) return false;
  try {
    // Claim paths are unique and never reused, so this exact unlink cannot remove a replacement owner.
    unlinkSync(claimPath);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return true;
    throw error;
  }
}

function claimIsBefore(left: ClaimRecord, right: FileLock): boolean {
  if (left.state !== "ready" || left.ticket === undefined) return false;
  return left.ticket < right.ticket || (left.ticket === right.ticket && left.owner < right.owner);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Test-only synchronization at the two claim publication boundaries. */
function waitForTestBarrier(phase: "choosing" | "ready", claimPath: string): void {
  const directory = process.env.T09_COOKIE_LOCK_BARRIER_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = join(directory, `${basename(claimPath)}.${phase}`);
  writeFileSync(`${marker}.ready`, "ready");
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(`${marker}.go`)) Atomics.wait(waitBuffer, 0, 0, LOCK_POLL_MS);
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
