import { createPlatformClient } from "@0000/platform-client";

export interface ResourceServiceConfig {
  database: D1Database;
  platformBaseUrl: string;
  authority: string;
  audience: string;
  serviceVerifier: string;
  guestGrantIssuer: string;
  fetch: typeof fetch;
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
  const resource = await config.database
    .prepare(
      "SELECT id, owner_kind, owner_id FROM fixture_resource WHERE id = ?",
    )
    .bind(resourceId)
    .first<{
      id: string;
      owner_kind: "organization" | "guest";
      owner_id: string;
    }>();
  if (!resource) return Response.json({ error: "not_found" }, { status: 404 });

  const principal = authentication.principal;
  const ownsResource =
    resource.owner_kind === "organization"
      ? (principal.kind === "human" ||
          principal.kind === "agent" ||
          principal.kind === "service") &&
        principal.organizationId === resource.owner_id
      : principal.kind === "guest" &&
        principal.subjectId === resource.owner_id &&
        principal.resourceIds.includes(resource.id);
  if (!ownsResource)
    return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ id: resource.id, ownerKind: resource.owner_kind });
}

export async function attestGuestResource(
  config: ResourceServiceConfig,
  input: {
    guestCredential: string;
    resourceId: string;
    resourceOwnerId: string;
    capabilities: string[];
  },
): Promise<{
  credential: string;
  credentialId: string;
  grantId: string;
} | null> {
  const response = await config.fetch(
    new URL("/internal/v1/guest-grants", config.platformBaseUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.guestGrantIssuer}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  if (response.status !== 201) return null;
  return response.json() as Promise<{
    credential: string;
    credentialId: string;
    grantId: string;
  }>;
}
