import { createAuth, PLATFORM_SESSION_FRESH_AGE_SECONDS } from "./auth";
import {
  createAgent,
  createOrNarrowAgentGrant,
  issueAgentCredential,
  listAgentCredentials,
  listAgentGrants,
  listOrganizationAgents,
  renameAgent,
  revokeAgentCredential,
  revokeAgentGrant,
  rotateAgentCredential,
  setAgentEnabled,
} from "./agent-state";
import {
  accountPage,
  accountScript,
  accountCss,
  assetResponse,
  htmlResponse,
  loginPage,
  organizationDetailsMarkup,
  safeAvatarUrl,
  type AccountInvitation,
  type AccountOrganization,
  type AccountCredential,
  type AccountCredentialService,
  type AccountAgent,
  type OrganizationDetails,
} from "./account-ui";
import {
  CredentialRotationConflict,
  ensureDefaultOrganization,
  hashOpaque,
  listActiveServices,
  listHumanCredentials,
  issueHumanCredential,
  isSafeCredentialExpiry,
  opaqueSecret,
  parseStringArray,
  resolveCredentialExpiry,
  revokeHumanCredential,
  rotateHumanCredential,
  parseConfiguredCredentialLifetimeDays,
  validCapabilities,
  validServiceAudience,
  validServiceId,
  type ServiceRegistration,
} from "./platform-state";
import {
  acceptOrganizationInvitation,
  cancelOrganizationInvitation,
  changeOrganizationLifecycle,
  changeUserLifecycle,
  createOrganizationInvitation,
  createOwnedOrganization,
  getCurrentOrganizationAuthority,
  getOrganizationMembershipForDisplay,
  listCurrentOrganizations,
  listOperatorOrganizations,
  listOperatorUsers,
  listOrganizationInvitations,
  listOrganizationMembers,
  listRecipientInvitations,
  removeOrganizationMember,
  renameOrganization,
  updateOrganizationMemberRole,
  leaveOrganization,
  isOrganizationRole,
  type OrganizationRole,
} from "./organization-state";
import {
  beginOAuthFlow,
  completeInitialOAuthAccess,
  completeOAuthConsent,
  findOAuthClient,
  findOAuthFlowForQuery,
  hasPlatformOAuthClient,
  loadOAuthFlow,
  oauthIntrospectionResponse,
  oauthMetadata,
  oauthPostLoginHooks,
  ownedOAuthFlow,
  parseOAuthQuery,
  selectOAuthFlow,
  type OAuthFlow,
} from "./oauth-installation";
import {
  oauthConsentPage,
  oauthErrorPage,
  oauthSelectionPage,
} from "./oauth-ui";
import {
  createGuestIdentity,
  issueGuestGrant,
  parseGuestAssertion,
  renewGuestGrant,
  resolveGuestControl,
  revokeGuestGrant,
  GuestAuthorityUnavailable,
  GuestGrantConflict,
  type GuestIssuer,
} from "./guest-state";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function hasTrustedOrigin(request: Request, env: Cloudflare.Env): boolean {
  try {
    return (
      request.headers.get("origin") === new URL(env.PLATFORM_BASE_URL).origin
    );
  } catch {
    return false;
  }
}

function normalizedPathname(pathname: string): string {
  let decoded = pathname;
  for (let pass = 0; pass < 5; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      // Keep malformed paths unmatched by the Worker route table.
      break;
    }
  }
  decoded = decoded.replace(/\/{2,}/g, "/");
  return decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded;
}

function isDisabledBetterAuthPath(pathname: string): boolean {
  return (
    pathname === "/api/auth/organization" ||
    pathname.startsWith("/api/auth/organization/") ||
    pathname === "/api/auth/delete-user" ||
    pathname.startsWith("/api/auth/delete-user/") ||
    pathname === "/api/auth/oauth2/revoke" ||
    pathname === "/api/auth/oauth2/register" ||
    pathname === "/api/auth/oauth2/delete-client" ||
    pathname === "/api/auth/oauth2/update-client" ||
    pathname === "/api/auth/oauth2/client/rotate-secret" ||
    pathname === "/api/auth/oauth2/public-client" ||
    pathname === "/api/auth/oauth2/public-client-prelogin" ||
    pathname === "/api/auth/oauth2/userinfo"
  );
}

async function getRawSession(request: Request, env: Cloudflare.Env) {
  return createAuth(env).api.getSession({ headers: request.headers });
}

async function isActiveUser(
  env: Cloudflare.Env,
  userId: string,
): Promise<boolean> {
  const activeUser = await env.IDENTITY_DB.withSession("first-primary")
    .prepare('SELECT id FROM "user" WHERE id = ? AND disabledAt IS NULL')
    .bind(userId)
    .first<{ id: string }>();
  return activeUser !== null;
}

async function getSession(request: Request, env: Cloudflare.Env) {
  const current = await getRawSession(request, env);
  if (!current || !(await isActiveUser(env, current.user.id))) return null;
  return current;
}

function isAllowedAccountCallback(
  value: unknown,
  env: Cloudflare.Env,
): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const base = new URL(env.PLATFORM_BASE_URL);
    const callback = new URL(value, base);
    if (callback.origin !== base.origin || callback.hash) return false;
    if (
      (callback.pathname === "/account" || callback.pathname === "/login") &&
      !callback.search
    ) {
      return true;
    }
    return (
      callback.pathname === "/oauth2/selection" &&
      parseOAuthQuery(callback.search.slice(1)) !== null
    );
  } catch {
    return false;
  }
}

function authPathNeedsBrowserOrigin(pathname: string): boolean {
  if (
    pathname === "/api/auth/oauth2/token" ||
    pathname === "/api/auth/oauth2/introspect" ||
    pathname === "/api/auth/oauth2/revoke" ||
    pathname === "/api/auth/oauth2/register" ||
    pathname.startsWith("/api/auth/callback/")
  ) {
    return false;
  }
  return pathname.startsWith("/api/auth/");
}

const OAUTH_CANONICAL_PATHS = new Set([
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/continue",
  "/api/auth/oauth2/consent",
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/introspect",
  "/api/auth/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server",
]);

function isExactOAuthPath(rawPathname: string, pathname: string): boolean {
  return !OAUTH_CANONICAL_PATHS.has(pathname) || rawPathname === pathname;
}

async function oauthConfiguredScopes(env: Cloudflare.Env): Promise<string[]> {
  const rows = await env.IDENTITY_DB.withSession("first-primary")
    .prepare(
      "SELECT allowed_capabilities FROM platform_service WHERE disabled = 0 ORDER BY service_id",
    )
    .all<{ allowed_capabilities: string }>();
  const scopes = new Set<string>();
  for (const row of rows.results) {
    const capabilities = parseStringArray(row.allowed_capabilities) ?? [];
    for (const capability of capabilities) {
      if (capability !== "offline_access") scopes.add(capability);
    }
  }
  return scopes.size > 0 ? [...scopes] : ["resource:read"];
}

async function oauthRequestState(
  request: Request,
  env: Cloudflare.Env,
  pathname: string,
): Promise<{
  platform: boolean;
  flowId: string | null;
  rawQuery: string | null;
}> {
  const database = env.IDENTITY_DB.withSession("first-primary");
  if (pathname === "/api/auth/oauth2/authorize" && request.method === "GET") {
    const clientId = new URL(request.url).searchParams.get("client_id");
    const platform = clientId
      ? await hasPlatformOAuthClient(database, clientId)
      : false;
    return { platform, flowId: null, rawQuery: null };
  }
  if (
    (pathname === "/api/auth/oauth2/continue" ||
      pathname === "/api/auth/oauth2/consent") &&
    request.method === "POST"
  ) {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await request.clone().json();
      body = isObject(parsed) ? parsed : null;
    } catch {
      try {
        const form = await request.clone().formData();
        body = {};
        for (const [key, value] of form.entries()) {
          if (typeof value === "string") body[key] = value;
        }
      } catch {
        body = null;
      }
    }
    const rawQuery =
      body && typeof body.oauth_query === "string" ? body.oauth_query : null;
    const current = await getSession(request, env);
    const flow =
      rawQuery && current
        ? await findOAuthFlowForQuery(
            database,
            rawQuery,
            current.user.id,
            current.session.id,
          )
        : null;
    const binding = rawQuery ? parseOAuthQuery(rawQuery) : null;
    const platform = binding
      ? await hasPlatformOAuthClient(database, binding.clientId)
      : false;
    return {
      platform,
      flowId: flow?.id ?? null,
      rawQuery,
    };
  }
  if (pathname === "/api/auth/oauth2/token" && request.method === "POST") {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await request.clone().json();
      body = isObject(parsed) ? parsed : null;
    } catch {
      try {
        const form = await request.clone().formData();
        body = {};
        for (const [key, value] of form.entries()) {
          if (typeof value === "string") body[key] = value;
        }
      } catch {
        body = null;
      }
    }
    const clientId =
      body && typeof body.client_id === "string" ? body.client_id : null;
    const platform = clientId
      ? await hasPlatformOAuthClient(database, clientId)
      : false;
    return { platform, flowId: null, rawQuery: null };
  }
  if (pathname === "/api/auth/oauth2/introspect" && request.method === "POST") {
    let body: Record<string, unknown> | null = null;
    try {
      const form = await request.clone().formData();
      body = {};
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") body[key] = value;
      }
    } catch {
      body = null;
    }
    const clientId =
      body && typeof body.client_id === "string" ? body.client_id : null;
    const platform = clientId
      ? await hasPlatformOAuthClient(database, clientId)
      : false;
    return { platform, flowId: null, rawQuery: null };
  }
  // Better Auth keeps the signed provider query in its OAuth state while the
  // social callback is running. Passing the request-local production config to
  // callback routes is safe: the post-login hook only participates in an OAuth
  // provider continuation and does not change an ordinary social sign-in.
  if (pathname.startsWith("/api/auth/callback/")) {
    return { platform: true, flowId: null, rawQuery: null };
  }
  return { platform: false, flowId: null, rawQuery: null };
}

async function oauthPlatformRoute(
  request: Request,
  env: Cloudflare.Env,
  pathname: string,
): Promise<Response | null> {
  const database = env.IDENTITY_DB.withSession("first-primary");
  if (
    (pathname === "/.well-known/oauth-authorization-server" ||
      pathname === "/api/auth/.well-known/oauth-authorization-server") &&
    request.method === "GET"
  ) {
    return Response.json(await oauthMetadata(database, env.PLATFORM_BASE_URL), {
      headers: { "cache-control": "no-store" },
    });
  }
  if (pathname === "/oauth2/selection") {
    const current = await getSession(request, env);
    if (!current) {
      const login = new URL("/login", env.PLATFORM_BASE_URL);
      login.search = new URL(request.url).search;
      return Response.redirect(login, 302);
    }
    if (request.method === "GET") {
      const rawQuery = new URL(request.url).search.slice(1);
      const begun = await beginOAuthFlow(database, rawQuery, {
        userId: current.user.id,
        sessionId: current.session.id,
      });
      if (!begun.flow)
        return oauthErrorPage(
          begun.error ?? "OAuth request unavailable",
          begun.status,
        );
      const binding = parseOAuthQuery(begun.flow.oauth_query);
      const client = binding
        ? await findOAuthClient(database, binding.clientId)
        : null;
      if (!binding || !client)
        return oauthErrorPage("OAuth request unavailable", 400);
      const organizations = await database
        .prepare(
          `SELECT organization.id AS organizationId, organization.name AS organizationName,
                  member.role AS role, organization.suspendedAt AS suspendedAt
           FROM member JOIN organization ON organization.id = member.organizationId
           WHERE member.userId = ? ORDER BY lower(organization.name), organization.id`,
        )
        .bind(current.user.id)
        .all<{
          organizationId: string;
          organizationName: string;
          role: string;
          suspendedAt: number | null;
        }>();
      return oauthSelectionPage(begun.flow, client, organizations.results);
    }
    if (request.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    if (!hasTrustedOrigin(request, env))
      return json(403, { error: "untrusted_origin" });
    const body = await requestBody(request);
    const flowId = typeof body?.flowId === "string" ? body.flowId : null;
    const organizationId =
      typeof body?.organizationId === "string" ? body.organizationId : null;
    if (!flowId || !organizationId)
      return json(400, { error: "invalid_request" });
    const selected = await selectOAuthFlow(database, {
      flowId,
      organizationId,
      userId: current.user.id,
      sessionId: current.session.id,
    });
    if (!selected.flow || selected.status !== 200) {
      return json(selected.status, {
        error: selected.error ?? "oauth_flow_unavailable",
      });
    }
    return Response.redirect(
      new URL(
        `/oauth2/continue?flow_id=${encodeURIComponent(flowId)}`,
        env.PLATFORM_BASE_URL,
      ),
      303,
    );
  }
  if (pathname === "/oauth2/continue" && request.method === "GET") {
    const current = await getSession(request, env);
    const flowId = new URL(request.url).searchParams.get("flow_id");
    const flow = await ownedOAuthFlow(
      database,
      flowId,
      current
        ? { userId: current.user.id, sessionId: current.session.id }
        : null,
      "selected",
    );
    if (!flow) return oauthErrorPage("OAuth flow is no longer available", 403);
    const binding = parseOAuthQuery(flow.oauth_query);
    if (!binding) return oauthErrorPage("OAuth request is malformed", 400);
    const scopes = await oauthConfiguredScopes(env);
    const internal = new Request(
      `${env.PLATFORM_BASE_URL}/api/auth/oauth2/continue`,
      {
        method: "POST",
        headers: {
          cookie: request.headers.get("cookie") ?? "",
          origin: new URL(env.PLATFORM_BASE_URL).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          postLogin: true,
          oauth_query: flow.oauth_query,
        }),
      },
    );
    const response = await createAuth(env, {
      oauthPlatform: true,
      oauthGrantTypes: ["authorization_code"],
      oauthScopes: scopes,
      oauthPostLogin: oauthPostLoginHooks(database, flow.id),
    }).handler(internal);
    if (response.status !== 200) return response;
    try {
      const result: unknown = await response.clone().json();
      if (isObject(result) && typeof result.url === "string") {
        return Response.redirect(
          new URL(result.url, env.PLATFORM_BASE_URL),
          302,
        );
      }
    } catch {
      // Return the provider response below when it is not a continuation URL.
    }
    return response;
  }
  if (pathname === "/consent" && request.method === "GET") {
    const current = await getSession(request, env);
    if (!current)
      return Response.redirect(new URL("/login", env.PLATFORM_BASE_URL), 302);
    const rawQuery = new URL(request.url).search.slice(1);
    const binding = parseOAuthQuery(rawQuery);
    const client = binding
      ? await findOAuthClient(database, binding.clientId)
      : null;
    const flow =
      binding && current
        ? await findOAuthFlowForQuery(
            database,
            rawQuery,
            current.user.id,
            current.session.id,
          )
        : null;
    const owned = flow
      ? await ownedOAuthFlow(
          database,
          flow.id,
          { userId: current.user.id, sessionId: current.session.id },
          "selected",
        )
      : null;
    if (!binding || !client || !owned)
      return oauthErrorPage("OAuth flow is no longer available", 403);
    return oauthConsentPage(rawQuery, client, owned);
  }
  return null;
}

async function validateAuthRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = normalizedPathname(url.pathname);
  if (
    request.method === "POST" &&
    authPathNeedsBrowserOrigin(pathname) &&
    !hasTrustedOrigin(request, env)
  ) {
    return json(403, { error: "untrusted_origin" });
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/auth/sign-in/social" ||
      pathname === "/api/auth/link-social")
  ) {
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return null;
    }
    if (
      body &&
      typeof body === "object" &&
      ("callbackURL" in body ||
        "errorCallbackURL" in body ||
        "newUserCallbackURL" in body)
    ) {
      const callbackBody = body as Record<string, unknown>;
      for (const field of [
        "callbackURL",
        "errorCallbackURL",
        "newUserCallbackURL",
      ] as const) {
        if (
          field in callbackBody &&
          !isAllowedAccountCallback(callbackBody[field], env)
        ) {
          return json(400, { error: "invalid_callback_destination" });
        }
      }
    }
  }

  if (pathname !== "/api/auth/sign-out") {
    const current = await getRawSession(request, env);
    if (current && !(await isActiveUser(env, current.user.id))) {
      return json(401, { error: "disabled_user" });
    }
  }
  return null;
}

function loginErrorMessage(code: string | null): string {
  switch (code) {
    case "signup_invitation_required":
      return "Sign-up is invitation-only. A current invitation for your verified email is required.";
    case "email_not_verified":
      return "Verify your provider email before signing in to Platform.";
    case "account_not_linked":
      return "This provider is not linked yet. Sign in with an existing provider, then link it from your account settings.";
    case "link_session_required":
      return "Sign in again before linking a provider account.";
    case "unable_to_create_user":
    case "signup_disabled":
      return "Platform could not create an account. If you are using a self-hosted service, ask the operator about signup access.";
    default:
      return code
        ? "Sign-in could not be completed. Try again or choose another provider."
        : "";
  }
}

async function unlinkSocialAccount(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (!hasTrustedOrigin(request, env))
    return json(403, { error: "untrusted_origin" });
  const current = await createAuth(env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!current || !(await isActiveUser(env, current.user.id)))
    return json(401, { error: "unauthenticated" });
  const createdAt = new Date(current.session.createdAt).getTime();
  if (
    !Number.isFinite(createdAt) ||
    Date.now() - createdAt >= PLATFORM_SESSION_FRESH_AGE_SECONDS * 1000
  ) {
    return json(403, { error: "session_not_fresh" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_request" });
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("accountId" in body) ||
    typeof body.accountId !== "string" ||
    !body.accountId ||
    body.accountId.length > 256
  ) {
    return json(400, { error: "invalid_request" });
  }

  const database = env.IDENTITY_DB.withSession("first-primary");
  const unlinked = await database
    .prepare(
      `DELETE FROM account
       WHERE id = ? AND userId = ?
         AND EXISTS (
           SELECT 1 FROM account AS another
           WHERE another.userId = ? AND another.id <> ?
         )`,
    )
    .bind(body.accountId, current.user.id, current.user.id, body.accountId)
    .run();
  if (unlinked.meta.changes === 1) return json(200, { status: true });

  const ownedAccount = await database
    .prepare("SELECT id FROM account WHERE id = ? AND userId = ?")
    .bind(body.accountId, current.user.id)
    .first<{ id: string }>();
  return ownedAccount
    ? json(400, { error: "failed_to_unlink_last_account" })
    : json(400, { error: "account_not_found" });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonStringArray(value: unknown): string[] | null {
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return value;
  }
  if (typeof value !== "string") return null;
  try {
    let parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function requestBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.clone().json();
    if (isObject(body)) return body;
  } catch {
    // HTML forms are used by the small OAuth consent pages as well as by
    // JSON callers. Parse a form only after JSON has failed.
  }
  try {
    const form = await request.clone().formData();
    const body: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") body[key] = value;
    }
    return body;
  } catch {
    return null;
  }
}

async function normalizeOAuthConsentRequest(
  request: Request,
): Promise<{ request: Request; browserForm: boolean }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
  ) {
    return { request, browserForm: false };
  }
  const body = await requestBody(request);
  if (!body) return { request, browserForm: true };
  const payload: Record<string, unknown> = {
    accept: body.accept === true || body.accept === "true",
  };
  if (typeof body.oauth_query === "string") {
    payload.oauth_query = body.oauth_query;
  }
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return {
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(payload),
    }),
    browserForm: true,
  };
}

function validOrganizationName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validOrganizationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validCredentialName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validCredentialId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validAgentName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validAgentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validAgentGrantId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isOperator(env: Cloudflare.Env, userId: string): boolean {
  const configuredId = env.PLATFORM_OPERATOR_USER_ID;
  return (
    typeof configuredId === "string" &&
    configuredId.length > 0 &&
    configuredId === userId
  );
}

async function authorizeOrganizationRequest(
  request: Request,
  env: Cloudflare.Env,
  organizationId: string,
): Promise<
  | {
      current: NonNullable<Awaited<ReturnType<typeof getSession>>>;
      authority: NonNullable<
        Awaited<ReturnType<typeof getCurrentOrganizationAuthority>>
      >;
    }
  | Response
> {
  const current = await getSession(request, env);
  if (!current)
    return json(401, {
      error: "unauthenticated",
      message: "Sign in to manage this organization.",
    });
  const database = env.IDENTITY_DB.withSession("first-primary");
  const authority = await getCurrentOrganizationAuthority(
    database,
    current.user.id,
    organizationId,
  );
  if (authority) return { current, authority };
  const membership = await getOrganizationMembershipForDisplay(
    database,
    current.user.id,
    organizationId,
  );
  return membership?.suspendedAt !== null && membership
    ? json(403, {
        error: "organization_suspended",
        message:
          "An operator must restore this organization before tenant administration can continue.",
      })
    : json(404, {
        error: "organization_not_found",
        message: "You do not have current membership in this organization.",
      });
}

async function loadAgentManagement(
  database: D1DatabaseSession,
  organizationId: string,
): Promise<{
  agents: Array<{
    id: string;
    organizationId: string;
    name: string;
    enabled: boolean;
    createdByUserId: string;
    createdAt: number;
    updatedAt: number;
    grants: Awaited<ReturnType<typeof listAgentGrants>>;
    credentials: Awaited<ReturnType<typeof listAgentCredentials>>;
  }>;
  services: AccountCredentialService[];
}> {
  const [agents, services] = await Promise.all([
    listOrganizationAgents(database, organizationId),
    listActiveServices(database),
  ]);
  const managedAgents = await Promise.all(
    agents.map(async (agent) => {
      const [grants, credentials] = await Promise.all([
        listAgentGrants(database, {
          organizationId,
          agentId: agent.id,
        }),
        listAgentCredentials(database, {
          organizationId,
          agentId: agent.id,
        }),
      ]);
      return { ...agent, grants, credentials };
    }),
  );
  return {
    agents: managedAgents,
    services: services.map((service) => ({
      id: service.serviceId,
      name: service.displayName || service.serviceId,
      audience: service.audience,
      capabilities: service.allowedCapabilities,
    })),
  };
}

async function accountManagementRoute(
  request: Request,
  env: Cloudflare.Env,
  pathname: string,
): Promise<Response | null> {
  if (!pathname.startsWith("/api/account/")) return null;
  if (request.method !== "GET" && !hasTrustedOrigin(request, env)) {
    return json(403, {
      error: "untrusted_origin",
      message: "Use the Platform account page to make this change.",
    });
  }

  if (
    pathname === "/api/account/organizations/detail" &&
    request.method === "GET"
  ) {
    const current = await getSession(request, env);
    if (!current)
      return json(401, {
        error: "unauthenticated",
        message: "Sign in to view this organization.",
      });
    const organizationId = new URL(request.url).searchParams.get(
      "organizationId",
    );
    if (!validOrganizationId(organizationId)) {
      return json(400, {
        error: "invalid_request",
        message: "Choose an organization first.",
      });
    }
    const database = env.IDENTITY_DB.withSession("first-primary");
    const authority = await getOrganizationMembershipForDisplay(
      database,
      current.user.id,
      organizationId,
    );
    if (!authority) {
      return json(404, {
        error: "organization_not_found",
        message:
          "You no longer have current membership in this organization. Refresh the page to update your access.",
      });
    }
    const [members, invitations] = await Promise.all([
      listOrganizationMembers(database, authority),
      listOrganizationInvitations(database, authority),
    ]);
    const details: OrganizationDetails = {
      id: authority.organizationId,
      name: authority.organizationName,
      role: authority.role,
      suspended: authority.suspendedAt !== null,
      viewerUserId: current.user.id,
      members,
      invitations,
    };
    return htmlResponse(organizationDetailsMarkup(details));
  }

  if (pathname === "/api/account/agents" && request.method === "GET") {
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    const organizationId = new URL(request.url).searchParams.get(
      "organizationId",
    );
    if (!validOrganizationId(organizationId)) {
      return json(400, { error: "invalid_request" });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can manage agents.",
      });
    }
    const management = await loadAgentManagement(
      env.IDENTITY_DB.withSession("first-primary"),
      organizationId,
    );
    return json(200, { organizationId, ...management });
  }

  if (pathname === "/api/account/agents" && request.method === "POST") {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validAgentName(body.name)
    ) {
      return json(400, {
        error: "invalid_agent_name",
        message: "Enter an agent name of 1 to 100 characters.",
      });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can create agents.",
      });
    }
    const agent = await createAgent(env.IDENTITY_DB, {
      actorUserId: authorization.current.user.id,
      organizationId: body.organizationId,
      name: body.name.trim(),
    });
    return agent
      ? json(201, agent)
      : json(409, {
          error: "agent_changed",
          message: "Agent authority changed. Refresh and try again.",
        });
  }

  if (pathname === "/api/account/agents/update" && request.method === "POST") {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validAgentId(body.agentId) ||
      !validAgentName(body.name)
    ) {
      return json(400, { error: "invalid_request" });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can rename agents.",
      });
    }
    const updated = await renameAgent(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        agentId: body.agentId,
        name: body.name.trim(),
      },
    );
    return updated
      ? json(200, { updated: true, organizationId: body.organizationId })
      : json(404, { error: "agent_not_found" });
  }

  if (
    pathname === "/api/account/agents/lifecycle" &&
    request.method === "POST"
  ) {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validAgentId(body.agentId) ||
      (body.action !== "disable" && body.action !== "restore")
    ) {
      return json(400, { error: "invalid_request" });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can change agent state.",
      });
    }
    const changed = await setAgentEnabled(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        agentId: body.agentId,
        enabled: body.action === "restore",
      },
    );
    return changed
      ? json(200, {
          enabled: body.action === "restore",
          organizationId: body.organizationId,
        })
      : json(404, { error: "agent_not_found" });
  }

  if (pathname === "/api/account/agents/grants" && request.method === "GET") {
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId");
    const agentId = url.searchParams.get("agentId");
    if (!validOrganizationId(organizationId) || !validAgentId(agentId)) {
      return json(400, { error: "invalid_request" });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, { error: "organization_manager_required" });
    }
    const grants = await listAgentGrants(
      env.IDENTITY_DB.withSession("first-primary"),
      { organizationId, agentId },
    );
    const agent = await env.IDENTITY_DB.withSession("first-primary")
      .prepare(
        "SELECT id FROM platform_agent WHERE id = ? AND organization_id = ?",
      )
      .bind(agentId, organizationId)
      .first<{ id: string }>();
    return agent
      ? json(200, { organizationId, agentId, grants })
      : json(404, { error: "agent_not_found" });
  }

  if (pathname === "/api/account/agents/grants" && request.method === "POST") {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validAgentId(body.agentId) ||
      !validServiceId(body.serviceId) ||
      !validCapabilities(body.capabilities)
    ) {
      return json(400, {
        error: "invalid_grant",
        message: "Choose a service and one or more unique capabilities.",
      });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can manage agent grants.",
      });
    }
    const service = await findActiveServiceById(
      env.IDENTITY_DB.withSession("first-primary"),
      body.serviceId,
    );
    if (!service)
      return json(503, { error: "service_registration_unavailable" });
    const result = await createOrNarrowAgentGrant(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        agentId: body.agentId,
        service,
        capabilities: body.capabilities,
      },
    );
    if (result.status === "created" || result.status === "narrowed") {
      return json(result.status === "created" ? 201 : 200, {
        ...result.grant,
        status: result.status,
      });
    }
    if (result.status === "unchanged") {
      return json(200, { ...result.grant, status: result.status });
    }
    if (result.status === "widening") {
      return json(409, {
        error: "grant_widening_requires_reauthorization",
        message: "Revoke the current grant before requesting wider access.",
      });
    }
    if (result.status === "invalid") {
      return json(400, { error: "invalid_grant" });
    }
    return json(404, { error: "agent_not_found" });
  }

  if (
    pathname === "/api/account/agents/grants/revoke" &&
    request.method === "POST"
  ) {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validAgentId(body.agentId) ||
      !validAgentGrantId(body.grantId)
    ) {
      return json(400, { error: "invalid_request" });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can revoke agent grants.",
      });
    }
    const revoked = await revokeAgentGrant(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        agentId: body.agentId,
        grantId: body.grantId,
      },
    );
    return revoked
      ? json(200, { revoked: true, organizationId: body.organizationId })
      : json(404, { error: "grant_not_found" });
  }

  if (
    pathname === "/api/account/agents/credentials" &&
    request.method === "GET"
  ) {
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId");
    const agentId = url.searchParams.get("agentId");
    if (!validOrganizationId(organizationId) || !validAgentId(agentId)) {
      return json(400, { error: "invalid_request" });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, { error: "organization_manager_required" });
    }
    const database = env.IDENTITY_DB.withSession("first-primary");
    const agent = await database
      .prepare(
        "SELECT id FROM platform_agent WHERE id = ? AND organization_id = ?",
      )
      .bind(agentId, organizationId)
      .first<{ id: string }>();
    if (!agent) return json(404, { error: "agent_not_found" });
    const credentials = await listAgentCredentials(database, {
      organizationId,
      agentId,
    });
    return json(200, { organizationId, agentId, credentials });
  }

  if (
    pathname === "/api/account/agents/credentials" &&
    request.method === "POST"
  ) {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validAgentId(body.agentId) ||
      !validAgentGrantId(body.grantId) ||
      (body.serviceId !== undefined && !validServiceId(body.serviceId)) ||
      (body.capabilities !== undefined &&
        !validCapabilities(body.capabilities)) ||
      (body.name !== undefined && !validCredentialName(body.name))
    ) {
      return json(400, { error: "invalid_request" });
    }
    const maxLifetimeDays = parseConfiguredCredentialLifetimeDays(
      env.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS,
    );
    if (maxLifetimeDays === null) {
      return json(503, { error: "credential_configuration_unavailable" });
    }
    const hasRequestedLifetime = Object.hasOwn(body, "lifetimeDays");
    if (
      hasRequestedLifetime &&
      (typeof body.lifetimeDays !== "number" ||
        !Number.isFinite(body.lifetimeDays) ||
        body.lifetimeDays <= 0 ||
        body.lifetimeDays > maxLifetimeDays)
    ) {
      return json(400, { error: "invalid_lifetime" });
    }
    const expiresAt = resolveCredentialExpiry(
      maxLifetimeDays,
      body.lifetimeDays,
    );
    if (expiresAt === null) return json(503, { error: "invalid_lifetime" });
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can issue agent credentials.",
      });
    }
    const database = env.IDENTITY_DB.withSession("first-primary");
    const grants = await listAgentGrants(database, {
      organizationId: body.organizationId,
      agentId: body.agentId,
    });
    const grant = grants.find(
      (candidate) =>
        candidate.id === body.grantId && candidate.revokedAt === null,
    );
    if (!grant) return json(404, { error: "grant_not_found" });
    const serviceId =
      typeof body.serviceId === "string" ? body.serviceId : grant.serviceId;
    if (serviceId !== grant.serviceId) {
      return json(404, { error: "grant_not_found" });
    }
    const service = await findActiveServiceById(database, serviceId);
    if (!service)
      return json(503, { error: "service_registration_unavailable" });
    const capabilities =
      body.capabilities === undefined ? grant.capabilities : body.capabilities;
    try {
      const issued = await issueAgentCredential(env.IDENTITY_DB, {
        actorUserId: authorization.current.user.id,
        service,
        organizationId: body.organizationId,
        agentId: body.agentId,
        grantId: body.grantId,
        capabilities,
        name: body.name,
        expiresAt,
      });
      return json(201, {
        ...issued,
        audience: service.audience,
        organizationId: body.organizationId,
        agentId: body.agentId,
        grantId: body.grantId,
        capabilities,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        return json(403, { error: "grant_exceeds_agent_authority" });
      }
      throw error;
    }
  }

  if (
    pathname === "/api/account/agents/credentials/rotate" &&
    request.method === "POST"
  ) {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validAgentId(body.agentId) ||
      !validCredentialId(body.credentialId)
    ) {
      return json(400, { error: "invalid_request" });
    }
    const maxLifetimeDays = parseConfiguredCredentialLifetimeDays(
      env.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS,
    );
    if (maxLifetimeDays === null) {
      return json(503, { error: "credential_configuration_unavailable" });
    }
    const hasRequestedLifetime = Object.hasOwn(body, "lifetimeDays");
    if (
      hasRequestedLifetime &&
      (typeof body.lifetimeDays !== "number" ||
        !Number.isFinite(body.lifetimeDays) ||
        body.lifetimeDays <= 0 ||
        body.lifetimeDays > maxLifetimeDays)
    ) {
      return json(400, { error: "invalid_lifetime" });
    }
    const expiresAt = resolveCredentialExpiry(
      maxLifetimeDays,
      body.lifetimeDays,
    );
    if (expiresAt === null) return json(503, { error: "invalid_lifetime" });
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, { error: "organization_manager_required" });
    }
    const database = env.IDENTITY_DB.withSession("first-primary");
    const credentials = await listAgentCredentials(database, {
      organizationId: body.organizationId,
      agentId: body.agentId,
    });
    const old = credentials.find(
      (credential) => credential.id === body.credentialId,
    );
    if (!old) return json(404, { error: "credential_not_found" });
    const grants = await listAgentGrants(database, {
      organizationId: body.organizationId,
      agentId: body.agentId,
    });
    const grant = grants.find((candidate) => candidate.id === old.grantId);
    if (!grant || grant.revokedAt !== null) {
      return json(404, { error: "credential_not_found" });
    }
    const service = await findActiveServiceById(database, grant.serviceId);
    if (!service) return json(404, { error: "credential_not_found" });
    try {
      const rotated = await rotateAgentCredential(env.IDENTITY_DB, {
        actorUserId: authorization.current.user.id,
        service,
        organizationId: body.organizationId,
        agentId: body.agentId,
        grantId: grant.id,
        credentialId: body.credentialId,
        expiresAt,
      });
      return json(201, {
        ...rotated,
        audience: service.audience,
        organizationId: body.organizationId,
        agentId: body.agentId,
        grantId: grant.id,
      });
    } catch (error) {
      if (error instanceof CredentialRotationConflict) {
        return json(409, {
          error: "credential_changed",
          message:
            "This agent credential expired, was revoked, or was rotated already.",
        });
      }
      if (error instanceof RangeError)
        return json(400, { error: "invalid_lifetime" });
      throw error;
    }
  }

  if (
    pathname === "/api/account/agents/credentials/revoke" &&
    request.method === "POST"
  ) {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validAgentId(body.agentId) ||
      !validCredentialId(body.credentialId)
    ) {
      return json(400, { error: "invalid_request" });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, { error: "organization_manager_required" });
    }
    const revoked = await revokeAgentCredential(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        agentId: body.agentId,
        credentialId: body.credentialId,
      },
    );
    return revoked
      ? json(200, { revoked: true, organizationId: body.organizationId })
      : json(404, { error: "credential_not_found" });
  }

  if (
    pathname === "/api/account/organizations/create" &&
    request.method === "POST"
  ) {
    const current = await getSession(request, env);
    if (!current)
      return json(401, {
        error: "unauthenticated",
        message: "Sign in to create an organization.",
      });
    const body = await requestBody(request);
    if (!body || !validOrganizationName(body.name)) {
      return json(400, {
        error: "invalid_organization_name",
        message: "Enter an organization name of 1 to 100 characters.",
      });
    }
    const created = await createOwnedOrganization(
      env.IDENTITY_DB,
      { id: current.user.id, name: current.user.name },
      body.name.trim(),
    );
    return created
      ? json(201, created)
      : json(401, {
          error: "unauthenticated",
          message: "Your account is no longer active.",
        });
  }

  if (
    pathname === "/api/account/organizations/update" &&
    request.method === "POST"
  ) {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validOrganizationName(body.name)
    ) {
      return json(400, {
        error: "invalid_request",
        message: "Enter an organization name of 1 to 100 characters.",
      });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can change its name.",
      });
    }
    const updated = await renameOrganization(
      env.IDENTITY_DB.withSession("first-primary"),
      authorization.current.user.id,
      body.organizationId,
      body.name.trim(),
    );
    return updated
      ? json(200, { updated: true })
      : json(409, {
          error: "organization_changed",
          message: "Organization access changed. Refresh and try again.",
        });
  }

  if (
    pathname === "/api/account/invitations/create" &&
    request.method === "POST"
  ) {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      typeof body.email !== "string" ||
      body.email.trim().length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
      !isOrganizationRole(body.role)
    ) {
      return json(400, {
        error: "invalid_invitation",
        message: "Enter a valid email address and one organization role.",
      });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can invite people.",
      });
    }
    if (body.role === "owner" && authorization.authority.role !== "owner") {
      return json(403, {
        error: "owner_required",
        message: "Only an owner can invite another owner.",
      });
    }
    const invitation = await createOrganizationInvitation(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        email: body.email.trim().toLowerCase(),
        role: body.role,
      },
    );
    return invitation
      ? json(201, {
          ...invitation,
          organizationId: body.organizationId,
          link: new URL(
            `/account?invitation=${encodeURIComponent(invitation.id)}`,
            env.PLATFORM_BASE_URL,
          ).href,
        })
      : json(409, {
          error: "invitation_conflict",
          message:
            "This person is already a member or has a current invitation.",
        });
  }

  if (
    pathname === "/api/account/invitations/cancel" &&
    request.method === "POST"
  ) {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validOrganizationId(body.invitationId)
    ) {
      return json(400, {
        error: "invalid_request",
        message: "Choose an invitation to cancel.",
      });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can manage invitations.",
      });
    }
    const invitation = await env.IDENTITY_DB.prepare(
      "SELECT role, status FROM invitation WHERE id = ? AND organizationId = ?",
    )
      .bind(body.invitationId, body.organizationId)
      .first<{ role: string | null; status: string }>();
    if (!invitation) {
      return json(404, {
        error: "invitation_not_found",
        message: "This invitation could not be found.",
      });
    }
    if (invitation.status !== "pending") {
      return json(409, {
        error: "invitation_changed",
        message: "This invitation is no longer pending.",
      });
    }
    if (
      invitation.role === "owner" &&
      authorization.authority.role !== "owner"
    ) {
      return json(403, {
        error: "owner_required",
        message: "Only an owner can cancel an owner invitation.",
      });
    }
    const cancelled = await cancelOrganizationInvitation(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        invitationId: body.invitationId,
      },
    );
    return cancelled
      ? json(200, { cancelled: true })
      : json(409, {
          error: "invitation_changed",
          message: "This invitation changed. Refresh the page and try again.",
        });
  }

  if (
    pathname === "/api/account/invitations/accept" &&
    request.method === "POST"
  ) {
    const current = await getSession(request, env);
    if (!current)
      return json(401, {
        error: "unauthenticated",
        message: "Sign in to accept an invitation.",
      });
    const body = await requestBody(request);
    if (!body || !validOrganizationId(body.invitationId)) {
      return json(400, {
        error: "invalid_request",
        message: "Choose an invitation to accept.",
      });
    }
    const result = await acceptOrganizationInvitation(
      env.IDENTITY_DB,
      current.user.id,
      body.invitationId,
    );
    if (result.status === "accepted") return json(200, result);
    const errors = {
      not_found: [
        404,
        "invitation_not_found",
        "This invitation is unavailable.",
      ],
      email_unverified: [
        403,
        "email_unverified",
        "Verify this email with your sign-in provider before accepting the invitation.",
      ],
      wrong_email: [
        403,
        "wrong_email",
        "Sign in with the verified email address that received this invitation.",
      ],
      organization_suspended: [
        403,
        "organization_suspended",
        "An operator must restore this organization before the invitation can be accepted.",
      ],
      expired: [
        410,
        "invitation_expired",
        "This invitation has expired. Ask an organization owner for a new invitation.",
      ],
      cancelled: [
        410,
        "invitation_cancelled",
        "This invitation was cancelled.",
      ],
      membership_removed: [
        409,
        "membership_removed",
        "This invitation was already accepted, but your membership was later removed. Ask an owner for a new invitation.",
      ],
    } as const;
    const [status, error, message] = errors[result.status];
    return json(status, { error, message });
  }

  if (pathname === "/api/account/members/role" && request.method === "POST") {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validOrganizationId(body.membershipId) ||
      !isOrganizationRole(body.role)
    ) {
      return json(400, {
        error: "invalid_request",
        message: "Choose one of the supported organization roles.",
      });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can change member roles.",
      });
    }
    if (body.role === "owner" && authorization.authority.role !== "owner") {
      return json(403, {
        error: "owner_required",
        message: "Only an owner can assign the owner role.",
      });
    }
    const target = await env.IDENTITY_DB.prepare(
      "SELECT userId, role FROM member WHERE id = ? AND organizationId = ?",
    )
      .bind(body.membershipId, body.organizationId)
      .first<{ userId: string; role: string }>();
    if (!target)
      return json(404, {
        error: "member_not_found",
        message: "This membership is no longer current.",
      });
    if (
      target.userId === authorization.current.user.id &&
      body.role === "owner" &&
      authorization.authority.role !== "owner"
    ) {
      return json(403, {
        error: "owner_required",
        message: "An admin cannot promote themselves to owner.",
      });
    }
    const updated = await updateOrganizationMemberRole(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        membershipId: body.membershipId,
        role: body.role,
      },
    );
    if (updated) return json(200, { updated: true });
    const targetOwner = target.role === "owner";
    if (targetOwner) {
      const owners = await env.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM member WHERE organizationId = ? AND role = 'owner'",
      )
        .bind(body.organizationId)
        .first<{ count: number }>();
      if ((owners?.count ?? 0) <= 1 && body.role !== "owner") {
        return json(409, {
          error: "final_owner_required",
          message: "This organization must keep at least one owner.",
        });
      }
      if (authorization.authority.role !== "owner") {
        return json(403, {
          error: "owner_required",
          message: "Only an owner can change another owner's role.",
        });
      }
    }
    return json(409, {
      error: "membership_changed",
      message: "This membership changed. Refresh the page and try again.",
    });
  }

  if (pathname === "/api/account/members/remove" && request.method === "POST") {
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validOrganizationId(body.membershipId)
    ) {
      return json(400, {
        error: "invalid_request",
        message: "Choose a current membership to remove.",
      });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    if (authorization.authority.role === "member") {
      return json(403, {
        error: "organization_manager_required",
        message: "An organization owner or admin can remove members.",
      });
    }
    const target = await env.IDENTITY_DB.prepare(
      "SELECT userId, role FROM member WHERE id = ? AND organizationId = ?",
    )
      .bind(body.membershipId, body.organizationId)
      .first<{ userId: string; role: string }>();
    if (!target)
      return json(404, {
        error: "member_not_found",
        message: "This membership is no longer current.",
      });
    if (target.userId === authorization.current.user.id) {
      return json(400, {
        error: "use_leave",
        message: "Use Leave organization to remove your own membership.",
      });
    }
    if (target.role === "owner" && authorization.authority.role !== "owner") {
      return json(403, {
        error: "owner_required",
        message: "Only an owner can remove another owner.",
      });
    }
    const removed = await removeOrganizationMember(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: authorization.current.user.id,
        organizationId: body.organizationId,
        membershipId: body.membershipId,
      },
    );
    if (removed) return json(200, { removed: true });
    if (target.role === "owner") {
      const owners = await env.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM member WHERE organizationId = ? AND role = 'owner'",
      )
        .bind(body.organizationId)
        .first<{ count: number }>();
      if ((owners?.count ?? 0) <= 1) {
        return json(409, {
          error: "final_owner_required",
          message: "This organization must keep at least one owner.",
        });
      }
    }
    return json(409, {
      error: "membership_changed",
      message: "This membership changed. Refresh the page and try again.",
    });
  }

  if (pathname === "/api/account/members/leave" && request.method === "POST") {
    const body = await requestBody(request);
    if (!body || !validOrganizationId(body.organizationId)) {
      return json(400, {
        error: "invalid_request",
        message: "Choose an organization to leave.",
      });
    }
    const authorization = await authorizeOrganizationRequest(
      request,
      env,
      body.organizationId,
    );
    if (authorization instanceof Response) return authorization;
    const left = await leaveOrganization(
      env.IDENTITY_DB.withSession("first-primary"),
      authorization.current.user.id,
      body.organizationId,
    );
    return left
      ? json(200, { left: true })
      : json(409, {
          error: "final_owner_required",
          message: "This organization must keep at least one owner.",
        });
  }

  if (pathname === "/api/account/operator" && request.method === "GET") {
    const current = await getSession(request, env);
    if (!current)
      return json(401, {
        error: "unauthenticated",
        message: "Sign in to use operator controls.",
      });
    if (!isOperator(env, current.user.id)) {
      return json(403, {
        error: "operator_required",
        message:
          "These controls are limited to the configured Platform operator.",
      });
    }
    const database = env.IDENTITY_DB.withSession("first-primary");
    const [organizations, users] = await Promise.all([
      listOperatorOrganizations(database),
      listOperatorUsers(database),
    ]);
    return json(200, { organizations, users });
  }

  if (
    pathname === "/api/account/operator/lifecycle" &&
    request.method === "POST"
  ) {
    const current = await getSession(request, env);
    if (!current)
      return json(401, {
        error: "unauthenticated",
        message: "Sign in to use operator controls.",
      });
    if (!isOperator(env, current.user.id)) {
      return json(403, {
        error: "operator_required",
        message:
          "Only the configured active Platform operator can change global account or organization status.",
      });
    }
    const body = await requestBody(request);
    if (!body || !validOrganizationId(body.targetId)) {
      return json(400, {
        error: "invalid_request",
        message: "Choose an organization or human account.",
      });
    }
    const database = env.IDENTITY_DB.withSession("first-primary");
    if (
      body.kind === "organization" &&
      (body.action === "suspend" || body.action === "restore")
    ) {
      const changed = await changeOrganizationLifecycle(
        database,
        current.user.id,
        body.targetId,
        body.action === "suspend",
      );
      return changed
        ? json(200, { changed: true })
        : json(409, {
            error: "organization_changed",
            message:
              "Organization status already changed. Refresh the operator list.",
          });
    }
    if (
      body.kind === "user" &&
      (body.action === "disable" || body.action === "restore")
    ) {
      const changed = await changeUserLifecycle(
        database,
        current.user.id,
        body.targetId,
        body.action === "disable",
      );
      return changed
        ? json(200, { changed: true })
        : json(409, {
            error: "account_changed",
            message:
              "Account status already changed. Refresh the operator list.",
          });
    }
    return json(400, {
      error: "invalid_request",
      message: "Choose a supported lifecycle action.",
    });
  }

  return null;
}

async function accountRoute(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = normalizedPathname(url.pathname);
  const management = await accountManagementRoute(request, env, pathname);
  if (management) return management;
  if (pathname === "/api/auth/unlink-account" && request.method === "POST") {
    return unlinkSocialAccount(request, env);
  }
  if (pathname === "/account.js" && request.method === "GET") {
    return assetResponse(
      accountScript,
      "application/javascript; charset=utf-8",
    );
  }
  if (pathname === "/account.css" && request.method === "GET") {
    return assetResponse(accountCss, "text/css; charset=utf-8");
  }
  if (pathname === "/login" && request.method === "GET") {
    const rawQuery = url.search.slice(1);
    return loginPage(
      loginErrorMessage(url.searchParams.get("error")),
      parseOAuthQuery(rawQuery) ? rawQuery : "",
    );
  }
  if (
    (pathname === "/error" || pathname === "/api/auth/error") &&
    request.method === "GET"
  ) {
    return loginPage(loginErrorMessage(url.searchParams.get("error")));
  }
  if (pathname === "/account" && request.method === "GET") {
    const auth = createAuth(env);
    const current = await getSession(request, env);
    if (!current) {
      return Response.redirect(new URL("/login", env.PLATFORM_BASE_URL), 302);
    }
    const defaultOrganization = await ensureDefaultOrganization(
      env.IDENTITY_DB,
      {
        id: current.user.id,
        name: current.user.name,
      },
    );
    const database = env.IDENTITY_DB.withSession("first-primary");
    const [defaultState, organizations, invitations, linkedAccounts] =
      await Promise.all([
        database
          .prepare(
            `SELECT owning_org.name, owning_org.suspendedAt, membership.role
         FROM platform_default_organization AS receipt
         LEFT JOIN organization AS owning_org ON owning_org.id = receipt.organization_id
         LEFT JOIN member AS membership
           ON membership.id = receipt.membership_id
          AND membership.organizationId = receipt.organization_id
         AND membership.userId = receipt.user_id
         WHERE receipt.user_id = ? AND receipt.organization_id = ?`,
          )
          .bind(current.user.id, defaultOrganization.organizationId)
          .first<{
            name: string | null;
            suspendedAt: number | null;
            role: string | null;
          }>(),
        listCurrentOrganizations(database, current.user.id),
        listRecipientInvitations(database, current.user.id),
        auth.api.listUserAccounts({ headers: request.headers }),
      ]);
    const requestedOrganizationId = url.searchParams.get("organizationId");
    const selectedOrganization =
      organizations.find(
        (entry) => entry.organizationId === requestedOrganizationId,
      ) ??
      organizations.find(
        (entry) => entry.organizationId === defaultOrganization.organizationId,
      ) ??
      organizations[0] ??
      null;
    let selectedDetails: OrganizationDetails | null = null;
    if (selectedOrganization) {
      const authority = await getOrganizationMembershipForDisplay(
        database,
        current.user.id,
        selectedOrganization.organizationId,
      );
      if (authority) {
        const [members, pending] = await Promise.all([
          listOrganizationMembers(database, authority),
          listOrganizationInvitations(database, authority),
        ]);
        selectedDetails = {
          id: authority.organizationId,
          name: authority.organizationName,
          role: authority.role,
          suspended: authority.suspendedAt !== null,
          viewerUserId: current.user.id,
          members,
          invitations: pending,
        };
      }
    }
    const configuredCredentialLifetimeDays =
      parseConfiguredCredentialLifetimeDays(
        env.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS,
      );
    let credentialOrganizationId: string | null = null;
    let credentialServices: AccountCredentialService[] = [];
    let credentials: AccountCredential[] = [];
    let agentOrganizationId: string | null = null;
    let agentServices: AccountCredentialService[] = [];
    let agents: AccountAgent[] = [];
    if (selectedOrganization) {
      const currentAuthority = await getCurrentOrganizationAuthority(
        database,
        current.user.id,
        selectedOrganization.organizationId,
      );
      if (currentAuthority) {
        const [services, listedCredentials] = await Promise.all([
          listActiveServices(database),
          listHumanCredentials(database, {
            userId: current.user.id,
            organizationId: currentAuthority.organizationId,
            membershipId: currentAuthority.membershipId,
          }),
        ]);
        credentialOrganizationId = currentAuthority.organizationId;
        credentialServices = services.map((service) => ({
          id: service.serviceId,
          name: service.displayName || service.serviceId,
          audience: service.audience,
          capabilities: service.allowedCapabilities,
        }));
        credentials = listedCredentials;
        if (
          currentAuthority.role === "owner" ||
          currentAuthority.role === "admin"
        ) {
          const managed = await loadAgentManagement(
            database,
            currentAuthority.organizationId,
          );
          agentOrganizationId = currentAuthority.organizationId;
          agentServices = managed.services;
          agents = managed.agents as AccountAgent[];
        }
      }
    }
    const accountOrganizations: AccountOrganization[] = organizations.map(
      (entry) => ({
        id: entry.organizationId,
        name: entry.organizationName,
        role: entry.role,
        suspended: entry.suspendedAt !== null,
      }),
    );
    const accountInvitations: AccountInvitation[] = invitations;
    return accountPage({
      name: current.user.name,
      email: current.user.email,
      image: current.user.image ?? null,
      defaultOrganization: {
        name: defaultState?.name ?? null,
        role: defaultState?.role ?? null,
        suspended: defaultState !== null && defaultState.suspendedAt !== null,
      },
      organizations: accountOrganizations,
      selectedOrganizationId: selectedOrganization?.organizationId ?? null,
      selectedOrganization: selectedDetails,
      invitations: accountInvitations,
      isOperator: isOperator(env, current.user.id),
      credentialOrganizationId,
      credentialServices,
      credentials,
      credentialMaxLifetimeDays: configuredCredentialLifetimeDays,
      agentOrganizationId,
      agentServices,
      agents,
      providers: linkedAccounts.map((account) => ({
        id: account.id,
        providerId: account.providerId,
      })),
    });
  }
  if (pathname === "/api/account/profile" && request.method === "POST") {
    if (!hasTrustedOrigin(request, env))
      return json(403, { error: "untrusted_origin" });
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid_request" });
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("name" in body) ||
      typeof body.name !== "string" ||
      body.name.trim().length === 0 ||
      body.name.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(body.name) ||
      !("avatarUrl" in body) ||
      typeof body.avatarUrl !== "string" ||
      body.avatarUrl.length > 2048
    ) {
      return json(400, { error: "invalid_profile" });
    }
    const image = body.avatarUrl.trim()
      ? safeAvatarUrl(body.avatarUrl.trim())
      : null;
    if (body.avatarUrl.trim() && !image)
      return json(400, { error: "avatar_url_must_use_https" });
    await createAuth(env).api.updateUser({
      headers: request.headers,
      body: { name: body.name.trim(), image },
    });
    return json(200, { updated: true });
  }
  return null;
}

function serviceFromRow(row: {
  service_id: string;
  audience: string;
  verifier_hash: string;
  allowed_capabilities: string;
  display_name?: string;
}): ServiceRegistration | null {
  const allowedCapabilities = parseStringArray(row.allowed_capabilities);
  if (
    !allowedCapabilities ||
    !validCapabilities(allowedCapabilities) ||
    !validServiceId(row.service_id) ||
    !validServiceAudience(row.audience)
  )
    return null;
  return {
    serviceId: row.service_id,
    audience: row.audience,
    verifierHash: row.verifier_hash,
    allowedCapabilities,
    displayName: row.display_name || undefined,
  };
}

async function findActiveServiceById(
  database: D1Database | D1DatabaseSession,
  serviceId: string,
): Promise<ServiceRegistration | null> {
  const row = await database
    .prepare(
      `SELECT service_id, audience, verifier_hash, allowed_capabilities, display_name
       FROM platform_service WHERE service_id = ? AND disabled = 0`,
    )
    .bind(serviceId)
    .first<{
      service_id: string;
      audience: string;
      verifier_hash: string;
      allowed_capabilities: string;
      display_name: string;
    }>();
  return row ? serviceFromRow(row) : null;
}

async function findServiceByVerifier(
  database: D1DatabaseSession,
  request: Request,
): Promise<ServiceRegistration | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return null;
  const verifierHash = await hashOpaque(match[1]!);
  const row = await database
    .prepare(
      "SELECT service_id, audience, verifier_hash, allowed_capabilities, display_name FROM platform_service WHERE verifier_hash = ? AND disabled = 0",
    )
    .bind(verifierHash)
    .first<{
      service_id: string;
      audience: string;
      verifier_hash: string;
      allowed_capabilities: string;
      display_name: string;
    }>();
  return row ? serviceFromRow(row) : null;
}

async function findGuestIssuer(
  database: D1DatabaseSession,
  request: Request,
): Promise<GuestIssuer | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return null;
  const issuerHash = await hashOpaque(match[1]!);
  const row = await database
    .prepare(
      `SELECT s.service_id, s.audience, s.verifier_hash, s.allowed_capabilities, s.display_name, i.capabilities AS issuer_capabilities
       FROM platform_service_grant_issuer i
       JOIN platform_service s ON s.service_id = i.service_id
       WHERE i.credential_hash = ? AND i.disabled = 0 AND s.disabled = 0`,
    )
    .bind(issuerHash)
    .first<{
      service_id: string;
      audience: string;
      verifier_hash: string;
      allowed_capabilities: string;
      display_name: string;
      issuer_capabilities: string;
    }>();
  if (!row) return null;
  const issuerCapabilities = parseStringArray(row.issuer_capabilities);
  if (!issuerCapabilities?.includes("guest:grant")) return null;
  const service = serviceFromRow(row);
  return service ? { service, issuerHash } : null;
}

export async function authenticateCredential(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const database = env.IDENTITY_DB.withSession("first-primary");
  const service = await findServiceByVerifier(database, request);
  if (!service) return json(503, { status: "authority_unavailable" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_request" });
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("credential" in body) ||
    typeof body.credential !== "string"
  ) {
    return json(400, { error: "invalid_request" });
  }

  const credentialHash = await hashOpaque(body.credential);
  const row = await database
    .prepare(
      `SELECT id, kind, subject_id, organization_id, membership_id, grant_id,
              audience, capabilities, resource_ids, expires_at, revoked_at,
              oauth_origin, oauth_installation_id, oauth_provider_row_id,
              oauth_provider_token_hash
       FROM platform_credential WHERE credential_hash = ?`,
    )
    .bind(credentialHash)
    .first<{
      id: string;
      kind: string;
      subject_id: string;
      organization_id: string | null;
      membership_id: string | null;
      grant_id: string | null;
      audience: string;
      capabilities: string;
      resource_ids: string;
      expires_at: number | null;
      revoked_at: number | null;
      oauth_origin: string | null;
      oauth_installation_id: string | null;
      oauth_provider_row_id: string | null;
      oauth_provider_token_hash: string | null;
    }>();
  if (
    !row ||
    row.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= Date.now()) ||
    row.audience !== service.audience
  ) {
    return json(401, { status: "invalid_credential" });
  }

  const capabilities = parseStringArray(row.capabilities);
  const resourceIds = parseStringArray(row.resource_ids);
  if (!capabilities || !resourceIds)
    return json(503, { status: "authority_unavailable" });
  if (!validCapabilities(capabilities)) {
    return json(401, { status: "invalid_credential" });
  }
  if (row.oauth_origin !== null) {
    if (
      row.oauth_origin !== "better-auth" ||
      row.kind !== "agent" ||
      !row.oauth_installation_id ||
      !row.oauth_provider_row_id ||
      !row.oauth_provider_token_hash ||
      row.membership_id === null ||
      !row.organization_id ||
      !row.grant_id ||
      resourceIds.length !== 0 ||
      row.expires_at === null
    ) {
      return json(503, { status: "authority_unavailable" });
    }
    const currentOAuth = await database
      .prepare(
        `SELECT credential.id, credential.subject_id, credential.organization_id,
                credential.membership_id, credential.grant_id, credential.audience,
                credential.capabilities, credential.resource_ids, credential.expires_at,
                installation.id AS installation_id,
                installation.client_id,
                installation.capabilities AS installation_capabilities,
                oauth_client.redirect_uri AS client_redirect_uri,
                flow.oauth_query AS oauth_query,
                access.id AS provider_row_id,
                access.resources AS provider_resources,
                access.scopes AS provider_scopes,
                consent.resources AS consent_resources,
                consent.scopes AS consent_scopes,
                oauth_client.capabilities AS client_capabilities,
                registered_client.scopes AS registered_scopes,
                service.allowed_capabilities AS service_capabilities
         FROM platform_credential AS credential
         JOIN platform_oauth_installation AS installation
           ON installation.id = credential.oauth_installation_id
          AND installation.active = 1
          AND installation.revoked_at IS NULL
          AND installation.membership_id = credential.membership_id
          AND installation.organization_id = credential.organization_id
          AND installation.audience = credential.audience
         JOIN oauthAccessToken AS access
           ON access.id = credential.oauth_provider_row_id
          AND access.token = credential.oauth_provider_token_hash
          AND access.referenceId = installation.id
          AND access.clientId = installation.client_id
           AND access.userId = installation.user_id
           AND access.revoked IS NULL
           AND access.refreshId IS NULL
           AND access.expiresAt > ?
         JOIN platform_oauth_client AS oauth_client
           ON oauth_client.client_id = installation.client_id
          AND oauth_client.service_id = installation.service_id
          AND oauth_client.active = 1
         JOIN platform_oauth_flow AS flow
           ON flow.installation_id = installation.id
          AND flow.status = 'activated'
         JOIN oauthClient AS registered_client
           ON registered_client.clientId = oauth_client.client_id
          AND registered_client.disabled = 0
         JOIN member AS membership
           ON membership.id = installation.membership_id
          AND membership.userId = installation.user_id
          AND membership.organizationId = installation.organization_id
         JOIN "user" AS subject_user
           ON subject_user.id = installation.user_id
          AND subject_user.disabledAt IS NULL
         JOIN organization AS owning_org
           ON owning_org.id = installation.organization_id
          AND owning_org.suspendedAt IS NULL
         JOIN platform_service AS service
           ON service.service_id = installation.service_id
          AND service.audience = installation.audience
          AND service.service_id = ?
          AND service.audience = ?
          AND service.verifier_hash = ?
          AND service.disabled = 0
         JOIN oauthConsent AS consent
           ON consent.clientId = installation.client_id
          AND consent.userId = installation.user_id
          AND consent.referenceId = installation.id
         WHERE credential.credential_hash = ?
           AND credential.oauth_origin = 'better-auth'
           AND credential.revoked_at IS NULL
           AND credential.expires_at > ?`,
      )
      .bind(
        Date.now(),
        service.serviceId,
        service.audience,
        service.verifierHash,
        credentialHash,
        Date.now(),
      )
      .first<{
        id: string;
        subject_id: string;
        organization_id: string;
        membership_id: string;
        grant_id: string;
        audience: string;
        capabilities: string;
        resource_ids: string;
        expires_at: number;
        installation_id: string;
        client_id: string;
        installation_capabilities: string;
        client_redirect_uri: string;
        oauth_query: string;
        provider_row_id: string;
        provider_resources: string | null;
        provider_scopes: string;
        consent_resources: string | null;
        consent_scopes: string;
        client_capabilities: string;
        registered_scopes: string;
        service_capabilities: string;
      }>();
    if (
      !currentOAuth ||
      currentOAuth.provider_row_id !== row.oauth_provider_row_id
    ) {
      return json(401, { status: "invalid_credential" });
    }
    const installationCapabilities = parseStringArray(
      currentOAuth.installation_capabilities,
    );
    const serviceCapabilities = parseStringArray(
      currentOAuth.service_capabilities,
    );
    const currentResourceIds = parseStringArray(currentOAuth.resource_ids);
    const currentCapabilities = parseStringArray(currentOAuth.capabilities);
    const providerResources = jsonStringArray(currentOAuth.provider_resources);
    const providerScopes = jsonStringArray(currentOAuth.provider_scopes);
    const consentResources = jsonStringArray(currentOAuth.consent_resources);
    const consentScopes = jsonStringArray(currentOAuth.consent_scopes);
    const clientCapabilities = parseStringArray(
      currentOAuth.client_capabilities,
    );
    const registeredScopes = parseStringArray(currentOAuth.registered_scopes);
    const binding = parseOAuthQuery(currentOAuth.oauth_query);
    if (
      !installationCapabilities ||
      !serviceCapabilities ||
      !currentResourceIds ||
      !currentCapabilities ||
      !providerResources ||
      !providerScopes ||
      !consentResources ||
      !consentScopes ||
      !clientCapabilities ||
      !registeredScopes ||
      !binding ||
      currentResourceIds.length !== 0 ||
      !validCapabilities(installationCapabilities) ||
      !validCapabilities(serviceCapabilities) ||
      !validCapabilities(currentCapabilities) ||
      !validCapabilities(providerScopes) ||
      !validCapabilities(consentScopes) ||
      !validCapabilities(clientCapabilities) ||
      !validCapabilities(registeredScopes) ||
      binding.clientId !== currentOAuth.client_id ||
      binding.redirectUri !== currentOAuth.client_redirect_uri ||
      binding.resource !== currentOAuth.audience ||
      !providerResources.includes(currentOAuth.audience) ||
      !consentResources.includes(currentOAuth.audience) ||
      providerResources.length !== 1 ||
      consentResources.length !== 1 ||
      providerScopes.length !== currentCapabilities.length ||
      consentScopes.length !== currentCapabilities.length ||
      binding.scopes.length !== currentCapabilities.length ||
      binding.scopes.some((scope) => !currentCapabilities.includes(scope)) ||
      currentCapabilities.some(
        (capability) =>
          !installationCapabilities.includes(capability) ||
          !serviceCapabilities.includes(capability) ||
          !clientCapabilities.includes(capability) ||
          !registeredScopes.includes(capability) ||
          !providerScopes.includes(capability) ||
          !consentScopes.includes(capability),
      )
    ) {
      return json(401, { status: "invalid_credential" });
    }
    return json(200, {
      status: "authenticated",
      principal: {
        version: 1,
        authority: env.PLATFORM_AUTHORITY_ID,
        kind: "agent",
        subjectId: currentOAuth.subject_id,
        credentialId: currentOAuth.id,
        organizationId: currentOAuth.organization_id,
        grantId: currentOAuth.grant_id,
        audience: currentOAuth.audience,
        capabilities: currentCapabilities,
        expiresAt: new Date(currentOAuth.expires_at).toISOString(),
      },
    });
  }
  if (
    row.kind !== "agent" &&
    capabilities.some(
      (capability) => !service.allowedCapabilities.includes(capability),
    )
  )
    return json(401, { status: "invalid_credential" });

  if (row.kind === "human") {
    if (!row.organization_id || !row.membership_id) {
      return json(503, { status: "authority_unavailable" });
    }
    const currentHuman = await database
      .prepare(
        `SELECT credential.id, credential.subject_id,
                credential.organization_id, credential.membership_id,
                credential.audience, credential.capabilities,
                credential.expires_at,
                live_service.allowed_capabilities AS service_capabilities
         FROM platform_credential AS credential
         JOIN member AS membership ON membership.id = credential.membership_id
         JOIN "user" AS subject_user ON subject_user.id = membership.userId
         JOIN organization AS owning_org ON owning_org.id = membership.organizationId
         JOIN platform_service AS live_service
           ON live_service.service_id = ?
          AND live_service.audience = ?
          AND live_service.verifier_hash = ?
          AND live_service.disabled = 0
         WHERE credential.credential_hash = ?
           AND credential.kind = 'human'
           AND credential.subject_id = membership.userId
           AND credential.organization_id = membership.organizationId
           AND credential.audience = live_service.audience
           AND credential.revoked_at IS NULL
           AND credential.expires_at > ?
           AND subject_user.disabledAt IS NULL
           AND owning_org.suspendedAt IS NULL`,
      )
      .bind(
        service.serviceId,
        service.audience,
        service.verifierHash,
        credentialHash,
        Date.now(),
      )
      .first<{
        id: string;
        subject_id: string;
        organization_id: string;
        membership_id: string;
        audience: string;
        capabilities: string;
        expires_at: number;
        service_capabilities: string;
      }>();
    if (!currentHuman) return json(401, { status: "invalid_credential" });
    const currentCapabilities = parseStringArray(currentHuman.capabilities);
    const serviceCapabilities = parseStringArray(
      currentHuman.service_capabilities,
    );
    if (
      !currentCapabilities ||
      !serviceCapabilities ||
      !validCapabilities(currentCapabilities) ||
      !validCapabilities(serviceCapabilities) ||
      !isSafeCredentialExpiry(currentHuman.expires_at)
    ) {
      return json(503, { status: "authority_unavailable" });
    }
    if (
      currentCapabilities.some(
        (capability) => !serviceCapabilities.includes(capability),
      )
    ) {
      return json(401, { status: "invalid_credential" });
    }
    return json(200, {
      status: "authenticated",
      principal: {
        version: 1,
        authority: env.PLATFORM_AUTHORITY_ID,
        kind: "human",
        subjectId: currentHuman.subject_id,
        credentialId: currentHuman.id,
        audience: currentHuman.audience,
        capabilities: currentCapabilities,
        expiresAt: new Date(currentHuman.expires_at).toISOString(),
        organizationId: currentHuman.organization_id,
        membershipId: currentHuman.membership_id,
      },
    });
  }

  if (row.kind === "agent") {
    if (
      !row.organization_id ||
      row.membership_id !== null ||
      !row.grant_id ||
      resourceIds.length !== 0 ||
      row.expires_at === null ||
      !isSafeCredentialExpiry(row.expires_at)
    ) {
      return json(503, { status: "authority_unavailable" });
    }
    const currentAgent = await database
      .prepare(
        `SELECT credential.id, credential.subject_id,
                credential.organization_id, credential.membership_id,
                credential.grant_id, credential.audience,
                credential.capabilities, credential.resource_ids,
                credential.expires_at,
                agent_grant.id AS current_grant_id,
                agent_grant.capabilities AS grant_capabilities,
                registered_service.allowed_capabilities AS service_capabilities
         FROM platform_credential AS credential
         JOIN platform_agent AS agent
           ON agent.id = credential.subject_id
          AND agent.organization_id = credential.organization_id
         JOIN organization AS owning_org
           ON owning_org.id = agent.organization_id
         JOIN platform_agent_grant AS agent_grant
           ON agent_grant.id = credential.grant_id
          AND agent_grant.agent_id = agent.id
          AND agent_grant.organization_id = agent.organization_id
         JOIN platform_service AS registered_service
           ON registered_service.service_id = ?
          AND registered_service.audience = ?
          AND registered_service.verifier_hash = ?
          AND registered_service.service_id = agent_grant.service_id
          AND registered_service.audience = agent_grant.audience
          AND registered_service.disabled = 0
         WHERE credential.credential_hash = ?
           AND credential.kind = 'agent'
           AND credential.organization_id = agent.organization_id
           AND credential.membership_id IS NULL
           AND credential.audience = registered_service.audience
           AND agent.enabled = 1
           AND owning_org.suspendedAt IS NULL
           AND agent_grant.revoked_at IS NULL
           AND credential.revoked_at IS NULL
           AND credential.expires_at > ?`,
      )
      .bind(
        service.serviceId,
        service.audience,
        service.verifierHash,
        credentialHash,
        Date.now(),
      )
      .first<{
        id: string;
        subject_id: string;
        organization_id: string;
        membership_id: string | null;
        grant_id: string;
        audience: string;
        capabilities: string;
        resource_ids: string;
        expires_at: number;
        current_grant_id: string;
        grant_capabilities: string;
        service_capabilities: string;
      }>();
    if (!currentAgent || currentAgent.current_grant_id !== row.grant_id) {
      return json(401, { status: "invalid_credential" });
    }
    const currentCapabilities = parseStringArray(currentAgent.capabilities);
    const currentResourceIds = parseStringArray(currentAgent.resource_ids);
    const grantCapabilities = parseStringArray(currentAgent.grant_capabilities);
    const serviceCapabilities = parseStringArray(
      currentAgent.service_capabilities,
    );
    if (
      !currentCapabilities ||
      !currentResourceIds ||
      !grantCapabilities ||
      !serviceCapabilities ||
      !validCapabilities(currentCapabilities) ||
      !validCapabilities(grantCapabilities) ||
      !validCapabilities(serviceCapabilities) ||
      currentResourceIds.length !== 0 ||
      !isSafeCredentialExpiry(currentAgent.expires_at)
    ) {
      return json(503, { status: "authority_unavailable" });
    }
    if (
      currentCapabilities.some(
        (capability) =>
          !grantCapabilities.includes(capability) ||
          !serviceCapabilities.includes(capability),
      )
    ) {
      return json(401, { status: "invalid_credential" });
    }
    return json(200, {
      status: "authenticated",
      principal: {
        version: 1,
        authority: env.PLATFORM_AUTHORITY_ID,
        kind: "agent",
        subjectId: currentAgent.subject_id,
        credentialId: currentAgent.id,
        organizationId: currentAgent.organization_id,
        grantId: currentAgent.grant_id,
        audience: currentAgent.audience,
        capabilities: currentCapabilities,
        expiresAt: new Date(currentAgent.expires_at).toISOString(),
      },
    });
  }

  if (row.kind === "guest") {
    if (
      !row.grant_id ||
      resourceIds.length === 0 ||
      row.organization_id ||
      row.membership_id
    ) {
      return json(503, { status: "authority_unavailable" });
    }
    const currentGuest = await database
      .prepare(
        `SELECT credential.id, credential.subject_id, credential.grant_id,
                credential.audience, credential.capabilities,
                credential.resource_ids, credential.expires_at,
                live_service.allowed_capabilities AS service_capabilities,
                guest_grant.resource_id AS grant_resource_id,
                guest_grant.capabilities AS grant_capabilities
         FROM platform_credential AS credential
         JOIN platform_guest AS guest
           ON guest.id = credential.subject_id
          AND guest.disabled_at IS NULL
         JOIN platform_guest_grant AS guest_grant
           ON guest_grant.id = credential.grant_id
          AND guest_grant.guest_id = guest.id
          AND guest_grant.service_id = ?
          AND guest_grant.audience = ?
          AND guest_grant.revoked_at IS NULL
         JOIN platform_service AS live_service
           ON live_service.service_id = ?
          AND live_service.audience = ?
          AND live_service.verifier_hash = ?
          AND live_service.disabled = 0
         WHERE credential.credential_hash = ?
           AND credential.kind = 'guest'
           AND credential.organization_id IS NULL
           AND credential.membership_id IS NULL
           AND credential.grant_id IS NOT NULL
           AND credential.audience = live_service.audience
           AND credential.expires_at IS NULL
           AND credential.revoked_at IS NULL`,
      )
      .bind(
        service.serviceId,
        service.audience,
        service.serviceId,
        service.audience,
        service.verifierHash,
        credentialHash,
      )
      .first<{
        id: string;
        subject_id: string;
        grant_id: string;
        audience: string;
        capabilities: string;
        resource_ids: string;
        expires_at: number | null;
        service_capabilities: string;
        grant_resource_id: string;
        grant_capabilities: string;
      }>();
    if (!currentGuest) return json(401, { status: "invalid_credential" });
    const currentCapabilities = parseStringArray(currentGuest.capabilities);
    const currentResourceIds = parseStringArray(currentGuest.resource_ids);
    const serviceCapabilities = parseStringArray(
      currentGuest.service_capabilities,
    );
    const grantCapabilities = parseStringArray(currentGuest.grant_capabilities);
    if (
      !currentCapabilities ||
      !currentResourceIds ||
      !serviceCapabilities ||
      !grantCapabilities
    ) {
      return json(503, { status: "authority_unavailable" });
    }
    if (
      !validCapabilities(currentCapabilities) ||
      !validCapabilities(serviceCapabilities) ||
      !validCapabilities(grantCapabilities) ||
      currentResourceIds.length !== 1 ||
      currentResourceIds[0] !== currentGuest.grant_resource_id
    ) {
      return json(503, { status: "authority_unavailable" });
    }
    if (
      currentCapabilities.some(
        (capability) =>
          !grantCapabilities.includes(capability) ||
          !serviceCapabilities.includes(capability),
      )
    ) {
      return json(401, { status: "invalid_credential" });
    }
    return json(200, {
      status: "authenticated",
      principal: {
        version: 1,
        authority: env.PLATFORM_AUTHORITY_ID,
        kind: "guest",
        subjectId: currentGuest.subject_id,
        credentialId: currentGuest.id,
        audience: currentGuest.audience,
        capabilities: currentCapabilities,
        expiresAt: currentGuest.expires_at,
        grantId: currentGuest.grant_id,
        resourceIds: currentResourceIds,
      },
    });
  }

  return json(503, { status: "authority_unavailable" });
}

function guestMutationResponse(
  result: Awaited<ReturnType<typeof issueGuestGrant>>,
  successStatus: number,
): Response {
  if (result.status === "success") {
    return json(successStatus, {
      status: "success",
      ...result.value,
    });
  }
  if (result.status === "invalid_guest_control") {
    return json(401, { status: "invalid_guest_control" });
  }
  if (result.status === "grant_denied") {
    return json(403, { status: "grant_denied" });
  }
  return json(409, { status: "conflict" });
}

async function createGuestRoute(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const issuer = await findGuestIssuer(
    env.IDENTITY_DB.withSession("first-primary"),
    request,
  );
  if (!issuer) return json(503, { status: "authority_unavailable" });
  const created = await createGuestIdentity(env.IDENTITY_DB, issuer);
  if (!created) return json(503, { status: "authority_unavailable" });
  return json(201, {
    status: "success",
    guestId: created.guestId,
    bootstrapCredential: created.bootstrapCredential,
    authority: env.PLATFORM_AUTHORITY_ID,
    audience: issuer.service.audience,
    purpose: "guest_control",
  });
}

async function resolveGuestControlRoute(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const issuer = await findGuestIssuer(
    env.IDENTITY_DB.withSession("first-primary"),
    request,
  );
  if (!issuer) return json(503, { status: "authority_unavailable" });
  const body = await requestBody(request);
  if (!body || typeof body.bootstrapCredential !== "string") {
    return json(400, { error: "invalid_request" });
  }
  try {
    const control = await resolveGuestControl(
      env.IDENTITY_DB.withSession("first-primary"),
      body.bootstrapCredential,
      issuer,
    );
    return control
      ? json(200, {
          status: "success",
          guestId: control.guestId,
          authority: env.PLATFORM_AUTHORITY_ID,
          audience: issuer.service.audience,
          purpose: "guest_control",
        })
      : json(401, { status: "invalid_guest_control" });
  } catch (error) {
    if (error instanceof GuestAuthorityUnavailable) {
      return json(503, { status: "authority_unavailable" });
    }
    throw error;
  }
}

async function attestGuestGrantRoute(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const issuer = await findGuestIssuer(
    env.IDENTITY_DB.withSession("first-primary"),
    request,
  );
  if (!issuer) return json(503, { status: "authority_unavailable" });
  const body = await requestBody(request);
  const assertion = body && parseGuestAssertion(body.assertion);
  if (
    !body ||
    typeof body.bootstrapCredential !== "string" ||
    typeof body.resourceId !== "string" ||
    !Array.isArray(body.capabilities) ||
    !assertion
  ) {
    return json(400, { error: "invalid_request" });
  }
  try {
    const result = await issueGuestGrant(env.IDENTITY_DB, {
      issuer,
      authority: env.PLATFORM_AUTHORITY_ID,
      bootstrapCredential: body.bootstrapCredential,
      resourceId: body.resourceId,
      capabilities: body.capabilities as string[],
      assertion,
    });
    return guestMutationResponse(result, 201);
  } catch (error) {
    if (error instanceof GuestAuthorityUnavailable) {
      return json(503, { status: "authority_unavailable" });
    }
    throw error;
  }
}

async function renewGuestGrantRoute(
  request: Request,
  env: Cloudflare.Env,
  grantId: string,
): Promise<Response> {
  const issuer = await findGuestIssuer(
    env.IDENTITY_DB.withSession("first-primary"),
    request,
  );
  if (!issuer) return json(503, { status: "authority_unavailable" });
  const body = await requestBody(request);
  const assertion = body && parseGuestAssertion(body.assertion);
  if (
    !body ||
    !validCredentialId(grantId) ||
    typeof body.bootstrapCredential !== "string" ||
    typeof body.resourceId !== "string" ||
    !Array.isArray(body.capabilities) ||
    !assertion
  ) {
    return json(400, { error: "invalid_request" });
  }
  try {
    const result = await renewGuestGrant(env.IDENTITY_DB, {
      issuer,
      authority: env.PLATFORM_AUTHORITY_ID,
      grantId,
      bootstrapCredential: body.bootstrapCredential,
      resourceId: body.resourceId,
      capabilities: body.capabilities as string[],
      assertion,
    });
    return guestMutationResponse(result, 201);
  } catch (error) {
    if (error instanceof GuestGrantConflict) {
      return json(409, { status: "conflict" });
    }
    if (error instanceof GuestAuthorityUnavailable) {
      return json(503, { status: "authority_unavailable" });
    }
    throw error;
  }
}

async function revokeGuestGrantRoute(
  request: Request,
  env: Cloudflare.Env,
  grantId: string,
): Promise<Response> {
  const issuer = await findGuestIssuer(
    env.IDENTITY_DB.withSession("first-primary"),
    request,
  );
  if (!issuer) return json(503, { status: "authority_unavailable" });
  if (!validCredentialId(grantId)) {
    return json(400, { error: "invalid_request" });
  }
  try {
    const revoked = await revokeGuestGrant(env.IDENTITY_DB, {
      issuer,
      grantId,
    });
    return revoked
      ? json(200, { status: "success", revoked: true })
      : json(403, { status: "grant_denied" });
  } catch (error) {
    if (error instanceof GuestAuthorityUnavailable) {
      return json(503, { status: "authority_unavailable" });
    }
    throw error;
  }
}

async function platformRoute(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/me" && request.method === "GET") {
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    const organization = await ensureDefaultOrganization(env.IDENTITY_DB, {
      id: current.user.id,
      name: current.user.name,
    });
    return json(200, { userId: current.user.id, ...organization });
  }
  if (url.pathname === "/api/credentials" && request.method === "GET") {
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    const organizationId = url.searchParams.get("organizationId");
    if (!validOrganizationId(organizationId)) {
      return json(400, { error: "invalid_request" });
    }
    const database = env.IDENTITY_DB.withSession("first-primary");
    const authority = await getCurrentOrganizationAuthority(
      database,
      current.user.id,
      organizationId,
    );
    if (!authority) return json(404, { error: "credential_not_found" });
    const [credentials, services] = await Promise.all([
      listHumanCredentials(database, {
        userId: current.user.id,
        organizationId: authority.organizationId,
        membershipId: authority.membershipId,
      }),
      listActiveServices(database),
    ]);
    return json(200, {
      organizationId: authority.organizationId,
      credentials,
      services: services.map((service) => ({
        id: service.serviceId,
        name: service.displayName || service.serviceId,
        audience: service.audience,
        capabilities: service.allowedCapabilities,
      })),
    });
  }
  if (url.pathname === "/api/credentials" && request.method === "POST") {
    if (!hasTrustedOrigin(request, env))
      return json(403, { error: "untrusted_origin" });
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    const body = await requestBody(request);
    if (
      !body ||
      typeof body.serviceId !== "string" ||
      !validOrganizationId(body.organizationId) ||
      !validCapabilities(body.capabilities) ||
      (body.name !== undefined && !validCredentialName(body.name))
    ) {
      return json(400, {
        error: "invalid_request",
        message:
          "Choose a service, organization, name and one or more unique capabilities.",
      });
    }
    const maxLifetimeDays = parseConfiguredCredentialLifetimeDays(
      env.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS,
    );
    if (maxLifetimeDays === null) {
      return json(503, { error: "credential_configuration_unavailable" });
    }
    const hasRequestedLifetime = Object.hasOwn(body, "lifetimeDays");
    if (
      hasRequestedLifetime &&
      (typeof body.lifetimeDays !== "number" ||
        !Number.isFinite(body.lifetimeDays) ||
        body.lifetimeDays <= 0 ||
        body.lifetimeDays > maxLifetimeDays)
    ) {
      return json(400, { error: "invalid_lifetime" });
    }
    const expiresAt = resolveCredentialExpiry(
      maxLifetimeDays,
      body.lifetimeDays,
    );
    if (expiresAt === null) return json(503, { error: "invalid_lifetime" });
    const authority = await getCurrentOrganizationAuthority(
      env.IDENTITY_DB.withSession("first-primary"),
      current.user.id,
      body.organizationId,
    );
    if (!authority) {
      return json(403, {
        error: "grant_exceeds_membership",
        message:
          "Choose an organization where your current membership is active.",
      });
    }
    const service = await findActiveServiceById(
      env.IDENTITY_DB.withSession("first-primary"),
      body.serviceId,
    );
    if (!service)
      return json(503, { error: "service_registration_unavailable" });
    try {
      const issued = await issueHumanCredential(env.IDENTITY_DB, {
        service,
        userId: authority.userId,
        organizationId: authority.organizationId,
        membershipId: authority.membershipId,
        capabilities: body.capabilities,
        name: body.name,
        expiresAt,
      });
      return json(201, {
        ...issued,
        audience: service.audience,
        name: body.name?.trim() || "Personal API credential",
        capabilities: body.capabilities,
        organizationId: authority.organizationId,
      });
    } catch (error) {
      if (error instanceof RangeError)
        return json(403, {
          error: "grant_exceeds_membership",
          message:
            "Choose an organization where your current membership is active.",
        });
      throw error;
    }
  }
  if (url.pathname === "/api/credentials/rotate" && request.method === "POST") {
    if (!hasTrustedOrigin(request, env))
      return json(403, { error: "untrusted_origin" });
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validCredentialId(body.credentialId)
    ) {
      return json(400, { error: "invalid_request" });
    }
    const maxLifetimeDays = parseConfiguredCredentialLifetimeDays(
      env.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS,
    );
    if (maxLifetimeDays === null) {
      return json(503, { error: "credential_configuration_unavailable" });
    }
    const hasRequestedLifetime = Object.hasOwn(body, "lifetimeDays");
    if (
      hasRequestedLifetime &&
      (typeof body.lifetimeDays !== "number" ||
        !Number.isFinite(body.lifetimeDays) ||
        body.lifetimeDays <= 0 ||
        body.lifetimeDays > maxLifetimeDays)
    ) {
      return json(400, { error: "invalid_lifetime" });
    }
    const expiresAt = resolveCredentialExpiry(
      maxLifetimeDays,
      body.lifetimeDays,
    );
    if (expiresAt === null) return json(503, { error: "invalid_lifetime" });
    const authority = await getCurrentOrganizationAuthority(
      env.IDENTITY_DB.withSession("first-primary"),
      current.user.id,
      body.organizationId,
    );
    if (!authority) return json(404, { error: "credential_not_found" });
    const old = await env.IDENTITY_DB.withSession("first-primary")
      .prepare(
        `SELECT service.service_id, service.audience, service.verifier_hash,
                service.allowed_capabilities, service.display_name
         FROM platform_credential AS credential
         JOIN platform_service AS service ON service.audience = credential.audience
         WHERE credential.id = ? AND credential.kind = 'human'
           AND credential.subject_id = ? AND credential.organization_id = ?
           AND credential.membership_id = ? AND service.disabled = 0`,
      )
      .bind(
        body.credentialId,
        current.user.id,
        authority.organizationId,
        authority.membershipId,
      )
      .first<{
        service_id: string;
        audience: string;
        verifier_hash: string;
        allowed_capabilities: string;
        display_name: string;
      }>();
    const service = old && serviceFromRow(old);
    if (!service) return json(404, { error: "credential_not_found" });
    try {
      const rotated = await rotateHumanCredential(env.IDENTITY_DB, {
        service,
        userId: current.user.id,
        organizationId: authority.organizationId,
        membershipId: authority.membershipId,
        credentialId: body.credentialId,
        expiresAt,
      });
      return json(201, {
        ...rotated,
        audience: service.audience,
        organizationId: authority.organizationId,
      });
    } catch (error) {
      if (error instanceof CredentialRotationConflict) {
        return json(409, {
          error: "credential_changed",
          message:
            "This credential expired, was revoked, or was rotated already.",
        });
      }
      if (error instanceof RangeError) {
        return json(400, { error: "invalid_lifetime" });
      }
      throw error;
    }
  }
  if (url.pathname === "/api/credentials/revoke" && request.method === "POST") {
    if (!hasTrustedOrigin(request, env))
      return json(403, { error: "untrusted_origin" });
    const current = await getSession(request, env);
    if (!current) return json(401, { error: "unauthenticated" });
    const body = await requestBody(request);
    if (
      !body ||
      !validOrganizationId(body.organizationId) ||
      !validCredentialId(body.credentialId)
    ) {
      return json(400, { error: "invalid_request" });
    }
    const authority = await getCurrentOrganizationAuthority(
      env.IDENTITY_DB.withSession("first-primary"),
      current.user.id,
      body.organizationId,
    );
    if (!authority) return json(404, { error: "credential_not_found" });
    const revoked = await revokeHumanCredential(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        userId: current.user.id,
        organizationId: authority.organizationId,
        membershipId: authority.membershipId,
        credentialId: body.credentialId,
      },
    );
    return revoked
      ? json(200, { revoked: true, organizationId: authority.organizationId })
      : json(404, { error: "credential_not_found" });
  }
  if (
    url.pathname === "/internal/v1/authenticate" &&
    request.method === "POST"
  ) {
    return authenticateCredential(request, env);
  }
  if (url.pathname === "/internal/v1/guests" && request.method === "POST") {
    return createGuestRoute(request, env);
  }
  if (
    url.pathname === "/internal/v1/guests/resolve" &&
    request.method === "POST"
  ) {
    return resolveGuestControlRoute(request, env);
  }
  if (
    url.pathname === "/internal/v1/guest-grants" &&
    request.method === "POST"
  ) {
    return attestGuestGrantRoute(request, env);
  }
  const renewMatch = /^\/internal\/v1\/guest-grants\/([^/]+)\/renew$/.exec(
    url.pathname,
  );
  if (renewMatch && request.method === "POST") {
    return renewGuestGrantRoute(
      request,
      env,
      decodeURIComponent(renewMatch[1]!),
    );
  }
  const revokeMatch = /^\/internal\/v1\/guest-grants\/([^/]+)\/revoke$/.exec(
    url.pathname,
  );
  if (revokeMatch && request.method === "POST") {
    return revokeGuestGrantRoute(
      request,
      env,
      decodeURIComponent(revokeMatch[1]!),
    );
  }
  return null;
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = normalizedPathname(url.pathname);
    if (!isExactOAuthPath(url.pathname, pathname)) {
      return new Response(null, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    if (pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    if (isDisabledBetterAuthPath(pathname)) {
      return new Response(null, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    try {
      const account = await accountRoute(request, env);
      if (account) return account;
      const oauthRoute = await oauthPlatformRoute(request, env, pathname);
      if (oauthRoute) return oauthRoute;
      const response = await platformRoute(request, env);
      if (response) return response;
      if (pathname.startsWith("/api/auth/")) {
        const denied = await validateAuthRequest(request, env);
        if (denied) return denied;
        const oauthState = await oauthRequestState(request, env, pathname);
        if (oauthState.platform) {
          if (
            pathname === "/api/auth/oauth2/token" &&
            request.method === "POST"
          ) {
            const body = await requestBody(request);
            if (body?.grant_type === "refresh_token") {
              return Response.json(
                {
                  error: "unsupported_grant_type",
                  error_description:
                    "Platform personal harnesses issue authorization-code access only.",
                },
                { status: 400, headers: { "cache-control": "no-store" } },
              );
            }
          }
          const scopes = await oauthConfiguredScopes(env);
          const consentRequest =
            pathname === "/api/auth/oauth2/consent" && request.method === "POST"
              ? await normalizeOAuthConsentRequest(request)
              : { request, browserForm: false };
          const authResponse = await createAuth(env, {
            oauthPlatform: true,
            oauthGrantTypes: ["authorization_code"],
            oauthScopes: scopes,
            oauthPostLogin: oauthPostLoginHooks(
              env.IDENTITY_DB.withSession("first-primary"),
              oauthState.flowId,
            ),
          }).handler(consentRequest.request);
          if (pathname === "/api/auth/oauth2/token") {
            const bound = await completeInitialOAuthAccess(
              env.IDENTITY_DB.withSession("first-primary"),
              authResponse,
            );
            if (bound) return bound;
          }
          if (pathname === "/api/auth/oauth2/consent" && oauthState.flowId) {
            const flow = await loadOAuthFlow(
              env.IDENTITY_DB.withSession("first-primary"),
              oauthState.flowId,
            );
            if (flow) {
              await completeOAuthConsent(
                env.IDENTITY_DB.withSession("first-primary"),
                flow,
                authResponse,
              );
              if (consentRequest.browserForm && authResponse.status === 200) {
                try {
                  const body: unknown = await authResponse.clone().json();
                  if (isObject(body)) {
                    const redirect =
                      typeof body.redirect_uri === "string"
                        ? body.redirect_uri
                        : typeof body.url === "string"
                          ? body.url
                          : null;
                    const binding = parseOAuthQuery(flow.oauth_query);
                    if (redirect && binding) {
                      const target = new URL(redirect);
                      const registered = new URL(binding.redirectUri);
                      if (
                        target.origin === registered.origin &&
                        target.pathname === registered.pathname &&
                        !target.hash
                      ) {
                        return Response.redirect(target, 303);
                      }
                    }
                  }
                } catch {
                  return json(500, { error: "invalid_consent_redirect" });
                }
                return json(500, { error: "invalid_consent_redirect" });
              }
            }
          }
          if (pathname === "/api/auth/oauth2/introspect") {
            return oauthIntrospectionResponse(
              env.IDENTITY_DB.withSession("first-primary"),
              request,
              authResponse,
            );
          }
          return authResponse;
        }
        return createAuth(env).handler(request);
      }
    } catch {
      return json(503, { status: "authority_unavailable" });
    }
    return new Response("Not Found", { status: 404 });
  },
};
