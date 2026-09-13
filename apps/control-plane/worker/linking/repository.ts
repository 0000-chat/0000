import {
  ConnectedAccountSchema,
  ProviderSchema,
  type ConnectedAccount,
  type Provider,
} from "@communicator/contracts";
import type { GatewayRoute } from "./gateway-client";

export type CommitLinkedAccountInput = {
  db: D1Database;
  sessionId: string;
  tenantId: string;
  actorPrincipalId: string;
  membershipId: string;
  targetIdentityId: string;
  provider: Provider;
  providerIdentity: {
    user_login_id: string;
    display_label: string;
    route: GatewayRoute;
  };
  identityHashSecret: string;
  occurredAt: string;
};

export type CommitLinkedAccountResult = {
  kind: "created" | "duplicate";
  account: ConnectedAccount | null;
  connection_id: string | null;
  account_id: string | null;
};

export type LinkingRepositoryErrorCode =
  | "authorization_required"
  | "invalid_link"
  | "duplicate_provider_identity"
  | "link_conflict"
  | "link_unavailable";

const messages: Record<LinkingRepositoryErrorCode, string> = {
  authorization_required: "Administrator connection management is required",
  invalid_link: "Invalid account link",
  duplicate_provider_identity: "This provider account is already connected",
  link_conflict: "Account link could not be committed",
  link_unavailable: "Account link directory unavailable",
};

export class LinkingRepositoryError extends Error {
  constructor(
    readonly code: LinkingRepositoryErrorCode,
    cause?: unknown,
  ) {
    super(messages[code]);
    this.name = "LinkingRepositoryError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
    }
  }
}

const accountRow = (row: Record<string, string>): ConnectedAccount =>
  ConnectedAccountSchema.parse({
    account_id: row.account_id,
    tenant_id: row.tenant_id,
    connection_id: row.connection_id,
    identity_id: row.identity_id,
    provider: row.provider,
    display_label: row.display_label,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

async function hmacHex(secret: string, value: string): Promise<string> {
  if (secret.length < 16) throw new LinkingRepositoryError("invalid_link");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const normalizeProviderIdentity = (
  provider: Provider,
  value: string,
): string => {
  if (!ProviderSchema.safeParse(provider).success)
    throw new LinkingRepositoryError("invalid_link");
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 256 || /\s/.test(normalized))
    throw new LinkingRepositoryError("invalid_link");
  return normalized;
};

const getExistingSessionCommit = async (
  db: D1Database,
  input: CommitLinkedAccountInput,
): Promise<CommitLinkedAccountResult | null> => {
  const row = await db
    .prepare(
      `SELECT ca.account_id, c.tenant_id, c.id AS connection_id, c.identity_id,
              c.provider, c.display_label, c.status, c.created_at, c.updated_at
       FROM connection_provider_identities AS pi
       JOIN connection_accounts AS ca
         ON ca.connection_id = pi.connection_id
       JOIN connections AS c
         ON c.tenant_id = pi.tenant_id AND c.id = pi.connection_id
       WHERE pi.tenant_id = ? AND pi.link_session_id = ?
       LIMIT 1`,
    )
    .bind(input.tenantId, input.sessionId)
    .first<Record<string, string>>();
  if (!row) return null;
  const account = accountRow(row);
  return {
    kind: "created",
    account,
    connection_id: row.connection_id ?? null,
    account_id: row.account_id ?? null,
  };
};

export async function commitLinkedAccount(
  input: CommitLinkedAccountInput,
): Promise<CommitLinkedAccountResult> {
  const provider = ProviderSchema.safeParse(input.provider);
  if (!provider.success) throw new LinkingRepositoryError("invalid_link");
  const normalized = normalizeProviderIdentity(
    provider.data,
    input.providerIdentity.user_login_id,
  );
  const identityKey = await hmacHex(
    input.identityHashSecret,
    `${provider.data}\0${normalized}`,
  );
  const db = input.db;
  try {
    // This is intentionally inside the same serialized finalization command
    // as the directory mutation. A role, membership, or target grant revoked
    // while the provider poll was in flight cannot complete a link.
    const administrator = await db
      .prepare(
        `SELECT 1 AS valid
         FROM principals AS p
         JOIN memberships AS m
           ON m.tenant_id = ? AND m.id = ? AND m.principal_id = p.id
         JOIN identities AS i
           ON i.tenant_id = m.tenant_id AND i.id = ?
         JOIN identity_grants AS g
           ON g.tenant_id = m.tenant_id
          AND g.membership_id = m.id
          AND g.identity_id = i.id
          AND g.operation_scope = 'connection.manage'
         WHERE p.id = ?
           AND p.principal_type IN ('human', 'operator')
           AND p.status = 'active'
           AND m.status = 'active'
           AND m.role IN ('owner', 'admin')
           AND i.identity_kind = 'human'
           AND i.status = 'active'
         LIMIT 1`,
      )
      .bind(
        input.tenantId,
        input.membershipId,
        input.targetIdentityId,
        input.actorPrincipalId,
      )
      .first<{ valid: number }>();
    if (!administrator)
      throw new LinkingRepositoryError("authorization_required");

    const existingSession = await getExistingSessionCommit(db, input);
    if (existingSession) return existingSession;

    const identity = await db
      .prepare(
        `SELECT 1 AS valid
         FROM identities
         WHERE tenant_id = ? AND id = ? AND identity_kind = 'human' AND status = 'active'
         LIMIT 1`,
      )
      .bind(input.tenantId, input.targetIdentityId)
      .first<{ valid: number }>();
    if (!identity) throw new LinkingRepositoryError("invalid_link");

    const route = await db
      .prepare(
        "SELECT 1 AS valid FROM gateway_routes WHERE id = ? AND status = 'active' LIMIT 1",
      )
      .bind(input.providerIdentity.route.gateway_route_id)
      .first<{ valid: number }>();
    if (!route) throw new LinkingRepositoryError("invalid_link");

    const duplicate = await db
      .prepare(
        "SELECT connection_id FROM connection_provider_identities WHERE tenant_id = ? AND provider = ? AND identity_key = ? LIMIT 1",
      )
      .bind(input.tenantId, provider.data, identityKey)
      .first<{ connection_id: string }>();
    if (duplicate) {
      return {
        kind: "duplicate",
        account: null,
        connection_id: duplicate.connection_id,
        account_id: null,
      };
    }

    const connectionId = `connection_${crypto.randomUUID().replaceAll("-", "")}`;
    const accountId = `account_${crypto.randomUUID().replaceAll("-", "")}`;
    const displayLabel = input.providerIdentity.display_label.trim();
    if (!displayLabel || displayLabel.length > 100)
      throw new LinkingRepositoryError("invalid_link");
    const payload = JSON.stringify({
      session_id: input.sessionId,
      identity_id: input.targetIdentityId,
      provider: provider.data,
      connection_id: connectionId,
      account_id: accountId,
      gateway_route_id: input.providerIdentity.route.gateway_route_id,
    });
    const requestHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(payload),
    );
    const requestHash = Array.from(new Uint8Array(requestHashBuffer), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const mutationKey = `link_${input.sessionId}`;
    await db.batch([
      db
        .prepare(
          "INSERT INTO directory_mutations (idempotency_key, tenant_id, actor_principal_id, mutation_type, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          mutationKey,
          input.tenantId,
          input.actorPrincipalId,
          "connection.linked",
          requestHash,
          input.occurredAt,
        ),
      db
        .prepare(
          "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at, last_synced_at, attention_code, sort_position) VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, NULL, NULL, 0)",
        )
        .bind(
          connectionId,
          input.tenantId,
          input.targetIdentityId,
          provider.data,
          displayLabel,
          input.occurredAt,
          input.occurredAt,
        ),
      db
        .prepare(
          "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          connectionId,
          input.providerIdentity.route.gateway_route_id,
          input.providerIdentity.route.bridge_instance_id,
          input.providerIdentity.route.matrix_user_id,
          input.providerIdentity.route.matrix_room_namespace,
          input.occurredAt,
          input.occurredAt,
        ),
      db
        .prepare(
          "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at, retired_at) VALUES (?, ?, 'active', ?, ?, NULL)",
        )
        .bind(accountId, connectionId, input.occurredAt, input.occurredAt),
      db
        .prepare(
          "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, provider_login_id, connection_id, link_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          input.tenantId,
          provider.data,
          identityKey,
          normalized,
          connectionId,
          input.sessionId,
          input.occurredAt,
        ),
      db
        .prepare(
          "INSERT INTO audit_events (id, tenant_id, actor_principal_id, action, target_type, target_id, reason, metadata_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
        )
        .bind(
          `audit_${input.sessionId}`,
          input.tenantId,
          input.actorPrincipalId,
          "connection.linked",
          "connection",
          connectionId,
          payload,
          input.occurredAt,
        ),
      db
        .prepare(
          "INSERT INTO control_event_outbox (event_id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `control_${input.sessionId}`,
          input.tenantId,
          "connection.linked",
          "connection",
          connectionId,
          payload,
          input.occurredAt,
        ),
    ]);
    const created = await db
      .prepare(
        `SELECT ca.account_id, c.tenant_id, c.id AS connection_id, c.identity_id,
                c.provider, c.display_label, c.status, c.created_at, c.updated_at
         FROM connection_accounts AS ca
         JOIN connections AS c ON c.id = ca.connection_id
         WHERE c.tenant_id = ? AND ca.account_id = ?
         LIMIT 1`,
      )
      .bind(input.tenantId, accountId)
      .first<Record<string, string>>();
    if (!created) throw new LinkingRepositoryError("link_conflict");
    return {
      kind: "created",
      account: accountRow(created),
      connection_id: connectionId,
      account_id: accountId,
    };
  } catch (error) {
    if (error instanceof LinkingRepositoryError) throw error;
    throw new LinkingRepositoryError("link_conflict", error);
  }
}
