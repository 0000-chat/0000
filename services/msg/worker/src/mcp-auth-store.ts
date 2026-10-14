import type { D1DatabaseLike } from "./operations";

export interface McpOAuthClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export interface McpAuthorizationRequest {
  readonly requestId: string;
  readonly stateValue: string;
  readonly stateHash: string;
  readonly csrfHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly resource: string;
  readonly codeChallenge: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly completedAt: number | null;
}

export interface McpAuthorizationCode {
  readonly codeHash: string;
  readonly requestId: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly resource: string;
  readonly codeChallenge: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
}

export interface McpAccessToken {
  readonly tokenHash: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface McpRefreshToken {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
  readonly replacedByHash: string | null;
  readonly revokedAt: number | null;
}

export interface McpGrant {
  readonly principalId: string;
  readonly threadUrl: string;
  readonly scope: string;
  /** Public-link grants stop when the owner revokes links; explicit grants may survive. */
  readonly source?: "public" | "explicit";
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export interface McpAuthStore {
  createClient(client: McpOAuthClient): Promise<void>;
  getClient(clientId: string, now: number): Promise<McpOAuthClient | null>;
  createAuthorizationRequest(request: McpAuthorizationRequest): Promise<void>;
  getAuthorizationRequest(requestId: string, now: number): Promise<McpAuthorizationRequest | null>;
  completeAuthorizationRequest(requestId: string, now: number): Promise<McpAuthorizationRequest | null>;
  createPrincipal(principalId: string, createdAt: number): Promise<void>;
  upsertGrant(grant: McpGrant): Promise<void>;
  getGrant(principalId: string, threadUrl: string): Promise<McpGrant | null>;
  getAuthorizationCode(codeHash: string, now: number): Promise<McpAuthorizationCode | null>;
  consumeAuthorizationCode(codeHash: string, now: number): Promise<McpAuthorizationCode | null>;
  createAuthorizationCode(code: McpAuthorizationCode): Promise<void>;
  createAccessToken(token: McpAccessToken): Promise<void>;
  getAccessToken(tokenHash: string, now: number): Promise<McpAccessToken | null>;
  revokeAccessToken(tokenHash: string, now: number): Promise<void>;
  createRefreshToken(token: McpRefreshToken): Promise<void>;
  getRefreshToken(tokenHash: string, now: number): Promise<McpRefreshToken | null>;
  markRefreshTokenUsed(tokenHash: string, replacedByHash: string, now: number): Promise<boolean>;
  revokeRefreshFamily(familyId: string, principalId: string, now: number): Promise<void>;
  revokePrincipal(principalId: string, now: number): Promise<void>;
  isPrincipalRevoked(principalId: string): Promise<boolean>;
  purgeExpired(now: number): Promise<void>;
}

interface ClientRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: string;
  readonly created_at: number;
  readonly expires_at: number | null;
}

interface AuthorizationRequestRow {
  readonly request_id: string;
  readonly state_value: string;
  readonly state_hash: string;
  readonly csrf_hash: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope: string;
  readonly resource: string;
  readonly code_challenge: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly completed_at: number | null;
}

interface AuthorizationCodeRow {
  readonly code_hash: string;
  readonly request_id: string;
  readonly principal_id: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope: string;
  readonly resource: string;
  readonly code_challenge: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly used_at: number | null;
}

interface AccessTokenRow {
  readonly token_hash: string;
  readonly principal_id: string;
  readonly client_id: string;
  readonly scope: string;
  readonly resource: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

interface RefreshTokenRow {
  readonly token_hash: string;
  readonly family_id: string;
  readonly principal_id: string;
  readonly client_id: string;
  readonly scope: string;
  readonly resource: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly used_at: number | null;
  readonly replaced_by_hash: string | null;
  readonly revoked_at: number | null;
}

interface GrantRow {
  readonly principal_id: string;
  readonly thread_url: string;
  readonly scope: string;
  readonly grant_source?: "public" | "explicit";
  readonly created_at: number;
  readonly revoked_at: number | null;
}

/** D1 persistence for MCP OAuth. Raw bearer values never cross this boundary. */
export class D1McpAuthStore implements McpAuthStore {
  constructor(private readonly d1: D1DatabaseLike) {}

  async createClient(client: McpOAuthClient): Promise<void> {
    await this.d1.prepare("INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(client.clientId, client.clientName, JSON.stringify(client.redirectUris), client.createdAt, client.expiresAt)
      .run();
  }

  async getClient(clientId: string, now: number): Promise<McpOAuthClient | null> {
    const row = await this.d1.prepare("SELECT client_id, client_name, redirect_uris, created_at, expires_at FROM mcp_oauth_clients WHERE client_id = ? AND (expires_at IS NULL OR expires_at > ?)")
      .bind(clientId, now).first<ClientRow>();
    if (!row) return null;
    let redirectUris: unknown;
    try {
      redirectUris = JSON.parse(row.redirect_uris);
    } catch {
      return null;
    }
    if (!Array.isArray(redirectUris) || !redirectUris.every((value): value is string => typeof value === "string")) return null;
    return { clientId: row.client_id, clientName: row.client_name, redirectUris, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  async createAuthorizationRequest(request: McpAuthorizationRequest): Promise<void> {
    await this.d1.prepare("INSERT INTO mcp_oauth_authorization_requests (request_id, state_value, state_hash, csrf_hash, client_id, redirect_uri, scope, resource, code_challenge, created_at, expires_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .bind(request.requestId, request.stateValue, request.stateHash, request.csrfHash, request.clientId, request.redirectUri, request.scope, request.resource, request.codeChallenge, request.createdAt, request.expiresAt)
      .run();
  }

  async getAuthorizationRequest(requestId: string, now: number): Promise<McpAuthorizationRequest | null> {
    const row = await this.d1.prepare("SELECT request_id, state_value, state_hash, csrf_hash, client_id, redirect_uri, scope, resource, code_challenge, created_at, expires_at, completed_at FROM mcp_oauth_authorization_requests WHERE request_id = ? AND expires_at > ?")
      .bind(requestId, now).first<AuthorizationRequestRow>();
    return row ? authorizationRequest(row) : null;
  }

  async completeAuthorizationRequest(requestId: string, now: number): Promise<McpAuthorizationRequest | null> {
    const updated = await this.d1.prepare("UPDATE mcp_oauth_authorization_requests SET completed_at = ? WHERE request_id = ? AND completed_at IS NULL AND expires_at > ?")
      .bind(now, requestId, now).run();
    if ((updated.meta?.changes ?? 0) !== 1) return null;
    return this.getAuthorizationRequest(requestId, now);
  }

  async createPrincipal(principalId: string, createdAt: number): Promise<void> {
    await this.d1.prepare("INSERT INTO mcp_oauth_principals (principal_id, created_at, revoked_at) VALUES (?, ?, NULL)")
      .bind(principalId, createdAt).run();
  }

  async upsertGrant(grant: McpGrant): Promise<void> {
    await this.d1.prepare("INSERT INTO mcp_oauth_grants (principal_id, thread_url, scope, created_at, revoked_at, grant_source) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(principal_id, thread_url) DO UPDATE SET scope = excluded.scope, revoked_at = NULL")
      .bind(grant.principalId, grant.threadUrl, grant.scope, grant.createdAt, grant.source ?? "public").run();
  }

  async getGrant(principalId: string, threadUrl: string): Promise<McpGrant | null> {
    const row = await this.d1.prepare("SELECT principal_id, thread_url, scope, created_at, revoked_at, grant_source FROM mcp_oauth_grants WHERE principal_id = ? AND thread_url = ? AND revoked_at IS NULL")
      .bind(principalId, threadUrl).first<GrantRow>();
    return row ? { principalId: row.principal_id, threadUrl: row.thread_url, scope: row.scope, source: row.grant_source ?? "public", createdAt: row.created_at, revokedAt: row.revoked_at } : null;
  }

  async createAuthorizationCode(code: McpAuthorizationCode): Promise<void> {
    await this.d1.prepare("INSERT INTO mcp_oauth_authorization_codes (code_hash, request_id, principal_id, client_id, redirect_uri, scope, resource, code_challenge, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .bind(code.codeHash, code.requestId, code.principalId, code.clientId, code.redirectUri, code.scope, code.resource, code.codeChallenge, code.createdAt, code.expiresAt).run();
  }

  async getAuthorizationCode(codeHash: string, now: number): Promise<McpAuthorizationCode | null> {
    const row = await this.d1.prepare("SELECT code_hash, request_id, principal_id, client_id, redirect_uri, scope, resource, code_challenge, created_at, expires_at, used_at FROM mcp_oauth_authorization_codes WHERE code_hash = ? AND expires_at > ? AND used_at IS NULL")
      .bind(codeHash, now).first<AuthorizationCodeRow>();
    return row ? authorizationCode(row) : null;
  }

  async consumeAuthorizationCode(codeHash: string, now: number): Promise<McpAuthorizationCode | null> {
    const updated = await this.d1.prepare("UPDATE mcp_oauth_authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .bind(now, codeHash, now).run();
    if ((updated.meta?.changes ?? 0) !== 1) return null;
    const row = await this.d1.prepare("SELECT code_hash, request_id, principal_id, client_id, redirect_uri, scope, resource, code_challenge, created_at, expires_at, used_at FROM mcp_oauth_authorization_codes WHERE code_hash = ?")
      .bind(codeHash).first<AuthorizationCodeRow>();
    return row ? authorizationCode(row) : null;
  }

  async createAccessToken(token: McpAccessToken): Promise<void> {
    await this.d1.prepare("INSERT INTO mcp_oauth_access_tokens (token_hash, principal_id, client_id, scope, resource, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .bind(token.tokenHash, token.principalId, token.clientId, token.scope, token.resource, token.createdAt, token.expiresAt).run();
  }

  async getAccessToken(tokenHash: string, now: number): Promise<McpAccessToken | null> {
    const row = await this.d1.prepare("SELECT token_hash, principal_id, client_id, scope, resource, created_at, expires_at, revoked_at FROM mcp_oauth_access_tokens WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL")
      .bind(tokenHash, now).first<AccessTokenRow>();
    return row ? accessToken(row) : null;
  }

  async revokeAccessToken(tokenHash: string, now: number): Promise<void> {
    await this.d1.prepare("UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(now, tokenHash).run();
  }

  async createRefreshToken(token: McpRefreshToken): Promise<void> {
    await this.d1.prepare("INSERT INTO mcp_oauth_refresh_tokens (token_hash, family_id, principal_id, client_id, scope, resource, created_at, expires_at, used_at, replaced_by_hash, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
      .bind(token.tokenHash, token.familyId, token.principalId, token.clientId, token.scope, token.resource, token.createdAt, token.expiresAt).run();
  }

  async getRefreshToken(tokenHash: string, now: number): Promise<McpRefreshToken | null> {
    const row = await this.d1.prepare("SELECT token_hash, family_id, principal_id, client_id, scope, resource, created_at, expires_at, used_at, replaced_by_hash, revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash = ? AND expires_at > ?")
      .bind(tokenHash, now).first<RefreshTokenRow>();
    return row ? refreshToken(row) : null;
  }

  async markRefreshTokenUsed(tokenHash: string, replacedByHash: string, now: number): Promise<boolean> {
    const result = await this.d1.prepare("UPDATE mcp_oauth_refresh_tokens SET used_at = ?, replaced_by_hash = ? WHERE token_hash = ? AND used_at IS NULL AND replaced_by_hash IS NULL AND revoked_at IS NULL AND expires_at > ?")
      .bind(now, replacedByHash, tokenHash, now).run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async revokeRefreshFamily(familyId: string, principalId: string, now: number): Promise<void> {
    await this.d1.prepare("UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").bind(now, familyId).run();
    await this.revokePrincipal(principalId, now);
  }

  async revokePrincipal(principalId: string, now: number): Promise<void> {
    await this.d1.prepare("UPDATE mcp_oauth_principals SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL").bind(now, principalId).run();
    await this.d1.prepare("UPDATE mcp_oauth_grants SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL").bind(now, principalId).run();
    await this.d1.prepare("UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL").bind(now, principalId).run();
    await this.d1.prepare("UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL").bind(now, principalId).run();
  }

  async isPrincipalRevoked(principalId: string): Promise<boolean> {
    const row = await this.d1.prepare("SELECT revoked_at FROM mcp_oauth_principals WHERE principal_id = ?").bind(principalId).first<{ revoked_at: number | null }>();
    return !row || row.revoked_at !== null;
  }

  async purgeExpired(now: number): Promise<void> {
    await this.d1.prepare("DELETE FROM mcp_oauth_authorization_codes WHERE expires_at <= ?").bind(now).run();
    await this.d1.prepare("DELETE FROM mcp_oauth_authorization_requests WHERE expires_at <= ?").bind(now).run();
    await this.d1.prepare("DELETE FROM mcp_oauth_access_tokens WHERE expires_at <= ?").bind(now).run();
    await this.d1.prepare("DELETE FROM mcp_oauth_refresh_tokens WHERE expires_at <= ?").bind(now).run();
    await this.d1.prepare("DELETE FROM mcp_oauth_clients WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now).run();
  }
}

function authorizationRequest(row: AuthorizationRequestRow): McpAuthorizationRequest {
  return { requestId: row.request_id, stateValue: row.state_value, stateHash: row.state_hash, csrfHash: row.csrf_hash, clientId: row.client_id, redirectUri: row.redirect_uri, scope: row.scope, resource: row.resource, codeChallenge: row.code_challenge, createdAt: row.created_at, expiresAt: row.expires_at, completedAt: row.completed_at };
}

function authorizationCode(row: AuthorizationCodeRow): McpAuthorizationCode {
  return { codeHash: row.code_hash, requestId: row.request_id, principalId: row.principal_id, clientId: row.client_id, redirectUri: row.redirect_uri, scope: row.scope, resource: row.resource, codeChallenge: row.code_challenge, createdAt: row.created_at, expiresAt: row.expires_at, usedAt: row.used_at };
}

function accessToken(row: AccessTokenRow): McpAccessToken {
  return { tokenHash: row.token_hash, principalId: row.principal_id, clientId: row.client_id, scope: row.scope, resource: row.resource, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

function refreshToken(row: RefreshTokenRow): McpRefreshToken {
  return { tokenHash: row.token_hash, familyId: row.family_id, principalId: row.principal_id, clientId: row.client_id, scope: row.scope, resource: row.resource, createdAt: row.created_at, expiresAt: row.expires_at, usedAt: row.used_at, replacedByHash: row.replaced_by_hash, revokedAt: row.revoked_at };
}
