import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

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
    const url = new URL(value);
    if (!sameOrigin(url, this.serviceOrigin) || url.protocol !== "https:") return undefined;
    const now = Date.now();
    this.purge(now);
    const matches = this.cookies.filter((cookie) => {
      const domainMatches = cookie.hostOnly ? cookie.domain === url.hostname : domainMatchesHost(cookie.domain, url.hostname);
      return domainMatches && pathMatches(cookie.path, url.pathname) && (!cookie.secure || url.protocol === "https:");
    });
    return matches.length === 0 ? undefined : matches.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
  }

  store(urlValue: string | URL, response: Response): void {
    const url = new URL(urlValue);
    if (!sameOrigin(url, this.serviceOrigin)) return;
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
    for (const value of values) this.storeSetCookie(url, value);
    this.persist();
  }

  wrapFetch(baseFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
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
      this.store(url, response);
      return response;
    };
  }

  websocketHeaders(value: string | URL): Record<string, string> {
    const cookie = this.cookieHeader(value);
    return cookie ? { Cookie: cookie } : {};
  }

  private storeSetCookie(url: URL, header: string): void {
    const parts = header.split(";").map((part) => part.trim());
    const first = parts.shift();
    if (!first) return;
    const separator = first.indexOf("=");
    if (separator <= 0) return;
    const name = first.slice(0, separator).trim();
    const value = decodeCookieValue(first.slice(separator + 1).trim());
    if (!value || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) return;
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
        if (!candidate || !domainMatchesHost(candidate, url.hostname) || candidate !== this.serviceOrigin.hostname) return;
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
    this.cookies = this.cookies.filter((cookie) => !(cookie.name === name && cookie.domain === domain && cookie.path === path));
    if (expiresAt !== undefined && expiresAt <= Date.now()) return;
    this.cookies.push({ name, value, domain, hostOnly, path, secure, ...(expiresAt === undefined ? {} : { expiresAt }) });
  }

  private purge(now: number): void {
    this.cookies = this.cookies.filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now);
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, `${JSON.stringify(this.cookies, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.filePath, 0o600);
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
