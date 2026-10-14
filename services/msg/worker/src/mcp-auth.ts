import type {
  McpAccessToken,
  McpAuthStore,
  McpGrant,
  McpRefreshToken,
} from "./mcp-auth-store";

export const MCP_SCOPES = ["threads:read", "threads:post", "threads:monitor"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export type McpThreadCapability = "read" | "post" | "monitor";

const SCOPE_SET = new Set<string>(MCP_SCOPES);
const CAPABILITY_SCOPE: Record<McpThreadCapability, McpScope> = {
  read: "threads:read",
  post: "threads:post",
  monitor: "threads:monitor",
};
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_STATE_CHARS = 512;
const MAX_CLIENT_NAME_CHARS = 200;
const MAX_THREAD_URL_CHARS = 2_048;
const MAX_THREAD_GRANTS = 32;

export interface McpAuthConfig {
  readonly issuer: string;
  readonly resource: string;
  /** Explicit legacy origins accepted for OAuth form submissions and Thread URLs. */
  readonly acceptedOrigins?: readonly string[];
  /** The URL advertised in WWW-Authenticate. Defaults to the resource origin's standard path. */
  readonly protectedResourceMetadataUrl?: string;
  readonly store: McpAuthStore;
  readonly now?: () => number;
}

export interface McpThreadValidation {
  /** The canonical URL to persist after the read-only existence check. */
  readonly canonicalUrl?: string;
}

export type McpThreadValidator = (threadUrl: string) => Promise<McpThreadValidation | null>;

export interface McpAuthorizeOptions {
  readonly validateThread: McpThreadValidator;
}

export interface McpPrincipal {
  readonly clientId: string;
  readonly principalId: string;
  readonly scopes: readonly McpScope[];
}

export class McpAuthError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_scope" | "unauthorized_client" | "access_denied",
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "McpAuthError";
  }
}

/**
 * Account-free OAuth authorization for Msg's MCP resource. The caller owns
 * the HTTP routing and supplies the read-only Thread existence check.
 */
export class McpAuthService {
  readonly issuer: string;
  readonly resource: string;
  private readonly protectedResourceMetadataUrl: string;
  private readonly acceptedOrigins: ReadonlySet<string>;
  private readonly acceptedResources: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(private readonly config: McpAuthConfig) {
    this.issuer = assertHttpsIdentifier(config.issuer, "issuer");
    this.resource = assertHttpsIdentifier(config.resource, "resource");
    this.protectedResourceMetadataUrl = assertHttpsIdentifier(config.protectedResourceMetadataUrl ?? `${new URL(this.resource).origin}/.well-known/oauth-protected-resource`, "protected resource metadata URL");
    this.acceptedOrigins = new Set([new URL(this.issuer).origin, ...(config.acceptedOrigins ?? []).map((value) => new URL(assertHttpsIdentifier(value, "accepted origin")).origin)]);
    // Legacy resources use the current MCP path on explicitly configured origins;
    // arbitrary resource URLs never become valid through this compatibility set.
    const resourcePath = new URL(this.resource).pathname;
    this.acceptedResources = new Set([...this.acceptedOrigins].map((origin) => `${origin}${resourcePath}`));
    this.now = config.now ?? (() => Date.now());
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: this.endpoint("authorize"),
      token_endpoint: this.endpoint("token"),
      registration_endpoint: this.endpoint("register"),
      revocation_endpoint: this.endpoint("revoke"),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...MCP_SCOPES],
      authorization_response_iss_parameter_supported: true,
    };
  }

  async registerClient(request: Request): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const body = await readJson(request);
    const clientName = requiredString(body.client_name, "client_name", MAX_CLIENT_NAME_CHARS);
    const redirectUris = parseRedirectUris(body.redirect_uris);
    if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || !body.grant_types.every((value) => value === "authorization_code" || value === "refresh_token"))) {
      throw new McpAuthError("invalid_client", "The client grant types are invalid.");
    }
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || !body.response_types.every((value) => value === "code"))) {
      throw new McpAuthError("invalid_client", "The client response types are invalid.");
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      throw new McpAuthError("invalid_client", "Only public clients using PKCE are supported.");
    }
    const now = this.now();
    const clientId = `cli_${randomOpaque(18)}`;
    await this.config.store.createClient({ clientId, clientName, redirectUris, createdAt: now, expiresAt: null });
    return json({
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  }

  async authorize(request: Request, options: McpAuthorizeOptions): Promise<Response> {
    if (request.method === "GET") return this.renderConsent(request);
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    assertSameOrigin(request, this.acceptedOrigins);
    const submission = await readAuthorizeSubmission(request);
    const now = this.now();
    const authRequest = await this.config.store.getAuthorizationRequest(submission.requestId, now);
    if (!authRequest || !this.acceptedResources.has(authRequest.resource) || !constantTimeEqual(await sha256(submission.csrf), authRequest.csrfHash) || authRequest.completedAt !== null) {
      throw new McpAuthError("invalid_request", "The authorization request is invalid or expired.");
    }
    if (submission.decision === "deny") {
      const completed = await this.config.store.completeAuthorizationRequest(authRequest.requestId, now);
      if (!completed) throw new McpAuthError("invalid_request", "The authorization request was already completed.");
      return redirectWithQuery(authRequest.redirectUri, { error: "access_denied", error_description: "The user denied access.", state: authRequest.stateValue, iss: this.issuerForResource(authRequest.resource) });
    }
    const grants = await this.validateSubmittedGrants(submission.grants, authRequest.scope, options.validateThread, authRequest.resource);
    const completed = await this.config.store.completeAuthorizationRequest(authRequest.requestId, now);
    if (!completed) throw new McpAuthError("invalid_request", "The authorization request was already completed.");

    const principalId = `prf_${randomOpaque(18)}`;
    const code = randomOpaque(32);
    await this.config.store.createPrincipal(principalId, now);
    for (const grant of grants) {
      await this.config.store.upsertGrant({ principalId, threadUrl: grant.threadUrl, scope: joinScopes(grant.scopes), source: "public", createdAt: now, revokedAt: null });
    }
    await this.config.store.createAuthorizationCode({
      codeHash: await sha256(code),
      requestId: authRequest.requestId,
      principalId,
      clientId: authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      scope: joinScopes(grants.flatMap((grant) => grant.scopes)),
      resource: authRequest.resource,
      codeChallenge: authRequest.codeChallenge,
      createdAt: now,
      expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
      usedAt: null,
    });
    return redirectWithQuery(authRequest.redirectUri, { code, state: authRequest.stateValue, iss: this.issuerForResource(authRequest.resource) });
  }

  async token(request: Request): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const form = await readForm(request);
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return this.exchangeAuthorizationCode(form);
    if (grantType === "refresh_token") return this.exchangeRefreshToken(form);
    throw new McpAuthError("invalid_request", "The grant_type is unsupported.");
  }

  async revoke(request: Request): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const form = await readForm(request);
    const token = form.get("token");
    const clientId = form.get("client_id");
    if (!token || token.length > 512 || !clientId) return json({ error: "invalid_request" }, 400);
    const now = this.now();
    const hash = await sha256(token);
    const access = await this.config.store.getAccessToken(hash, now);
    if (access) {
      if (access.clientId !== clientId) return json({ error: "invalid_client" }, 401);
      // A bearer-token revocation is a connection disconnect in this
      // account-free model. Revoking only the access token would leave an
      // event grant alive for background delivery or refresh.
      await this.config.store.revokePrincipal(access.principalId, now);
      return new Response(null, { status: 200, headers: noStoreHeaders() });
    }
    const refresh = await this.config.store.getRefreshToken(hash, now);
    if (refresh) {
      if (refresh.clientId !== clientId) return json({ error: "invalid_client" }, 401);
      await this.config.store.revokeRefreshFamily(refresh.familyId, refresh.principalId, now);
    }
    return new Response(null, { status: 200, headers: noStoreHeaders() });
  }

  async authenticateBearer(request: Request, requiredScopes: readonly McpScope[] = []): Promise<McpPrincipal> {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{32,512})$/iu.exec(authorization);
    if (!match) throw new McpAuthError("invalid_grant", "A valid bearer token is required.", 401);
    const now = this.now();
    const token = await this.config.store.getAccessToken(await sha256(match[1]), now);
    if (!token || !this.acceptedResources.has(token.resource) || await this.config.store.isPrincipalRevoked(token.principalId)) {
      throw new McpAuthError("invalid_grant", "The bearer token is invalid or expired.", 401);
    }
    const scopes = parseScopes(token.scope);
    if (requiredScopes.some((scope) => !scopes.includes(scope))) throw new McpAuthError("invalid_scope", "The bearer token lacks the required scope.", 403);
    return { clientId: token.clientId, principalId: token.principalId, scopes };
  }

  async validateGrant(principalId: string, threadUrl: string, capability: McpThreadCapability): Promise<McpGrant | null> {
    if (await this.config.store.isPrincipalRevoked(principalId)) return null;
    for (const candidate of canonicalThreadUrlCandidates(threadUrl, this.resource, this.acceptedOrigins)) {
      const grant = await this.config.store.getGrant(principalId, candidate);
      if (grant) return parseScopes(grant.scope).includes(CAPABILITY_SCOPE[capability]) ? grant : null;
    }
    return null;
  }

  async disconnect(principalId: string): Promise<void> {
    await this.config.store.revokePrincipal(principalId, this.now());
  }

  profile(principalId: string): { readonly id: string } {
    if (!/^prf_[A-Za-z0-9_-]{20,64}$/u.test(principalId)) throw new McpAuthError("invalid_grant", "The profile is invalid.", 401);
    return { id: principalId };
  }

  bearerChallenge(requiredScopes: readonly McpScope[] = []): string {
    const value = [`Bearer resource_metadata="${this.protectedResourceMetadataUrl}"`, "error=\"invalid_token\"", "error_description=\"Authentication required\""];
    if (requiredScopes.length) value.push(`scope="${requiredScopes.join(" ")}"`);
    return value.join(", ");
  }

  private async renderConsent(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let parsed: AuthorizationParameters;
    try {
      parsed = this.parseAuthorizationParameters(url.searchParams);
    } catch (error) {
      if (error instanceof McpAuthError) return this.authorizationError(url.searchParams, error);
      throw error;
    }
    const client = await this.config.store.getClient(parsed.clientId, this.now());
    if (!client || !client.redirectUris.includes(parsed.redirectUri)) return json({ error: "invalid_request" }, 400);
    const now = this.now();
    const requestId = `req_${randomOpaque(18)}`;
    const csrf = randomOpaque(32);
    await this.config.store.createAuthorizationRequest({
      requestId,
      stateValue: parsed.state,
      stateHash: await sha256(parsed.state),
      csrfHash: await sha256(csrf),
      clientId: parsed.clientId,
      redirectUri: parsed.redirectUri,
      scope: joinScopes(parsed.scopes),
      resource: parsed.resource,
      codeChallenge: parsed.codeChallenge,
      createdAt: now,
      expiresAt: now + AUTHORIZATION_REQUEST_TTL_MS,
      completedAt: null,
    });
    return html(consentHtml(this.issuerForResource(parsed.resource), client.clientName, requestId, csrf, parsed.scopes));
  }

  private parseAuthorizationParameters(params: URLSearchParams): AuthorizationParameters {
    const responseType = params.get("response_type");
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    const scope = params.get("scope");
    const state = params.get("state");
    const codeChallenge = params.get("code_challenge");
    const method = params.get("code_challenge_method");
    const resource = params.get("resource");
    if (responseType !== "code" || !clientId || !redirectUri || !scope || !state || !codeChallenge || method !== "S256" || resource === null || !this.acceptedResources.has(resource)) {
      throw new McpAuthError("invalid_request", "The authorization request is incomplete.");
    }
    if (state.length > MAX_STATE_CHARS || !/^[\x21-\x7e]+$/u.test(state)) throw new McpAuthError("invalid_request", "The state is invalid.");
    if (!isSafeRedirectUri(redirectUri)) throw new McpAuthError("invalid_request", "The redirect URI is invalid.");
    const scopes = parseRequestedScopes(scope);
    if (codeChallenge.length < 43 || codeChallenge.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(codeChallenge)) throw new McpAuthError("invalid_request", "The code challenge is invalid.");
    return { clientId, redirectUri, scopes, state, codeChallenge, resource };
  }

  private async validateSubmittedGrants(submitted: readonly SubmittedGrant[], requestedScope: string, validateThread: McpThreadValidator, resource: string): Promise<readonly ValidatedGrant[]> {
    if (!submitted.length || submitted.length > MAX_THREAD_GRANTS) throw new McpAuthError("access_denied", "At least one Thread must be selected.");
    const allowed = new Set(parseScopes(requestedScope));
    const seen = new Set<string>();
    const grants: ValidatedGrant[] = [];
    for (const item of submitted) {
      const candidate = canonicalThreadUrl(item.threadUrl, resource, this.acceptedOrigins);
      if (seen.has(candidate)) throw new McpAuthError("invalid_request", "A Thread was selected more than once.");
      seen.add(candidate);
      const scopes = [...new Set(item.scopes)].filter((scope): scope is McpScope => SCOPE_SET.has(scope) && allowed.has(scope as McpScope));
      if (!scopes.length) throw new McpAuthError("invalid_scope", "Each Thread needs at least one requested capability.");
      const exists = await validateThread(candidate);
      if (!exists) throw new McpAuthError("access_denied", "The selected Thread could not be found.");
      const canonicalUrl = exists.canonicalUrl ? canonicalThreadUrl(exists.canonicalUrl, resource, this.acceptedOrigins) : candidate;
      grants.push({ threadUrl: canonicalUrl, scopes });
    }
    return grants;
  }

  private async exchangeAuthorizationCode(form: URLSearchParams): Promise<Response> {
    const code = requiredForm(form, "code");
    const clientId = requiredForm(form, "client_id");
    const redirectUri = requiredForm(form, "redirect_uri");
    const verifier = requiredForm(form, "code_verifier");
    const resource = requiredForm(form, "resource");
    if (!this.acceptedResources.has(resource) || !isCodeVerifier(verifier)) throw new McpAuthError("invalid_grant", "The authorization code request is invalid.");
    const now = this.now();
    const codeHash = await sha256(code);
    const record = await this.config.store.getAuthorizationCode(codeHash, now);
    if (!record || record.clientId !== clientId || record.redirectUri !== redirectUri || !this.acceptedResources.has(record.resource) || record.resource !== resource || !(await verifyPkce(verifier, record.codeChallenge))) {
      throw new McpAuthError("invalid_grant", "The authorization code is invalid or expired.");
    }
    const consumed = await this.config.store.consumeAuthorizationCode(codeHash, now);
    if (!consumed || await this.config.store.isPrincipalRevoked(consumed.principalId)) throw new McpAuthError("invalid_grant", "The authorization code is invalid or expired.");
    return this.issueTokenPair(consumed.principalId, consumed.clientId, consumed.scope, consumed.resource, now, randomOpaque(18));
  }

  private async exchangeRefreshToken(form: URLSearchParams): Promise<Response> {
    const refreshValue = requiredForm(form, "refresh_token");
    const clientId = requiredForm(form, "client_id");
    const resource = requiredForm(form, "resource");
    if (!this.acceptedResources.has(resource) || refreshValue.length > 512) throw new McpAuthError("invalid_grant", "The refresh token is invalid.");
    const now = this.now();
    const hash = await sha256(refreshValue);
    const refresh = await this.config.store.getRefreshToken(hash, now);
    if (!refresh || refresh.clientId !== clientId || !this.acceptedResources.has(refresh.resource) || refresh.resource !== resource) throw new McpAuthError("invalid_grant", "The refresh token is invalid.");
    if (refresh.usedAt !== null || refresh.replacedByHash !== null || refresh.revokedAt !== null) {
      await this.config.store.revokeRefreshFamily(refresh.familyId, refresh.principalId, now);
      throw new McpAuthError("invalid_grant", "The refresh token was replayed and the connection was revoked.");
    }
    if (await this.config.store.isPrincipalRevoked(refresh.principalId)) throw new McpAuthError("invalid_grant", "The connection was revoked.");
    const requestedScope = form.get("scope");
    const scope = requestedScope === null ? parseScopes(refresh.scope) : parseRequestedScopes(requestedScope);
    const original = new Set(parseScopes(refresh.scope));
    if (scope.some((item) => !original.has(item))) throw new McpAuthError("invalid_scope", "The requested scope exceeds the granted scope.");
    const nextRefresh = randomOpaque(32);
    const nextHash = await sha256(nextRefresh);
    if (!await this.config.store.markRefreshTokenUsed(hash, nextHash, now)) {
      await this.config.store.revokeRefreshFamily(refresh.familyId, refresh.principalId, now);
      throw new McpAuthError("invalid_grant", "The refresh token was replayed and the connection was revoked.");
    }
    const response = await this.issueTokenPair(refresh.principalId, refresh.clientId, joinScopes(scope), refresh.resource, now, refresh.familyId, nextRefresh);
    return response;
  }

  private async issueTokenPair(principalId: string, clientId: string, scope: string, resource: string, now: number, familyId: string, refreshValue = randomOpaque(32)): Promise<Response> {
    const accessValue = randomOpaque(32);
    const access: McpAccessToken = { tokenHash: await sha256(accessValue), principalId, clientId, scope, resource, createdAt: now, expiresAt: now + ACCESS_TOKEN_TTL_MS, revokedAt: null };
    const refresh: McpRefreshToken = { tokenHash: await sha256(refreshValue), familyId, principalId, clientId, scope, resource, createdAt: now, expiresAt: now + REFRESH_TOKEN_TTL_MS, usedAt: null, replacedByHash: null, revokedAt: null };
    await this.config.store.createAccessToken(access);
    await this.config.store.createRefreshToken(refresh);
    return json({ access_token: accessValue, token_type: "Bearer", expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), refresh_token: refreshValue, scope }, 200);
  }

  private endpoint(path: string): string { return `${this.issuer}/${path}`; }

  private issuerForResource(resource: string): string {
    return this.acceptedResources.has(resource) ? new URL(resource).origin : this.issuer;
  }

  private async authorizationError(params: URLSearchParams, error: McpAuthError): Promise<Response> {
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    const state = params.get("state");
    const client = clientId ? await this.config.store.getClient(clientId, this.now()) : null;
    if (client && redirectUri && client.redirectUris.includes(redirectUri) && state && state.length <= MAX_STATE_CHARS && /^[\x21-\x7e]+$/u.test(state)) {
      const resource = params.get("resource") ?? "";
      return redirectWithQuery(redirectUri, { error: error.code, error_description: error.message, state, iss: this.issuerForResource(resource) });
    }
    return json({ error: error.code, error_description: error.message }, error.status);
  }
}

interface AuthorizationParameters {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly McpScope[];
  readonly state: string;
  readonly codeChallenge: string;
  readonly resource: string;
}

interface SubmittedGrant {
  readonly threadUrl: string;
  readonly scopes: readonly string[];
}

interface ValidatedGrant {
  readonly threadUrl: string;
  readonly scopes: readonly McpScope[];
}

function parseRequestedScopes(value: string): McpScope[] {
  const scopes = [...new Set(value.trim().split(/\s+/u))];
  if (!scopes.length || scopes.some((scope) => !SCOPE_SET.has(scope))) throw new McpAuthError("invalid_scope", "The requested scope is unsupported.");
  return scopes as McpScope[];
}

function parseScopes(value: string): McpScope[] {
  return value.trim() ? value.trim().split(/\s+/u).filter((scope): scope is McpScope => SCOPE_SET.has(scope)) : [];
}

function joinScopes(scopes: readonly string[]): string {
  return [...new Set(scopes)].filter((scope) => SCOPE_SET.has(scope)).sort().join(" ");
}

function canonicalThreadUrl(value: string, resource: string, acceptedOrigins: ReadonlySet<string>): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_THREAD_URL_CHARS) throw new McpAuthError("invalid_request", "The Thread URL is invalid.");
  let url: URL;
  try { url = new URL(value); } catch { throw new McpAuthError("invalid_request", "The Thread URL is invalid."); }
  const resourceUrl = new URL(resource);
  if (url.protocol !== "https:" || !acceptedOrigins.has(url.origin) || url.search || url.hash || url.username || url.password || !/^\/[^/]+$/u.test(url.pathname)) throw new McpAuthError("invalid_request", "The Thread URL is invalid.");
  return `${resourceUrl.origin}${url.pathname}`;
}

function canonicalThreadUrlCandidates(value: string, resource: string, acceptedOrigins: ReadonlySet<string>): readonly string[] {
  const canonical = canonicalThreadUrl(value, resource, acceptedOrigins);
  const pathname = new URL(canonical).pathname;
  return [canonical, ...[...acceptedOrigins].map((origin) => `${origin}${pathname}`).filter((candidate) => candidate !== canonical)];
}

function assertHttpsIdentifier(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`The OAuth ${label} must be an absolute HTTPS URL.`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname.endsWith("/"))) throw new Error(`The OAuth ${label} must be a canonical HTTPS URL.`);
  return parsed.pathname === "/" ? parsed.origin : parsed.toString();
}

function parseRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20 || !value.every((item) => typeof item === "string")) throw new McpAuthError("invalid_client", "redirect_uris must be a non-empty array.");
  const uris = [...new Set(value as string[])];
  if (uris.some((uri) => !isSafeRedirectUri(uri))) throw new McpAuthError("invalid_client", "Redirect URIs must use HTTPS and cannot contain fragments.");
  return uris;
}

function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.hostname.length > 0 && value.length <= 2_048;
  } catch { return false; }
}

function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return Promise.reject(new McpAuthError("invalid_request", "The request must be JSON."));
  return readLimited(request).then((text) => {
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new McpAuthError("invalid_request", "The JSON body is invalid."); }
  });
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") throw new McpAuthError("invalid_request", "The request must be form encoded.");
  return new URLSearchParams(await readLimited(request));
}

async function readAuthorizeSubmission(request: Request): Promise<{ readonly requestId: string; readonly csrf: string; readonly decision: "allow" | "deny"; readonly grants: readonly SubmittedGrant[] }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(await readLimited(request));
    const requestId = form.get("request_id") ?? "";
    const csrf = form.get("csrf") ?? "";
    const decisionValue = form.get("decision");
    if (decisionValue !== "allow" && decisionValue !== "deny") throw new McpAuthError("invalid_request", "The decision is invalid.");
    const decision = decisionValue;
    const threadUrls = (form.get("thread_urls") ?? "").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const scopes = form.getAll("scope");
    return { requestId, csrf, decision, grants: threadUrls.map((threadUrl) => ({ threadUrl, scopes })) };
  }
  const body = await readJson(request);
  const requestId = typeof body.request_id === "string" ? body.request_id : "";
  const csrf = typeof body.csrf === "string" ? body.csrf : "";
  const decision = body.decision === "deny" ? "deny" : body.decision === "allow" ? "allow" : (() => { throw new McpAuthError("invalid_request", "The decision is invalid."); })();
  if (!Array.isArray(body.grants)) throw new McpAuthError("invalid_request", "The grants are invalid.");
  const grants = body.grants.map((value): SubmittedGrant => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpAuthError("invalid_request", "The grants are invalid.");
    const item = value as Record<string, unknown>;
    if (typeof item.thread_url !== "string" || !Array.isArray(item.scopes) || !item.scopes.every((scope) => typeof scope === "string")) throw new McpAuthError("invalid_request", "The grants are invalid.");
    return { threadUrl: item.thread_url, scopes: item.scopes as string[] };
  });
  return { requestId, csrf, decision, grants };
}

function requiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maxChars) throw new McpAuthError("invalid_request", `The ${field} is invalid.`);
  return value;
}

function requiredForm(form: URLSearchParams, field: string): string {
  const value = form.get(field);
  if (!value) throw new McpAuthError("invalid_request", `The ${field} is required.`);
  return value;
}

function assertSameOrigin(request: Request, acceptedOrigins: ReadonlySet<string>): void {
  const origin = request.headers.get("origin");
  if (origin && !acceptedOrigins.has(origin)) throw new McpAuthError("access_denied", "The consent request origin is invalid.", 403);
}

function isCodeVerifier(value: string): boolean { return value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/u.test(value); }

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> { return constantTimeEqual(await sha256(verifier), challenge); }

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return encodeBase64Url(digest);
}

function randomOpaque(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

function redirectWithQuery(uri: string, values: Record<string, string>): Response {
  const redirect = new URL(uri);
  for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { ...noStoreHeaders(), location: redirect.toString() } });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...noStoreHeaders(), "content-type": "application/json; charset=utf-8" } });
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { ...noStoreHeaders(), "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'" } });
}

function noStoreHeaders(): Record<string, string> { return { "cache-control": "no-store", "pragma": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }; }

function methodNotAllowed(allow: string): Response { return new Response(null, { status: 405, headers: { ...noStoreHeaders(), allow } }); }

async function readLimited(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new McpAuthError("invalid_request", "The request body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new McpAuthError("invalid_request", "The request body is too large.");
  return text;
}

function consentHtml(issuer: string, clientName: string, requestId: string, csrf: string, scopes: readonly McpScope[]): string {
  const scopeLabels = scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connect 0000.chat</title></head><body><main><h1>Connect 0000.chat</h1><p><strong>${escapeHtml(clientName)}</strong> requests access to selected 0000.chat Threads.</p><ul>${scopeLabels}</ul><form method="post" action="${escapeHtml(`${issuer}/authorize`)}"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label for="thread_urls">Thread URLs</label><p>Enter one Thread URL per line. The URL is used only after you submit this form.</p><textarea id="thread_urls" name="thread_urls" rows="6" cols="80" required></textarea><fieldset><legend>Capabilities for each selected Thread</legend>${scopes.map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked>${escapeHtml(scope)}</label>`).join(" ")}</fieldset><button type="submit" name="decision" value="allow">Allow access</button><button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`;
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
