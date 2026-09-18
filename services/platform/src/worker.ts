import { createAuth, PLATFORM_SESSION_FRESH_AGE_SECONDS } from "./auth";
import {
  accountPage,
  accountScript,
  accountCss,
  assetResponse,
  loginPage,
  safeAvatarUrl,
} from "./account-ui";
import {
  ensureDefaultOrganization,
  hashOpaque,
  issueHumanCredential,
  opaqueSecret,
  parseStringArray,
  type ServiceRegistration,
} from "./platform-state";

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
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep malformed paths unmatched by the Worker route table.
  }
  return decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded;
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
    return (
      callback.origin === base.origin &&
      (callback.pathname === "/account" || callback.pathname === "/login") &&
      !callback.search &&
      !callback.hash
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

async function accountRoute(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = normalizedPathname(url.pathname);
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
    return loginPage(loginErrorMessage(url.searchParams.get("error")));
  }
  if (
    (pathname === "/error" || pathname === "/api/auth/error") &&
    request.method === "GET"
  ) {
    return loginPage(loginErrorMessage(url.searchParams.get("error")));
  }
  if (pathname === "/account" && request.method === "GET") {
    const auth = createAuth(env);
    const current = await auth.api.getSession({ headers: request.headers });
    if (!current || !(await isActiveUser(env, current.user.id))) {
      return Response.redirect(new URL("/login", env.PLATFORM_BASE_URL), 302);
    }
    const organization = await ensureDefaultOrganization(env.IDENTITY_DB, {
      id: current.user.id,
      name: current.user.name,
    });
    const [orgState, linkedAccounts] = await Promise.all([
      env.IDENTITY_DB.prepare(
        `SELECT owning_org.name, owning_org.suspendedAt, membership.role
         FROM platform_default_organization AS receipt
         LEFT JOIN organization AS owning_org ON owning_org.id = receipt.organization_id
         LEFT JOIN member AS membership
           ON membership.id = receipt.membership_id
          AND membership.organizationId = receipt.organization_id
          AND membership.userId = receipt.user_id
         WHERE receipt.user_id = ? AND receipt.organization_id = ?`,
      )
        .bind(current.user.id, organization.organizationId)
        .first<{
          name: string | null;
          suspendedAt: number | null;
          role: string | null;
        }>(),
      auth.api.listUserAccounts({ headers: request.headers }),
    ]);
    return accountPage({
      name: current.user.name,
      email: current.user.email,
      image: current.user.image ?? null,
      organizationName: orgState?.name ?? null,
      membershipRole: orgState?.role ?? null,
      organizationSuspended:
        orgState?.suspendedAt !== null && orgState !== null,
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
}): ServiceRegistration | null {
  const allowedCapabilities = parseStringArray(row.allowed_capabilities);
  if (!allowedCapabilities) return null;
  return {
    serviceId: row.service_id,
    audience: row.audience,
    verifierHash: row.verifier_hash,
    allowedCapabilities,
  };
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
      "SELECT service_id, audience, verifier_hash, allowed_capabilities FROM platform_service WHERE verifier_hash = ? AND disabled = 0",
    )
    .bind(verifierHash)
    .first<{
      service_id: string;
      audience: string;
      verifier_hash: string;
      allowed_capabilities: string;
    }>();
  return row ? serviceFromRow(row) : null;
}

async function findServiceByGrantIssuer(
  database: D1DatabaseSession,
  request: Request,
): Promise<ServiceRegistration | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return null;
  const row = await database
    .prepare(
      `SELECT s.service_id, s.audience, s.verifier_hash, s.allowed_capabilities, i.capabilities AS issuer_capabilities
       FROM platform_service_grant_issuer i
       JOIN platform_service s ON s.service_id = i.service_id
       WHERE i.credential_hash = ? AND i.disabled = 0 AND s.disabled = 0`,
    )
    .bind(await hashOpaque(match[1]!))
    .first<{
      service_id: string;
      audience: string;
      verifier_hash: string;
      allowed_capabilities: string;
      issuer_capabilities: string;
    }>();
  if (!row) return null;
  const issuerCapabilities = parseStringArray(row.issuer_capabilities);
  if (!issuerCapabilities?.includes("guest:grant")) return null;
  return serviceFromRow(row);
}

async function authenticateCredential(
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
              audience, capabilities, resource_ids, expires_at, revoked_at
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

  if (row.kind === "human") {
    if (!row.organization_id || !row.membership_id) {
      return json(503, { status: "authority_unavailable" });
    }
    const membership = await database
      .prepare(
        `SELECT membership.id
         FROM member AS membership
         JOIN "user" AS subject_user ON subject_user.id = membership.userId
         JOIN organization AS owning_org ON owning_org.id = membership.organizationId
         WHERE membership.id = ?
           AND membership.organizationId = ?
           AND membership.userId = ?
           AND subject_user.disabledAt IS NULL
           AND owning_org.suspendedAt IS NULL`,
      )
      .bind(row.membership_id, row.organization_id, row.subject_id)
      .first<{ id: string }>();
    if (!membership) return json(401, { status: "invalid_credential" });
    return json(200, {
      status: "authenticated",
      principal: {
        version: 1,
        authority: env.PLATFORM_AUTHORITY_ID,
        kind: "human",
        subjectId: row.subject_id,
        credentialId: row.id,
        audience: service.audience,
        capabilities,
        expiresAt: new Date(row.expires_at!).toISOString(),
        organizationId: row.organization_id,
        membershipId: membership.id,
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
    const guest = await database
      .prepare(
        "SELECT id FROM platform_guest WHERE id = ? AND disabled_at IS NULL",
      )
      .bind(row.subject_id)
      .first<{ id: string }>();
    if (!guest) return json(401, { status: "invalid_credential" });
    return json(200, {
      status: "authenticated",
      principal: {
        version: 1,
        authority: env.PLATFORM_AUTHORITY_ID,
        kind: "guest",
        subjectId: row.subject_id,
        credentialId: row.id,
        audience: service.audience,
        capabilities,
        expiresAt: null,
        grantId: row.grant_id,
        resourceIds,
      },
    });
  }

  return json(503, { status: "authority_unavailable" });
}

async function createGuestBootstrap(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (!hasTrustedOrigin(request, env))
    return json(403, { error: "untrusted_origin" });
  const guestId = crypto.randomUUID();
  const bootstrapId = crypto.randomUUID();
  const credential = opaqueSecret("guest_");
  const credentialHash = await hashOpaque(credential);
  const createdAt = Date.now();
  await env.IDENTITY_DB.batch([
    env.IDENTITY_DB.prepare(
      "INSERT INTO platform_guest (id, created_at) VALUES (?, ?)",
    ).bind(guestId, createdAt),
    env.IDENTITY_DB.prepare(
      "INSERT INTO platform_guest_bootstrap (id, credential_hash, guest_id, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
    ).bind(bootstrapId, credentialHash, guestId, createdAt),
  ]);
  return json(201, { guestId, credential });
}

async function attestGuestGrant(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const database = env.IDENTITY_DB.withSession("first-primary");
  const service = await findServiceByGrantIssuer(database, request);
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
    !("guestCredential" in body) ||
    typeof body.guestCredential !== "string" ||
    !("resourceId" in body) ||
    typeof body.resourceId !== "string" ||
    !body.resourceId ||
    !("resourceOwnerId" in body) ||
    typeof body.resourceOwnerId !== "string" ||
    !body.resourceOwnerId ||
    !("capabilities" in body) ||
    !Array.isArray(body.capabilities) ||
    !body.capabilities.every(
      (item) => typeof item === "string" && item.length > 0,
    )
  ) {
    return json(400, { error: "invalid_request" });
  }
  const capabilities = body.capabilities as string[];
  if (
    capabilities.length === 0 ||
    capabilities.some(
      (capability) => !service.allowedCapabilities.includes(capability),
    )
  ) {
    return json(403, { error: "grant_exceeds_service_permissions" });
  }
  const guestBootstrap = await database
    .prepare(
      `SELECT bootstrap.guest_id
       FROM platform_guest_bootstrap AS bootstrap
       JOIN platform_guest AS guest ON guest.id = bootstrap.guest_id
       WHERE bootstrap.credential_hash = ?
         AND bootstrap.revoked_at IS NULL
         AND guest.disabled_at IS NULL`,
    )
    .bind(await hashOpaque(body.guestCredential))
    .first<{ guest_id: string }>();
  if (!guestBootstrap || guestBootstrap.guest_id !== body.resourceOwnerId) {
    return json(401, { status: "invalid_credential" });
  }

  const credential = opaqueSecret("guest_grant_");
  const credentialId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO platform_credential
       (id, credential_hash, kind, subject_id, organization_id, membership_id, grant_id, audience, capabilities, resource_ids, expires_at, revoked_at)
       VALUES (?, ?, 'guest', ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      credentialId,
      await hashOpaque(credential),
      guestBootstrap.guest_id,
      grantId,
      service.audience,
      JSON.stringify(capabilities),
      JSON.stringify([body.resourceId]),
    )
    .run();
  return json(201, {
    credential,
    credentialId,
    grantId,
    resourceId: body.resourceId,
  });
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
  if (url.pathname === "/api/credentials" && request.method === "POST") {
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
      !("serviceId" in body) ||
      typeof body.serviceId !== "string" ||
      !("capabilities" in body) ||
      !Array.isArray(body.capabilities) ||
      !body.capabilities.every(
        (item) => typeof item === "string" && item.length > 0,
      )
    ) {
      return json(400, { error: "invalid_request" });
    }
    const organization = await ensureDefaultOrganization(env.IDENTITY_DB, {
      id: current.user.id,
      name: current.user.name,
    });
    const rawService = await env.IDENTITY_DB.prepare(
      "SELECT service_id, audience, verifier_hash, allowed_capabilities FROM platform_service WHERE service_id = ? AND disabled = 0",
    )
      .bind(body.serviceId)
      .first<{
        service_id: string;
        audience: string;
        verifier_hash: string;
        allowed_capabilities: string;
      }>();
    const service = rawService && serviceFromRow(rawService);
    if (!service)
      return json(503, { error: "service_registration_unavailable" });
    try {
      const issued = await issueHumanCredential(env.IDENTITY_DB, {
        service,
        userId: current.user.id,
        ...organization,
        capabilities: body.capabilities as string[],
      });
      return json(201, { ...issued, audience: service.audience });
    } catch (error) {
      if (error instanceof RangeError)
        return json(403, { error: "grant_exceeds_membership" });
      throw error;
    }
  }
  if (url.pathname === "/api/credentials/revoke" && request.method === "POST") {
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
      !("credentialId" in body) ||
      typeof body.credentialId !== "string"
    ) {
      return json(400, { error: "invalid_request" });
    }
    const result = await env.IDENTITY_DB.prepare(
      "UPDATE platform_credential SET revoked_at = ? WHERE id = ? AND subject_id = ? AND revoked_at IS NULL",
    )
      .bind(Date.now(), body.credentialId, current.user.id)
      .run();
    return result.meta.changes === 1
      ? json(200, { revoked: true })
      : json(404, { error: "credential_not_found" });
  }
  if (
    url.pathname === "/internal/v1/authenticate" &&
    request.method === "POST"
  ) {
    return authenticateCredential(request, env);
  }
  if (url.pathname === "/api/guest/bootstrap" && request.method === "POST") {
    return createGuestBootstrap(request, env);
  }
  if (
    url.pathname === "/internal/v1/guest-grants" &&
    request.method === "POST"
  ) {
    return attestGuestGrant(request, env);
  }
  return null;
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    try {
      const account = await accountRoute(request, env);
      if (account) return account;
      const response = await platformRoute(request, env);
      if (response) return response;
      if (url.pathname.startsWith("/api/auth/")) {
        const denied = await validateAuthRequest(request, env);
        if (denied) return denied;
        return createAuth(env).handler(request);
      }
    } catch {
      return json(503, { status: "authority_unavailable" });
    }
    return new Response("Not Found", { status: 404 });
  },
};
