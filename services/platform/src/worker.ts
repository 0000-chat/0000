import { createAuth } from "./auth";
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
  return request.headers.get("origin") === env.PLATFORM_BASE_URL;
}

async function getSession(request: Request, env: Cloudflare.Env) {
  return createAuth(env).api.getSession({ headers: request.headers });
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
      const response = await platformRoute(request, env);
      if (response) return response;
    } catch {
      return json(503, { status: "authority_unavailable" });
    }
    if (url.pathname.startsWith("/api/auth/")) {
      return createAuth(env).handler(request);
    }
    return new Response("Not Found", { status: 404 });
  },
};
