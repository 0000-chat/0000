import type { Context, Hono } from "hono";
import { parseBearerToken } from "../auth/bearer";
import {
  constantTimeEqual,
  decryptVerifier,
  encryptVerifier,
  randomIdentifier,
  randomBase64url,
  sha256Base64url,
} from "./crypto";
import {
  completeOAuthUpstreamLogin,
  createOAuthInstallation,
  findOAuthClient,
  findOAuthCode,
  findOAuthUpstreamLogin,
  findOAuthTransaction,
  insertOAuthCode,
  insertOAuthUpstreamLogin,
  insertOAuthTransaction,
  markOAuthConsent,
} from "./repository";
import {
  getOAuthRuntimeConfig,
  signOAuthAccessToken,
  type OAuthAccessTokenClaims,
  type OAuthRuntimeConfig,
} from "./tokens";

const MAX_FORM_BYTES = 32_768;
const AUTHORIZATION_CODE_TTL_MS = 120_000;
const OAUTH_SCOPE = "communicator.read";

export type OAuthHumanSession = {
  issuer: string;
  subject: string;
  tenantId: string;
  membershipId: string;
  principalId: string;
};

export type OAuthUpstreamLoginInput = {
  request: Request;
  env: Cloudflare.Env;
  authorizationCode: string;
  verifier: string;
  nonce: string;
  clientId: string;
  redirectUri: string;
};

export type OAuthRouteServices = {
  resolveHumanSession: (
    request: Request,
    env: Cloudflare.Env,
  ) => Promise<OAuthHumanSession | null>;
  getConfig?: (env: Cloudflare.Env) => OAuthRuntimeConfig;
  clock?: () => Date;
  /** Completes the separate upstream OIDC-client exchange and verifies its ID token. */
  completeUpstreamLogin?: (
    input: OAuthUpstreamLoginInput,
  ) => Promise<OAuthHumanSession | null>;
  signAccessToken?: (
    env: Cloudflare.Env,
    config: OAuthRuntimeConfig,
    claims: OAuthAccessTokenClaims,
  ) => Promise<string>;
};

type OAuthContext = Context<{ Bindings: Cloudflare.Env; Variables: any }>;

const runtimeConfig = (services: OAuthRouteServices, env: Cloudflare.Env) =>
  (services.getConfig ?? getOAuthRuntimeConfig)(env);

const now = (services: OAuthRouteServices): Date =>
  services.clock?.() ?? new Date();

const json = (
  context: OAuthContext,
  body: Record<string, unknown>,
  status: 200 | 302 | 400 | 401 | 404 | 405 | 500 | 503,
  headers: Record<string, string> = {},
): Response =>
  context.json(body, status as never, {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    ...headers,
  });

const oauthError = (
  context: OAuthContext,
  error: string,
  description: string,
  status: 400 | 401 | 404 | 503 = 400,
): Response => json(context, { error, error_description: description }, status);

const stringParam = (params: URLSearchParams, key: string): string | null => {
  const value = params.get(key);
  return value && value.length <= 2048 ? value : null;
};

const validPkceValue = (value: string): boolean =>
  /^[A-Za-z0-9._~-]{43,128}$/.test(value);

const validState = (value: string): boolean =>
  /^[A-Za-z0-9._~-]{8,512}$/.test(value);

const redirectWithCode = (
  context: OAuthContext,
  redirectUri: string,
  code: string,
  state: string,
): Response => {
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  return context.redirect(target.href, 302);
};

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_FORM_BYTES)
    return null;
  const text = await request.text();
  if (text.length > MAX_FORM_BYTES) return null;
  return new URLSearchParams(text);
}

async function createAuthorizationTransaction(
  db: D1DatabaseSession,
  input: {
    clientId: string;
    redirectUri: string;
    resource: string;
    scope: string;
    codeChallenge: string;
    human: OAuthHumanSession;
    clientState: string;
    current: Date;
  },
): Promise<{ transactionId: string; consentToken: string; expiresAt: string }> {
  const expiresAt = new Date(input.current.getTime() + AUTHORIZATION_CODE_TTL_MS);
  const transactionId = randomIdentifier("oauth_tx");
  const consentToken = randomBase64url(32);
  await insertOAuthTransaction(db, {
    id: transactionId,
    stateHash: await sha256Base64url(input.clientState),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource: input.resource,
    scope: input.scope,
    clientState: input.clientState,
    codeChallenge: input.codeChallenge,
    humanIssuer: input.human.issuer,
    humanSubject: input.human.subject,
    tenantId: input.human.tenantId,
    membershipId: input.human.membershipId,
    expiresAt: expiresAt.toISOString(),
    consentHash: await sha256Base64url(consentToken),
    createdAt: input.current.toISOString(),
  });
  return { transactionId, consentToken, expiresAt: expiresAt.toISOString() };
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character] ?? character,
  );

function consentPage(
  context: OAuthContext,
  input: {
    transactionId: string;
    consentToken: string;
    clientName: string;
    resource: string;
    scope: string;
    expiresAt: string;
  },
): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Authorize Communicator</title></head><body><main><h1>Authorize ${escapeHtml(input.clientName)}</h1><p>This client requests read access to Communicator at <code>${escapeHtml(input.resource)}</code>.</p><p>Requested scope: <code>${escapeHtml(input.scope)}</code>.</p><p>This approval creates a separate non-admin agent installation. Account access still requires an administrator grant.</p><form method="post" action="/oauth/consent"><input type="hidden" name="transaction_id" value="${escapeHtml(input.transactionId)}"><input type="hidden" name="consent_token" value="${escapeHtml(input.consentToken)}"><button type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="cancel">Cancel</button></form><p>Expires at ${escapeHtml(input.expiresAt)}</p></main></body></html>`;
  return context.html(html, 200, {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'",
  });
}

async function beginUpstreamLogin(
  context: OAuthContext,
  services: OAuthRouteServices,
  config: OAuthRuntimeConfig,
  input: {
    clientId: string;
    redirectUri: string;
    resource: string;
    scope: string;
    clientState: string;
    clientCodeChallenge: string;
  },
): Promise<Response> {
  if (
    !config.humanAuthorizeUrl ||
    !config.humanClientId ||
    !config.humanRedirectUri
  ) {
    return oauthError(
      context,
      "login_required",
      "Human sign-in is not configured",
      401,
    );
  }
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(config.humanAuthorizeUrl);
    new URL(config.humanRedirectUri);
  } catch {
    return oauthError(
      context,
      "temporarily_unavailable",
      "Human sign-in configuration is invalid",
      503,
    );
  }
  const database = context.env.CONTROL_DB;
  if (!database || typeof database.withSession !== "function") {
    return oauthError(context, "temporarily_unavailable", "OAuth directory unavailable", 503);
  }
  const current = now(services);
  const expiresAt = new Date(current.getTime() + AUTHORIZATION_CODE_TTL_MS);
  const upstreamState = randomBase64url(32);
  const upstreamNonce = randomBase64url(24);
  const upstreamVerifier = randomBase64url(48);
  const encrypted = await encryptVerifier(upstreamVerifier, config.signingSecret);
  await insertOAuthUpstreamLogin(database.withSession("first-primary"), {
    id: randomIdentifier("oauth_upstream"),
    stateHash: await sha256Base64url(upstreamState),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource: input.resource,
    scope: input.scope,
    clientState: input.clientState,
    clientCodeChallenge: input.clientCodeChallenge,
    upstreamNonce,
    verifierCiphertext: encrypted.ciphertext,
    verifierIv: encrypted.iv,
    tenantHint: new URL(context.req.url).searchParams.get("tenant_id"),
    expiresAt: expiresAt.toISOString(),
    createdAt: current.toISOString(),
  });
  upstreamUrl.searchParams.set("client_id", config.humanClientId);
  upstreamUrl.searchParams.set("redirect_uri", config.humanRedirectUri);
  upstreamUrl.searchParams.set("response_type", "code");
  upstreamUrl.searchParams.set("scope", config.humanScope ?? "openid profile");
  upstreamUrl.searchParams.set("state", upstreamState);
  upstreamUrl.searchParams.set("nonce", upstreamNonce);
  upstreamUrl.searchParams.set("code_challenge", await sha256Base64url(upstreamVerifier));
  upstreamUrl.searchParams.set("code_challenge_method", "S256");
  return context.redirect(upstreamUrl.href, 302);
}

async function authorize(
  context: OAuthContext,
  services: OAuthRouteServices,
): Promise<Response> {
  const params = new URL(context.req.url).searchParams;
  const clientId = stringParam(params, "client_id");
  const redirectUri = stringParam(params, "redirect_uri");
  const responseType = stringParam(params, "response_type");
  const state = stringParam(params, "state");
  const codeChallenge = stringParam(params, "code_challenge");
  const method = stringParam(params, "code_challenge_method");
  const resource = stringParam(params, "resource");
  const scope = stringParam(params, "scope") ?? OAUTH_SCOPE;
  if (
    !clientId ||
    !redirectUri ||
    responseType !== "code" ||
    !state ||
    !validState(state) ||
    !codeChallenge ||
    !validPkceValue(codeChallenge) ||
    method !== "S256" ||
    !resource ||
    scope !== OAUTH_SCOPE
  ) {
    return oauthError(
      context,
      "invalid_request",
      "Authorization requires code, state, S256 PKCE, resource, and communicator.read",
    );
  }

  let config: OAuthRuntimeConfig;
  try {
    config = runtimeConfig(services, context.env);
  } catch {
    return oauthError(
      context,
      "temporarily_unavailable",
      "OAuth service is not configured",
      503,
    );
  }
  if (resource !== config.resource) {
    return oauthError(context, "invalid_target", "Unknown resource");
  }

  const database = context.env.CONTROL_DB;
  if (!database || typeof database.withSession !== "function") {
    return oauthError(
      context,
      "temporarily_unavailable",
      "OAuth directory unavailable",
      503,
    );
  }
  const db = database.withSession("first-primary");
  const client = await findOAuthClient(db, clientId, redirectUri);
  if (!client) return oauthError(context, "invalid_client", "Unknown client");
  const human = await services.resolveHumanSession(context.req.raw, context.env);
  if (!human)
    return beginUpstreamLogin(context, services, config, {
      clientId,
      redirectUri,
      resource,
      scope,
      clientState: state,
      clientCodeChallenge: codeChallenge,
    });

  const current = now(services);
  const transaction = await createAuthorizationTransaction(db, {
    clientId,
    redirectUri,
    resource,
    scope,
    codeChallenge,
    human,
    clientState: state,
    current,
  });
  return consentPage(context, {
    transactionId: transaction.transactionId,
    consentToken: transaction.consentToken,
    clientName: client.client_name,
    resource,
    scope,
    expiresAt: transaction.expiresAt,
  });
}

async function upstreamCallback(
  context: OAuthContext,
  services: OAuthRouteServices,
): Promise<Response> {
  const params = new URL(context.req.url).searchParams;
  const state = stringParam(params, "state");
  const authorizationCode = stringParam(params, "code");
  if (!state || !validState(state) || !authorizationCode) {
    return oauthError(context, "invalid_request", "Upstream callback is incomplete");
  }
  let config: OAuthRuntimeConfig;
  try {
    config = runtimeConfig(services, context.env);
  } catch {
    return oauthError(context, "temporarily_unavailable", "OAuth service is not configured", 503);
  }
  const database = context.env.CONTROL_DB;
  if (!database || typeof database.withSession !== "function") {
    return oauthError(context, "temporarily_unavailable", "OAuth directory unavailable", 503);
  }
  const db = database.withSession("first-primary");
  const row = await findOAuthUpstreamLogin(db, await sha256Base64url(state));
  const current = now(services);
  if (!row || row.completed_at !== null || Date.parse(row.expires_at) <= current.getTime()) {
    return oauthError(context, "invalid_request", "Upstream login state is invalid");
  }
  let verifier: string;
  try {
    verifier = await decryptVerifier(
      row.verifier_ciphertext,
      row.verifier_iv,
      config.signingSecret,
    );
  } catch {
    return oauthError(context, "invalid_request", "Upstream login transaction is invalid");
  }
  if (!services.completeUpstreamLogin) {
    return oauthError(context, "temporarily_unavailable", "Human sign-in exchange is not configured", 503);
  }
  const human = await services.completeUpstreamLogin({
    request: context.req.raw,
    env: context.env,
    authorizationCode,
    verifier,
    nonce: row.upstream_nonce,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
  });
  await completeOAuthUpstreamLogin(db, row.id, current.toISOString());
  if (!human) return oauthError(context, "access_denied", "Human sign-in was not accepted", 401);
  const transaction = await createAuthorizationTransaction(db, {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    scope: row.scope,
    codeChallenge: row.client_code_challenge,
    human,
    clientState: row.client_state,
    current,
  });
  const client = await findOAuthClient(db, row.client_id, row.redirect_uri);
  if (!client) return oauthError(context, "invalid_client", "Unknown client");
  return consentPage(context, {
    transactionId: transaction.transactionId,
    consentToken: transaction.consentToken,
    clientName: client.client_name,
    resource: row.resource,
    scope: row.scope,
    expiresAt: transaction.expiresAt,
  });
}

async function consent(
  context: OAuthContext,
  services: OAuthRouteServices,
): Promise<Response> {
  const form = await readForm(context.req.raw);
  if (!form) return oauthError(context, "invalid_request", "Invalid consent form");
  const transactionId = stringParam(form, "transaction_id");
  const consentToken = stringParam(form, "consent_token");
  const action = stringParam(form, "action");
  if (!transactionId || !consentToken || (action !== "approve" && action !== "cancel")) {
    return oauthError(context, "invalid_request", "Invalid consent action");
  }
  const config = (() => {
    try {
      return runtimeConfig(services, context.env);
    } catch {
      return null;
    }
  })();
  if (!config) return oauthError(context, "temporarily_unavailable", "OAuth service is not configured", 503);
  const database = context.env.CONTROL_DB;
  if (!database || typeof database.withSession !== "function") {
    return oauthError(context, "temporarily_unavailable", "OAuth directory unavailable", 503);
  }
  const db = database.withSession("first-primary");
  const transaction = await findOAuthTransaction(db, transactionId);
  const current = now(services);
  if (
    !transaction ||
    transaction.consented_at !== null ||
    transaction.completed_at !== null ||
    Date.parse(transaction.expires_at) <= current.getTime() ||
    !(await constantTimeEqual(
      await sha256Base64url(consentToken),
      transaction.consent_hash,
    ))
  ) {
    return oauthError(context, "invalid_request", "Consent transaction is invalid or expired");
  }
  const client = await findOAuthClient(
    db,
    transaction.client_id,
    transaction.redirect_uri,
  );
  if (!client) return oauthError(context, "invalid_client", "Unknown client");
  await markOAuthConsent(db, transaction.id, current.toISOString());
  if (action === "cancel") {
    await db
      .prepare(
        "UPDATE oauth_authorization_transactions SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
      )
      .bind(current.toISOString(), transaction.id)
      .run();
    const target = new URL(transaction.redirect_uri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("state", transaction.client_state);
    return context.redirect(target.href, 302);
  }
  const code = randomBase64url(32);
  await insertOAuthCode(db, {
    id: randomIdentifier("oauth_code"),
    transactionId: transaction.id,
    codeHash: await sha256Base64url(code),
    expiresAt: transaction.expires_at,
    createdAt: current.toISOString(),
  });
  return redirectWithCode(
    context,
    transaction.redirect_uri,
    code,
    transaction.client_state,
  );
}

async function token(
  context: OAuthContext,
  services: OAuthRouteServices,
): Promise<Response> {
  const form = await readForm(context.req.raw);
  if (!form) return oauthError(context, "invalid_request", "Invalid form body");
  const grantType = stringParam(form, "grant_type");
  const code = stringParam(form, "code");
  const clientId = stringParam(form, "client_id");
  const redirectUri = stringParam(form, "redirect_uri");
  const verifier = stringParam(form, "code_verifier");
  const resource = stringParam(form, "resource");
  if (
    grantType !== "authorization_code" ||
    !code ||
    !clientId ||
    !redirectUri ||
    !verifier ||
    !validPkceValue(verifier) ||
    !resource
  ) {
    return oauthError(context, "invalid_request", "Invalid authorization-code request");
  }
  let config: OAuthRuntimeConfig;
  try {
    config = runtimeConfig(services, context.env);
  } catch {
    return oauthError(
      context,
      "temporarily_unavailable",
      "OAuth service is not configured",
      503,
    );
  }
  if (resource !== config.resource) return oauthError(context, "invalid_target", "Unknown resource");
  const database = context.env.CONTROL_DB;
  if (!database || typeof database.withSession !== "function") {
    return oauthError(context, "temporarily_unavailable", "OAuth directory unavailable", 503);
  }
  const db = database.withSession("first-primary");
  const client = await findOAuthClient(db, clientId, redirectUri);
  if (!client) return oauthError(context, "invalid_client", "Unknown client");
  const row = await findOAuthCode(db, await sha256Base64url(code));
  const current = now(services);
  if (
    !row ||
    row.client_id !== clientId ||
    row.redirect_uri !== redirectUri ||
    row.resource !== resource ||
    row.consumed_at !== null ||
    Date.parse(row.code_expires_at) <= current.getTime() ||
    Date.parse(row.transaction_expires_at) <= current.getTime()
  ) {
    return oauthError(context, "invalid_grant", "Authorization code is invalid or expired");
  }
  const challenge = await sha256Base64url(verifier);
  if (!(await constantTimeEqual(challenge, row.code_challenge))) {
    return oauthError(context, "invalid_grant", "PKCE verifier is invalid");
  }

  const installationId = randomIdentifier("oauth_installation");
  const principalId = randomIdentifier("principal");
  const membershipId = randomIdentifier("membership");
  const identityId = randomIdentifier("identity");
  const installation = await createOAuthInstallation(db, {
    installationId,
    clientId,
    redirectUri,
    resource,
    humanIssuer: row.human_issuer,
    humanSubject: row.human_subject,
    tenantId: row.tenant_id,
    membershipId,
    principalId,
    identityId,
    createdAt: current.toISOString(),
    asIssuer: config.issuer,
  });
  await db
    .prepare(
      "UPDATE oauth_authorization_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
    )
    .bind(current.toISOString(), row.code_id)
    .run();
  await db
    .prepare(
      "UPDATE oauth_authorization_transactions SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
    )
    .bind(current.toISOString(), row.transaction_id)
    .run();

  const issuedAt = current;
  const expiresAt = new Date(
    current.getTime() + config.accessTokenTtlSeconds * 1000,
  );
  const tokenId = randomIdentifier("oauth_token");
  const claims: OAuthAccessTokenClaims = {
    installationId: installation.id,
    clientId,
    subject: installation.principal_id,
    scope: row.scope,
    issuer: config.issuer,
    resource,
    tokenId,
    issuedAt,
    expiresAt,
  };
  const accessToken = services.signAccessToken
    ? await services.signAccessToken(context.env, config, claims)
    : await signOAuthAccessToken(config, claims);
  return json(context, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSeconds,
    scope: row.scope,
  }, 200);
}

export function registerOAuthRoutes(
  app: Hono<any>,
  services: OAuthRouteServices,
): void {
  app.get("/.well-known/oauth-authorization-server", (context) => {
    try {
      const config = runtimeConfig(services, context.env);
      const origin = new URL(context.req.url).origin;
      return json(context, {
        issuer: config.issuer,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [OAUTH_SCOPE],
      }, 200);
    } catch {
      return oauthError(context, "temporarily_unavailable", "OAuth service is not configured", 503);
    }
  });
  app.get("/.well-known/oauth-protected-resource", (context) => {
    try {
      const config = runtimeConfig(services, context.env);
      const origin = new URL(context.req.url).origin;
      return json(context, {
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: [OAUTH_SCOPE],
        resource_documentation: `${origin}/api/v1/openapi.json`,
      }, 200);
    } catch {
      return oauthError(context, "temporarily_unavailable", "OAuth service is not configured", 503);
    }
  });
  app.get("/oauth/authorize", (context) => authorize(context, services));
  app.get("/oauth/callback", (context) => upstreamCallback(context, services));
  app.post("/oauth/consent", (context) => consent(context, services));
  app.post("/oauth/token", (context) => token(context, services));
}

export function parseHumanBearer(request: Request): string {
  return parseBearerToken(request.headers.get("Authorization") ?? undefined);
}
