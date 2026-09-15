import { type ProjectionConnectionBinding } from "@communicator/contracts";

export type ActiveIngestionRoute = {
  gateway_route_id: string;
  service_principal_id: string;
};

export type ArchivedIngestionRoute = ActiveIngestionRoute;

export type ActiveIngestionService = {
  service_principal_id: string;
  issuer: string;
  subject: string;
  token_id: string;
};

export type IngestionConnectionBinding = ProjectionConnectionBinding & {
  gateway_route_id: string;
  account_status: "active" | "retired";
};

export type IngestionDirectoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "not_found" | "unavailable" };

export type IngestionDirectoryDatabase = D1Database | D1DatabaseSession;

const MAX_INGESTION_ACCOUNTS = 500;
const INGESTION_ACCOUNT_QUERY_CHUNK = 50;

type IngestionRouteRow = {
  gateway_route_id: string;
  service_principal_id: string;
};

type IngestionServiceRow = {
  service_principal_id: string;
  issuer: string;
  subject: string;
  token_id: string;
};

type IngestionBindingRow = {
  account_id: string;
  connection_id: string;
  identity_id: string;
  platform: ProjectionConnectionBinding["platform"];
  gateway_route_id: string;
  account_status: "active" | "retired";
};

const notFound = <T>(): IngestionDirectoryResult<T> => ({
  ok: false,
  code: "not_found",
});

const unavailable = <T>(): IngestionDirectoryResult<T> => ({
  ok: false,
  code: "unavailable",
});

function primarySession(db: IngestionDirectoryDatabase): D1DatabaseSession {
  if ("withSession" in db && typeof db.withSession === "function") {
    return db.withSession("first-primary");
  }
  return db as D1DatabaseSession;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) continue;
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.length - rightBytes.length;
}

function hasExactUniqueAccountIds(accountIds: readonly string[]): boolean {
  if (accountIds.length === 0 || accountIds.length > MAX_INGESTION_ACCOUNTS) {
    return false;
  }
  if (
    accountIds.some(
      (accountId) => typeof accountId !== "string" || accountId.length === 0,
    )
  ) {
    return false;
  }
  return new Set(accountIds).size === accountIds.length;
}

function sortBindings(
  rows: IngestionBindingRow[],
): IngestionConnectionBinding[] {
  return rows
    .slice()
    .sort((left, right) => compareUtf8(left.account_id, right.account_id))
    .map((row) => ({
      account_id: row.account_id,
      connection_id: row.connection_id,
      identity_id: row.identity_id,
      platform: row.platform,
      gateway_route_id: row.gateway_route_id,
      account_status: row.account_status,
    }));
}

export async function findActiveIngestionService(
  db: IngestionDirectoryDatabase,
  issuer: string,
  subject: string,
  tokenId: string | null | undefined,
): Promise<IngestionDirectoryResult<ActiveIngestionService>> {
  if (!issuer || !subject || !tokenId) return notFound();

  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT
         p.id AS service_principal_id,
         p.issuer,
         p.subject,
         ? AS token_id
       FROM principals AS p
       WHERE p.issuer = ?
         AND p.subject = ?
         AND p.principal_type = 'service'
         AND p.status = 'active'
         AND p.revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM revoked_tokens AS rt
           WHERE rt.issuer = p.issuer
             AND rt.token_id = ?
         )
       LIMIT 1`,
      )
      .bind(tokenId, issuer, subject, tokenId)
      .first<IngestionServiceRow>();

    return row ? { ok: true, value: row } : notFound();
  } catch {
    return unavailable();
  }
}

export async function resolveActiveIngestionRoute(
  db: IngestionDirectoryDatabase,
  servicePrincipalId: string,
  gatewayRouteId: string,
): Promise<IngestionDirectoryResult<ActiveIngestionRoute>> {
  if (!servicePrincipalId || !gatewayRouteId) return notFound();

  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT
         gr.id AS gateway_route_id,
         gr.service_principal_id
       FROM gateway_routes AS gr
       JOIN principals AS p ON p.id = gr.service_principal_id
       WHERE gr.id = ?
         AND gr.service_principal_id = ?
         AND gr.status = 'active'
         AND p.principal_type = 'service'
         AND p.status = 'active'
         AND p.revoked_at IS NULL
       LIMIT 1`,
      )
      .bind(gatewayRouteId, servicePrincipalId)
      .first<IngestionRouteRow>();

    return row ? { ok: true, value: row } : notFound();
  } catch {
    return unavailable();
  }
}

export async function resolveArchivedIngestionRoute(
  db: IngestionDirectoryDatabase,
  gatewayRouteId: string,
): Promise<IngestionDirectoryResult<ArchivedIngestionRoute>> {
  if (!gatewayRouteId) return notFound();

  try {
    const row = await primarySession(db)
      .prepare(
        `SELECT
         gr.id AS gateway_route_id,
         gr.service_principal_id
       FROM gateway_routes AS gr
       JOIN principals AS p ON p.id = gr.service_principal_id
       WHERE gr.id = ?
         AND p.principal_type = 'service'
       LIMIT 1`,
      )
      .bind(gatewayRouteId)
      .first<IngestionRouteRow>();

    return row ? { ok: true, value: row } : notFound();
  } catch {
    return unavailable();
  }
}

function accountPlaceholders(accountIds: readonly string[]): string {
  return accountIds.map(() => "?").join(", ");
}

async function resolveBindings(
  db: IngestionDirectoryDatabase,
  gatewayRouteId: string,
  tenantId: string,
  accountIds: readonly string[],
  archived: boolean,
): Promise<IngestionDirectoryResult<IngestionConnectionBinding[]>> {
  if (!gatewayRouteId || !tenantId || !hasExactUniqueAccountIds(accountIds)) {
    return notFound();
  }

  const routeStatus = archived ? "" : "AND gr.status = 'active'";
  const principalStatus = archived ? "" : "AND p.status = 'active'";
  const tenantStatus = archived ? "" : "AND t.status = 'active'";
  const identityStatus = archived ? "" : "AND i.status = 'active'";
  const accountStatus = archived ? "" : "AND ca.status = 'active'";
  const connectionStatus = archived
    ? ""
    : "AND c.status IN ('connected', 'syncing', 'ready', 'attention_required', 'disconnected')";

  try {
    const session = primarySession(db);
    const rows: IngestionBindingRow[] = [];
    for (
      let offset = 0;
      offset < accountIds.length;
      offset += INGESTION_ACCOUNT_QUERY_CHUNK
    ) {
      const accountChunk = accountIds.slice(
        offset,
        offset + INGESTION_ACCOUNT_QUERY_CHUNK,
      );
      const accountList = accountPlaceholders(accountChunk);
      const chunkRows = await session
        .prepare(
          `SELECT
           ca.account_id,
           ca.connection_id,
           c.identity_id,
           c.provider AS platform,
           cr.gateway_route_id,
           ca.status AS account_status
         FROM connection_accounts AS ca
         JOIN connections AS c ON c.id = ca.connection_id
         JOIN tenants AS t ON t.id = c.tenant_id
         JOIN identities AS i ON i.tenant_id = c.tenant_id AND i.id = c.identity_id
         JOIN connection_routes AS cr
           ON cr.connection_id = c.id
          AND cr.gateway_route_id = ?
         JOIN gateway_routes AS gr ON gr.id = cr.gateway_route_id
         JOIN principals AS p ON p.id = gr.service_principal_id
         WHERE c.tenant_id = ?
           AND ca.account_id IN (${accountList})
           ${routeStatus}
           ${principalStatus}
           ${tenantStatus}
           ${identityStatus}
           ${accountStatus}
           ${connectionStatus}
         ORDER BY ca.account_id COLLATE BINARY`,
        )
        .bind(gatewayRouteId, tenantId, ...accountChunk)
        .all<IngestionBindingRow>();
      rows.push(...chunkRows.results);
    }

    if (rows.length !== accountIds.length) return notFound();
    const returnedIds = new Set(rows.map((row) => row.account_id));
    if (
      returnedIds.size !== accountIds.length ||
      accountIds.some((id) => !returnedIds.has(id))
    ) {
      return notFound();
    }

    return { ok: true, value: sortBindings(rows) };
  } catch {
    return unavailable();
  }
}

export async function resolveActiveIngressBindings(
  db: IngestionDirectoryDatabase,
  gatewayRouteId: string,
  tenantId: string,
  accountIds: readonly string[],
): Promise<IngestionDirectoryResult<IngestionConnectionBinding[]>> {
  return resolveBindings(db, gatewayRouteId, tenantId, accountIds, false);
}

export async function resolveArchivedBindings(
  db: IngestionDirectoryDatabase,
  gatewayRouteId: string,
  tenantId: string,
  accountIds: readonly string[],
): Promise<IngestionDirectoryResult<IngestionConnectionBinding[]>> {
  return resolveBindings(db, gatewayRouteId, tenantId, accountIds, true);
}
