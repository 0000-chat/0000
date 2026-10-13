import type {
  BrowserOAuthTransaction,
  BrowserOAuthTransactionStore,
} from "@0000/platform-client";
import {
  selectBrowserCredential,
  type PlatformBrowserClientOptions,
} from "@0000/platform-client";
import {
  handleResourceRequest,
  type ResourceServiceConfig,
} from "./resource-service";

/**
 * Consumer-owned D1 adapter used by the browser prerequisite fixture. The
 * DELETE ... RETURNING statement is the one-use boundary: a read followed by
 * a delete would let concurrent callbacks redeem the same browser transaction.
 */
export class D1BrowserOAuthTransactionStore
  implements BrowserOAuthTransactionStore
{
  constructor(private readonly database: D1Database) {}

  async put(transaction: BrowserOAuthTransaction): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO fixture_browser_oauth_transaction
         (state_hash, browser_binding_hash, code_verifier, code_challenge,
          client_id, redirect_uri, resource, scopes, return_to, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run();
  }

  async consume(input: {
    stateHash: string;
    browserBindingHash: string;
    now: number;
  }): Promise<BrowserOAuthTransaction | null> {
    const row = await this.database
      .prepare(
        `DELETE FROM fixture_browser_oauth_transaction
         WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ?
         RETURNING state_hash, browser_binding_hash, code_verifier,
                   code_challenge, client_id, redirect_uri, resource, scopes,
                   return_to, expires_at`,
      )
      .bind(input.stateHash, input.browserBindingHash, input.now)
      .first<{
        state_hash: string;
        browser_binding_hash: string;
        code_verifier: string;
        code_challenge: string;
        client_id: string;
        redirect_uri: string;
        resource: string;
        scopes: string;
        return_to: string;
        expires_at: number;
      }>();
    if (!row) return null;
    let scopes: unknown;
    try {
      scopes = JSON.parse(row.scopes);
    } catch {
      return null;
    }
    if (
      !Array.isArray(scopes) ||
      !scopes.every((scope) => typeof scope === "string")
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
      expiresAt: row.expires_at,
    };
  }

  async cleanup(input: { now: number; limit: number }): Promise<number> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) return 0;
    const result = await this.database
      .prepare(
        `DELETE FROM fixture_browser_oauth_transaction
         WHERE rowid IN (
           SELECT rowid FROM fixture_browser_oauth_transaction
           WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT ?
         )`,
      )
      .bind(input.now, input.limit)
      .run();
    return result.meta.changes;
  }
}

/**
 * Small consumer fixture endpoint: the browser cookie is selected at the
 * service boundary and converted into the verifier's Authorization input.
 * The endpoint never serializes the selected credential.
 */
export async function handleBrowserFixtureRequest(
  request: Request,
  config: ResourceServiceConfig,
  options: Pick<PlatformBrowserClientOptions, "credentialCookieName"> = {},
): Promise<Response> {
  const selected = selectBrowserCredential(
    request,
    options.credentialCookieName,
  );
  if (selected.status !== "present") {
    return Response.json(
      {
        error:
          selected.status === "invalid"
            ? "invalid_credential"
            : "unauthenticated",
      },
      { status: 401 },
    );
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${selected.credential}`);
  return handleResourceRequest(new Request(request, { headers }), config);
}
