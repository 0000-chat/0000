import { symmetricEncrypt } from "better-auth/crypto";
import { APIError } from "better-auth/api";
import {
  hashOpaque,
  opaqueSecret,
  parseStringArray,
  validCapabilities,
  validServiceAudience,
  validServiceId,
} from "./platform-state";
import type { PlatformOAuthPostLogin } from "./auth-schema";

type OAuthDatabase = Pick<D1Database, "prepare" | "batch">;

const SIGNED_QUERY_FIELDS = new Set([
  "sig",
  "exp",
  "ba_iat",
  "ba_pl",
  "ba_param",
]);
const MAX_QUERY_LENGTH = 16_384;

export type OAuthClientAuthMethod = "none" | "client_secret_post";

function validOAuthCapabilities(value: unknown): value is string[] {
  return validCapabilities(value) && !value.includes("offline_access");
}

export interface TrustedOAuthClientInput {
  serviceId: string;
  redirectUri: string;
  capabilities: string[];
  authMethod: OAuthClientAuthMethod;
  ownerUserId?: string | null;
  clientId?: string;
  name?: string;
}

export interface TrustedOAuthClient {
  clientId: string;
  clientSecret: string | null;
  serviceId: string;
  audience: string;
  redirectUri: string;
  capabilities: string[];
  authMethod: OAuthClientAuthMethod;
}

export interface OAuthClientRecord extends TrustedOAuthClient {
  ownerUserId: string | null;
  scopes: string[];
}

export interface OAuthQueryBinding {
  raw: string;
  semantic: string;
  state: string;
  expiresAt: number;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
}

export type OAuthFlowStatus =
  | "pending"
  | "selected"
  | "consumed"
  | "activated"
  | "rejected";

export interface OAuthFlow {
  id: string;
  query_hash: string;
  oauth_query: string;
  state: string;
  user_id: string;
  session_id: string;
  organization_id: string | null;
  membership_id: string | null;
  installation_id: string | null;
  status: OAuthFlowStatus;
  expires_at: number;
  created_at: number;
  consumed_at: number | null;
}

interface ProviderAccessRow {
  id: string;
  referenceId: string | null;
  clientId: string;
  userId: string | null;
  resources: string | null;
  scopes: string;
  refreshId: string | null;
  expiresAt: number | null;
  revoked: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonArray(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if (typeof value !== "string") return null;
  try {
    let parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function querySemantic(query: URLSearchParams): string {
  return [...query.entries()]
    .filter(([key]) => !SIGNED_QUERY_FIELDS.has(key))
    .sort(([keyA, valueA], [keyB, valueB]) => {
      if (keyA !== keyB) return keyA < keyB ? -1 : 1;
      if (valueA !== valueB) return valueA < valueB ? -1 : 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function parseOAuthQuery(raw: string): OAuthQueryBinding | null {
  if (!raw || raw.length > MAX_QUERY_LENGTH) return null;
  const query = new URLSearchParams(raw);
  const state = query.get("state");
  const signature = query.get("sig");
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  const resource = query.get("resource");
  const codeChallenge = query.get("code_challenge");
  const expiresRaw = query.get("exp");
  const expiresSeconds = expiresRaw === null ? NaN : Number(expiresRaw);
  const expiresAt = expiresSeconds * 1000;
  const scopes = (query.get("scope") ?? "").split(" ").filter(Boolean);
  if (
    !state ||
    !signature ||
    !clientId ||
    !redirectUri ||
    !resource ||
    !codeChallenge ||
    query.get("response_type") !== "code" ||
    query.get("code_challenge_method") !== "S256" ||
    !Number.isSafeInteger(expiresSeconds) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0 ||
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length
  ) {
    return null;
  }
  return {
    raw,
    semantic: querySemantic(query),
    state,
    expiresAt,
    clientId,
    redirectUri,
    resource,
    scopes,
    codeChallenge,
  };
}

export async function oauthProviderTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function validRedirectUri(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && url.hostname === "localhost")) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validClientId(value: string): boolean {
  return (
    value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export async function provisionTrustedOAuthClient(
  database: OAuthDatabase,
  secretKey: string,
  input: TrustedOAuthClientInput,
): Promise<TrustedOAuthClient> {
  if (!validServiceId(input.serviceId)) throw new Error("invalid_service_id");
  if (
    input.authMethod !== "none" &&
    input.authMethod !== "client_secret_post"
  ) {
    throw new Error("invalid_client_auth_method");
  }
  if (!secretKey) throw new Error("missing_better_auth_secret");
  if (!validRedirectUri(input.redirectUri)) {
    throw new Error("invalid_redirect_uri");
  }
  if (!validOAuthCapabilities(input.capabilities)) {
    throw new Error("invalid_capabilities");
  }
  const service = await database
    .prepare(
      `SELECT service_id, audience, allowed_capabilities
       FROM platform_service WHERE service_id = ? AND disabled = 0`,
    )
    .bind(input.serviceId)
    .first<{
      service_id: string;
      audience: string;
      allowed_capabilities: string;
    }>();
  if (!service || !validServiceAudience(service.audience)) {
    throw new Error("service_not_found");
  }
  const catalog = parseStringArray(service.allowed_capabilities);
  if (
    !catalog ||
    input.capabilities.some((capability) => !catalog.includes(capability))
  ) {
    throw new Error("capability_not_registered");
  }
  const clientId = input.clientId ?? `platform-oauth-${crypto.randomUUID()}`;
  if (!validClientId(clientId)) throw new Error("invalid_client_id");
  const now = Date.now();
  const clientSecret =
    input.authMethod === "client_secret_post"
      ? opaqueSecret("oauth_secret_")
      : null;
  const storedSecret = clientSecret
    ? await symmetricEncrypt({ key: secretKey, data: clientSecret })
    : null;
  const capabilities = JSON.stringify(input.capabilities);
  const resourceId = service.audience;
  const clientName = input.name?.trim() || `0000 ${input.serviceId}`;
  if (clientName.length > 120 || /[\u0000-\u001f\u007f]/.test(clientName)) {
    throw new Error("invalid_client_name");
  }
  await database.batch([
    database
      .prepare(
        `INSERT INTO oauthResource
         (id, identifier, name, accessTokenTtl, refreshTokenTtl,
          allowedScopes, disabled, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?) 
         ON CONFLICT(identifier) DO UPDATE SET
           allowedScopes = excluded.allowedScopes,
           disabled = 0,
           updatedAt = excluded.updatedAt`,
      )
      .bind(
        crypto.randomUUID(),
        resourceId,
        clientName,
        3600,
        capabilities,
        now,
        now,
      ),
    database
      .prepare(
        `INSERT INTO oauthClient
         (id, clientId, clientSecret, disabled, skipConsent, scopes,
          clientCredentialsScopes, userId, createdAt, updatedAt, name,
          redirectUris, grantTypes, responseTypes, tokenEndpointAuthMethod,
          applicationType, requirePKCE, dpopBoundAccessTokens)
         VALUES (?, ?, ?, 0, 0, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, 'web', 1, 0)`,
      )
      .bind(
        crypto.randomUUID(),
        clientId,
        storedSecret,
        capabilities,
        input.ownerUserId ?? null,
        now,
        now,
        clientName,
        JSON.stringify([input.redirectUri]),
        JSON.stringify(["authorization_code"]),
        JSON.stringify(["code"]),
        input.authMethod,
      ),
    database
      .prepare(
        `INSERT INTO oauthClientResource (id, clientId, resourceId, createdAt)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), clientId, resourceId, now),
    database
      .prepare(
        `INSERT INTO platform_oauth_client
         (client_id, service_id, owner_user_id, redirect_uri, capabilities,
          active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        clientId,
        input.serviceId,
        input.ownerUserId ?? null,
        input.redirectUri,
        capabilities,
        now,
        now,
      ),
  ]);
  return {
    clientId,
    clientSecret,
    serviceId: input.serviceId,
    audience: service.audience,
    redirectUri: input.redirectUri,
    capabilities: [...input.capabilities],
    authMethod: input.authMethod,
  };
}

export async function findOAuthClient(
  database: OAuthDatabase,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const row = await database
    .prepare(
      `SELECT p.client_id, p.service_id, p.owner_user_id, p.redirect_uri,
              p.capabilities, o.scopes, o.tokenEndpointAuthMethod,
              o.disabled AS client_disabled, s.audience, s.disabled AS service_disabled,
              r.disabled AS resource_disabled, cr.id AS resource_link
       FROM platform_oauth_client AS p
       JOIN oauthClient AS o ON o.clientId = p.client_id
       JOIN platform_service AS s ON s.service_id = p.service_id
       LEFT JOIN oauthResource AS r ON r.identifier = s.audience
       LEFT JOIN oauthClientResource AS cr
         ON cr.clientId = p.client_id AND cr.resourceId = s.audience
       WHERE p.client_id = ? AND p.active = 1 AND o.disabled = 0
         AND s.disabled = 0 AND r.disabled = 0 AND cr.id IS NOT NULL`,
    )
    .bind(clientId)
    .first<{
      client_id: string;
      service_id: string;
      owner_user_id: string | null;
      redirect_uri: string;
      capabilities: string;
      scopes: string | null;
      tokenEndpointAuthMethod: OAuthClientAuthMethod | null;
      client_disabled: number | null;
      audience: string;
      service_disabled: number;
      resource_disabled: number | null;
      resource_link: string;
    }>();
  if (!row) return null;
  const capabilities = parseStringArray(row.capabilities);
  const scopes = parseStringArray(row.scopes ?? "[]");
  if (
    !capabilities ||
    !validOAuthCapabilities(capabilities) ||
    !scopes ||
    !validOAuthCapabilities(scopes)
  ) {
    return null;
  }
  if (
    row.tokenEndpointAuthMethod !== "none" &&
    row.tokenEndpointAuthMethod !== "client_secret_post"
  ) {
    return null;
  }
  return {
    clientId: row.client_id,
    clientSecret: null,
    serviceId: row.service_id,
    audience: row.audience,
    redirectUri: row.redirect_uri,
    capabilities,
    authMethod: row.tokenEndpointAuthMethod,
    ownerUserId: row.owner_user_id,
    scopes,
  };
}

export function validateOAuthQuery(
  binding: OAuthQueryBinding,
  client: OAuthClientRecord,
): boolean {
  return (
    binding.clientId === client.clientId &&
    binding.redirectUri === client.redirectUri &&
    binding.resource === client.audience &&
    binding.scopes.every(
      (scope) =>
        client.capabilities.includes(scope) && client.scopes.includes(scope),
    ) &&
    binding.scopes.length > 0
  );
}

function flowFromRow(row: OAuthFlow): OAuthFlow {
  return row;
}

export async function loadOAuthFlow(
  database: OAuthDatabase,
  flowId: string,
): Promise<OAuthFlow | null> {
  const row = await database
    .prepare(
      `SELECT id, query_hash, oauth_query, state, user_id, session_id,
              organization_id, membership_id, installation_id, status,
              expires_at, created_at, consumed_at
       FROM platform_oauth_flow WHERE id = ?`,
    )
    .bind(flowId)
    .first<OAuthFlow>();
  return row ? flowFromRow(row) : null;
}

export async function findOAuthFlowForQuery(
  database: OAuthDatabase,
  rawQuery: string,
  userId: string,
  sessionId: string,
): Promise<OAuthFlow | null> {
  const binding = parseOAuthQuery(rawQuery);
  if (!binding) return null;
  const rows = await database
    .prepare(
      `SELECT id, query_hash, oauth_query, state, user_id, session_id,
              organization_id, membership_id, installation_id, status,
              expires_at, created_at, consumed_at
       FROM platform_oauth_flow
       WHERE state = ? AND user_id = ? AND session_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(binding.state, userId, sessionId)
    .all<OAuthFlow>();
  return (
    rows.results.find((row) => {
      const candidate = parseOAuthQuery(row.oauth_query);
      return candidate?.semantic === binding.semantic;
    }) ?? null
  );
}

export async function beginOAuthFlow(
  database: OAuthDatabase,
  rawQuery: string,
  current: { userId: string; sessionId: string },
): Promise<{ status: number; flow: OAuthFlow | null; error?: string }> {
  const binding = parseOAuthQuery(rawQuery);
  if (!binding)
    return { status: 400, flow: null, error: "invalid_oauth_query" };
  if (binding.expiresAt <= Date.now()) {
    return { status: 400, flow: null, error: "expired_oauth_query" };
  }
  const client = await findOAuthClient(database, binding.clientId);
  if (!client || !validateOAuthQuery(binding, client)) {
    return { status: 400, flow: null, error: "oauth_request_not_registered" };
  }
  const queryHash = await hashOpaque(rawQuery);
  const existing = await database
    .prepare(
      `SELECT id, query_hash, oauth_query, state, user_id, session_id,
              organization_id, membership_id, installation_id, status,
              expires_at, created_at, consumed_at
       FROM platform_oauth_flow WHERE query_hash = ?`,
    )
    .bind(queryHash)
    .first<OAuthFlow>();
  if (existing) {
    if (
      existing.user_id !== current.userId ||
      existing.session_id !== current.sessionId
    ) {
      return { status: 403, flow: null, error: "oauth_flow_forbidden" };
    }
    if (existing.status !== "pending") {
      return { status: 409, flow: existing, error: "oauth_flow_used" };
    }
    return { status: 200, flow: existing };
  }
  const now = Date.now();
  const flowId = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO platform_oauth_flow
       (id, query_hash, oauth_query, state, user_id, session_id,
        organization_id, membership_id, installation_id, status,
        expires_at, created_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', ?, ?, NULL)`,
    )
    .bind(
      flowId,
      queryHash,
      rawQuery,
      binding.state,
      current.userId,
      current.sessionId,
      binding.expiresAt,
      now,
    )
    .run();
  const flow = await loadOAuthFlow(database, flowId);
  return { status: 201, flow };
}

export async function selectOAuthFlow(
  database: OAuthDatabase,
  input: {
    flowId: string;
    organizationId: string;
    userId: string;
    sessionId: string;
  },
): Promise<{ status: number; flow: OAuthFlow | null; error?: string }> {
  const flow = await loadOAuthFlow(database, input.flowId);
  if (
    !flow ||
    flow.user_id !== input.userId ||
    flow.session_id !== input.sessionId
  ) {
    return { status: 403, flow: null, error: "oauth_flow_forbidden" };
  }
  if (flow.status !== "pending") {
    return { status: 409, flow, error: "oauth_flow_used" };
  }
  if (flow.expires_at <= Date.now()) {
    await database
      .prepare(
        `UPDATE platform_oauth_flow SET status = 'rejected'
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(flow.id)
      .run();
    return { status: 400, flow: null, error: "expired_oauth_flow" };
  }
  const binding = parseOAuthQuery(flow.oauth_query);
  const client = binding
    ? await findOAuthClient(database, binding.clientId)
    : null;
  if (!binding || !client || !validateOAuthQuery(binding, client)) {
    return { status: 400, flow: null, error: "oauth_request_not_registered" };
  }
  const currentMembership = await database
    .prepare(
      `SELECT member.id
       FROM member JOIN organization ON organization.id = member.organizationId
       JOIN "user" ON "user".id = member.userId
       WHERE member.organizationId = ? AND member.userId = ?
         AND organization.suspendedAt IS NULL AND "user".disabledAt IS NULL`,
    )
    .bind(input.organizationId, input.userId)
    .first<{ id: string }>();
  if (!currentMembership) {
    return { status: 403, flow: null, error: "organization_forbidden" };
  }
  const installationId = crypto.randomUUID();
  const subjectId = `oauth-subject-${crypto.randomUUID()}`;
  const grantId = `oauth-grant-${crypto.randomUUID()}`;
  const now = Date.now();
  const installation = database
    .prepare(
      `INSERT INTO platform_oauth_installation
       (id, client_id, user_id, membership_id, organization_id, service_id,
        audience, capabilities, subject_id, grant_id, active, revoked_at,
        created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM "user" WHERE id = ? AND disabledAt IS NULL
       ) AND EXISTS (
         SELECT 1 FROM member
         JOIN organization ON organization.id = member.organizationId
         WHERE member.id = ? AND member.organizationId = ?
           AND member.userId = ? AND organization.suspendedAt IS NULL
       ) AND EXISTS (
         SELECT 1 FROM platform_oauth_client
         WHERE client_id = ? AND service_id = ? AND active = 1
       ) AND EXISTS (
         SELECT 1 FROM platform_service
         WHERE service_id = ? AND audience = ? AND disabled = 0
       )`,
    )
    .bind(
      installationId,
      client.clientId,
      input.userId,
      currentMembership.id,
      input.organizationId,
      client.serviceId,
      client.audience,
      JSON.stringify(binding.scopes),
      subjectId,
      grantId,
      now,
      binding.expiresAt,
      input.userId,
      currentMembership.id,
      input.organizationId,
      input.userId,
      client.clientId,
      client.serviceId,
      client.serviceId,
      client.audience,
    );
  const updated = await database
    .prepare(
      `UPDATE platform_oauth_flow
       SET organization_id = ?, membership_id = ?, installation_id = ?,
           status = 'selected'
       WHERE id = ? AND status = 'pending' AND user_id = ? AND session_id = ?
         AND expires_at > ?`,
    )
    .bind(
      input.organizationId,
      currentMembership.id,
      installationId,
      flow.id,
      input.userId,
      input.sessionId,
      now,
    );
  const results = await database.batch([installation, updated]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    await database
      .prepare(
        "DELETE FROM platform_oauth_installation WHERE id = ? AND active = 0",
      )
      .bind(installationId)
      .run();
    return { status: 409, flow: null, error: "oauth_flow_race" };
  }
  return { status: 200, flow: await loadOAuthFlow(database, flow.id) };
}

export async function ownedOAuthFlow(
  database: OAuthDatabase,
  flowId: string | null,
  current: { userId: string; sessionId: string } | null,
  statuses: OAuthFlowStatus | OAuthFlowStatus[],
): Promise<OAuthFlow | null> {
  if (!flowId || !current) return null;
  const flow = await loadOAuthFlow(database, flowId);
  if (!flow) return null;
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (
    !allowed.includes(flow.status) ||
    flow.user_id !== current.userId ||
    flow.session_id !== current.sessionId ||
    flow.expires_at <= Date.now() ||
    !flow.organization_id ||
    !flow.membership_id ||
    !flow.installation_id
  ) {
    return null;
  }
  const currentMembership = await database
    .prepare(
      `SELECT member.id FROM member
       JOIN organization ON organization.id = member.organizationId
       JOIN "user" ON "user".id = member.userId
       WHERE member.id = ? AND member.organizationId = ? AND member.userId = ?
         AND organization.suspendedAt IS NULL AND "user".disabledAt IS NULL`,
    )
    .bind(flow.membership_id, flow.organization_id, flow.user_id)
    .first<{ id: string }>();
  return currentMembership ? flow : null;
}

export function oauthPostLoginHooks(
  database: OAuthDatabase,
  flowId: string | null,
): PlatformOAuthPostLogin {
  return {
    page: "/oauth2/selection",
    shouldRedirect: async ({ user, session }) => {
      const flow = await ownedOAuthFlow(
        database,
        flowId,
        { userId: user.id, sessionId: session.id },
        "selected",
      );
      return flow === null;
    },
    consentReferenceId: async ({ user, session }) => {
      const flow = await ownedOAuthFlow(
        database,
        flowId,
        { userId: user.id, sessionId: session.id },
        "selected",
      );
      if (!flow?.installation_id) {
        throw new APIError("BAD_REQUEST", {
          error: "invalid_request",
          error_description: "owned OAuth flow is no longer valid",
        });
      }
      const installation = await database
        .prepare(
          `SELECT installation.id FROM platform_oauth_installation AS installation
           JOIN platform_oauth_client AS oauth_client
             ON oauth_client.client_id = installation.client_id
            AND oauth_client.service_id = installation.service_id
            AND oauth_client.active = 1
           JOIN oauthClient AS registered_client
             ON registered_client.clientId = installation.client_id
            AND registered_client.disabled = 0
           JOIN platform_service AS service
             ON service.service_id = installation.service_id
            AND service.audience = installation.audience
            AND service.disabled = 0
           WHERE installation.id = ? AND installation.user_id = ? AND installation.membership_id = ?
             AND installation.organization_id = ? AND installation.active = 0
             AND installation.revoked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM json_each(installation.capabilities) AS requested
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(service.allowed_capabilities) AS catalog
                 WHERE catalog.value = requested.value
               )
             )`,
        )
        .bind(
          flow.installation_id,
          user.id,
          flow.membership_id,
          flow.organization_id,
        )
        .first<{ id: string }>();
      if (!installation) {
        throw new APIError("BAD_REQUEST", {
          error: "invalid_request",
          error_description: "OAuth installation is no longer pending",
        });
      }
      return installation.id;
    },
  };
}

export async function completeOAuthConsent(
  database: OAuthDatabase,
  flow: OAuthFlow,
  response: Response,
): Promise<void> {
  if (response.status !== 200) return;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  if (
    !isObject(body) ||
    (typeof body.redirect_uri !== "string" && typeof body.url !== "string")
  ) {
    return;
  }
  const redirect =
    typeof body.redirect_uri === "string"
      ? body.redirect_uri
      : typeof body.url === "string"
        ? body.url
        : null;
  const denied = redirect
    ? (() => {
        try {
          return (
            new URL(redirect).searchParams.get("error") === "access_denied"
          );
        } catch {
          return false;
        }
      })()
    : false;
  await database
    .prepare(
      `UPDATE platform_oauth_flow SET status = ?, consumed_at = ?
       WHERE id = ? AND status = 'selected' AND expires_at > ?`,
    )
    .bind(denied ? "rejected" : "consumed", Date.now(), flow.id, Date.now())
    .run();
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

async function revokeProviderAccess(
  database: OAuthDatabase,
  accessHash: string,
): Promise<void> {
  await database
    .prepare("UPDATE oauthAccessToken SET revoked = 1 WHERE token = ?")
    .bind(accessHash)
    .run();
}

function providerResponseAccessToken(response: Response): Promise<{
  token: string | null;
  refreshToken: string | null;
}> {
  return response
    .clone()
    .json()
    .then((body: unknown) => {
      if (!isObject(body)) return { token: null, refreshToken: null };
      return {
        token:
          typeof body.access_token === "string" && body.access_token
            ? body.access_token
            : null,
        refreshToken:
          typeof body.refresh_token === "string" && body.refresh_token
            ? body.refresh_token
            : null,
      };
    })
    .catch(() => ({ token: null, refreshToken: null }));
}

export async function completeInitialOAuthAccess(
  database: OAuthDatabase,
  response: Response,
): Promise<Response | undefined> {
  if (response.status !== 200) return;
  const returned = await providerResponseAccessToken(response);
  if (!returned.token) {
    return noStoreError(
      "server_error",
      "OAuth token response was malformed",
      500,
    );
  }
  const accessHash = await oauthProviderTokenHash(returned.token);
  if (returned.refreshToken) {
    await revokeProviderAccess(database, accessHash);
    return noStoreError(
      "server_error",
      "authorization-code configuration unexpectedly issued a refresh token",
      500,
    );
  }
  const access = await database
    .prepare(
      `SELECT id, referenceId, clientId, userId, resources, scopes, refreshId, expiresAt, revoked
       FROM oauthAccessToken WHERE token = ?`,
    )
    .bind(accessHash)
    .first<ProviderAccessRow>();
  const installationId = access?.referenceId;
  if (
    !access ||
    !installationId ||
    !access.userId ||
    access.revoked !== null ||
    access.refreshId !== null
  ) {
    if (access) await revokeProviderAccess(database, accessHash);
    return noStoreError("invalid_grant", "access token is not bound", 400);
  }
  let resources = jsonArray(access.resources ?? "[]");
  const scopes = jsonArray(access.scopes);
  if (
    !resources ||
    !scopes ||
    !validOAuthCapabilities(scopes) ||
    !access.expiresAt
  ) {
    await revokeProviderAccess(database, accessHash);
    return noStoreError("server_error", "issued OAuth row is malformed", 500);
  }
  const flow = await database
    .prepare(
      `SELECT id, query_hash, oauth_query, state, user_id, session_id,
              organization_id, membership_id, installation_id, status,
              expires_at, created_at, consumed_at
       FROM platform_oauth_flow WHERE installation_id = ?`,
    )
    .bind(installationId)
    .first<OAuthFlow>();
  const installation = await database
    .prepare(
      `SELECT id, client_id, user_id, membership_id, organization_id,
              service_id, audience, capabilities, subject_id, grant_id,
              active, revoked_at, expires_at
       FROM platform_oauth_installation WHERE id = ?`,
    )
    .bind(installationId)
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
    }>();
  const binding = flow ? parseOAuthQuery(flow.oauth_query) : null;
  const installationCapabilities = installation
    ? parseStringArray(installation.capabilities)
    : null;
  const current = installation
    ? await database
        .prepare(
          `SELECT member.id, pc.redirect_uri,
                  pc.capabilities AS client_capabilities,
                  oc.scopes AS registered_scopes,
                  consent.resources AS consent_resources,
                  consent.scopes AS consent_scopes
           FROM member JOIN organization ON organization.id = member.organizationId
           JOIN "user" ON "user".id = member.userId
           JOIN platform_oauth_client AS pc ON pc.client_id = ?
            AND pc.service_id = ? AND pc.active = 1
           JOIN oauthClient AS oc ON oc.clientId = pc.client_id AND oc.disabled = 0
           JOIN platform_service AS service ON service.service_id = pc.service_id
           JOIN oauthConsent AS consent
             ON consent.clientId = pc.client_id
            AND consent.userId = ? AND consent.referenceId = ?
           WHERE member.id = ? AND member.userId = ?
             AND member.organizationId = ? AND organization.suspendedAt IS NULL
             AND "user".disabledAt IS NULL AND service.disabled = 0
             AND service.audience = ? AND pc.service_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?) AS requested
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(service.allowed_capabilities) AS catalog
                 WHERE catalog.value = requested.value
               )
             )`,
        )
        .bind(
          installation.client_id,
          installation.service_id,
          installation.user_id,
          installation.id,
          installation.membership_id,
          installation.user_id,
          installation.organization_id,
          installation.audience,
          installation.service_id,
          installation.capabilities,
        )
        .first<{
          id: string;
          redirect_uri: string;
          client_capabilities: string;
          registered_scopes: string;
          consent_resources: string | null;
          consent_scopes: string;
        }>()
    : null;
  const currentClientCapabilities = current
    ? parseStringArray(current.client_capabilities)
    : null;
  const currentRegisteredScopes = current
    ? parseStringArray(current.registered_scopes)
    : null;
  const currentConsentResources = current
    ? jsonArray(current.consent_resources)
    : null;
  const currentConsentScopes = current
    ? jsonArray(current.consent_scopes)
    : null;
  if (
    !installation ||
    !flow ||
    !binding ||
    flow.status !== "consumed" ||
    flow.user_id !== access.userId ||
    flow.installation_id !== installation.id ||
    access.clientId !== installation.client_id ||
    access.referenceId !== installation.id ||
    !current ||
    current.redirect_uri !== binding.redirectUri ||
    binding.clientId !== installation.client_id ||
    binding.resource !== installation.audience ||
    installation.active !== 0 ||
    installation.revoked_at !== null ||
    installation.expires_at <= Date.now() ||
    access.expiresAt <= Date.now() ||
    !installationCapabilities ||
    !validOAuthCapabilities(installationCapabilities) ||
    !validOAuthCapabilities(scopes) ||
    !currentClientCapabilities ||
    !currentRegisteredScopes ||
    !currentConsentResources ||
    !currentConsentScopes ||
    !validOAuthCapabilities(currentClientCapabilities) ||
    !validOAuthCapabilities(currentRegisteredScopes) ||
    !validOAuthCapabilities(currentConsentScopes) ||
    resources.length !== 1 ||
    resources[0] !== installation.audience ||
    !currentConsentResources.includes(installation.audience) ||
    scopes.length !== installationCapabilities.length ||
    scopes.some(
      (scope) =>
        !installationCapabilities.includes(scope) ||
        !binding.scopes.includes(scope) ||
        !currentClientCapabilities.includes(scope) ||
        !currentRegisteredScopes.includes(scope) ||
        !currentConsentScopes.includes(scope),
    ) ||
    binding.scopes.length !== installationCapabilities.length ||
    binding.scopes.some((scope) => !installationCapabilities.includes(scope))
  ) {
    await revokeProviderAccess(database, accessHash);
    return noStoreError(
      "invalid_grant",
      "OAuth consent flow is no longer active",
      400,
    );
  }
  const now = Date.now();
  // The provider's opaque access value is the credential presented to shared
  // services. Store its Platform hash separately from the provider hash.
  const credential = returned.token;
  const credentialId = crypto.randomUUID();
  const insert = database
    .prepare(
      `INSERT INTO platform_credential
       (id, credential_hash, kind, subject_id, organization_id, membership_id,
        grant_id, audience, capabilities, resource_ids, expires_at, revoked_at,
        name, created_at, revoked_reason, replaced_by_id, predecessor_id,
        oauth_origin, oauth_installation_id, oauth_provider_row_id,
        oauth_provider_token_hash)
       SELECT ?, ?, 'agent', i.subject_id, i.organization_id, i.membership_id,
              i.grant_id, i.audience, i.capabilities, '[]', a.expiresAt, NULL,
              'OAuth personal harness', ?, NULL, NULL, NULL, 'better-auth',
              i.id, a.id, ?
       FROM platform_oauth_installation AS i
       JOIN oauthAccessToken AS a ON a.id = ? AND a.token = ?
       JOIN platform_oauth_client AS pc
         ON pc.client_id = i.client_id AND pc.service_id = i.service_id
        AND pc.active = 1
       JOIN oauthClient AS oc ON oc.clientId = i.client_id AND oc.disabled = 0
       JOIN platform_service AS service
         ON service.service_id = i.service_id AND service.audience = i.audience
        AND service.disabled = 0
       JOIN oauthConsent AS consent
         ON consent.clientId = i.client_id AND consent.userId = i.user_id
        AND consent.referenceId = i.id
       WHERE i.id = ? AND i.active = 0 AND i.revoked_at IS NULL
         AND a.referenceId = i.id AND a.clientId = i.client_id
         AND a.userId = i.user_id AND a.revoked IS NULL
         AND a.refreshId IS NULL
         AND a.expiresAt > ?
         AND i.expires_at > ?
         AND EXISTS (SELECT 1 FROM member WHERE id = i.membership_id
           AND userId = i.user_id AND organizationId = i.organization_id)
         AND EXISTS (
           SELECT 1 FROM platform_oauth_flow
           WHERE id = ? AND installation_id = i.id AND status = 'consumed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(i.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(service.allowed_capabilities) AS catalog
             WHERE catalog.value = requested.value
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(i.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(json_extract(a.scopes, '$')) AS granted
             WHERE granted.value = requested.value
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(i.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(json_extract(consent.scopes, '$')) AS granted
             WHERE granted.value = requested.value
           )
         )
         AND EXISTS (
           SELECT 1 FROM json_each(json_extract(a.resources, '$')) AS resource
           WHERE resource.value = i.audience
         )
         AND EXISTS (
           SELECT 1 FROM json_each(json_extract(consent.resources, '$')) AS resource
           WHERE resource.value = i.audience
         )
         AND NOT EXISTS (SELECT 1 FROM platform_credential
           WHERE oauth_provider_row_id = a.id)`,
    )
    .bind(
      credentialId,
      await hashOpaque(credential),
      now,
      accessHash,
      access.id,
      accessHash,
      installation.id,
      now,
      now,
      flow.id,
    );
  const results = await database.batch([
    insert,
    database
      .prepare(
        `UPDATE oauthAccessToken SET sessionId = NULL
         WHERE id = ? AND token = ? AND referenceId = ?`,
      )
      .bind(access.id, accessHash, installation.id),
    database
      .prepare(
        `UPDATE platform_oauth_installation SET active = 1
         WHERE id = ? AND active = 0 AND revoked_at IS NULL`,
      )
      .bind(installation.id),
    database
      .prepare(
        `UPDATE platform_oauth_flow SET status = 'activated'
         WHERE id = ? AND status = 'consumed'`,
      )
      .bind(flow.id),
  ]);
  if (results[0]?.meta.changes !== 1) {
    await revokeProviderAccess(database, accessHash);
    return noStoreError(
      "invalid_grant",
      "OAuth access binding was not durable",
      400,
    );
  }
  const durable = await database
    .prepare(
      `SELECT c.id AS credential_id, i.active, f.status, a.sessionId
       FROM platform_credential AS c
       JOIN platform_oauth_installation AS i ON i.id = c.oauth_installation_id
       JOIN platform_oauth_flow AS f ON f.id = ?
       JOIN oauthAccessToken AS a ON a.id = c.oauth_provider_row_id
       WHERE c.id = ? AND c.oauth_provider_token_hash = ?`,
    )
    .bind(flow.id, credentialId, accessHash)
    .first<{
      credential_id: string;
      active: number;
      status: string;
      sessionId: string | null;
    }>();
  if (!durable || durable.active !== 1 || durable.status !== "activated") {
    await revokeProviderAccess(database, accessHash);
    return noStoreError("server_error", "OAuth authority was not durable", 500);
  }
  return;
}

export async function oauthTokenIsCurrentlyAuthorized(
  database: OAuthDatabase,
  token: string,
): Promise<boolean> {
  const hash = await oauthProviderTokenHash(token);
  const row = await database
    .prepare(
      `SELECT c.id, i.audience AS audience,
              i.capabilities AS installation_capabilities,
              a.resources AS provider_resources, a.scopes AS provider_scopes,
              consent.resources AS consent_resources, consent.scopes AS consent_scopes,
              pc.capabilities AS client_capabilities, oc.scopes AS registered_scopes,
              service.allowed_capabilities AS service_capabilities
       FROM platform_credential AS c
       JOIN platform_oauth_installation AS i
         ON i.id = c.oauth_installation_id AND i.active = 1
       JOIN oauthAccessToken AS a
         ON a.id = c.oauth_provider_row_id AND a.token = c.oauth_provider_token_hash
        AND a.refreshId IS NULL
       JOIN platform_oauth_client AS pc
         ON pc.client_id = i.client_id AND pc.active = 1
       JOIN oauthClient AS oc ON oc.clientId = i.client_id AND oc.disabled = 0
       JOIN member AS m ON m.id = i.membership_id
         AND m.userId = i.user_id AND m.organizationId = i.organization_id
       JOIN "user" AS u ON u.id = i.user_id AND u.disabledAt IS NULL
       JOIN organization AS org ON org.id = i.organization_id
         AND org.suspendedAt IS NULL
       JOIN platform_service AS service ON service.service_id = i.service_id
         AND service.audience = i.audience AND service.disabled = 0
       JOIN oauthConsent AS consent ON consent.clientId = i.client_id
         AND consent.userId = i.user_id AND consent.referenceId = i.id
       WHERE c.credential_hash = ? AND c.oauth_origin = 'better-auth'
         AND a.token = ?
         AND NOT EXISTS (
           SELECT 1 FROM json_each(c.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(service.allowed_capabilities) AS catalog
             WHERE catalog.value = requested.value
           )
         )
         AND c.revoked_at IS NULL AND c.expires_at > ?
         AND a.revoked IS NULL AND a.expiresAt > ?`,
    )
    .bind(await hashOpaque(token), hash, Date.now(), Date.now())
    .first<{
      id: string;
      audience: string;
      installation_capabilities: string;
      provider_resources: string | null;
      provider_scopes: string;
      consent_resources: string | null;
      consent_scopes: string;
      client_capabilities: string;
      registered_scopes: string;
      service_capabilities: string;
    }>();
  if (!row) return false;
  const installationCapabilities = jsonArray(row.installation_capabilities);
  const providerResources = jsonArray(row.provider_resources);
  const providerScopes = jsonArray(row.provider_scopes);
  const consentResources = jsonArray(row.consent_resources);
  const consentScopes = jsonArray(row.consent_scopes);
  const clientCapabilities = jsonArray(row.client_capabilities);
  const registeredScopes = jsonArray(row.registered_scopes);
  const serviceCapabilities = jsonArray(row.service_capabilities);
  if (
    !installationCapabilities ||
    !providerResources ||
    !providerScopes ||
    !consentResources ||
    !consentScopes ||
    !clientCapabilities ||
    !registeredScopes ||
    !serviceCapabilities ||
    !validOAuthCapabilities(installationCapabilities) ||
    !validOAuthCapabilities(providerScopes) ||
    !validOAuthCapabilities(consentScopes) ||
    !validOAuthCapabilities(clientCapabilities) ||
    !validOAuthCapabilities(registeredScopes) ||
    !validOAuthCapabilities(serviceCapabilities)
  ) {
    return false;
  }
  return (
    providerResources.includes(row.audience) &&
    consentResources.includes(row.audience) &&
    installationCapabilities.every(
      (capability) =>
        serviceCapabilities.includes(capability) &&
        clientCapabilities.includes(capability) &&
        registeredScopes.includes(capability) &&
        providerScopes.includes(capability) &&
        consentScopes.includes(capability),
    )
  );
}

export async function oauthIntrospectionResponse(
  database: OAuthDatabase,
  request: Request,
  response: Response,
): Promise<Response> {
  if (response.status !== 200) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!isObject(body) || body.active !== true) return response;
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return noStoreError(
      "server_error",
      "introspection request was malformed",
      500,
    );
  }
  const token = form.get("token");
  if (
    typeof token !== "string" ||
    !(await oauthTokenIsCurrentlyAuthorized(database, token))
  ) {
    return Response.json(
      { active: false },
      { headers: { "cache-control": "no-store" } },
    );
  }
  return response;
}

export async function oauthMetadata(
  database: OAuthDatabase,
  issuer: string,
): Promise<Record<string, unknown>> {
  const rows = await database
    .prepare(
      `SELECT allowed_capabilities FROM platform_service WHERE disabled = 0
       ORDER BY service_id`,
    )
    .all<{ allowed_capabilities: string }>();
  const scopes = new Set<string>();
  for (const row of rows.results) {
    const capabilities = parseStringArray(row.allowed_capabilities) ?? [];
    for (const capability of capabilities) {
      if (capability !== "offline_access") scopes.add(capability);
    }
  }
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth2/token`,
    introspection_endpoint: `${issuer}/api/auth/oauth2/introspect`,
    introspection_endpoint_auth_methods_supported: ["client_secret_post"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...scopes].sort(),
  };
}
