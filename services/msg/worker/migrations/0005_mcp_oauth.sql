-- Account-free OAuth 2.1 state for the MCP resource server.
-- Secrets are never stored in clear text. Values ending in `_hash` are
-- SHA-256 base64url digests of high-entropy opaque values.

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_clients_expiry ON mcp_oauth_clients(expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_requests (
  request_id TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id),
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_authorization_requests_expiry ON mcp_oauth_authorization_requests(expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_principals (
  principal_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_principals_revoked ON mcp_oauth_principals(revoked_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  principal_id TEXT NOT NULL REFERENCES mcp_oauth_principals(principal_id),
  thread_url TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (principal_id, thread_url)
);
CREATE INDEX IF NOT EXISTS mcp_oauth_grants_thread ON mcp_oauth_grants(thread_url, revoked_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES mcp_oauth_authorization_requests(request_id),
  principal_id TEXT NOT NULL REFERENCES mcp_oauth_principals(principal_id),
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id),
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_authorization_codes_expiry ON mcp_oauth_authorization_codes(expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES mcp_oauth_principals(principal_id),
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id),
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_access_tokens_principal ON mcp_oauth_access_tokens(principal_id, revoked_at);
CREATE INDEX IF NOT EXISTS mcp_oauth_access_tokens_expiry ON mcp_oauth_access_tokens(expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES mcp_oauth_principals(principal_id),
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id),
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_by_hash TEXT,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_refresh_tokens_family ON mcp_oauth_refresh_tokens(family_id, revoked_at);
CREATE INDEX IF NOT EXISTS mcp_oauth_refresh_tokens_expiry ON mcp_oauth_refresh_tokens(expires_at);
