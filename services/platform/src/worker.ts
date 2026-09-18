import { createAuth, PLATFORM_SESSION_FRESH_AGE_SECONDS } from "./auth";
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
  type OrganizationDetails,
} from "./account-ui";
import {
  ensureDefaultOrganization,
  hashOpaque,
  issueHumanCredential,
  opaqueSecret,
  parseStringArray,
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
  ORGANIZATION_ROLES,
  type OrganizationRole,
} from "./organization-state";

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
    pathname.startsWith("/api/auth/delete-user/")
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (
    typeof value === "string" &&
    ORGANIZATION_ROLES.includes(value as OrganizationRole)
  );
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
    const body = await requestBody(request);
    if (
      !body ||
      typeof body.serviceId !== "string" ||
      !validOrganizationId(body.organizationId) ||
      !Array.isArray(body.capabilities) ||
      !body.capabilities.every(
        (item) => typeof item === "string" && item.length > 0,
      )
    ) {
      return json(400, {
        error: "invalid_request",
        message: "Choose a service, organization and one or more capabilities.",
      });
    }
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
        userId: authority.userId,
        organizationId: authority.organizationId,
        membershipId: authority.membershipId,
        capabilities: body.capabilities as string[],
      });
      return json(201, { ...issued, audience: service.audience });
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
    const pathname = normalizedPathname(url.pathname);
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
      const response = await platformRoute(request, env);
      if (response) return response;
      if (pathname.startsWith("/api/auth/")) {
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
