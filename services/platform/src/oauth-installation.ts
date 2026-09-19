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
export type OAuthClientPurpose = "personal_harness" | "first_party_browser";

function validOAuthClientPurpose(value: unknown): value is OAuthClientPurpose {
  return value === "personal_harness" || value === "first_party_browser";
}

function validOAuthCapabilities(value: unknown): value is string[] {
  return validCapabilities(value) && !value.includes("offline_access");
}

export function validOAuthScopes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        (entry === "offline_access" || validCapabilities([entry])),
    )
  );
}

function oauthCapabilitiesFromScopes(scopes: string[]): string[] {
  return scopes.filter((scope) => scope !== "offline_access");
}

export interface TrustedOAuthClientInput {
  serviceId: string;
  redirectUri: string;
  capabilities: string[];
  authMethod: OAuthClientAuthMethod;
  purpose?: OAuthClientPurpose;
  ownerUserId?: string | null;
  clientId?: string;
  name?: string;
  refreshEnabled?: boolean;
}

export interface TrustedOAuthClient {
  clientId: string;
  clientSecret: string | null;
  serviceId: string;
  audience: string;
  redirectUri: string;
  capabilities: string[];
  authMethod: OAuthClientAuthMethod;
  purpose: OAuthClientPurpose;
  refreshEnabled: boolean;
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
  purpose: OAuthClientPurpose;
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

export function validOAuthClientRedirectUri(value: string): boolean {
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
  validateTrustedOAuthClientInput(input, secretKey);
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
  if (!catalog) throw new Error("service_catalog_malformed");
  const registration = await prepareTrustedOAuthClientRegistration(
    input,
    { serviceId: service.service_id, audience: service.audience, catalog },
    secretKey,
  );
  const results = await database.batch(
    trustedOAuthClientStatements(registration).map((statement) =>
      database.prepare(statement.sql).bind(...statement.values),
    ),
  );
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error("service_changed_during_provisioning");
  }
  return {
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    serviceId: input.serviceId,
    audience: service.audience,
    redirectUri: input.redirectUri,
    capabilities: [...input.capabilities],
    authMethod: input.authMethod,
    purpose: registration.purpose,
    refreshEnabled: registration.refreshEnabled,
  };
}

export function validateTrustedOAuthClientInput(
  input: TrustedOAuthClientInput,
  secretKey: string,
): void {
  if (!validServiceId(input.serviceId)) throw new Error("invalid_service_id");
  if (
    input.authMethod !== "none" &&
    input.authMethod !== "client_secret_post"
  ) {
    throw new Error("invalid_client_auth_method");
  }
  const purpose = input.purpose ?? "personal_harness";
  if (!validOAuthClientPurpose(purpose)) {
    throw new Error("invalid_client_purpose");
  }
  if (purpose === "first_party_browser") {
    if (input.authMethod !== "client_secret_post") {
      throw new Error("first_party_browser_requires_confidential_client");
    }
    if (input.refreshEnabled === true) {
      throw new Error("first_party_browser_refresh_not_supported");
    }
  }
  if (!secretKey) throw new Error("missing_better_auth_secret");
  if (!validOAuthClientRedirectUri(input.redirectUri)) {
    throw new Error("invalid_redirect_uri");
  }
  if (!validOAuthCapabilities(input.capabilities)) {
    throw new Error("invalid_capabilities");
  }
  if (
    input.refreshEnabled !== undefined &&
    typeof input.refreshEnabled !== "boolean"
  ) {
    throw new Error("invalid_refresh_flag");
  }
  if (input.clientId && !validClientId(input.clientId)) {
    throw new Error("invalid_client_id");
  }
  const clientName = input.name?.trim() || `0000 ${input.serviceId}`;
  if (clientName.length > 120 || /[\u0000-\u001f\u007f]/.test(clientName)) {
    throw new Error("invalid_client_name");
  }
}

export interface TrustedOAuthClientService {
  serviceId: string;
  audience: string;
  catalog: string[];
}

export interface TrustedOAuthClientRegistration {
  clientId: string;
  clientSecret: string | null;
  storedSecret: string | null;
  serviceId: string;
  audience: string;
  redirectUri: string;
  capabilities: string[];
  authMethod: OAuthClientAuthMethod;
  purpose: OAuthClientPurpose;
  refreshEnabled: boolean;
  ownerUserId: string | null;
  clientName: string;
  now: number;
  resourceId: string;
  catalog: string[];
}

export async function prepareTrustedOAuthClientRegistration(
  input: TrustedOAuthClientInput,
  service: TrustedOAuthClientService,
  secretKey: string,
  now = Date.now(),
): Promise<TrustedOAuthClientRegistration> {
  validateTrustedOAuthClientInput(input, secretKey);
  if (
    input.serviceId !== service.serviceId ||
    !validServiceAudience(service.audience) ||
    !validCapabilities(service.catalog)
  ) {
    throw new Error("service_catalog_malformed");
  }
  if (
    input.capabilities.some(
      (capability) => !service.catalog.includes(capability),
    )
  ) {
    throw new Error("capability_not_registered");
  }
  const clientId = input.clientId ?? `platform-oauth-${crypto.randomUUID()}`;
  if (!validClientId(clientId)) throw new Error("invalid_client_id");
  const clientSecret =
    input.authMethod === "client_secret_post"
      ? opaqueSecret("oauth_secret_")
      : null;
  const storedSecret = clientSecret
    ? await symmetricEncrypt({ key: secretKey, data: clientSecret })
    : null;
  return {
    clientId,
    clientSecret,
    storedSecret,
    serviceId: service.serviceId,
    audience: service.audience,
    redirectUri: input.redirectUri,
    capabilities: [...input.capabilities],
    authMethod: input.authMethod,
    purpose: input.purpose ?? "personal_harness",
    refreshEnabled: input.refreshEnabled === true,
    ownerUserId: input.ownerUserId ?? null,
    clientName: input.name?.trim() || `0000 ${input.serviceId}`,
    now,
    resourceId: service.audience,
    catalog: [...service.catalog],
  };
}

export interface OAuthClientProvisionStatement {
  sql: string;
  values: Array<string | number | null>;
}

export function trustedOAuthClientStatements(
  registration: TrustedOAuthClientRegistration,
): OAuthClientProvisionStatement[] {
  const capabilities = JSON.stringify(registration.capabilities);
  const catalog = JSON.stringify(registration.catalog);
  const protocolScopes = JSON.stringify([
    ...registration.capabilities,
    ...(registration.refreshEnabled ? ["offline_access"] : []),
  ]);
  const resourceScopes = JSON.stringify([
    ...registration.catalog,
    ...(registration.refreshEnabled ? ["offline_access"] : []),
  ]);
  const grantTypes = JSON.stringify(
    registration.refreshEnabled
      ? ["authorization_code", "refresh_token"]
      : ["authorization_code"],
  );
  // Every write rechecks the exact service snapshot used to prepare this
  // registration. A service disable or capability change between the read
  // and this batch therefore produces zero writes instead of publishing a
  // stale resource/client pair.
  const serviceGuard = `EXISTS (
    SELECT 1 FROM platform_service
    WHERE service_id = ? AND audience = ? AND disabled = 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS expected
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(platform_service.allowed_capabilities) AS current
          WHERE current.value = expected.value
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(platform_service.allowed_capabilities) AS current
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(?) AS expected
          WHERE expected.value = current.value
        )
      )
  )`;
  const serviceGuardValues = [
    registration.serviceId,
    registration.audience,
    catalog,
    catalog,
  ];
  return [
    {
      sql: `INSERT INTO oauthResource
       (id, identifier, name, accessTokenTtl, refreshTokenTtl,
        allowedScopes, disabled, createdAt, updatedAt)
       SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?
       WHERE ${serviceGuard}
       ON CONFLICT(identifier) DO UPDATE SET
         allowedScopes = excluded.allowedScopes,
         refreshTokenTtl = CASE
           WHEN excluded.refreshTokenTtl IS NOT NULL THEN excluded.refreshTokenTtl
           ELSE oauthResource.refreshTokenTtl
         END,
         disabled = 0,
         updatedAt = excluded.updatedAt
       WHERE ${serviceGuard}`,
      values: [
        crypto.randomUUID(),
        registration.resourceId,
        registration.clientName,
        3600,
        registration.refreshEnabled ? 30 * 24 * 60 * 60 : null,
        resourceScopes,
        registration.now,
        registration.now,
        ...serviceGuardValues,
        ...serviceGuardValues,
      ],
    },
    {
      sql: `INSERT INTO oauthClient
       (id, clientId, clientSecret, disabled, skipConsent, scopes,
        clientCredentialsScopes, userId, createdAt, updatedAt, name,
        redirectUris, grantTypes, responseTypes, tokenEndpointAuthMethod,
        applicationType, requirePKCE, dpopBoundAccessTokens)
       SELECT ?, ?, ?, 0, 0, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, 'web', 1, 0
       WHERE ${serviceGuard}`,
      values: [
        crypto.randomUUID(),
        registration.clientId,
        registration.storedSecret,
        protocolScopes,
        registration.ownerUserId,
        registration.now,
        registration.now,
        registration.clientName,
        JSON.stringify([registration.redirectUri]),
        grantTypes,
        JSON.stringify(["code"]),
        registration.authMethod,
        ...serviceGuardValues,
      ],
    },
    {
      sql: `INSERT INTO oauthClientResource (id, clientId, resourceId, createdAt)
       SELECT ?, ?, ?, ?
       WHERE ${serviceGuard}`,
      values: [
        crypto.randomUUID(),
        registration.clientId,
        registration.resourceId,
        registration.now,
        ...serviceGuardValues,
      ],
    },
    {
      sql: `INSERT INTO platform_oauth_client
       (client_id, service_id, owner_user_id, redirect_uri, capabilities,
        purpose, active, refresh_enabled, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
       WHERE ${serviceGuard}`,
      values: [
        registration.clientId,
        registration.serviceId,
        registration.ownerUserId,
        registration.redirectUri,
        capabilities,
        registration.purpose,
        registration.refreshEnabled ? 1 : 0,
        registration.now,
        registration.now,
        ...serviceGuardValues,
      ],
    },
  ];
}

export async function findOAuthClient(
  database: OAuthDatabase,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const row = await database
    .prepare(
      `SELECT p.client_id, p.service_id, p.owner_user_id, p.redirect_uri,
              p.capabilities, p.purpose, p.refresh_enabled, o.scopes, o.tokenEndpointAuthMethod,
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
      purpose: OAuthClientPurpose;
      refresh_enabled: number;
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
    !validOAuthScopes(scopes)
  ) {
    return null;
  }
  if (!validOAuthClientPurpose(row.purpose)) return null;
  if (
    row.purpose === "first_party_browser" &&
    (row.tokenEndpointAuthMethod !== "client_secret_post" ||
      row.refresh_enabled !== 0 ||
      scopes.includes("offline_access"))
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
    purpose: row.purpose,
    refreshEnabled: row.refresh_enabled === 1,
    ownerUserId: row.owner_user_id,
    scopes,
  };
}

/**
 * Keep canonical Platform OAuth routes classified after a client or its
 * service has been disabled.  An active lookup is intentionally insufficient:
 * otherwise the request would fall through to the fixture/default provider
 * and bypass Platform's authority decision.
 */
export async function hasPlatformOAuthClient(
  database: OAuthDatabase,
  clientId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT p.client_id
       FROM platform_oauth_client AS p
       JOIN oauthClient AS o ON o.clientId = p.client_id
       WHERE p.client_id = ?
       LIMIT 1`,
    )
    .bind(clientId)
    .first<{ client_id: string }>();
  return row !== null;
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
        client.scopes.includes(scope) &&
        (scope === "offline_access"
          ? client.refreshEnabled
          : client.capabilities.includes(scope)),
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
              organization_id, membership_id, installation_id, purpose, status,
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
              organization_id, membership_id, installation_id, purpose, status,
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
              organization_id, membership_id, installation_id, purpose, status,
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
    if (existing.purpose !== client.purpose) {
      return { status: 400, flow: null, error: "oauth_request_not_registered" };
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
        organization_id, membership_id, installation_id, purpose, status,
        expires_at, created_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'pending', ?, ?, NULL)`,
    )
    .bind(
      flowId,
      queryHash,
      rawQuery,
      binding.state,
      current.userId,
      current.sessionId,
      client.purpose,
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
  if (
    !binding ||
    !client ||
    flow.purpose !== client.purpose ||
    !validateOAuthQuery(binding, client)
  ) {
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
        audience, capabilities, subject_id, grant_id, purpose, active, revoked_at,
        created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM "user" WHERE id = ? AND disabledAt IS NULL
       ) AND EXISTS (
         SELECT 1 FROM member
         JOIN organization ON organization.id = member.organizationId
         WHERE member.id = ? AND member.organizationId = ?
           AND member.userId = ? AND organization.suspendedAt IS NULL
       ) AND EXISTS (
         SELECT 1 FROM platform_oauth_client
         WHERE client_id = ? AND service_id = ? AND purpose = ? AND active = 1
       ) AND EXISTS (
         SELECT 1 FROM platform_service
         WHERE service_id = ? AND audience = ? AND disabled = 0
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?) AS requested
             WHERE NOT EXISTS (
               SELECT 1 FROM json_each(platform_service.allowed_capabilities) AS catalog
               WHERE catalog.value = requested.value
             )
           )
       ) AND EXISTS (
         SELECT 1 FROM oauthClient
         WHERE clientId = ? AND disabled = 0
       ) AND EXISTS (
         SELECT 1 FROM oauthResource
         WHERE identifier = ? AND disabled = 0
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
      JSON.stringify(oauthCapabilitiesFromScopes(binding.scopes)),
      subjectId,
      grantId,
      client.purpose,
      now,
      binding.expiresAt,
      input.userId,
      currentMembership.id,
      input.organizationId,
      input.userId,
      client.clientId,
      client.serviceId,
      client.purpose,
      client.serviceId,
      client.audience,
      JSON.stringify(oauthCapabilitiesFromScopes(binding.scopes)),
      client.clientId,
      client.audience,
    );
  const updated = await database
    .prepare(
      `UPDATE platform_oauth_flow
       SET organization_id = ?, membership_id = ?, installation_id = ?,
           status = 'selected'
       WHERE id = ? AND status = 'pending' AND user_id = ? AND session_id = ?
         AND expires_at > ?
       AND EXISTS (
           SELECT 1 FROM platform_oauth_installation
           WHERE id = ? AND active = 0
         ) AND EXISTS (
           SELECT 1 FROM "user"
           WHERE id = ? AND disabledAt IS NULL
         ) AND EXISTS (
           SELECT 1 FROM member
           JOIN organization ON organization.id = member.organizationId
           WHERE member.id = ? AND member.organizationId = ?
             AND member.userId = ? AND organization.suspendedAt IS NULL
         ) AND EXISTS (
           SELECT 1 FROM platform_oauth_client
           WHERE client_id = ? AND service_id = ? AND purpose = ? AND active = 1
         ) AND EXISTS (
           SELECT 1 FROM oauthClient
           WHERE clientId = ? AND disabled = 0
         ) AND EXISTS (
           SELECT 1 FROM oauthResource
           WHERE identifier = ? AND disabled = 0
         ) AND EXISTS (
           SELECT 1 FROM platform_service
           WHERE service_id = ? AND audience = ? AND disabled = 0
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?) AS requested
               WHERE NOT EXISTS (
                 SELECT 1 FROM json_each(platform_service.allowed_capabilities) AS catalog
                 WHERE catalog.value = requested.value
               )
             )
         )`,
    )
    .bind(
      input.organizationId,
      currentMembership.id,
      installationId,
      flow.id,
      input.userId,
      input.sessionId,
      now,
      installationId,
      input.userId,
      currentMembership.id,
      input.organizationId,
      input.userId,
      client.clientId,
      client.serviceId,
      client.purpose,
      client.clientId,
      client.audience,
      client.serviceId,
      client.audience,
      JSON.stringify(oauthCapabilitiesFromScopes(binding.scopes)),
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
            AND oauth_client.purpose = installation.purpose
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
             AND installation.purpose = ?
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
          flow.purpose,
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

async function invalidateOAuthBinding(
  database: OAuthDatabase,
  input: {
    accessHash: string;
    installationId: string;
    flowId: string;
    credentialId?: string;
    reason: string;
  },
): Promise<void> {
  const now = Date.now();
  await database.batch([
    database
      .prepare("UPDATE oauthAccessToken SET revoked = 1 WHERE token = ?")
      .bind(input.accessHash),
    database
      .prepare(
        `UPDATE platform_oauth_installation
         SET active = 0, revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ? AND active = 1`,
      )
      .bind(now, input.installationId),
    database
      .prepare(
        `UPDATE platform_credential
         SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = ?
         WHERE id = ? AND oauth_installation_id = ?`,
      )
      .bind(now, input.reason, input.credentialId ?? "", input.installationId),
    database
      .prepare(
        `UPDATE platform_oauth_flow
         SET status = 'rejected', consumed_at = COALESCE(consumed_at, ?)
         WHERE id = ? AND status IN ('consumed', 'activated')`,
      )
      .bind(now, input.flowId),
  ]);
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
              organization_id, membership_id, installation_id, purpose, status,
              expires_at, created_at, consumed_at
       FROM platform_oauth_flow WHERE installation_id = ?`,
    )
    .bind(installationId)
    .first<OAuthFlow>();
  const installation = await database
    .prepare(
      `SELECT id, client_id, user_id, membership_id, organization_id,
              service_id, audience, capabilities, subject_id, grant_id,
              purpose, active, revoked_at, expires_at
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
      grant_id: string | null;
      purpose: OAuthClientPurpose;
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
          `SELECT member.id, pc.redirect_uri, pc.purpose AS client_purpose,
                  pc.refresh_enabled AS client_refresh_enabled,
                  oc.tokenEndpointAuthMethod AS client_auth_method,
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
          client_purpose: OAuthClientPurpose;
          client_refresh_enabled: number;
          client_auth_method: OAuthClientAuthMethod;
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
    flow.purpose !== installation.purpose ||
    access.clientId !== installation.client_id ||
    access.referenceId !== installation.id ||
    !current ||
    current.redirect_uri !== binding.redirectUri ||
    current.client_purpose !== installation.purpose ||
    (installation.purpose === "first_party_browser" &&
      (current.client_refresh_enabled !== 0 ||
        current.client_auth_method !== "client_secret_post")) ||
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
    !validOAuthScopes(currentRegisteredScopes) ||
    !validOAuthScopes(currentConsentScopes) ||
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
       SELECT ?, ?,
              CASE WHEN i.purpose = 'first_party_browser' THEN 'human' ELSE 'agent' END,
              CASE WHEN i.purpose = 'first_party_browser' THEN i.user_id ELSE i.subject_id END,
              i.organization_id, i.membership_id,
              CASE WHEN i.purpose = 'first_party_browser' THEN NULL ELSE i.grant_id END,
              i.audience, i.capabilities, '[]', a.expiresAt, NULL,
              CASE WHEN i.purpose = 'first_party_browser'
                THEN 'First-party browser access' ELSE 'OAuth personal harness' END,
              ?, NULL, NULL, NULL, 'better-auth',
              i.id, a.id, ?
       FROM platform_oauth_installation AS i
       JOIN oauthAccessToken AS a ON a.id = ? AND a.token = ?
       JOIN platform_oauth_client AS pc
         ON pc.client_id = i.client_id AND pc.service_id = i.service_id
        AND pc.active = 1 AND pc.purpose = i.purpose
       JOIN oauthClient AS oc ON oc.clientId = i.client_id AND oc.disabled = 0
       JOIN platform_service AS service
         ON service.service_id = i.service_id AND service.audience = i.audience
        AND service.disabled = 0
       JOIN "user" AS current_user
         ON current_user.id = i.user_id AND current_user.disabledAt IS NULL
       JOIN organization AS current_org
         ON current_org.id = i.organization_id AND current_org.suspendedAt IS NULL
       JOIN member AS current_member
         ON current_member.id = i.membership_id
        AND current_member.userId = i.user_id
        AND current_member.organizationId = i.organization_id
       JOIN oauthConsent AS consent
         ON consent.clientId = i.client_id AND consent.userId = i.user_id
        AND consent.referenceId = i.id
       WHERE i.id = ? AND i.active = 0 AND i.revoked_at IS NULL
         AND a.referenceId = i.id AND a.clientId = i.client_id
         AND a.userId = i.user_id AND a.revoked IS NULL
         AND a.refreshId IS NULL
         AND a.expiresAt > ?
         AND i.expires_at > ?
         AND pc.redirect_uri = ?
         AND EXISTS (SELECT 1 FROM member WHERE id = i.membership_id
           AND userId = i.user_id AND organizationId = i.organization_id)
         AND EXISTS (
         SELECT 1 FROM platform_oauth_flow
           WHERE id = ? AND installation_id = i.id AND purpose = i.purpose
             AND status = 'consumed'
             AND user_id = i.user_id AND organization_id = i.organization_id
             AND membership_id = i.membership_id AND expires_at > ?
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
             SELECT 1 FROM json_each(pc.capabilities) AS ceiling
             WHERE ceiling.value = requested.value
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(i.capabilities) AS requested
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(json_extract(oc.scopes, '$')) AS ceiling
             WHERE ceiling.value = requested.value
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
      binding.redirectUri,
      flow.id,
      now,
    );
  const results = await database.batch([
    insert,
    database
      .prepare(
        `UPDATE oauthAccessToken SET sessionId = NULL
         WHERE id = ? AND token = ? AND referenceId = ?
           AND EXISTS (
             SELECT 1 FROM platform_credential
             WHERE id = ? AND oauth_provider_row_id = ?
           )`,
      )
      .bind(access.id, accessHash, installation.id, credentialId, access.id),
    database
      .prepare(
        `UPDATE platform_oauth_installation SET active = 1
         WHERE id = ? AND active = 0 AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM platform_credential
             WHERE id = ? AND oauth_installation_id = ?
               AND oauth_provider_row_id = ?
           )`,
      )
      .bind(installation.id, credentialId, installation.id, access.id),
    database
      .prepare(
        `UPDATE platform_oauth_flow SET status = 'activated'
         WHERE id = ? AND status = 'consumed'
           AND EXISTS (
             SELECT 1 FROM platform_credential
             WHERE id = ? AND oauth_installation_id = ?
               AND oauth_provider_row_id = ?
           )`,
      )
      .bind(flow.id, credentialId, installation.id, access.id),
  ]);
  if (results[0]?.meta.changes !== 1) {
    await invalidateOAuthBinding(database, {
      accessHash,
      installationId: installation.id,
      flowId: flow.id,
      credentialId,
      reason: "oauth_binding_not_durable",
    });
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
       JOIN platform_oauth_flow AS f
         ON f.id = ? AND f.installation_id = i.id
        AND f.purpose = i.purpose AND f.status = 'activated'
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
    await invalidateOAuthBinding(database, {
      accessHash,
      installationId: installation.id,
      flowId: flow.id,
      credentialId,
      reason: "oauth_authority_not_durable",
    });
    return noStoreError("server_error", "OAuth authority was not durable", 500);
  }
  if (!(await oauthTokenIsCurrentlyAuthorized(database, credential))) {
    await invalidateOAuthBinding(database, {
      accessHash,
      installationId: installation.id,
      flowId: flow.id,
      credentialId,
      reason: "oauth_authority_changed_during_activation",
    });
    return noStoreError("server_error", "OAuth authority changed", 500);
  }
  return;
}

export async function oauthTokenIsCurrentlyAuthorized(
  database: OAuthDatabase,
  token: string,
): Promise<boolean> {
  const platformHash = await hashOpaque(token);
  const refreshMarker = await database
    .prepare(
      `SELECT oauth_refresh_token_id FROM platform_credential
       WHERE credential_hash = ? AND oauth_origin = 'better-auth'`,
    )
    .bind(platformHash)
    .first<{ oauth_refresh_token_id: string | null }>();
  if (refreshMarker?.oauth_refresh_token_id) {
    const refresh = await database
      .prepare(
        `SELECT c.id
         FROM platform_credential AS c
         JOIN platform_oauth_refresh_token AS t ON t.id = c.oauth_refresh_token_id
          AND t.state = 'issued'
         JOIN platform_oauth_refresh_family AS f ON f.id = t.family_id
          AND f.state = 'active'
         AND f.expires_at > ?
         JOIN platform_oauth_installation AS i ON i.id = c.oauth_installation_id
          AND i.active = 1 AND i.revoked_at IS NULL
          AND i.purpose = 'personal_harness'
         JOIN oauthAccessToken AS a ON a.id = c.oauth_provider_row_id
          AND a.token = c.oauth_provider_token_hash
          AND a.refreshId = t.provider_refresh_row_id
          AND a.referenceId = i.id AND a.clientId = i.client_id
          AND a.userId = i.user_id AND a.revoked IS NULL
          AND a.expiresAt > ?
          AND json_array_length(json_extract(a.resources, '$')) = 1
          AND json_extract(json_extract(a.resources, '$'), '$[0]') = i.audience
         JOIN oauthRefreshToken AS refresh ON refresh.id = t.provider_refresh_row_id
          AND refresh.token = t.provider_refresh_token_hash
          AND refresh.clientId = i.client_id AND refresh.userId = i.user_id
          AND refresh.referenceId = i.id AND refresh.revoked IS NULL
          AND refresh.expiresAt > ?
          AND json_array_length(json_extract(refresh.resources, '$')) = 1
          AND json_extract(json_extract(refresh.resources, '$'), '$[0]') = i.audience
         JOIN platform_oauth_client AS pc ON pc.client_id = i.client_id
          AND pc.service_id = i.service_id AND pc.active = 1
          AND pc.refresh_enabled = 1
         JOIN oauthClient AS oc ON oc.clientId = i.client_id AND oc.disabled = 0
          AND oc.grantTypes LIKE '%refresh_token%'
         JOIN oauthResource AS resource ON resource.identifier = i.audience
          AND resource.disabled = 0 AND resource.refreshTokenTtl IS NOT NULL
          AND resource.refreshTokenTtl > 0
         JOIN member AS m ON m.id = i.membership_id
          AND m.userId = i.user_id AND m.organizationId = i.organization_id
         JOIN "user" AS u ON u.id = i.user_id AND u.disabledAt IS NULL
         JOIN organization AS org ON org.id = i.organization_id
          AND org.suspendedAt IS NULL
         JOIN platform_service AS service ON service.service_id = i.service_id
          AND service.audience = i.audience AND service.disabled = 0
         JOIN oauthConsent AS consent ON consent.clientId = i.client_id
          AND consent.userId = i.user_id AND consent.referenceId = i.id
          AND json_array_length(json_extract(consent.resources, '$')) = 1
          AND json_extract(json_extract(consent.resources, '$'), '$[0]') = i.audience
         WHERE c.credential_hash = ? AND c.oauth_refresh_token_id = ?
           AND c.oauth_origin = 'better-auth' AND c.kind = 'agent'
           AND c.revoked_at IS NULL
           AND c.expires_at > ?
           AND c.subject_id = f.subject_id AND c.grant_id = f.grant_id
           AND c.organization_id = f.organization_id
           AND c.membership_id = f.membership_id AND c.audience = f.audience
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
               SELECT 1 FROM json_each(f.capabilities) AS ceiling
               WHERE ceiling.value = requested.value
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
               SELECT 1 FROM json_each(json_extract(a.scopes, '$')) AS granted
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
           AND a.refreshId = refresh.id
           AND NOT EXISTS (
             SELECT 1 FROM json_each(c.capabilities) AS requested
             WHERE NOT EXISTS (
               SELECT 1 FROM json_each(service.allowed_capabilities) AS catalog
               WHERE catalog.value = requested.value
             )
           )
         LIMIT 1`,
      )
      .bind(
        Date.now(),
        Date.now(),
        Date.now(),
        platformHash,
        refreshMarker.oauth_refresh_token_id,
        Date.now(),
      )
      .first<{ id: string }>();
    return refresh !== null;
  }
  const hash = await oauthProviderTokenHash(token);
  const row = await database
    .prepare(
      `SELECT c.id, c.kind, c.subject_id, c.membership_id, c.grant_id,
              i.user_id AS installation_user_id,
              i.membership_id AS installation_membership_id,
              i.subject_id AS installation_subject_id,
              i.grant_id AS installation_grant_id,
              i.client_id AS client_id, i.audience AS audience,
              i.purpose AS installation_purpose,
              pc.refresh_enabled AS client_refresh_enabled,
              oc.tokenEndpointAuthMethod AS client_auth_method,
              i.capabilities AS installation_capabilities,
              pc.redirect_uri AS client_redirect_uri,
              f.oauth_query AS oauth_query,
              a.resources AS provider_resources, a.scopes AS provider_scopes,
              consent.resources AS consent_resources, consent.scopes AS consent_scopes,
              pc.capabilities AS client_capabilities, oc.scopes AS registered_scopes,
              service.allowed_capabilities AS service_capabilities
      FROM platform_credential AS c
      JOIN platform_oauth_installation AS i
         ON i.id = c.oauth_installation_id AND i.active = 1
        AND i.revoked_at IS NULL
       JOIN oauthAccessToken AS a
         ON a.id = c.oauth_provider_row_id AND a.token = c.oauth_provider_token_hash
        AND a.refreshId IS NULL
       JOIN platform_oauth_client AS pc
         ON pc.client_id = i.client_id AND pc.active = 1
        AND pc.purpose = i.purpose
       JOIN platform_oauth_flow AS f
         ON f.installation_id = i.id AND f.purpose = i.purpose
        AND f.status = 'activated'
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
      kind: string;
      subject_id: string;
      membership_id: string | null;
      grant_id: string | null;
      installation_user_id: string;
      installation_membership_id: string;
      installation_subject_id: string;
      installation_grant_id: string;
      client_id: string;
      audience: string;
      installation_purpose: OAuthClientPurpose;
      client_refresh_enabled: number;
      client_auth_method: OAuthClientAuthMethod;
      installation_capabilities: string;
      client_redirect_uri: string;
      oauth_query: string;
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
  const binding = parseOAuthQuery(row.oauth_query);
  if (
    !installationCapabilities ||
    !providerResources ||
    !providerScopes ||
    !consentResources ||
    !consentScopes ||
    !clientCapabilities ||
    !registeredScopes ||
    !serviceCapabilities ||
    !binding ||
    !validOAuthCapabilities(installationCapabilities) ||
    !validOAuthCapabilities(providerScopes) ||
    !validOAuthScopes(consentScopes) ||
    !validOAuthCapabilities(clientCapabilities) ||
    !validOAuthScopes(registeredScopes) ||
    !validOAuthCapabilities(serviceCapabilities)
  ) {
    return false;
  }
  return (
    ((row.installation_purpose === "first_party_browser" &&
      row.client_refresh_enabled === 0 &&
      row.client_auth_method === "client_secret_post" &&
      row.kind === "human" &&
      row.subject_id === row.installation_user_id &&
      row.membership_id === row.installation_membership_id &&
      row.grant_id === null) ||
      (row.installation_purpose === "personal_harness" &&
        row.kind === "agent" &&
        row.subject_id === row.installation_subject_id &&
        row.membership_id === row.installation_membership_id &&
        row.grant_id === row.installation_grant_id)) &&
    binding.clientId === row.client_id &&
    binding.redirectUri === row.client_redirect_uri &&
    binding.resource === row.audience &&
    providerResources.includes(row.audience) &&
    consentResources.includes(row.audience) &&
    providerResources.length === 1 &&
    consentResources.length === 1 &&
    providerScopes.length === installationCapabilities.length &&
    consentScopes.length === installationCapabilities.length &&
    binding.scopes.length === installationCapabilities.length &&
    binding.scopes.every((scope) => installationCapabilities.includes(scope)) &&
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
  const refreshClient = await database
    .prepare(
      `SELECT 1 FROM platform_oauth_client AS p
       JOIN oauthClient AS c ON c.clientId = p.client_id
       JOIN platform_service AS s ON s.service_id = p.service_id
       JOIN oauthResource AS r ON r.identifier = s.audience
       WHERE p.active = 1 AND p.refresh_enabled = 1
         AND c.disabled = 0
         AND c.grantTypes LIKE '%refresh_token%'
         AND r.disabled = 0 AND r.refreshTokenTtl IS NOT NULL
         AND r.refreshTokenTtl > 0 AND s.disabled = 0
       LIMIT 1`,
    )
    .first();
  const refreshSupported = refreshClient !== null;
  if (refreshSupported) scopes.add("offline_access");
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth2/token`,
    introspection_endpoint: `${issuer}/api/auth/oauth2/introspect`,
    introspection_endpoint_auth_methods_supported: ["client_secret_post"],
    response_types_supported: ["code"],
    grant_types_supported: refreshSupported
      ? ["authorization_code", "refresh_token"]
      : ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...scopes].sort(),
  };
}
