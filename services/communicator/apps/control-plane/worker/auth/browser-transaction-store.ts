import type {
  BrowserOAuthTransaction,
  BrowserOAuthTransactionStore,
} from "@0000/platform-client";

type BrowserTransactionRow = {
  state_hash: unknown;
  browser_binding_hash: unknown;
  code_verifier: unknown;
  code_challenge: unknown;
  client_id: unknown;
  redirect_uri: unknown;
  resource: unknown;
  scopes_json: unknown;
  return_to: unknown;
  expires_at_ms: unknown;
  created_at_ms: unknown;
};

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const safeInteger = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

function primary(db: D1Database): D1DatabaseSession {
  return db.withSession("first-primary");
}

function parseRow(row: BrowserTransactionRow): BrowserOAuthTransaction | null {
  if (
    !isString(row.state_hash) ||
    !isString(row.browser_binding_hash) ||
    !isString(row.code_verifier) ||
    !isString(row.code_challenge) ||
    !isString(row.client_id) ||
    !isString(row.redirect_uri) ||
    !isString(row.resource) ||
    !isString(row.scopes_json) ||
    !isString(row.return_to) ||
    !safeInteger(row.expires_at_ms, 1) ||
    !safeInteger(row.created_at_ms, 0)
  ) {
    return null;
  }
  let scopes: unknown;
  try {
    scopes = JSON.parse(row.scopes_json);
  } catch {
    return null;
  }
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every((scope) => isString(scope))
  ) {
    return null;
  }
  return {
    stateHash: row.state_hash,
    browserBindingHash: row.browser_binding_hash,
    codeVerifier: row.code_verifier,
    codeChallenge: row.code_challenge,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    scopes,
    returnTo: row.return_to,
    expiresAt: row.expires_at_ms,
  };
}

export function createBrowserOAuthTransactionStore(
  database: D1Database,
  now: () => number = () => Date.now(),
): BrowserOAuthTransactionStore {
  return {
    async put(transaction) {
      const session = primary(database);
      await session
        .prepare(
          `INSERT INTO platform_browser_oauth_transactions
             (state_hash, browser_binding_hash, code_verifier, code_challenge,
              client_id, redirect_uri, resource, scopes_json, return_to,
              expires_at_ms, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          transaction.stateHash,
          transaction.browserBindingHash,
          transaction.codeVerifier,
          transaction.codeChallenge,
          transaction.clientId,
          transaction.redirectUri,
          transaction.resource,
          JSON.stringify(transaction.scopes),
          transaction.returnTo,
          transaction.expiresAt,
          now(),
        )
        .run();
    },

    async consume(input) {
      const session = primary(database);
      const row = await session
        .prepare(
          `DELETE FROM platform_browser_oauth_transactions
           WHERE state_hash = ?
             AND browser_binding_hash = ?
             AND expires_at_ms > ?
           RETURNING state_hash, browser_binding_hash, code_verifier,
             code_challenge, client_id, redirect_uri, resource, scopes_json,
             return_to, expires_at_ms, created_at_ms`,
        )
        .bind(input.stateHash, input.browserBindingHash, input.now)
        .first<BrowserTransactionRow>();
      return row ? parseRow(row) : null;
    },

    async cleanup(input) {
      const session = primary(database);
      const result = await session
        .prepare(
          `DELETE FROM platform_browser_oauth_transactions
           WHERE state_hash IN (
             SELECT state_hash
             FROM platform_browser_oauth_transactions
             WHERE expires_at_ms <= ?
             ORDER BY expires_at_ms ASC, state_hash ASC
             LIMIT ?
           )`,
        )
        .bind(input.now, input.limit)
        .run();
      return result.meta.changes ?? 0;
    },
  };
}
