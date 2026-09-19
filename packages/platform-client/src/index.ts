import {
  parseGuestCreateResult,
  parseGuestGrantResult,
  parseGuestResolveResult,
  parseAuthenticationResult,
  parsePrincipal,
  type AuthenticationResult,
  type AuthenticationWireResult,
  type GuestCreateResult,
  type GuestGrantAssertion,
  type GuestGrantResult,
  type GuestResolveResult,
} from "@0000/contracts";

export interface PlatformClientOptions {
  baseUrl: string;
  authority: string;
  audience: string;
  serviceVerifier: string;
  fetch?: typeof fetch;
  /** Request deadline in milliseconds. Accepted range: 1..60000. */
  timeoutMs?: number;
}

export interface PlatformClient {
  authenticate(presentedCredential: string): Promise<AuthenticationResult>;
}

export interface PlatformGuestClientOptions {
  baseUrl: string;
  authority: string;
  audience: string;
  guestGrantIssuer: string;
  fetch?: typeof fetch;
  /** Request deadline in milliseconds. Accepted range: 1..60000. */
  timeoutMs?: number;
}

export interface GuestGrantInput {
  bootstrapCredential: string;
  resourceId: string;
  capabilities: string[];
  assertion: GuestGrantAssertion;
}

export interface GuestRenewInput extends GuestGrantInput {
  grantId: string;
}

export interface PlatformGuestClient {
  createGuest(): Promise<GuestCreateResult>;
  resolveGuestControl(bootstrapCredential: string): Promise<GuestResolveResult>;
  attestGuestGrant(input: GuestGrantInput): Promise<GuestGrantResult>;
  renewGuestGrant(input: GuestRenewInput): Promise<GuestGrantResult>;
  revokeGuestGrant(
    grantId: string,
  ): Promise<
    | { status: "success"; revoked: true }
    | { status: "grant_denied" }
    | { status: "authority_unavailable" }
  >;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

type JsonTransportResult =
  | { response: Response; value: unknown }
  | { response: null; value: null };

function validateTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
}

function resolveEndpoint(path: string, baseUrl: string): URL | null {
  try {
    return new URL(path, baseUrl);
  } catch {
    return null;
  }
}

function unexpectedRedirect(response: Response, endpoint: URL): boolean {
  if (response.type === "opaqueredirect") return true;
  if (response.status >= 300 && response.status < 400) return true;
  if (response.redirected) return true;
  if (!response.url) return false;
  try {
    return new URL(response.url).origin !== endpoint.origin;
  } catch {
    return true;
  }
}

export function createJsonTransport(
  request: typeof fetch,
  timeoutMs: number,
): (url: URL, init: RequestInit) => Promise<JsonTransportResult> {
  return (url, init) => {
    const controller =
      typeof AbortController === "undefined" ? null : new AbortController();
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    return new Promise<JsonTransportResult>((resolve) => {
      const complete = (result: JsonTransportResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };

      const expire = (): void => {
        if (settled) return;
        timedOut = true;
        try {
          controller?.abort();
        } catch {
          // Some injected transports expose an AbortController-like object
          // that can throw while aborting. The deadline still applies.
        }
        complete({ response: null, value: null });
      };

      const expired = (): boolean => timedOut || Date.now() >= deadline;

      timer = setTimeout(expire, timeoutMs);

      const run = async (): Promise<void> => {
        try {
          const response = await request(url, {
            ...init,
            // Cloudflare's edge fetch does not implement redirect:error.
            // Manual mode still prevents forwarding the request, and every
            // redirect response is rejected before its body is trusted.
            redirect: "manual",
            ...(controller ? { signal: controller.signal } : {}),
          });
          if (expired()) {
            expire();
            return;
          }
          if (unexpectedRedirect(response, url)) {
            complete({ response: null, value: null });
            return;
          }
          const value = await response.json();
          if (expired()) {
            expire();
            return;
          }
          complete({ response, value });
        } catch {
          if (expired()) expire();
          else complete({ response: null, value: null });
        }
      };

      // Keep the operation observed after a timeout. A transport or body
      // parser may ignore abort and reject after the caller has completed.
      void run().catch(() => {
        if (expired()) expire();
        else complete({ response: null, value: null });
      });
    });
  };
}

export function createPlatformClient(
  options: PlatformClientOptions,
): PlatformClient {
  const timeoutMs = validateTimeout(options.timeoutMs);
  const request = options.fetch ?? fetch;
  const transport = createJsonTransport(request, timeoutMs);
  const authenticate = async (
    presentedCredential: string,
  ): Promise<AuthenticationResult> => {
    if (!presentedCredential) return { status: "invalid_credential" };

    const endpoint = resolveEndpoint(
      "/internal/v1/authenticate",
      options.baseUrl,
    );
    if (!endpoint) return { status: "authority_unavailable" };

    const result = await transport(
      endpoint,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.serviceVerifier}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ credential: presentedCredential }),
      },
    );
    if (!result.response) return { status: "authority_unavailable" };

    const response = result.response;
    if (response.status >= 500) return { status: "authority_unavailable" };

    const parsed: AuthenticationWireResult | null =
      parseAuthenticationResult(result.value);
    if (!parsed) return { status: "authority_unavailable" };
    if (response.status === 401) {
      return parsed.status === "invalid_credential"
        ? { status: "invalid_credential" }
        : { status: "authority_unavailable" };
    }
    if (!response.ok) return { status: "authority_unavailable" };
    if (parsed.status === "invalid_credential")
      return { status: "authority_unavailable" };
    if (parsed.status !== "authenticated") return parsed;

    const principal = parsePrincipal(parsed.principal, {
      authority: options.authority,
      audience: options.audience,
    });
    return principal
      ? { status: "authenticated", principal }
      : { status: "authority_unavailable" };
  };

  return { authenticate };
}

function unavailable<T>(): T {
  return { status: "authority_unavailable" } as T;
}

export function createPlatformGuestClient(
  options: PlatformGuestClientOptions,
): PlatformGuestClient {
  const timeoutMs = validateTimeout(options.timeoutMs);
  const request = options.fetch ?? fetch;
  const transport = createJsonTransport(request, timeoutMs);

  async function post(
    path: string,
    body?: unknown,
  ): Promise<JsonTransportResult> {
    const endpoint = resolveEndpoint(path, options.baseUrl);
    if (!endpoint) return { response: null, value: null };
    return transport(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.guestGrantIssuer}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function statusFailure(
    response: Response,
    value: unknown,
  ): {
    status:
      | "invalid_guest_control"
      | "grant_denied"
      | "conflict"
      | "authority_unavailable";
  } {
    if (response.status >= 500) return { status: "authority_unavailable" };
    if (response.status === 401 && isStatus(value, "invalid_guest_control")) {
      return { status: "invalid_guest_control" };
    }
    if (response.status === 403 && isStatus(value, "grant_denied")) {
      return { status: "grant_denied" };
    }
    if (response.status === 409 && isStatus(value, "conflict")) {
      return { status: "conflict" };
    }
    return { status: "authority_unavailable" };
  }

  function isStatus(value: unknown, status: string): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { status?: unknown }).status === status
    );
  }

  async function grant(
    path: string,
    body: GuestGrantInput | GuestRenewInput,
  ): Promise<GuestGrantResult> {
    const result = await post(path, body);
    if (!result.response) return unavailable<GuestGrantResult>();
    if (!result.response.ok)
      return statusFailure(result.response, result.value);
    const parsed = parseGuestGrantResult(result.value, {
      authority: options.authority,
      audience: options.audience,
    });
    return parsed && parsed.status === "success"
      ? parsed
      : unavailable<GuestGrantResult>();
  }

  return {
    async createGuest(): Promise<GuestCreateResult> {
      const result = await post("/internal/v1/guests");
      if (!result.response) return unavailable<GuestCreateResult>();
      if (!result.response.ok)
        return statusFailure(result.response, result.value);
      const parsed = parseGuestCreateResult(result.value, {
        authority: options.authority,
        audience: options.audience,
      });
      return parsed && parsed.status === "success"
        ? parsed
        : unavailable<GuestCreateResult>();
    },
    async resolveGuestControl(
      bootstrapCredential: string,
    ): Promise<GuestResolveResult> {
      if (!bootstrapCredential) return { status: "invalid_guest_control" };
      const result = await post("/internal/v1/guests/resolve", {
        bootstrapCredential,
      });
      if (!result.response) return unavailable<GuestResolveResult>();
      if (!result.response.ok)
        return statusFailure(result.response, result.value);
      const parsed = parseGuestResolveResult(result.value, {
        authority: options.authority,
        audience: options.audience,
      });
      return parsed && parsed.status === "success"
        ? parsed
        : unavailable<GuestResolveResult>();
    },
    attestGuestGrant(input: GuestGrantInput): Promise<GuestGrantResult> {
      return grant("/internal/v1/guest-grants", input);
    },
    renewGuestGrant(input: GuestRenewInput): Promise<GuestGrantResult> {
      return grant(
        `/internal/v1/guest-grants/${encodeURIComponent(input.grantId)}/renew`,
        input,
      );
    },
    async revokeGuestGrant(grantId: string) {
      if (!grantId) return { status: "grant_denied" as const };
      const result = await post(
        `/internal/v1/guest-grants/${encodeURIComponent(grantId)}/revoke`,
      );
      if (!result.response) return { status: "authority_unavailable" as const };
      if (!result.response.ok) {
        const failure = statusFailure(result.response, result.value);
        return failure.status === "grant_denied"
          ? { status: "grant_denied" as const }
          : { status: "authority_unavailable" as const };
      }
      if (
        typeof result.value === "object" &&
        result.value !== null &&
        !Array.isArray(result.value) &&
        (result.value as { status?: unknown }).status === "success" &&
        (result.value as { revoked?: unknown }).revoked === true
      ) {
        return { status: "success" as const, revoked: true as const };
      }
      return { status: "authority_unavailable" as const };
    },
  };
}

export type BrowserOAuthFailureStatus =
  | "invalid_login"
  | "authority_unavailable"
  | "invalid_request";

export interface BrowserOAuthTransaction {
  stateHash: string;
  browserBindingHash: string;
  codeVerifier: string;
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  returnTo: string;
  expiresAt: number;
}

/**
 * The consumer must implement consume atomically in its durable store. It
 * must delete only a matching, unexpired state and return it once; a cookie
 * delete or a read followed by a delete is not a valid implementation.
 */
export interface BrowserOAuthTransactionStore {
  put(transaction: BrowserOAuthTransaction): Promise<void>;
  consume(input: {
    stateHash: string;
    browserBindingHash: string;
    now: number;
  }): Promise<BrowserOAuthTransaction | null>;
  cleanup(input: { now: number; limit: number }): Promise<number>;
}

export interface PlatformBrowserClientOptions {
  /** Platform authority origin. This client is server-side and keeps secrets here. */
  baseUrl: string;
  authority: string;
  audience: string;
  serviceVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  transactionStore: BrowserOAuthTransactionStore;
  /** Routes are consumer-configurable but must resolve on the Platform origin. */
  routes?: {
    authorization?: string;
    token?: string;
  };
  /** The service origin used to validate local return paths. */
  returnOrigin?: string;
  credentialCookieName?: string;
  browserBindingCookieName?: string;
  timeoutMs?: number;
  transactionTtlMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

export type BrowserAuthorizationStartResult =
  | {
      status: "started";
      authorizationUrl: string;
      setCookie: string;
      returnTo: string;
      expiresAt: number;
    }
  | { status: "invalid_request" }
  | { status: "authority_unavailable" };

export type BrowserAuthorizationCallbackResult =
  | {
      status: "authenticated";
      returnTo: string;
      setCookie: string;
      clearBrowserBindingCookie: string;
      expiresAt: number;
    }
  | {
      status: "invalid_login";
      reason:
        | "invalid_state"
        | "invalid_callback"
        | "access_denied"
        | "invalid_grant"
        | "invalid_response"
        | "unexpected_refresh";
      returnTo?: string;
      clearBrowserBindingCookie?: string;
    }
  | {
      status: "authority_unavailable";
      returnTo?: string;
      clearBrowserBindingCookie?: string;
    };

export type BrowserCredentialSelection =
  | { source: "authorization"; status: "present"; credential: string }
  | { source: "authorization"; status: "invalid"; credential: null }
  | { source: "cookie"; status: "present"; credential: string }
  | { source: "cookie"; status: "invalid"; credential: null }
  | { source: "none"; status: "absent"; credential: null };

export interface PlatformBrowserClient {
  start(input?: { returnTo?: string }): Promise<BrowserAuthorizationStartResult>;
  callback(request: Request): Promise<BrowserAuthorizationCallbackResult>;
  selectCredential(request: Request): BrowserCredentialSelection;
  clearCredentialCookie(): string;
  clearBrowserBindingCookie(): string;
  isSameOriginUnsafeRequest(request: Request): boolean;
}

const DEFAULT_BROWSER_TRANSACTION_TTL_MS = 5 * 60 * 1000;
const MAX_BROWSER_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const BROWSER_CLEANUP_LIMIT = 32;
const COOKIE_NAME_PATTERN = /^(?:__Host-)?[A-Za-z0-9!#$%&'*+.^_`|~-]{1,96}$/;

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function randomBrowserSecret(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hashBrowserMaterial(value: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      ),
    ),
  );
}

function browserRoute(baseUrl: string, path: string): URL | null {
  try {
    const base = new URL(baseUrl);
    const route = new URL(path, base);
    return route.origin === base.origin ? route : null;
  } catch {
    return null;
  }
}

function validBrowserCookieName(value: string): boolean {
  return COOKIE_NAME_PATTERN.test(value);
}

function cookieHeader(
  name: string,
  value: string,
  maxAge: number,
  now = Date.now(),
): string {
  const safeAge = Math.max(0, Math.floor(maxAge));
  const expires = new Date(now + safeAge * 1000).toUTCString();
  return `${name}=${encodeURIComponent(value)}; Max-Age=${safeAge}; Expires=${expires}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function credentialCookieHeader(
  name: string,
  value: string,
  expiresAt: number,
): string {
  const expires = new Date(expiresAt).toUTCString();
  return `${name}=${encodeURIComponent(value)}; Expires=${expires}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function clearCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function parseCookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  const values: string[] = [];
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      values.push(decodeURIComponent(value));
    } catch {
      return null;
    }
  }
  return values.length === 1 ? values[0]! : null;
}

function hasCookieName(request: Request, name: string): boolean {
  const raw = request.headers.get("cookie");
  if (!raw) return false;
  return raw.split(";").some((part) => {
    const separator = part.indexOf("=");
    return separator > 0 && part.slice(0, separator).trim() === name;
  });
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasDuplicateQueryParameter(
  params: URLSearchParams,
  name: string,
): boolean {
  return params.getAll(name).length > 1;
}

function safeReturnPath(value: unknown, origin: string): string | null {
  if (value === undefined) return "/";
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const resolved = new URL(value, origin);
    if (resolved.origin !== new URL(origin).origin || resolved.hash) return null;
    if (value.startsWith("//")) return null;
    const normalized = `${resolved.pathname}${resolved.search}`;
    if (!normalized.startsWith("/") || normalized.startsWith("//")) return null;
    return value.startsWith("/") ? normalized : null;
  } catch {
    return null;
  }
}

function browserReturnOrigin(options: PlatformBrowserClientOptions): string {
  const consumerOrigin = new URL(options.redirectUri).origin;
  if (options.returnOrigin === undefined) return consumerOrigin;
  const configuredOrigin = new URL(options.returnOrigin).origin;
  if (configuredOrigin !== consumerOrigin) {
    throw new Error("Browser OAuth return origin must match the redirect origin");
  }
  return consumerOrigin;
}

function validateBrowserOptions(options: PlatformBrowserClientOptions): void {
  const base = new URL(options.baseUrl);
  if (!options.authority || !options.audience || !options.clientId || !options.clientSecret) {
    throw new Error("Platform browser OAuth configuration is incomplete");
  }
  const resource = new URL(options.resource);
  if (resource.username || resource.password || resource.search || resource.hash) {
    throw new Error("Browser OAuth resource must be an origin URL");
  }
  if (!validBrowserCookieName(options.credentialCookieName ?? "__Host-0000-access")) {
    throw new Error("Invalid browser credential cookie name");
  }
  if (!validBrowserCookieName(options.browserBindingCookieName ?? "__Host-0000-oauth-binding")) {
    throw new Error("Invalid browser binding cookie name");
  }
  if ((options.credentialCookieName ?? "__Host-0000-access") === (options.browserBindingCookieName ?? "__Host-0000-oauth-binding")) {
    throw new Error("Browser credential and binding cookie names must differ");
  }
  if (
    !Array.isArray(options.scopes) ||
    options.scopes.length === 0 ||
    options.scopes.some((scope) => !/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,63}$/.test(scope)) ||
    new Set(options.scopes).size !== options.scopes.length ||
    options.scopes.includes("offline_access")
  ) {
    throw new Error("Browser OAuth scopes must be unique access capabilities");
  }
  if (!validBrowserRedirectUri(options.redirectUri)) {
    throw new Error("Invalid browser OAuth redirect URI");
  }
  if (new URL(options.redirectUri).search || new URL(options.redirectUri).hash) {
    throw new Error("Browser OAuth redirect URI must not contain query or fragment");
  }
  if (!browserRoute(options.baseUrl, options.routes?.authorization ?? "/api/auth/oauth2/authorize")) {
    throw new Error("Browser OAuth authorization route must be same-origin");
  }
  if (!browserRoute(options.baseUrl, options.routes?.token ?? "/api/auth/oauth2/token")) {
    throw new Error("Browser OAuth token route must be same-origin");
  }
  if (!Number.isSafeInteger(options.transactionTtlMs ?? DEFAULT_BROWSER_TRANSACTION_TTL_MS) ||
      (options.transactionTtlMs ?? DEFAULT_BROWSER_TRANSACTION_TTL_MS) < 1_000 ||
      (options.transactionTtlMs ?? DEFAULT_BROWSER_TRANSACTION_TTL_MS) > MAX_BROWSER_TRANSACTION_TTL_MS) {
    throw new RangeError("transactionTtlMs is outside the bounded browser-login range");
  }
  browserReturnOrigin(options);
  void base;
}

function validBrowserRedirectUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost")) &&
      !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function tokenExpiry(value: Record<string, unknown>, now: number): number | null {
  const expiresAt = typeof value.expires_at === "string" ? Date.parse(value.expires_at) : NaN;
  const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in) && value.expires_in > 0
    ? Math.floor(now + value.expires_in * 1000)
    : NaN;
  const candidate = Number.isFinite(expiresAt) ? expiresAt : expiresIn;
  return Number.isSafeInteger(candidate) && candidate > now ? candidate : null;
}

function callbackFailure(
  status: "invalid_login" | "authority_unavailable",
  reason: Extract<BrowserAuthorizationCallbackResult, { status: "invalid_login" }>["reason"] | undefined,
  returnTo: string | undefined,
  clearBrowserBindingCookie: string | undefined,
): BrowserAuthorizationCallbackResult {
  if (status === "authority_unavailable") {
    return { status, ...(returnTo ? { returnTo } : {}), ...(clearBrowserBindingCookie ? { clearBrowserBindingCookie } : {}) };
  }
  return {
    status,
    reason: reason ?? "invalid_callback",
    ...(returnTo ? { returnTo } : {}),
    ...(clearBrowserBindingCookie ? { clearBrowserBindingCookie } : {}),
  };
}

export function selectBrowserCredential(
  request: Request,
  credentialCookieName = "__Host-0000-access",
): BrowserCredentialSelection {
  if (request.headers.has("authorization")) {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/.exec(header);
    return match
      ? { source: "authorization", status: "present", credential: match[1]! }
      : { source: "authorization", status: "invalid", credential: null };
  }
  const credential = parseCookieValue(request, credentialCookieName);
  return credential
    ? { source: "cookie", status: "present", credential }
    : hasCookieName(request, credentialCookieName)
      ? { source: "cookie", status: "invalid", credential: null }
      : { source: "none", status: "absent", credential: null };
}

export function isSameOriginUnsafeBrowserRequest(
  request: Request,
  origin: string,
): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  try {
    return request.headers.get("origin") === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function clearBrowserCredentialCookie(
  credentialCookieName = "__Host-0000-access",
): string {
  return clearCookieHeader(credentialCookieName);
}

export async function startBrowserAuthorization(
  options: PlatformBrowserClientOptions,
  input: { returnTo?: string } = {},
): Promise<BrowserAuthorizationStartResult> {
  validateBrowserOptions(options);
  const now = options.now?.() ?? Date.now();
  const returnOrigin = browserReturnOrigin(options);
  const returnTo = safeReturnPath(input.returnTo, returnOrigin);
  if (!returnTo) return { status: "invalid_request" };
  const state = randomBrowserSecret();
  const browserBinding = randomBrowserSecret();
  const codeVerifier = randomBrowserSecret(48);
  const codeChallenge = await hashBrowserMaterial(codeVerifier);
  const stateHash = await hashBrowserMaterial(state);
  const browserBindingHash = await hashBrowserMaterial(browserBinding);
  const ttl = options.transactionTtlMs ?? DEFAULT_BROWSER_TRANSACTION_TTL_MS;
  const expiresAt = now + ttl;
  try {
    await options.transactionStore.cleanup({ now, limit: BROWSER_CLEANUP_LIMIT });
    await options.transactionStore.put({
      stateHash,
      browserBindingHash,
      codeVerifier,
      codeChallenge,
      clientId: options.clientId,
      redirectUri: options.redirectUri,
      resource: options.resource,
      scopes: [...options.scopes],
      returnTo,
      expiresAt,
    });
  } catch {
    return { status: "authority_unavailable" };
  }
  const authorization = browserRoute(
    options.baseUrl,
    options.routes?.authorization ?? "/api/auth/oauth2/authorize",
  );
  if (!authorization) return { status: "authority_unavailable" };
  authorization.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: "code",
    redirect_uri: options.redirectUri,
    resource: options.resource,
    scope: options.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return {
    status: "started",
    authorizationUrl: authorization.toString(),
    setCookie: cookieHeader(
      options.browserBindingCookieName ?? "__Host-0000-oauth-binding",
      browserBinding,
      Math.floor(ttl / 1000),
      now,
    ),
    returnTo,
    expiresAt,
  };
}

export async function completeBrowserAuthorization(
  options: PlatformBrowserClientOptions,
  request: Request,
): Promise<BrowserAuthorizationCallbackResult> {
  validateBrowserOptions(options);
  const now = options.now?.() ?? Date.now();
  const bindingCookieName = options.browserBindingCookieName ?? "__Host-0000-oauth-binding";
  const clearBinding = clearCookieHeader(bindingCookieName);
  let callback: URL;
  try {
    callback = new URL(request.url);
    const configured = new URL(options.redirectUri);
    if (request.method !== "GET" || callback.origin !== configured.origin || callback.pathname !== configured.pathname) {
      return callbackFailure("invalid_login", "invalid_callback", undefined, undefined);
    }
  } catch {
    return callbackFailure("invalid_login", "invalid_callback", undefined, undefined);
  }
  const params = callback.searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const error = params.get("error");
  if (
    !state ||
    state.length > 512 ||
    hasDuplicateQueryParameter(params, "state") ||
    hasDuplicateQueryParameter(params, "code") ||
    hasDuplicateQueryParameter(params, "error") ||
    hasDuplicateQueryParameter(params, "error_description") ||
    hasDuplicateQueryParameter(params, "error_uri") ||
    (code && code.length > 4096) ||
    (error && error.length > 256)
  ) {
    return callbackFailure("invalid_login", "invalid_callback", undefined, undefined);
  }
  const hasErrorFields = error !== null || params.has("error_description") || params.has("error_uri");
  if ((code !== null && hasErrorFields) || (code === null && !hasErrorFields)) {
    return callbackFailure("invalid_login", "invalid_callback", undefined, undefined);
  }
  const browserBinding = parseCookieValue(request, bindingCookieName);
  if (!browserBinding) return callbackFailure("invalid_login", "invalid_state", undefined, undefined);
  const stateHash = await hashBrowserMaterial(state);
  const browserBindingHash = await hashBrowserMaterial(browserBinding);
  let transaction: BrowserOAuthTransaction | null;
  try {
    transaction = await options.transactionStore.consume({ stateHash, browserBindingHash, now });
  } catch {
    return callbackFailure("authority_unavailable", undefined, undefined, undefined);
  }
  if (!transaction || transaction.expiresAt <= now) {
    return callbackFailure("invalid_login", "invalid_state", undefined, clearBinding);
  }
  const transactionIsCurrent = transaction.clientId === options.clientId &&
    transaction.redirectUri === options.redirectUri &&
    transaction.resource === options.resource &&
    sameStringArray(transaction.scopes, options.scopes) &&
    transaction.stateHash === stateHash &&
    transaction.codeChallenge === await hashBrowserMaterial(transaction.codeVerifier) &&
    safeReturnPath(transaction.returnTo, browserReturnOrigin(options)) !== null;
  if (!transactionIsCurrent) {
    return callbackFailure("invalid_login", "invalid_state", undefined, clearBinding);
  }
  if (error !== null) {
    return callbackFailure("invalid_login", error === "access_denied" ? "access_denied" : "invalid_grant", transaction.returnTo, clearBinding);
  }
  if (!code) return callbackFailure("invalid_login", "invalid_callback", transaction.returnTo, clearBinding);
  const tokenEndpoint = browserRoute(options.baseUrl, options.routes?.token ?? "/api/auth/oauth2/token");
  if (!tokenEndpoint) return callbackFailure("authority_unavailable", undefined, transaction.returnTo, clearBinding);
  const timeoutMs = validateTimeout(options.timeoutMs);
  const requestFetch = options.fetch ?? fetch;
  const transport = createJsonTransport(requestFetch, timeoutMs);
  const exchange = await transport(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      code,
      code_verifier: transaction.codeVerifier,
      resource: options.resource,
    }),
  });
  if (!exchange.response) return callbackFailure("authority_unavailable", undefined, transaction.returnTo, clearBinding);
  if (exchange.response.status >= 500 || exchange.response.status === 408 || exchange.response.status === 429) {
    return callbackFailure("authority_unavailable", undefined, transaction.returnTo, clearBinding);
  }
  if (!isRecordValue(exchange.value)) {
    return callbackFailure("invalid_login", "invalid_response", transaction.returnTo, clearBinding);
  }
  if (!exchange.response.ok) {
    return callbackFailure("invalid_login", exchange.value.error === "invalid_grant" ? "invalid_grant" : "invalid_response", transaction.returnTo, clearBinding);
  }
  if (
    typeof exchange.value.error === "string" ||
    typeof exchange.value.access_token !== "string" ||
    !exchange.value.access_token ||
    (typeof exchange.value.refresh_token === "string" && exchange.value.refresh_token.length > 0) ||
    (exchange.value.refresh_token !== undefined && exchange.value.refresh_token !== null) ||
    (typeof exchange.value.token_type !== "string" || exchange.value.token_type.toLowerCase() !== "bearer")
  ) {
    return callbackFailure(
      "invalid_login",
      typeof exchange.value.refresh_token === "string" ? "unexpected_refresh" : "invalid_response",
      transaction.returnTo,
      clearBinding,
    );
  }
  const token = exchange.value.access_token;
  const exchangeNow = options.now?.() ?? Date.now();
  const tokenExpiresAt = tokenExpiry(exchange.value, exchangeNow);
  if (tokenExpiresAt === null) return callbackFailure("invalid_login", "invalid_response", transaction.returnTo, clearBinding);
  const platform = createPlatformClient({
    baseUrl: options.baseUrl,
    authority: options.authority,
    audience: options.audience,
    serviceVerifier: options.serviceVerifier,
    fetch: requestFetch,
    timeoutMs,
  });
  const verified = await platform.authenticate(token);
  if (verified.status === "authority_unavailable") {
    return callbackFailure("authority_unavailable", undefined, transaction.returnTo, clearBinding);
  }
  if (
    verified.status !== "authenticated" ||
    verified.principal.kind !== "human" ||
    verified.principal.authority !== options.authority ||
    verified.principal.audience !== options.audience ||
    verified.principal.capabilities.some((capability) => !options.scopes.includes(capability))
  ) {
    return callbackFailure("invalid_login", "invalid_response", transaction.returnTo, clearBinding);
  }
  const finalNow = options.now?.() ?? Date.now();
  const authorityExpiry = Date.parse(verified.principal.expiresAt);
  const expiresAt = Math.min(tokenExpiresAt, authorityExpiry);
  // HTTP cookie dates have one-second granularity and Chromium reports an
  // Expires date at the end of its serialized second. Leave a bounded
  // two-second margin so the browser cookie can never outlive the credential.
  const cookieExpiresAt = expiresAt - 2_000;
  if (
    !Number.isSafeInteger(authorityExpiry) ||
    authorityExpiry <= finalNow ||
    expiresAt <= finalNow ||
    !Number.isSafeInteger(expiresAt) ||
    cookieExpiresAt <= finalNow
  ) {
    return callbackFailure("invalid_login", "invalid_response", transaction.returnTo, clearBinding);
  }
  return {
    status: "authenticated",
    returnTo: transaction.returnTo,
    setCookie: credentialCookieHeader(
      options.credentialCookieName ?? "__Host-0000-access",
      token,
      cookieExpiresAt,
    ),
    clearBrowserBindingCookie: clearBinding,
    expiresAt,
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPlatformBrowserClient(
  options: PlatformBrowserClientOptions,
): PlatformBrowserClient {
  validateBrowserOptions(options);
  const credentialCookieName = options.credentialCookieName ?? "__Host-0000-access";
  const bindingCookieName = options.browserBindingCookieName ?? "__Host-0000-oauth-binding";
  return {
    start: (input = {}) => startBrowserAuthorization(options, input),
    callback: (request) => completeBrowserAuthorization(options, request),
    selectCredential: (request) => selectBrowserCredential(request, credentialCookieName),
    clearCredentialCookie: () => clearBrowserCredentialCookie(credentialCookieName),
    clearBrowserBindingCookie: () => clearCookieHeader(bindingCookieName),
    isSameOriginUnsafeRequest: (request) => isSameOriginUnsafeBrowserRequest(request, browserReturnOrigin(options)),
  };
}

/** Alias kept for consumers that name the shared helper by its OAuth role. */
export const createBrowserOAuthClient = createPlatformBrowserClient;
