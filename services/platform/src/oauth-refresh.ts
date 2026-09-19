import { getOAuthProviderApi } from "@better-auth/oauth-provider";
import {
  findOAuthClient,
  oauthProviderTokenHash,
  parseOAuthQuery,
  type OAuthClientRecord,
} from "./oauth-installation";
import {
  hashOpaque,
  parseStringArray,
  validCapabilities,
} from "./platform-state";

type OAuthDatabase = Pick<D1Database, "prepare" | "batch">;

const FAMILY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

type ProviderAuth = {
  clientId: string;
  client: { clientId?: string };
  method: string;
};

type AuthLike = {
  $context: Promise<any>;
  handler: (request: Request) => Promise<Response>;
};

export type OAuthRefreshPreparation =
  | { kind: "not_refresh" }
  | { kind: "refresh"; familyId: string; tokenId: string; nonce: string }
  | { kind: "response"; response: Response };

interface RefreshLedgerRow {
  id: string;
  family_id: string;
  installation_id: string;
  provider_refresh_row_id: string;
  provider_refresh_token_hash: string;
  provider_access_row_id: string | null;
  capabilities: string;
  resources: string;
  expires_at: number;
  state: string;
  family_state: string;
  pending_token_id: string | null;
  pending_consumption_nonce: string | null;
  user_id: string;
  client_id: string;
  membership_id: string;
  organization_id: string;
  service_id: string;
  audience: string;
  subject_id: string;
  grant_id: string;
}

interface CurrentRefreshRow extends RefreshLedgerRow {
  family_capabilities: string;
  family_expires_at: number;
  installation_active: number;
  installation_revoked_at: number | null;
  client_active: number;
  client_disabled: number | null;
  client_capabilities: string;
  registered_scopes: string | null;
  registered_grant_types: string | null;
  service_disabled: number;
  service_capabilities: string;
  resource_refresh_ttl: number | null;
  org_suspended_at: number | null;
  user_disabled_at: number | null;
  consent_resources: string | null;
  consent_scopes: string | null;
  provider_refresh_id: string;
  provider_refresh_token: string;
  provider_refresh_client_id: string;
  provider_refresh_user_id: string | null;
  provider_refresh_reference_id: string | null;
  provider_refresh_revoked: number | null;
  provider_refresh_expires: number | null;
  provider_refresh_resources: string | null;
  provider_refresh_scopes: string | null;
  provider_access_id: string;
  provider_access_token: string;
  provider_access_client_id: string;
  provider_access_user_id: string | null;
  provider_access_reference_id: string | null;
  provider_access_refresh_id: string | null;
  provider_access_revoked: number | null;
  provider_access_expires: number | null;
  provider_access_resources: string | null;
  provider_access_scopes: string | null;
}

interface ProviderAccessRow {
  id: string;
  token: string;
  referenceId: string | null;
  clientId: string;
  userId: string | null;
  resources: string | null;
  scopes: string;
  refreshId: string | null;
  expiresAt: number | null;
  revoked: number | null;
  sessionId: string | null;
}

interface ProviderRefreshRow {
  id: string;
  token: string;
  clientId: string;
  userId: string | null;
  referenceId: string | null;
  resources: string | null;
  scopes: string;
  expiresAt: number | null;
  revoked: number | null;
  sessionId: string | null;
}

interface ReturnedTokens {
  accessToken: string | null;
  refreshToken: string | null;
  body: Record<string, unknown> | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): string[] | null {
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

function protocolScopes(value: string[] | null): string[] | null {
  if (!value || new Set(value).size !== value.length) return null;
  return value.every(
    (scope) => scope === "offline_access" || validCapabilities([scope]),
  )
    ? value
    : null;
}

function capabilities(value: string[] | null): string[] | null {
  return value && validCapabilities(value) && !value.includes("offline_access")
    ? value
    : null;
}

function subset(values: string[], ceiling: string[]): boolean {
  return values.every((value) => ceiling.includes(value));
}

function noStoreError(
  error: string,
  description: string,
  status: number,
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );
}

async function requestBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
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

async function providerApi(
  auth: AuthLike,
  request: Request,
  body: Record<string, unknown>,
) {
  const context = await auth.$context;
  const plugin = context.getPlugin("oauth-provider");
  if (!plugin) throw new Error("oauth-provider plugin unavailable");
  return getOAuthProviderApi(
    {
      context,
      request,
      headers: request.headers,
      body,
      path: "/oauth2/token",
    } as never,
    plugin.options,
    "refresh_token",
  );
}

function providerError(error: unknown): Response {
  const candidate = error as { body?: { error?: unknown }; message?: string };
  const code =
    candidate.body?.error === "invalid_client"
      ? "invalid_client"
      : "invalid_request";
  return noStoreError(
    code,
    candidate.message ?? "OAuth client authentication failed",
    400,
  );
}

async function refreshLedgerRow(
  database: OAuthDatabase,
  tokenHash: string,
  clientId: string,
): Promise<RefreshLedgerRow | null> {
  return database
    .prepare(
      `SELECT t.id, t.family_id, t.installation_id, t.provider_refresh_row_id,
              t.provider_refresh_token_hash, t.provider_access_row_id,
              t.capabilities, t.resources, t.expires_at, t.state,
              f.state AS family_state, f.pending_token_id,
              f.pending_consumption_nonce, f.user_id, f.client_id,
              f.membership_id, f.organization_id, f.service_id, f.audience,
              f.subject_id, f.grant_id
       FROM platform_oauth_refresh_token AS t
       JOIN platform_oauth_refresh_family AS f ON f.id = t.family_id
       WHERE t.provider_refresh_token_hash = ? AND f.client_id = ?
       LIMIT 1`,
    )
    .bind(tokenHash, clientId)
    .first<RefreshLedgerRow>();
}

async function currentRefreshRow(
  database: OAuthDatabase,
  row: RefreshLedgerRow,
): Promise<CurrentRefreshRow | null> {
  return database
    .prepare(
      `SELECT t.id, t.family_id, t.installation_id, t.provider_refresh_row_id,
              t.provider_refresh_token_hash, t.provider_access_row_id,
              t.capabilities, t.resources, t.expires_at, t.state,
              f.state AS family_state, f.pending_token_id,
              f.pending_consumption_nonce, f.user_id, f.client_id,
              f.membership_id, f.organization_id, f.service_id, f.audience,
              f.subject_id, f.grant_id, f.capabilities AS family_capabilities,
              f.expires_at AS family_expires_at,
              i.active AS installation_active, i.revoked_at AS installation_revoked_at,
              pc.active AS client_active, oc.disabled AS client_disabled,
              pc.capabilities AS client_capabilities, oc.scopes AS registered_scopes,
              oc.grantTypes AS registered_grant_types,
              service.disabled AS service_disabled,
              service.allowed_capabilities AS service_capabilities,
              resource.refreshTokenTtl AS resource_refresh_ttl,
              owning_org.suspendedAt AS org_suspended_at,
              subject_user.disabledAt AS user_disabled_at,
              consent.resources AS consent_resources,
              consent.scopes AS consent_scopes,
              provider_refresh.id AS provider_refresh_id,
              provider_refresh.token AS provider_refresh_token,
              provider_refresh.clientId AS provider_refresh_client_id,
              provider_refresh.userId AS provider_refresh_user_id,
              provider_refresh.referenceId AS provider_refresh_reference_id,
              provider_refresh.revoked AS provider_refresh_revoked,
              provider_refresh.expiresAt AS provider_refresh_expires,
              provider_refresh.resources AS provider_refresh_resources,
              provider_refresh.scopes AS provider_refresh_scopes,
              provider_access.id AS provider_access_id,
              provider_access.token AS provider_access_token,
              provider_access.clientId AS provider_access_client_id,
              provider_access.userId AS provider_access_user_id,
              provider_access.referenceId AS provider_access_reference_id,
              provider_access.refreshId AS provider_access_refresh_id,
              provider_access.revoked AS provider_access_revoked,
              provider_access.expiresAt AS provider_access_expires,
              provider_access.resources AS provider_access_resources,
              provider_access.scopes AS provider_access_scopes
       FROM platform_oauth_refresh_token AS t
       JOIN platform_oauth_refresh_family AS f ON f.id = t.family_id
       JOIN platform_oauth_installation AS i ON i.id = f.installation_id
       JOIN platform_oauth_client AS pc ON pc.client_id = f.client_id
       JOIN oauthClient AS oc ON oc.clientId = f.client_id
       JOIN platform_service AS service ON service.service_id = f.service_id
        AND service.audience = f.audience
       JOIN oauthResource AS resource ON resource.identifier = f.audience
       JOIN member AS membership ON membership.id = f.membership_id
        AND membership.userId = f.user_id
        AND membership.organizationId = f.organization_id
       JOIN "user" AS subject_user ON subject_user.id = f.user_id
       JOIN organization AS owning_org ON owning_org.id = f.organization_id
       JOIN oauthConsent AS consent ON consent.clientId = f.client_id
        AND consent.userId = f.user_id AND consent.referenceId = f.installation_id
       JOIN oauthRefreshToken AS provider_refresh
        ON provider_refresh.id = t.provider_refresh_row_id
        AND provider_refresh.token = t.provider_refresh_token_hash
       JOIN oauthAccessToken AS provider_access
        ON provider_access.id = t.provider_access_row_id
        AND provider_access.refreshId = provider_refresh.id
       WHERE t.id = ? AND t.family_id = ?
       LIMIT 1`,
    )
    .bind(row.id, row.family_id)
    .first<CurrentRefreshRow>();
}

function authorityMatches(
  row: CurrentRefreshRow,
  client: OAuthClientRecord,
  requestedResource: string | null,
  requestedScopes: string[] | null,
): boolean {
  const rowCapabilities = capabilities(arrayValue(row.capabilities));
  const familyCapabilities = capabilities(arrayValue(row.family_capabilities));
  const familyResources = arrayValue(row.resources);
  const providerResources = arrayValue(row.provider_refresh_resources);
  const providerAccessResources = arrayValue(row.provider_access_resources);
  const providerScopes = protocolScopes(
    arrayValue(row.provider_refresh_scopes),
  );
  const providerAccessScopes = protocolScopes(
    arrayValue(row.provider_access_scopes),
  );
  const consentResources = arrayValue(row.consent_resources);
  const consentScopes = protocolScopes(arrayValue(row.consent_scopes));
  const clientCapabilities = capabilities(arrayValue(row.client_capabilities));
  const registeredScopes = protocolScopes(arrayValue(row.registered_scopes));
  const registeredGrantTypes = arrayValue(row.registered_grant_types);
  const serviceCapabilities = capabilities(
    arrayValue(row.service_capabilities),
  );
  const bindingScopes = requestedScopes;
  return Boolean(
    row.state === "issued" &&
      row.family_state === "active" &&
      row.family_expires_at > Date.now() &&
      row.installation_active === 1 &&
      row.installation_revoked_at === null &&
      row.client_active === 1 &&
      row.client_disabled === 0 &&
      row.client_id === client.clientId &&
      row.service_id === client.serviceId &&
      client.refreshEnabled &&
      row.service_disabled === 0 &&
      row.org_suspended_at === null &&
      row.user_disabled_at === null &&
      row.resource_refresh_ttl !== null &&
      row.resource_refresh_ttl > 0 &&
      registeredGrantTypes?.includes("refresh_token") &&
      row.provider_refresh_revoked === null &&
      row.provider_refresh_expires !== null &&
      row.provider_refresh_expires > Date.now() &&
      row.expires_at > Date.now() &&
      row.audience === client.audience &&
      familyResources?.length === 1 &&
      familyResources[0] === client.audience &&
      providerResources?.length === 1 &&
      providerResources[0] === client.audience &&
      providerAccessResources?.length === 1 &&
      providerAccessResources[0] === client.audience &&
      consentResources?.length === 1 &&
      consentResources[0] === client.audience &&
      providerScopes !== null &&
      providerAccessScopes !== null &&
      providerAccessScopes.includes("offline_access") ===
        providerScopes.includes("offline_access") &&
      consentScopes !== null &&
      clientCapabilities !== null &&
      registeredScopes !== null &&
      serviceCapabilities !== null &&
      rowCapabilities !== null &&
      familyCapabilities !== null &&
      subset(rowCapabilities, familyCapabilities) &&
      subset(rowCapabilities, client.capabilities) &&
      subset(rowCapabilities, clientCapabilities) &&
      subset(rowCapabilities, serviceCapabilities) &&
      subset(
        rowCapabilities,
        providerScopes.filter((scope) => scope !== "offline_access"),
      ) &&
      subset(
        rowCapabilities,
        consentScopes.filter((scope) => scope !== "offline_access"),
      ) &&
      subset(
        rowCapabilities,
        providerAccessScopes.filter((scope) => scope !== "offline_access"),
      ) &&
      row.provider_refresh_id === row.provider_refresh_row_id &&
      row.provider_refresh_token === row.provider_refresh_token_hash &&
      row.provider_refresh_client_id === row.client_id &&
      row.provider_refresh_user_id === row.user_id &&
      row.provider_refresh_reference_id === row.installation_id &&
      row.provider_access_id === row.provider_access_row_id &&
      row.provider_access_token.length > 0 &&
      row.provider_access_client_id === row.client_id &&
      row.provider_access_user_id === row.user_id &&
      row.provider_access_reference_id === row.installation_id &&
      row.provider_access_refresh_id === row.provider_refresh_row_id &&
      row.provider_access_revoked === null &&
      row.provider_access_expires !== null &&
      row.provider_access_expires > Date.now() &&
      (requestedResource === null || requestedResource === client.audience) &&
      (bindingScopes === null || subset(bindingScopes, providerScopes)),
  );
}

async function terminateRefreshFamily(
  database: OAuthDatabase,
  familyId: string,
  reason: string,
  terminalState: "revoked" | "quarantined" = "revoked",
  replayTokenId: string | null = null,
): Promise<void> {
  const now = Date.now();
  const tokenTerminalState =
    terminalState === "quarantined" ? "quarantined" : "revoked";
  await database.batch([
    database
      .prepare(
        `UPDATE platform_oauth_refresh_family
         SET state = ?, pending_token_id = NULL, pending_consumption_nonce = NULL,
             revoked_at = COALESCE(revoked_at, ?), revoked_reason = ?, updated_at = ?
         WHERE id = ? AND state IN ('active', 'pending')`,
      )
      .bind(terminalState, now, reason, now, familyId),
    database
      .prepare(
        `UPDATE platform_oauth_refresh_token
         SET state = CASE WHEN state = 'pending' THEN ? ELSE 'revoked' END,
             revoked_at = COALESCE(revoked_at, ?), revoked_reason = ?, updated_at = ?
         WHERE family_id = ? AND state IN ('issued', 'pending')`,
      )
      .bind(tokenTerminalState, now, reason, now, familyId),
    database
      .prepare(
        `UPDATE platform_oauth_refresh_token
         SET state = 'replayed', replayed_at = COALESCE(replayed_at, ?),
             revoked_reason = ?, updated_at = ?
         WHERE id = ? AND family_id = ? AND state = 'consumed'`,
      )
      .bind(now, reason, now, replayTokenId ?? "", familyId),
    database
      .prepare(
        `UPDATE platform_credential
         SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = ?
         WHERE oauth_refresh_token_id IN (
           SELECT id FROM platform_oauth_refresh_token WHERE family_id = ?
         )`,
      )
      .bind(now, reason, familyId),
    database
      .prepare(
        `UPDATE oauthRefreshToken SET revoked = COALESCE(revoked, ?)
         WHERE id IN (SELECT provider_refresh_row_id
                      FROM platform_oauth_refresh_token WHERE family_id = ?)`,
      )
      .bind(now, familyId),
    database
      .prepare(
        `UPDATE oauthAccessToken SET revoked = COALESCE(revoked, ?)
         WHERE id IN (SELECT provider_access_row_id
                      FROM platform_oauth_refresh_token
                      WHERE family_id = ? AND provider_access_row_id IS NOT NULL)`,
      )
      .bind(now, familyId),
    database
      .prepare(
        `UPDATE platform_oauth_installation SET active = 0,
                revoked_at = COALESCE(revoked_at, ?)
         WHERE id = (SELECT installation_id FROM platform_oauth_refresh_family WHERE id = ?)`,
      )
      .bind(now, familyId),
  ]);
}

async function parseReturnedTokens(
  response: Response,
): Promise<ReturnedTokens> {
  try {
    const value: unknown = await response.clone().json();
    if (!isObject(value))
      return { accessToken: null, refreshToken: null, body: null };
    return {
      accessToken:
        typeof value.access_token === "string" && value.access_token
          ? value.access_token
          : null,
      refreshToken:
        typeof value.refresh_token === "string" && value.refresh_token
          ? value.refresh_token
          : null,
      body: value,
    };
  } catch {
    return { accessToken: null, refreshToken: null, body: null };
  }
}

function requestedScopes(body: Record<string, unknown>): string[] | null {
  if (body.scope === undefined) return null;
  if (typeof body.scope !== "string") return [];
  const scopes = body.scope.split(" ").filter(Boolean);
  return protocolScopes(scopes);
}

/**
 * Authenticate and fence a refresh request before Better Auth sees it.  A
 * refresh value is never handed to the provider unless the Platform ledger
 * has an active, current installation and the single pending slot was won.
 */
export async function prepareOAuthRefresh(
  database: OAuthDatabase,
  auth: AuthLike,
  request: Request,
): Promise<OAuthRefreshPreparation> {
  const body = await requestBody(request);
  if (!body || body.grant_type !== "refresh_token")
    return { kind: "not_refresh" };
  let provider: ReturnType<typeof getOAuthProviderApi>;
  let authenticated: ProviderAuth;
  try {
    provider = await providerApi(auth, request, body);
    authenticated = (await provider.authenticateClient({
      requireCredentials: false,
    })) as ProviderAuth;
  } catch (error) {
    return { kind: "response", response: providerError(error) };
  }
  const client = await findOAuthClient(database, authenticated.clientId);
  if (!client || !client.refreshEnabled) {
    return {
      kind: "response",
      response: noStoreError(
        "invalid_client",
        "refresh is not enabled for this client",
        400,
      ),
    };
  }
  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    return {
      kind: "response",
      response: noStoreError(
        "invalid_request",
        "refresh_token is required",
        400,
      ),
    };
  }
  const tokenHash = await provider.hashToken(refreshToken, "refresh_token");
  const row = await refreshLedgerRow(
    database,
    tokenHash,
    authenticated.clientId,
  );
  if (!row) {
    return {
      kind: "response",
      response: noStoreError(
        "invalid_grant",
        "refresh token is not mapped",
        400,
      ),
    };
  }
  const requestedResource =
    typeof body.resource === "string" ? body.resource : null;
  const scope = requestedScopes(body);
  const storedCapabilities = capabilities(arrayValue(row.capabilities));
  if (
    !storedCapabilities ||
    (requestedResource !== null && requestedResource !== row.audience) ||
    (scope !== null &&
      !subset(
        scope.filter((entry) => entry !== "offline_access"),
        storedCapabilities,
      ))
  ) {
    return {
      kind: "response",
      response: noStoreError(
        "invalid_scope",
        "requested binding is outside the installation",
        400,
      ),
    };
  }
  if (
    row.family_state === "pending" &&
    row.pending_token_id === row.id &&
    row.state === "pending"
  ) {
    return {
      kind: "response",
      response: jsonAuthorityUnavailable("refresh rotation is already pending"),
    };
  }
  if (row.state !== "issued" || row.family_state !== "active") {
    await terminateRefreshFamily(
      database,
      row.family_id,
      "refresh_replay",
      "revoked",
      row.id,
    );
    return {
      kind: "response",
      response: noStoreError(
        "invalid_grant",
        "refresh token has already been consumed",
        400,
      ),
    };
  }
  const current = await currentRefreshRow(database, row);
  if (
    !current ||
    !authorityMatches(current, client, requestedResource, scope)
  ) {
    return {
      kind: "response",
      response: jsonAuthorityUnavailable("refresh authority is unavailable"),
    };
  }
  const nonce = crypto.randomUUID();
  const fenceNow = Date.now();
  const consumed = await database
    .prepare(
      `UPDATE platform_oauth_refresh_family
       SET state = 'pending', pending_token_id = ?, pending_consumption_nonce = ?, updated_at = ?
       WHERE id = ? AND state = 'active' AND pending_token_id IS NULL
         AND EXISTS (
           SELECT 1 FROM platform_oauth_refresh_token
           WHERE id = ? AND family_id = ? AND state = 'issued'
             AND provider_refresh_token_hash = ?
         )
         AND EXISTS (
           SELECT 1
           FROM platform_oauth_refresh_family AS family
           JOIN platform_oauth_refresh_token AS token
             ON token.id = ? AND token.family_id = family.id
            AND token.state = 'issued'
            AND token.provider_refresh_token_hash = ?
           JOIN platform_oauth_installation AS installation
             ON installation.id = family.installation_id
           JOIN platform_oauth_client AS client
             ON client.client_id = family.client_id
            AND client.service_id = family.service_id
            AND client.active = 1 AND client.refresh_enabled = 1
           JOIN oauthClient AS registered_client
             ON registered_client.clientId = family.client_id
            AND registered_client.disabled = 0
            AND registered_client.grantTypes LIKE '%refresh_token%'
           JOIN platform_service AS service
             ON service.service_id = family.service_id
            AND service.audience = family.audience AND service.disabled = 0
           JOIN oauthResource AS resource
             ON resource.identifier = family.audience
            AND resource.disabled = 0 AND resource.refreshTokenTtl > 0
           JOIN member AS membership
             ON membership.id = family.membership_id
            AND membership.userId = family.user_id
            AND membership.organizationId = family.organization_id
           JOIN "user" AS subject_user
             ON subject_user.id = family.user_id AND subject_user.disabledAt IS NULL
           JOIN organization AS owning_org
             ON owning_org.id = family.organization_id
            AND owning_org.suspendedAt IS NULL
           JOIN oauthConsent AS consent
             ON consent.clientId = family.client_id
            AND consent.userId = family.user_id
            AND consent.referenceId = family.installation_id
           JOIN oauthRefreshToken AS provider_refresh
             ON provider_refresh.id = token.provider_refresh_row_id
            AND provider_refresh.token = token.provider_refresh_token_hash
            AND provider_refresh.clientId = family.client_id
           AND provider_refresh.userId = family.user_id
            AND provider_refresh.referenceId = family.installation_id
            AND provider_refresh.revoked IS NULL
            AND provider_refresh.expiresAt > ?
            AND json_array_length(json_extract(provider_refresh.resources, '$')) = 1
            AND json_extract(json_extract(provider_refresh.resources, '$'), '$[0]') = family.audience
           JOIN oauthAccessToken AS provider_access
             ON provider_access.id = token.provider_access_row_id
            AND provider_access.refreshId = provider_refresh.id
            AND provider_access.clientId = family.client_id
            AND provider_access.userId = family.user_id
            AND provider_access.referenceId = family.installation_id
            AND provider_access.revoked IS NULL
            AND provider_access.expiresAt > ?
            AND json_array_length(json_extract(provider_access.resources, '$')) = 1
            AND json_extract(json_extract(provider_access.resources, '$'), '$[0]') = family.audience
           WHERE family.id = ? AND family.state = 'active'
             AND family.expires_at > ?
             AND installation.active = 1
             AND installation.revoked_at IS NULL
             AND installation.expires_at > ?
             AND token.expires_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM json_each(token.capabilities) AS requested
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(service.allowed_capabilities) AS catalog
                 WHERE catalog.value = requested.value
               )
             )
           AND NOT EXISTS (
             SELECT 1 FROM json_each(token.capabilities) AS requested
             WHERE NOT EXISTS (
               SELECT 1 FROM json_each(client.capabilities) AS ceiling
               WHERE ceiling.value = requested.value
             )
           )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(token.capabilities) AS requested
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(registered_client.scopes) AS registered
                 WHERE registered.value = requested.value
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(token.capabilities) AS requested
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(json_extract(consent.scopes, '$')) AS consented
                 WHERE consented.value = requested.value
               )
             )
             AND json_array_length(json_extract(token.resources, '$')) = 1
             AND json_extract(json_extract(token.resources, '$'), '$[0]') = family.audience
             AND json_array_length(json_extract(consent.resources, '$')) = 1
             AND json_extract(json_extract(consent.resources, '$'), '$[0]') = family.audience
         )`,
    )
    .bind(
      row.id,
      nonce,
      fenceNow,
      row.family_id,
      row.id,
      row.family_id,
      tokenHash,
      row.id,
      tokenHash,
      fenceNow,
      fenceNow,
      row.family_id,
      fenceNow,
      fenceNow,
      fenceNow,
    )
    .run();
  const fenced = await database
    .prepare(
      `SELECT f.state, f.pending_token_id, f.pending_consumption_nonce,
              t.state AS token_state, t.consumption_nonce
       FROM platform_oauth_refresh_family AS f
       LEFT JOIN platform_oauth_refresh_token AS t ON t.id = f.pending_token_id
       WHERE f.id = ?`,
    )
    .bind(row.family_id)
    .first<{
      state: string;
      pending_token_id: string | null;
      pending_consumption_nonce: string | null;
      token_state: string | null;
      consumption_nonce: string | null;
    }>();
  if (
    fenced?.state !== "pending" ||
    fenced.pending_token_id !== row.id ||
    fenced.pending_consumption_nonce !== nonce ||
    fenced.token_state !== "pending" ||
    fenced.consumption_nonce !== nonce
  ) {
    const state = await database
      .prepare(
        "SELECT state, pending_token_id FROM platform_oauth_refresh_family WHERE id = ?",
      )
      .bind(row.family_id)
      .first<{ state: string; pending_token_id: string | null }>();
    if (state?.state === "pending" && state.pending_token_id === row.id) {
      return {
        kind: "response",
        response: jsonAuthorityUnavailable(
          "refresh rotation is already pending",
        ),
      };
    }
    return {
      kind: "response",
      response: jsonAuthorityUnavailable(
        "refresh rotation did not acquire its fence",
      ),
    };
  }
  return { kind: "refresh", familyId: row.family_id, tokenId: row.id, nonce };
}

function jsonAuthorityUnavailable(description: string): Response {
  return Response.json(
    {
      status: "authority_unavailable",
      error: "temporarily_unavailable",
      error_description: description,
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

async function providerRowsForResponse(
  database: OAuthDatabase,
  accessToken: string,
  refreshToken: string,
  clientId: string,
): Promise<{
  access: ProviderAccessRow;
  refresh: ProviderRefreshRow;
  accessHash: string;
  refreshHash: string;
} | null> {
  const accessHash = await oauthProviderTokenHash(accessToken);
  const refreshHash = await oauthProviderTokenHash(refreshToken);
  const access = await database
    .prepare(
      `SELECT id, token, referenceId, clientId, userId, resources, scopes, refreshId,
              expiresAt, revoked, sessionId
       FROM oauthAccessToken WHERE token = ? AND clientId = ? LIMIT 1`,
    )
    .bind(accessHash, clientId)
    .first<ProviderAccessRow>();
  const refresh = await database
    .prepare(
      `SELECT id, token, clientId, userId, referenceId, resources, scopes,
              expiresAt, revoked, sessionId
       FROM oauthRefreshToken WHERE token = ? AND clientId = ? LIMIT 1`,
    )
    .bind(refreshHash, clientId)
    .first<ProviderRefreshRow>();
  if (!access || !refresh) return null;
  if (access.refreshId !== refresh.id) return null;
  return { access, refresh, accessHash, refreshHash };
}

/**
 * Revoke provider rows that were returned before Platform could map them.
 * The rows are addressed by their exact opaque IDs, hashes, and client; a
 * mapping failure must not leave an unbound provider successor usable outside
 * the Platform ledger.
 */
async function revokeUnmappedProviderRows(
  database: OAuthDatabase,
  rows: {
    access: ProviderAccessRow;
    refresh: ProviderRefreshRow;
  },
): Promise<void> {
  const revokedAt = Date.now();
  await database.batch([
    database
      .prepare(
        `UPDATE oauthRefreshToken SET revoked = COALESCE(revoked, ?)
         WHERE id = ? AND token = ? AND clientId = ?`,
      )
      .bind(
        revokedAt,
        rows.refresh.id,
        rows.refresh.token,
        rows.refresh.clientId,
      ),
    database
      .prepare(
        `UPDATE oauthAccessToken SET revoked = COALESCE(revoked, ?)
         WHERE id = ? AND token = ? AND clientId = ?`,
      )
      .bind(revokedAt, rows.access.id, rows.access.token, rows.access.clientId),
  ]);
}

async function quarantineAfterFailure(
  database: OAuthDatabase,
  familyId: string,
  reason: string,
): Promise<void> {
  try {
    await terminateRefreshFamily(database, familyId, reason, "quarantined");
  } catch {
    // The pending fence itself remains durable and every verifier requires an
    // active family.  Do not restore a predecessor or keep an in-memory flag.
  }
}

export async function abandonOAuthRefresh(
  database: OAuthDatabase,
  preparation: Extract<OAuthRefreshPreparation, { kind: "refresh" }>,
  reason: string,
): Promise<void> {
  await quarantineAfterFailure(database, preparation.familyId, reason);
}

async function currentFamilyAuthority(
  database: OAuthDatabase,
  familyId: string,
  tokenId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT f.state AS family_state, f.capabilities AS family_capabilities,
              f.expires_at AS family_expires_at, t.state AS token_state,
              t.capabilities AS token_capabilities, t.resources AS token_resources,
              t.provider_refresh_token_hash,
              i.id AS installation_id, i.client_id, i.user_id, i.membership_id,
              i.organization_id, i.service_id, i.audience,
              i.active AS installation_active, i.revoked_at AS installation_revoked_at,
              pc.active AS client_active, pc.refresh_enabled,
              pc.capabilities AS client_capabilities, oc.disabled AS client_disabled,
              oc.scopes AS registered_scopes, oc.grantTypes AS registered_grant_types,
              service.disabled AS service_disabled,
              service.allowed_capabilities AS service_capabilities,
              resource.refreshTokenTtl AS resource_refresh_ttl,
              owning_org.suspendedAt AS organization_suspended,
              subject_user.disabledAt AS user_disabled,
              provider_refresh.id AS refresh_id,
              provider_refresh.token AS refresh_token,
              provider_refresh.clientId AS refresh_client_id,
              provider_refresh.userId AS refresh_user_id,
              provider_refresh.referenceId AS refresh_reference_id,
              provider_refresh.resources AS refresh_resources,
              provider_refresh.scopes AS refresh_scopes,
              provider_refresh.revoked AS refresh_revoked,
              provider_refresh.expiresAt AS refresh_expires,
              provider_access.id AS access_id,
              provider_access.token AS access_token,
              provider_access.clientId AS access_client_id,
              provider_access.userId AS access_user_id,
              provider_access.referenceId AS access_reference_id,
              provider_access.refreshId AS access_refresh_id,
              provider_access.resources AS access_resources,
              provider_access.scopes AS access_scopes,
              provider_access.revoked AS access_revoked,
              provider_access.expiresAt AS access_expires,
              consent.resources AS consent_resources,
              consent.scopes AS consent_scopes
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id AND t.id = ?
       JOIN platform_oauth_installation AS i ON i.id = f.installation_id
       JOIN platform_oauth_client AS pc ON pc.client_id = f.client_id
       JOIN oauthClient AS oc ON oc.clientId = f.client_id
       JOIN platform_service AS service ON service.service_id = f.service_id
        AND service.audience = f.audience
       JOIN oauthResource AS resource ON resource.identifier = f.audience
       JOIN member AS membership ON membership.id = f.membership_id
        AND membership.userId = f.user_id
        AND membership.organizationId = f.organization_id
       JOIN organization AS owning_org ON owning_org.id = f.organization_id
       JOIN "user" AS subject_user ON subject_user.id = f.user_id
       JOIN oauthRefreshToken AS provider_refresh ON provider_refresh.id = t.provider_refresh_row_id
        AND provider_refresh.token = t.provider_refresh_token_hash
       JOIN oauthAccessToken AS provider_access ON provider_access.id = t.provider_access_row_id
        AND provider_access.refreshId = provider_refresh.id
       JOIN oauthConsent AS consent ON consent.clientId = f.client_id
        AND consent.userId = f.user_id AND consent.referenceId = f.installation_id
       WHERE f.id = ? LIMIT 1`,
    )
    .bind(tokenId, familyId)
    .first<{
      family_state: string;
      family_capabilities: string;
      family_expires_at: number;
      token_state: string;
      token_capabilities: string;
      token_resources: string;
      provider_refresh_token_hash: string;
      installation_id: string;
      client_id: string;
      user_id: string;
      membership_id: string;
      organization_id: string;
      service_id: string;
      audience: string;
      installation_active: number;
      installation_revoked_at: number | null;
      client_active: number;
      refresh_enabled: number;
      client_capabilities: string;
      client_disabled: number | null;
      registered_scopes: string | null;
      registered_grant_types: string | null;
      service_disabled: number;
      service_capabilities: string;
      resource_refresh_ttl: number | null;
      organization_suspended: number | null;
      user_disabled: number | null;
      refresh_id: string;
      refresh_token: string;
      refresh_client_id: string;
      refresh_user_id: string | null;
      refresh_reference_id: string | null;
      refresh_resources: string | null;
      refresh_scopes: string | null;
      refresh_revoked: number | null;
      refresh_expires: number | null;
      access_id: string;
      access_token: string;
      access_client_id: string;
      access_user_id: string | null;
      access_reference_id: string | null;
      access_refresh_id: string | null;
      access_resources: string | null;
      access_scopes: string | null;
      access_revoked: number | null;
      access_expires: number | null;
      consent_resources: string | null;
      consent_scopes: string | null;
    }>();
  if (!row) return false;
  const familyCapabilities = capabilities(arrayValue(row.family_capabilities));
  const tokenCapabilities = capabilities(arrayValue(row.token_capabilities));
  const tokenResources = arrayValue(row.token_resources);
  const refreshResources = arrayValue(row.refresh_resources);
  const refreshScopes = protocolScopes(arrayValue(row.refresh_scopes));
  const accessResources = arrayValue(row.access_resources);
  const accessScopes = protocolScopes(arrayValue(row.access_scopes));
  const consentResources = arrayValue(row.consent_resources);
  const consentScopes = protocolScopes(arrayValue(row.consent_scopes));
  const clientCapabilities = capabilities(arrayValue(row.client_capabilities));
  const registeredScopes = protocolScopes(arrayValue(row.registered_scopes));
  const registeredGrantTypes = arrayValue(row.registered_grant_types);
  const serviceCapabilities = capabilities(
    arrayValue(row.service_capabilities),
  );
  return (
    row.family_state === "active" &&
    row.token_state === "issued" &&
    row.family_expires_at > Date.now() &&
    row.installation_active === 1 &&
    row.installation_revoked_at === null &&
    row.client_active === 1 &&
    row.refresh_enabled === 1 &&
    row.client_disabled === 0 &&
    row.service_disabled === 0 &&
    row.organization_suspended === null &&
    row.user_disabled === null &&
    row.resource_refresh_ttl !== null &&
    row.resource_refresh_ttl > 0 &&
    registeredGrantTypes?.includes("refresh_token") === true &&
    familyCapabilities !== null &&
    tokenCapabilities !== null &&
    subset(tokenCapabilities, familyCapabilities) &&
    tokenResources?.length === 1 &&
    tokenResources[0] === row.audience &&
    refreshResources?.length === 1 &&
    refreshResources[0] === row.audience &&
    accessResources?.length === 1 &&
    accessResources[0] === row.audience &&
    consentResources?.length === 1 &&
    consentResources[0] === row.audience &&
    refreshScopes !== null &&
    accessScopes !== null &&
    consentScopes !== null &&
    clientCapabilities !== null &&
    registeredScopes !== null &&
    serviceCapabilities !== null &&
    subset(tokenCapabilities, clientCapabilities) &&
    subset(tokenCapabilities, serviceCapabilities) &&
    subset(
      tokenCapabilities,
      registeredScopes.filter((scope) => scope !== "offline_access"),
    ) &&
    subset(
      tokenCapabilities,
      refreshScopes.filter((scope) => scope !== "offline_access"),
    ) &&
    subset(
      tokenCapabilities,
      accessScopes.filter((scope) => scope !== "offline_access"),
    ) &&
    subset(
      tokenCapabilities,
      consentScopes.filter((scope) => scope !== "offline_access"),
    ) &&
    row.refresh_token === row.provider_refresh_token_hash &&
    row.refresh_client_id === row.client_id &&
    row.refresh_user_id === row.user_id &&
    row.refresh_reference_id === row.installation_id &&
    row.access_id.length > 0 &&
    row.access_client_id === row.client_id &&
    row.access_user_id === row.user_id &&
    row.access_reference_id === row.installation_id &&
    row.access_refresh_id === row.refresh_id &&
    row.refresh_revoked === null &&
    row.refresh_expires !== null &&
    row.refresh_expires > Date.now() &&
    row.access_revoked === null &&
    row.access_expires !== null &&
    row.access_expires > Date.now()
  );
}

/** Map a successful provider refresh response to the exact winning lineage. */
export async function completeOAuthRefresh(
  database: OAuthDatabase,
  response: Response,
  preparation: Extract<OAuthRefreshPreparation, { kind: "refresh" }>,
  clientId: string,
): Promise<Response> {
  if (response.status !== 200) {
    await quarantineAfterFailure(
      database,
      preparation.familyId,
      "provider_refresh_failed",
    );
    return jsonAuthorityUnavailable(
      "refresh provider response was not successful",
    );
  }
  const returned = await parseReturnedTokens(response);
  if (!returned.accessToken || !returned.refreshToken) {
    await quarantineAfterFailure(
      database,
      preparation.familyId,
      "provider_refresh_response_malformed",
    );
    return jsonAuthorityUnavailable("refresh provider response was malformed");
  }
  const rows = await providerRowsForResponse(
    database,
    returned.accessToken,
    returned.refreshToken,
    clientId,
  );
  if (!rows) {
    await quarantineAfterFailure(
      database,
      preparation.familyId,
      "provider_refresh_rows_unbound",
    );
    return jsonAuthorityUnavailable("refresh provider rows were not bound");
  }
  const predecessor = await database
    .prepare(
      `SELECT t.resources, t.capabilities, t.sequence, t.installation_id,
              t.expires_at, f.expires_at AS family_expires_at,
              f.capabilities AS family_capabilities,
              i.client_id, i.user_id, i.membership_id, i.organization_id,
              i.service_id, i.audience, i.subject_id, i.grant_id,
              c.id AS old_credential_id, c.expires_at AS old_credential_expires
       FROM platform_oauth_refresh_token AS t
       JOIN platform_oauth_refresh_family AS f ON f.id = t.family_id
       JOIN platform_oauth_installation AS i ON i.id = t.installation_id
       LEFT JOIN platform_credential AS c ON c.oauth_refresh_token_id = t.id
       WHERE t.id = ? AND t.family_id = ? AND t.state = 'pending'
         AND f.state = 'pending' AND f.pending_token_id = ?
         AND f.pending_consumption_nonce = ?`,
    )
    .bind(
      preparation.tokenId,
      preparation.familyId,
      preparation.tokenId,
      preparation.nonce,
    )
    .first<{
      resources: string;
      capabilities: string;
      sequence: number;
      installation_id: string;
      expires_at: number;
      family_expires_at: number;
      family_capabilities: string;
      client_id: string;
      user_id: string;
      membership_id: string;
      organization_id: string;
      service_id: string;
      audience: string;
      subject_id: string;
      grant_id: string;
      old_credential_id: string | null;
      old_credential_expires: number | null;
    }>();
  const providerResources = arrayValue(rows.access.resources);
  const providerRefreshResources = arrayValue(rows.refresh.resources);
  const providerScopes = protocolScopes(arrayValue(rows.access.scopes));
  const providerRefreshScopes = protocolScopes(arrayValue(rows.refresh.scopes));
  const predecessorResources = arrayValue(predecessor?.resources ?? null);
  const predecessorCapabilities = capabilities(
    arrayValue(predecessor?.capabilities ?? null),
  );
  const familyCapabilities = capabilities(
    arrayValue(predecessor?.family_capabilities ?? null),
  );
  const effectiveCapabilities = providerScopes
    ? providerScopes.filter((scope) => scope !== "offline_access")
    : null;
  if (
    !predecessor ||
    !providerResources ||
    providerResources.length !== 1 ||
    providerResources[0] !== predecessor.audience ||
    !providerRefreshResources ||
    providerRefreshResources.length !== 1 ||
    providerRefreshResources[0] !== predecessor.audience ||
    !providerScopes ||
    !providerRefreshScopes ||
    !effectiveCapabilities ||
    !predecessorResources ||
    !predecessorCapabilities ||
    !familyCapabilities ||
    !subset(effectiveCapabilities, predecessorCapabilities) ||
    !subset(effectiveCapabilities, familyCapabilities) ||
    !subset(
      effectiveCapabilities,
      providerRefreshScopes.filter((scope) => scope !== "offline_access"),
    ) ||
    providerScopes.includes("offline_access") !==
      providerRefreshScopes.includes("offline_access") ||
    rows.access.referenceId !== predecessor.installation_id ||
    rows.refresh.referenceId !== predecessor.installation_id ||
    rows.access.userId !== predecessor.user_id ||
    rows.refresh.userId !== predecessor.user_id ||
    rows.access.clientId !== predecessor.client_id ||
    rows.refresh.clientId !== predecessor.client_id ||
    rows.access.revoked !== null ||
    rows.refresh.revoked !== null ||
    rows.access.expiresAt === null ||
    rows.refresh.expiresAt === null ||
    !predecessor.old_credential_id
  ) {
    await revokeUnmappedProviderRows(database, rows).catch(() => undefined);
    await quarantineAfterFailure(
      database,
      preparation.familyId,
      "provider_refresh_binding_mismatch",
    );
    return jsonAuthorityUnavailable(
      "refresh provider binding was inconsistent",
    );
  }
  const successorId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const successorExpiry = Math.min(
    rows.access.expiresAt,
    rows.refresh.expiresAt,
    predecessor.family_expires_at,
  );
  const batch = [
    database
      .prepare(
        `UPDATE platform_oauth_refresh_token
         SET state = 'consumed', consumed_at = ?, updated_at = ?
         WHERE id = ? AND family_id = ? AND state = 'pending'
           AND consumption_nonce = ?`,
      )
      .bind(
        now,
        now,
        preparation.tokenId,
        preparation.familyId,
        preparation.nonce,
      ),
    database
      .prepare(
        `INSERT INTO platform_oauth_refresh_token
         (id, family_id, installation_id, provider_refresh_row_id,
          provider_refresh_token_hash, provider_access_row_id, predecessor_id,
          predecessor_consumption_nonce, sequence, resources, capabilities,
          expires_at, state, consumption_nonce, consumed_at, replayed_at,
          revoked_at, revoked_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', NULL, NULL,
                 NULL, NULL, NULL, ?, ?)`,
      )
      .bind(
        successorId,
        preparation.familyId,
        predecessor.installation_id,
        rows.refresh.id,
        rows.refresh.token,
        rows.access.id,
        preparation.tokenId,
        preparation.nonce,
        predecessor.sequence + 1,
        JSON.stringify(providerResources),
        JSON.stringify(effectiveCapabilities),
        successorExpiry,
        now,
        now,
      ),
    database
      .prepare(
        `INSERT INTO platform_credential
         (id, credential_hash, kind, subject_id, organization_id, membership_id,
          grant_id, audience, capabilities, resource_ids, expires_at, revoked_at,
          name, created_at, revoked_reason, replaced_by_id, predecessor_id,
          oauth_origin, oauth_installation_id, oauth_provider_row_id,
          oauth_provider_token_hash, oauth_refresh_token_id)
         VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, '[]', ?, NULL,
                 'OAuth personal harness', ?, NULL, NULL, NULL, 'better-auth',
                 ?, ?, ?, ?)`,
      )
      .bind(
        credentialId,
        await hashOpaque(returned.accessToken),
        predecessor.subject_id,
        predecessor.organization_id,
        predecessor.membership_id,
        predecessor.grant_id,
        predecessor.audience,
        JSON.stringify(effectiveCapabilities),
        successorExpiry,
        now,
        predecessor.installation_id,
        rows.access.id,
        rows.access.token,
        successorId,
      ),
    database
      .prepare(
        `UPDATE platform_credential
         SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = 'rotated',
             replaced_by_id = ?
         WHERE id = ? AND oauth_refresh_token_id = ? AND revoked_at IS NULL`,
      )
      .bind(
        now,
        credentialId,
        predecessor.old_credential_id ?? "",
        preparation.tokenId,
      ),
    database
      .prepare(
        `UPDATE oauthAccessToken SET sessionId = NULL
         WHERE id = ? AND token = ? AND referenceId = ?`,
      )
      .bind(rows.access.id, rows.access.token, predecessor.installation_id),
    database
      .prepare(
        `UPDATE oauthRefreshToken SET sessionId = NULL
         WHERE id = ? AND token = ? AND referenceId = ?`,
      )
      .bind(rows.refresh.id, rows.refresh.token, predecessor.installation_id),
    database
      .prepare(
        `UPDATE platform_oauth_refresh_family
         SET state = 'active', pending_token_id = NULL,
             pending_consumption_nonce = NULL, updated_at = ?
         WHERE id = ? AND state = 'pending'
           AND pending_token_id = ? AND pending_consumption_nonce = ?`,
      )
      .bind(now, preparation.familyId, preparation.tokenId, preparation.nonce),
  ];
  try {
    const results = await database.batch(batch);
    if (results.at(-1)?.meta.changes !== 1) {
      throw new Error("oauth refresh family publication assertion failed");
    }
  } catch {
    await revokeUnmappedProviderRows(database, rows).catch(() => undefined);
    await quarantineAfterFailure(
      database,
      preparation.familyId,
      "refresh_mapping_failed",
    );
    return jsonAuthorityUnavailable("refresh mapping was not durable");
  }
  if (
    !(await currentFamilyAuthority(database, preparation.familyId, successorId))
  ) {
    await quarantineAfterFailure(
      database,
      preparation.familyId,
      "refresh_authority_changed",
    );
    return jsonAuthorityUnavailable(
      "refresh authority changed before delivery",
    );
  }
  return response;
}

/**
 * Bind an explicit offline-access initial response.  Access-only T06 responses
 * continue through completeInitialOAuthAccess in oauth-installation.ts.
 */
export async function completeInitialOAuthRefresh(
  database: OAuthDatabase,
  response: Response,
): Promise<Response | undefined> {
  if (response.status !== 200) return;
  const returned = await parseReturnedTokens(response);
  if (!returned.refreshToken) return;
  if (!returned.accessToken)
    return noStoreError(
      "server_error",
      "OAuth token response was malformed",
      500,
    );
  const accessHash = await oauthProviderTokenHash(returned.accessToken);
  const refreshHash = await oauthProviderTokenHash(returned.refreshToken);
  const access = await database
    .prepare(
      `SELECT id, token, referenceId, clientId, userId, resources, scopes, refreshId,
              expiresAt, revoked, sessionId
       FROM oauthAccessToken WHERE token = ? LIMIT 1`,
    )
    .bind(accessHash)
    .first<ProviderAccessRow>();
  if (!access?.referenceId || !access.userId || !access.refreshId) {
    if (access)
      await database
        .prepare("UPDATE oauthAccessToken SET revoked = 1 WHERE id = ?")
        .bind(access.id)
        .run();
    return noStoreError("invalid_grant", "access token is not bound", 400);
  }
  const refresh = await database
    .prepare(
      `SELECT id, token, clientId, userId, referenceId, resources, scopes,
              expiresAt, revoked, sessionId
       FROM oauthRefreshToken WHERE id = ? AND token = ? LIMIT 1`,
    )
    .bind(access.refreshId, refreshHash)
    .first<ProviderRefreshRow>();
  if (!refresh) {
    await database
      .prepare("UPDATE oauthAccessToken SET revoked = 1 WHERE id = ?")
      .bind(access.id)
      .run();
    return noStoreError("invalid_grant", "refresh token is not bound", 400);
  }
  const context = await database
    .prepare(
      `SELECT i.id, i.client_id, i.user_id, i.membership_id, i.organization_id,
              i.service_id, i.audience, i.capabilities, i.subject_id, i.grant_id,
              i.active, i.revoked_at, i.expires_at,
              f.id AS flow_id, f.oauth_query, f.status AS flow_status,
              f.expires_at AS flow_expires_at, f.consumed_at,
              pc.redirect_uri, pc.refresh_enabled, pc.capabilities AS client_capabilities,
              oc.scopes AS registered_scopes,
              consent.resources AS consent_resources, consent.scopes AS consent_scopes,
              service.allowed_capabilities AS service_capabilities,
              member.id AS current_membership
       FROM platform_oauth_installation AS i
       JOIN platform_oauth_flow AS f ON f.installation_id = i.id
       JOIN platform_oauth_client AS pc ON pc.client_id = i.client_id
       JOIN oauthClient AS oc ON oc.clientId = i.client_id
       JOIN platform_service AS service ON service.service_id = i.service_id
        AND service.audience = i.audience
       JOIN member ON member.id = i.membership_id
        AND member.userId = i.user_id AND member.organizationId = i.organization_id
       JOIN "user" ON "user".id = i.user_id
       JOIN organization ON organization.id = i.organization_id
       JOIN oauthConsent AS consent ON consent.clientId = i.client_id
        AND consent.userId = i.user_id AND consent.referenceId = i.id
       WHERE i.id = ? LIMIT 1`,
    )
    .bind(access.referenceId)
    .first<{
      id: string;
      client_id: string;
      user_id: string;
      membership_id: string;
      organization_id: string;
      service_id: string;
      audience: string;
      capabilities: string;
      subject_id: string;
      grant_id: string;
      active: number;
      revoked_at: number | null;
      expires_at: number;
      flow_id: string;
      oauth_query: string;
      flow_status: string;
      flow_expires_at: number;
      consumed_at: number | null;
      redirect_uri: string;
      refresh_enabled: number;
      client_capabilities: string;
      registered_scopes: string | null;
      consent_resources: string | null;
      consent_scopes: string | null;
      service_capabilities: string;
      current_membership: string;
    }>();
  const binding = context ? parseOAuthQuery(context.oauth_query) : null;
  const installationCapabilities = capabilities(
    arrayValue(context?.capabilities ?? null),
  );
  const accessResources = arrayValue(access.resources);
  const accessScopes = protocolScopes(arrayValue(access.scopes));
  const refreshResources = arrayValue(refresh?.resources ?? null);
  const refreshScopes = protocolScopes(arrayValue(refresh?.scopes ?? null));
  const consentResources = arrayValue(context?.consent_resources ?? null);
  const consentScopes = protocolScopes(
    arrayValue(context?.consent_scopes ?? null),
  );
  const clientCapabilities = capabilities(
    arrayValue(context?.client_capabilities ?? null),
  );
  const registeredScopes = protocolScopes(
    arrayValue(context?.registered_scopes ?? null),
  );
  const serviceCapabilities = capabilities(
    arrayValue(context?.service_capabilities ?? null),
  );
  const requestedCapabilities =
    accessScopes?.filter((scope) => scope !== "offline_access") ?? null;
  if (
    !refresh ||
    !context ||
    !binding ||
    !installationCapabilities ||
    !accessResources ||
    accessResources.length !== 1 ||
    accessResources[0] !== context.audience ||
    !accessScopes?.includes("offline_access") ||
    !requestedCapabilities ||
    !subset(requestedCapabilities, installationCapabilities) ||
    !subset(requestedCapabilities, clientCapabilities ?? []) ||
    !subset(
      requestedCapabilities,
      registeredScopes?.filter((scope) => scope !== "offline_access") ?? [],
    ) ||
    !subset(requestedCapabilities, serviceCapabilities ?? []) ||
    !refreshResources ||
    refreshResources.length !== 1 ||
    refreshResources[0] !== context.audience ||
    !refreshScopes ||
    !consentResources?.includes(context.audience) ||
    !consentScopes ||
    !consentScopes.includes("offline_access") ||
    !clientCapabilities ||
    !registeredScopes ||
    !serviceCapabilities ||
    !context.refresh_enabled ||
    context.flow_status !== "consumed" ||
    context.active !== 0 ||
    context.revoked_at !== null ||
    context.expires_at <= Date.now() ||
    context.flow_expires_at <= Date.now() ||
    context.current_membership !== context.membership_id ||
    access.clientId !== context.client_id ||
    refresh.clientId !== context.client_id ||
    access.userId !== context.user_id ||
    refresh.userId !== context.user_id ||
    access.referenceId !== context.id ||
    refresh.referenceId !== context.id ||
    access.refreshId !== refresh.id ||
    access.revoked !== null ||
    refresh.revoked !== null ||
    access.expiresAt === null ||
    refresh.expiresAt === null ||
    binding.clientId !== context.client_id ||
    binding.redirectUri !== context.redirect_uri ||
    binding.resource !== context.audience ||
    !binding.scopes.includes("offline_access")
  ) {
    await database.batch([
      database
        .prepare("UPDATE oauthAccessToken SET revoked = 1 WHERE id = ?")
        .bind(access.id),
      database
        .prepare("UPDATE oauthRefreshToken SET revoked = 1 WHERE id = ?")
        .bind(refresh.id),
    ]);
    return noStoreError(
      "invalid_grant",
      "OAuth installation binding is no longer active",
      400,
    );
  }
  const familyId = crypto.randomUUID();
  const rootId = crypto.randomUUID();
  const rootNonce = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const epoch = context.consumed_at ?? now;
  const familyExpires = epoch + FAMILY_LIFETIME_MS;
  const rootExpires = Math.min(
    access.expiresAt,
    refresh.expiresAt,
    familyExpires,
  );
  const capabilitiesJson = JSON.stringify(requestedCapabilities);
  const resourcesJson = JSON.stringify([context.audience]);
  const initialStatements = [
    database
      .prepare(
        `INSERT INTO platform_oauth_refresh_family
         (id, installation_id, client_id, user_id, membership_id, organization_id,
          service_id, audience, subject_id, grant_id, capabilities,
          family_epoch_at, expires_at, state, pending_token_id,
          pending_consumption_nonce, revoked_at, revoked_reason, created_at, updated_at)
         SELECT ?, i.id, i.client_id, i.user_id, i.membership_id, i.organization_id,
                i.service_id, i.audience, i.subject_id, i.grant_id, i.capabilities,
                ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?
         FROM platform_oauth_installation AS i
         JOIN platform_oauth_flow AS f ON f.installation_id = i.id
         WHERE i.id = ? AND i.active = 0 AND i.revoked_at IS NULL
           AND f.id = ? AND f.status = 'consumed'
           AND f.expires_at > ? AND i.expires_at > ?`,
      )
      .bind(
        familyId,
        epoch,
        familyExpires,
        rootId,
        rootNonce,
        now,
        now,
        context.id,
        context.flow_id,
        now,
        now,
      ),
    database
      .prepare(
        `INSERT INTO platform_oauth_refresh_token
         (id, family_id, installation_id, provider_refresh_row_id,
          provider_refresh_token_hash, provider_access_row_id, predecessor_id,
          predecessor_consumption_nonce, sequence, resources, capabilities,
          expires_at, state, consumption_nonce, consumed_at, replayed_at,
          revoked_at, revoked_reason, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, 'pending', ?, NULL,
                NULL, NULL, NULL, ?, ?
         WHERE EXISTS (SELECT 1 FROM platform_oauth_refresh_family
                      WHERE id = ? AND state = 'pending'
                        AND pending_token_id = ? AND pending_consumption_nonce = ?)`,
      )
      .bind(
        rootId,
        familyId,
        context.id,
        refresh.id,
        refresh.token,
        access.id,
        resourcesJson,
        capabilitiesJson,
        rootExpires,
        rootNonce,
        now,
        now,
        familyId,
        rootId,
        rootNonce,
      ),
    database
      .prepare(
        `UPDATE platform_oauth_refresh_token SET state = 'issued', updated_at = ?
         WHERE id = ? AND family_id = ? AND state = 'pending'
           AND consumption_nonce = ?`,
      )
      .bind(now, rootId, familyId, rootNonce),
    database
      .prepare(
        `INSERT INTO platform_credential
         (id, credential_hash, kind, subject_id, organization_id, membership_id,
          grant_id, audience, capabilities, resource_ids, expires_at, revoked_at,
          name, created_at, revoked_reason, replaced_by_id, predecessor_id,
          oauth_origin, oauth_installation_id, oauth_provider_row_id,
          oauth_provider_token_hash, oauth_refresh_token_id)
         SELECT ?, ?, 'agent', i.subject_id, i.organization_id, i.membership_id,
                i.grant_id, i.audience, ?, '[]', ?, NULL,
                'OAuth personal harness', ?, NULL, NULL, NULL, 'better-auth',
                i.id, ?, ?, ?
         FROM platform_oauth_installation AS i
         JOIN platform_oauth_refresh_family AS f ON f.installation_id = i.id
          AND f.id = ? AND f.state = 'pending'
         JOIN platform_oauth_refresh_token AS t ON t.id = ?
          AND t.family_id = f.id AND t.state = 'issued'
         WHERE i.id = ? AND i.active = 0 AND i.revoked_at IS NULL`,
      )
      .bind(
        credentialId,
        await hashOpaque(returned.accessToken),
        capabilitiesJson,
        rootExpires,
        now,
        access.id,
        accessHash,
        rootId,
        familyId,
        rootId,
        context.id,
      ),
    database
      .prepare(
        `UPDATE oauthAccessToken SET sessionId = NULL
         WHERE id = ? AND token = ? AND referenceId = ?
           AND EXISTS (SELECT 1 FROM platform_credential
                       WHERE id = ? AND oauth_refresh_token_id = ?)`,
      )
      .bind(
        access.id,
        access.token ?? accessHash,
        context.id,
        credentialId,
        rootId,
      ),
    database
      .prepare(
        `UPDATE oauthRefreshToken SET sessionId = NULL
         WHERE id = ? AND token = ? AND referenceId = ?
           AND EXISTS (SELECT 1 FROM platform_credential
                       WHERE id = ? AND oauth_refresh_token_id = ?)`,
      )
      .bind(refresh.id, refresh.token, context.id, credentialId, rootId),
    database
      .prepare(
        `UPDATE platform_oauth_installation SET active = 1
         WHERE id = ? AND active = 0 AND revoked_at IS NULL
           AND EXISTS (SELECT 1 FROM platform_credential
                       WHERE id = ? AND oauth_refresh_token_id = ?)`,
      )
      .bind(context.id, credentialId, rootId),
    database
      .prepare(
        `UPDATE platform_oauth_flow SET status = 'activated'
         WHERE id = ? AND installation_id = ? AND status = 'consumed'
           AND EXISTS (SELECT 1 FROM platform_credential
                       WHERE id = ? AND oauth_refresh_token_id = ?)`,
      )
      .bind(context.flow_id, context.id, credentialId, rootId),
    database
      .prepare(
        `UPDATE platform_oauth_refresh_family
         SET state = 'active', pending_token_id = NULL,
             pending_consumption_nonce = NULL, updated_at = ?
         WHERE id = ? AND state = 'pending'
           AND pending_token_id = ? AND pending_consumption_nonce = ?`,
      )
      .bind(now, familyId, rootId, rootNonce),
  ];
  try {
    const results = await database.batch(initialStatements);
    if (results.at(-1)?.meta.changes !== 1) {
      throw new Error("oauth refresh root publication assertion failed");
    }
  } catch {
    await quarantineAfterFailure(
      database,
      familyId,
      "initial_refresh_mapping_failed",
    );
    await database
      .batch([
        database
          .prepare(
            "UPDATE oauthAccessToken SET revoked = COALESCE(revoked, ?) WHERE id = ?",
          )
          .bind(now, access.id),
        database
          .prepare(
            "UPDATE oauthRefreshToken SET revoked = COALESCE(revoked, ?) WHERE id = ?",
          )
          .bind(now, refresh.id),
      ])
      .catch(() => undefined);
    return jsonAuthorityUnavailable(
      "OAuth refresh installation was not durable",
    );
  }
  if (!(await currentFamilyAuthority(database, familyId, rootId))) {
    await quarantineAfterFailure(
      database,
      familyId,
      "initial_refresh_authority_changed",
    );
    return jsonAuthorityUnavailable(
      "OAuth refresh authority changed before delivery",
    );
  }
  return response;
}

export interface OAuthRefreshCredential {
  id: string;
  subject_id: string;
  organization_id: string;
  membership_id: string;
  grant_id: string;
  audience: string;
  capabilities: string;
  resource_ids: string;
  expires_at: number;
}

export async function findOAuthRefreshCredential(
  database: OAuthDatabase,
  credentialHash: string,
  service: { serviceId: string; audience: string; verifierHash: string },
): Promise<OAuthRefreshCredential | null> {
  const row = await database
    .prepare(
      `SELECT c.id, c.subject_id, c.organization_id, c.membership_id,
              c.grant_id, c.audience, c.capabilities, c.resource_ids,
              c.expires_at, t.capabilities AS token_capabilities
       FROM platform_credential AS c
       JOIN platform_oauth_refresh_token AS t ON t.id = c.oauth_refresh_token_id
        AND t.state = 'issued'
       JOIN platform_oauth_refresh_family AS f ON f.id = t.family_id
        AND f.state = 'active'
       JOIN platform_oauth_installation AS i ON i.id = c.oauth_installation_id
        AND i.active = 1 AND i.revoked_at IS NULL
        AND i.membership_id = c.membership_id
        AND i.organization_id = c.organization_id
        AND i.audience = c.audience
       JOIN oauthAccessToken AS access ON access.id = c.oauth_provider_row_id
        AND access.token = c.oauth_provider_token_hash
        AND access.refreshId = t.provider_refresh_row_id
        AND access.referenceId = i.id AND access.clientId = i.client_id
        AND access.userId = i.user_id AND access.revoked IS NULL
        AND access.expiresAt > ?
        AND json_array_length(json_extract(access.resources, '$')) = 1
        AND json_extract(json_extract(access.resources, '$'), '$[0]') = i.audience
       JOIN platform_oauth_client AS pc ON pc.client_id = i.client_id
        AND pc.service_id = i.service_id AND pc.active = 1
        AND pc.refresh_enabled = 1
       JOIN oauthClient AS oc ON oc.clientId = i.client_id AND oc.disabled = 0
        AND oc.grantTypes LIKE '%refresh_token%'
       JOIN oauthResource AS resource ON resource.identifier = i.audience
        AND resource.disabled = 0 AND resource.refreshTokenTtl IS NOT NULL
        AND resource.refreshTokenTtl > 0
       JOIN oauthRefreshToken AS refresh ON refresh.id = t.provider_refresh_row_id
        AND refresh.token = t.provider_refresh_token_hash
       AND refresh.clientId = i.client_id AND refresh.userId = i.user_id
        AND refresh.referenceId = i.id AND refresh.revoked IS NULL
        AND refresh.expiresAt > ?
       JOIN oauthConsent AS consent ON consent.clientId = i.client_id
        AND consent.userId = i.user_id AND consent.referenceId = i.id
        AND json_array_length(json_extract(consent.resources, '$')) = 1
        AND json_extract(json_extract(consent.resources, '$'), '$[0]') = i.audience
       JOIN member AS membership ON membership.id = i.membership_id
        AND membership.userId = i.user_id AND membership.organizationId = i.organization_id
       JOIN "user" AS subject_user ON subject_user.id = i.user_id
        AND subject_user.disabledAt IS NULL
       JOIN organization AS owning_org ON owning_org.id = i.organization_id
        AND owning_org.suspendedAt IS NULL
       JOIN platform_service AS registered_service ON registered_service.service_id = i.service_id
        AND registered_service.audience = i.audience
        AND registered_service.service_id = ?
        AND registered_service.audience = ?
       AND registered_service.verifier_hash = ?
        AND registered_service.disabled = 0
         WHERE c.credential_hash = ? AND c.oauth_origin = 'better-auth'
         AND c.oauth_refresh_token_id IS NOT NULL
         AND c.revoked_at IS NULL AND c.expires_at > ?
         AND c.subject_id = f.subject_id
         AND c.grant_id = f.grant_id
         AND c.organization_id = f.organization_id
         AND c.membership_id = f.membership_id
         AND c.audience = f.audience
         AND NOT EXISTS (
           SELECT 1 FROM json_each(c.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(t.capabilities) AS effective
              WHERE effective.value = requested.value
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(c.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(pc.capabilities) AS ceiling
             WHERE ceiling.value = requested.value
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(c.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(oc.scopes) AS registered
             WHERE registered.value = requested.value
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(c.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(json_extract(consent.scopes, '$')) AS consented
             WHERE consented.value = requested.value
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(c.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(json_extract(access.scopes, '$')) AS granted
             WHERE granted.value = requested.value
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(c.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(json_extract(refresh.scopes, '$')) AS granted
             WHERE granted.value = requested.value
           )
         )
         AND access.refreshId = refresh.id
         AND NOT EXISTS (
           SELECT 1 FROM json_each(c.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(registered_service.allowed_capabilities) AS catalog
             WHERE catalog.value = requested.value
           )
         )
       LIMIT 1`,
    )
    .bind(
      Date.now(),
      Date.now(),
      service.serviceId,
      service.audience,
      service.verifierHash,
      credentialHash,
      Date.now(),
    )
    .first<OAuthRefreshCredential>();
  return row ?? null;
}

export async function revokeOAuthInstallation(
  database: OAuthDatabase,
  installationId: string,
  reason: string,
): Promise<boolean> {
  const family = await database
    .prepare(
      "SELECT id FROM platform_oauth_refresh_family WHERE installation_id = ?",
    )
    .bind(installationId)
    .first<{ id: string }>();
  if (family) {
    await terminateRefreshFamily(database, family.id, reason);
  }
  const now = Date.now();
  const result = await database.batch([
    database
      .prepare(
        `UPDATE platform_oauth_installation
         SET active = 0, revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ?`,
      )
      .bind(now, installationId),
    database
      .prepare(
        `UPDATE platform_credential SET revoked_at = COALESCE(revoked_at, ?),
                revoked_reason = COALESCE(revoked_reason, ?)
         WHERE oauth_installation_id = ?`,
      )
      .bind(now, reason, installationId),
    database
      .prepare(
        `UPDATE oauthAccessToken SET revoked = COALESCE(revoked, ?)
         WHERE referenceId = ?`,
      )
      .bind(now, installationId),
    database
      .prepare(
        `UPDATE oauthRefreshToken SET revoked = COALESCE(revoked, ?)
         WHERE referenceId = ?`,
      )
      .bind(now, installationId),
    database
      .prepare(
        `UPDATE platform_oauth_flow SET status = 'rejected', consumed_at = COALESCE(consumed_at, ?)
         WHERE installation_id = ? AND status IN ('selected', 'consumed', 'activated')`,
      )
      .bind(now, installationId),
    database
      .prepare(`DELETE FROM oauthConsent WHERE referenceId = ?`)
      .bind(installationId),
  ]);
  return result.some((entry) => entry.meta.changes > 0);
}

export async function listOAuthInstallations(
  database: OAuthDatabase,
  userId: string,
  organizationId: string | null,
): Promise<Array<Record<string, unknown>>> {
  const rows = await database
    .prepare(
      `SELECT i.id, i.client_id, i.service_id, i.audience, i.capabilities,
              i.created_at, i.expires_at, i.active, i.revoked_at,
              i.organization_id, organization.name AS organization_name,
              c.name AS client_name, f.state AS family_state,
              f.expires_at AS family_expires_at
       FROM platform_oauth_installation AS i
       JOIN oauthClient AS c ON c.clientId = i.client_id
       JOIN organization ON organization.id = i.organization_id
       LEFT JOIN platform_oauth_refresh_family AS f ON f.installation_id = i.id
       WHERE (
         (? IS NULL AND i.user_id = ?)
         OR (
           ? IS NOT NULL AND i.organization_id = ?
           AND (
             i.user_id = ?
             OR EXISTS (
               SELECT 1 FROM member AS manager
               WHERE manager.organizationId = i.organization_id
                 AND manager.userId = ?
                 AND manager.role IN ('owner', 'admin')
                 AND organization.suspendedAt IS NULL
             )
           )
         )
       )
       ORDER BY i.created_at DESC, i.id DESC`,
    )
    .bind(
      organizationId,
      userId,
      organizationId,
      organizationId,
      userId,
      userId,
    )
    .all();
  return rows.results;
}
