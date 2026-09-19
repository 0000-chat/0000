import {
  createPlatformClient,
  createPlatformGuestClient,
} from "@0000/platform-client";

export interface ResourceServiceConfig {
  database: D1Database;
  platformBaseUrl: string;
  authority: string;
  audience: string;
  serviceVerifier: string;
  guestGrantIssuer: string;
  fetch: typeof fetch;
  /** Optional because older fixture callers identify a service by audience. */
  serviceId?: string;
}

type FixtureResource = {
  id: string;
  owner_kind: "organization" | "guest";
  owner_id: string;
  audience: string | null;
};

function guestClient(config: ResourceServiceConfig) {
  return createPlatformGuestClient({
    baseUrl: config.platformBaseUrl,
    authority: config.authority,
    audience: config.audience,
    guestGrantIssuer: config.guestGrantIssuer,
    fetch: config.fetch,
  });
}

async function registeredServiceId(
  config: ResourceServiceConfig,
): Promise<string | null> {
  if (config.serviceId) return config.serviceId;
  const row = await config.database
    .prepare(
      "SELECT service_id FROM platform_service WHERE audience = ? AND disabled = 0",
    )
    .bind(config.audience)
    .first<{ service_id: string }>();
  return row?.service_id ?? null;
}

async function resource(
  config: ResourceServiceConfig,
  resourceId: string,
): Promise<FixtureResource | null> {
  return config.database
    .prepare(
      "SELECT id, owner_kind, owner_id, audience FROM fixture_resource WHERE id = ?",
    )
    .bind(resourceId)
    .first<FixtureResource>();
}

async function participantLinkMatches(
  config: ResourceServiceConfig,
  input: { resourceId: string; guestId: string; linkToken?: string },
): Promise<boolean> {
  if (!input.linkToken) return false;
  const serviceId = await registeredServiceId(config);
  if (!serviceId) return false;
  const row = await config.database
    .prepare(
      `SELECT resource_id
       FROM fixture_resource_participant
       WHERE resource_id = ? AND guest_id = ? AND service_id = ?
         AND audience = ? AND link_token = ? AND enabled = 1`,
    )
    .bind(
      input.resourceId,
      input.guestId,
      serviceId,
      config.audience,
      input.linkToken,
    )
    .first<{ resource_id: string }>();
  return Boolean(row);
}

export async function handleResourceRequest(
  request: Request,
  config: ResourceServiceConfig,
): Promise<Response> {
  const match = /^Bearer ([^\s]+)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match)
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  const client = createPlatformClient({
    baseUrl: config.platformBaseUrl,
    authority: config.authority,
    audience: config.audience,
    serviceVerifier: config.serviceVerifier,
    fetch: config.fetch,
  });
  const authentication = await client.authenticate(match[1]!);
  if (authentication.status === "invalid_credential") {
    return Response.json({ error: "invalid_credential" }, { status: 401 });
  }
  if (authentication.status === "authority_unavailable") {
    return Response.json({ error: "authority_unavailable" }, { status: 503 });
  }

  const resourceId = new URL(request.url).pathname
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (!resourceId)
    return Response.json({ error: "not_found" }, { status: 404 });
  if (!authentication.principal.capabilities.includes("resource:read")) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const storedResource = await resource(config, resourceId);
  if (!storedResource)
    return Response.json({ error: "not_found" }, { status: 404 });
  if (
    storedResource.audience !== null &&
    storedResource.audience !== config.audience
  ) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const principal = authentication.principal;
  let hasGuestAccess = false;
  if (principal.kind === "guest") {
    const ownerAccess =
      storedResource.owner_kind === "guest" &&
      principal.subjectId === storedResource.owner_id;
    const serviceId = await registeredServiceId(config);
    const participantAccess = serviceId
      ? Boolean(
          await config.database
            .prepare(
              `SELECT resource_id
               FROM fixture_resource_participant
               WHERE resource_id = ? AND guest_id = ? AND service_id = ?
                 AND audience = ? AND enabled = 1`,
            )
            .bind(
              storedResource.id,
              principal.subjectId,
              serviceId,
              config.audience,
            )
            .first<{ resource_id: string }>(),
        )
      : false;
    hasGuestAccess =
      principal.resourceIds.includes(storedResource.id) &&
      (ownerAccess || participantAccess);
  }
  const hasOrganizationAccess =
    storedResource.owner_kind === "organization" &&
    (principal.kind === "human" ||
      principal.kind === "agent" ||
      principal.kind === "service") &&
    principal.organizationId === storedResource.owner_id;
  if (!hasGuestAccess && !hasOrganizationAccess)
    return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    id: storedResource.id,
    ownerKind: storedResource.owner_kind,
  });
}

export async function attestGuestResource(
  config: ResourceServiceConfig,
  input: {
    bootstrapCredential?: string;
    resourceId: string;
    capabilities: string[];
    participantLink?: string;
    assertion?: "owner" | "participant";
  },
): Promise<{
  credential: string;
  credentialId: string;
  grantId: string;
  principal: unknown;
} | null> {
  const bootstrapCredential = input.bootstrapCredential;
  if (!bootstrapCredential) return null;
  const storedResource = await resource(config, input.resourceId);
  if (
    !storedResource ||
    (storedResource.audience !== null &&
      storedResource.audience !== config.audience)
  ) {
    return null;
  }
  const client = guestClient(config);
  const control = await client.resolveGuestControl(bootstrapCredential);
  if (control.status !== "success") return null;
  const participant = await participantLinkMatches(config, {
    resourceId: input.resourceId,
    guestId: control.guestId,
    linkToken: input.participantLink,
  });
  const isOwner =
    storedResource.owner_kind === "guest" &&
    control.guestId === storedResource.owner_id;
  const assertion =
    input.assertion === "participant" || (!isOwner && participant)
      ? { kind: "participant" as const }
      : input.assertion === "owner" || isOwner
        ? { kind: "owner" as const, storedOwnerId: storedResource.owner_id }
        : null;
  if (!assertion) return null;
  if (assertion.kind === "participant" && !participant) return null;
  const result = await client.attestGuestGrant({
    bootstrapCredential,
    resourceId: input.resourceId,
    capabilities: input.capabilities,
    assertion,
  });
  if (result.status !== "success") return null;
  return result.value;
}

function cookieName(serviceId: string): string {
  return `fixture_guest_control_${serviceId}`;
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export async function handleGuestBootstrapRequest(
  request: Request,
  config: ResourceServiceConfig,
): Promise<Response> {
  const serviceId = await registeredServiceId(config);
  if (!serviceId)
    return Response.json({ status: "authority_unavailable" }, { status: 503 });
  const name = cookieName(serviceId);
  const existing = cookieValue(request, name);
  const client = guestClient(config);
  if (existing !== undefined) {
    if (!existing) {
      return Response.json(
        { status: "invalid_guest_control" },
        { status: 401 },
      );
    }
    const resolved = await client.resolveGuestControl(existing);
    if (resolved.status === "success") return Response.json(resolved);
    if (resolved.status === "invalid_guest_control") {
      return Response.json(resolved, { status: 401 });
    }
    return Response.json({ status: "authority_unavailable" }, { status: 503 });
  }
  const created = await client.createGuest();
  if (created.status !== "success") {
    return Response.json({ status: "authority_unavailable" }, { status: 503 });
  }
  const response = Response.json(
    {
      status: "success",
      guestId: created.guestId,
      authority: created.authority,
      audience: created.audience,
      purpose: created.purpose,
    },
    { status: 201 },
  );
  response.headers.append(
    "set-cookie",
    `${name}=${created.bootstrapCredential}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  return response;
}
