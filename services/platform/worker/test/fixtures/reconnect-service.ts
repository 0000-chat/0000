import type { AuthenticationResult } from "@0000/contracts";
import { createPlatformClient } from "@0000/platform-client";

export interface ReconnectServiceConfig {
  database: D1Database;
  platformBaseUrl: string;
  authority: string;
  audience: string;
  serviceVerifier: string;
  fetch: typeof fetch;
  beforeApply?: (input: {
    resourceId: string;
    organizationId: string;
  }) => Promise<void>;
}

export interface ReconnectPayload {
  resourceId: string;
  payload: string;
}

export interface ReconnectAttempt {
  resourceId: string;
  status: number;
  acknowledged: boolean;
}

export interface ReconnectTransport {
  preflight?: (
    credential: string,
    payload: ReconnectPayload,
  ) => Promise<Response>;
  beforeSubmit?: (payload: ReconnectPayload) => Promise<void>;
  submit: (credential: string, payload: ReconnectPayload) => Promise<Response>;
}

interface ReconnectResourceRow {
  id: string;
  organization_id: string;
  audience: string;
  payload: string;
  revision: number;
}

function bearerCredential(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1] ?? null;
}

function organizationId(
  authentication: Extract<AuthenticationResult, { status: "authenticated" }>,
): string | null {
  return authentication.principal.kind === "guest"
    ? null
    : authentication.principal.organizationId;
}

async function authenticate(
  request: Request,
  config: ReconnectServiceConfig,
): Promise<
  Response | Extract<AuthenticationResult, { status: "authenticated" }>
> {
  const credential = bearerCredential(request);
  if (!credential) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const result = await createPlatformClient({
    baseUrl: config.platformBaseUrl,
    authority: config.authority,
    audience: config.audience,
    serviceVerifier: config.serviceVerifier,
    fetch: config.fetch,
  }).authenticate(credential);
  if (result.status === "invalid_credential") {
    return Response.json({ error: "invalid_credential" }, { status: 401 });
  }
  if (result.status === "authority_unavailable") {
    return Response.json({ error: "authority_unavailable" }, { status: 503 });
  }
  return result;
}

async function resource(
  database: D1Database,
  resourceId: string,
): Promise<ReconnectResourceRow | null> {
  return database
    .prepare(
      `SELECT id, organization_id, audience, payload, revision
       FROM fixture_reconnect_resource WHERE id = ?`,
    )
    .bind(resourceId)
    .first<ReconnectResourceRow>();
}

function resourceIdFromUrl(request: Request): string | null {
  const resourceId = new URL(request.url).pathname
    .split("/")
    .filter(Boolean)
    .at(-1);
  return resourceId || null;
}

function canWrite(
  authentication: Extract<AuthenticationResult, { status: "authenticated" }>,
): boolean {
  return authentication.principal.capabilities.includes("resource:write");
}

export async function handleReconnectRead(
  request: Request,
  config: ReconnectServiceConfig,
): Promise<Response> {
  const authentication = await authenticate(request, config);
  if (authentication instanceof Response) return authentication;
  if (!canWrite(authentication)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const resourceId = resourceIdFromUrl(request);
  if (!resourceId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const stored = await resource(config.database, resourceId);
  const principalOrganizationId = organizationId(authentication);
  if (
    !stored ||
    stored.audience !== config.audience ||
    principalOrganizationId === null ||
    stored.organization_id !== principalOrganizationId
  ) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({
    id: stored.id,
    organizationId: stored.organization_id,
    payload: stored.payload,
    revision: stored.revision,
  });
}

export async function handleReconnectWrite(
  request: Request,
  config: ReconnectServiceConfig,
): Promise<Response> {
  const authentication = await authenticate(request, config);
  if (authentication instanceof Response) return authentication;
  if (!canWrite(authentication)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("resourceId" in body) ||
    typeof body.resourceId !== "string" ||
    body.resourceId.length === 0 ||
    !("payload" in body) ||
    typeof body.payload !== "string"
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const principalOrganizationId = organizationId(authentication);
  const stored = await resource(config.database, body.resourceId);
  if (
    !stored ||
    stored.audience !== config.audience ||
    principalOrganizationId === null ||
    stored.organization_id !== principalOrganizationId
  ) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // The test-only hook models another writer changing ownership after the
  // client preflight and before this server-side conditional apply.
  await config.beforeApply?.({
    resourceId: body.resourceId,
    organizationId: principalOrganizationId,
  });
  const updated = await config.database
    .prepare(
      `UPDATE fixture_reconnect_resource
       SET payload = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND audience = ?`,
    )
    .bind(
      body.payload,
      Date.now(),
      body.resourceId,
      principalOrganizationId,
      config.audience,
    )
    .run();
  if (updated.meta.changes !== 1) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const applied = await resource(config.database, body.resourceId);
  if (!applied) {
    return Response.json({ error: "authority_unavailable" }, { status: 503 });
  }
  return Response.json({
    acknowledged: true,
    id: applied.id,
    payload: applied.payload,
    revision: applied.revision,
  });
}

/**
 * A deliberately small application-owned queue for the reconnect proof. It
 * removes one payload only after the fixture service acknowledges its write.
 */
export class ReconnectFixtureClient {
  private pending: ReconnectPayload[] = [];

  enqueue(payload: ReconnectPayload): void {
    this.pending.push({ ...payload });
  }

  pendingPayloads(): ReconnectPayload[] {
    return this.pending.map((payload) => ({ ...payload }));
  }

  async reconnect(
    credential: string,
    transport: ReconnectTransport,
  ): Promise<ReconnectAttempt[]> {
    const remaining: ReconnectPayload[] = [];
    const attempts: ReconnectAttempt[] = [];
    for (const payload of this.pending) {
      if (transport.preflight) {
        const preflight = await transport.preflight(credential, payload);
        if (!preflight.ok) {
          attempts.push({
            resourceId: payload.resourceId,
            status: preflight.status,
            acknowledged: false,
          });
          remaining.push(payload);
          continue;
        }
      }
      await transport.beforeSubmit?.(payload);
      let response: Response;
      try {
        response = await transport.submit(credential, payload);
      } catch {
        response = Response.json(
          { error: "authority_unavailable" },
          { status: 503 },
        );
      }
      const acknowledged = response.status >= 200 && response.status < 300;
      attempts.push({
        resourceId: payload.resourceId,
        status: response.status,
        acknowledged,
      });
      if (!acknowledged) remaining.push(payload);
    }
    this.pending = remaining;
    return attempts;
  }
}
