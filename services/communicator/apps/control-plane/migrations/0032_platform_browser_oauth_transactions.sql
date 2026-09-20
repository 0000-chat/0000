-- Shared Platform browser helper state. The verifier and browser binding are
-- retained server-side only; consumption is one atomic matching delete.
CREATE TABLE platform_browser_oauth_transactions (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) > 0),
  browser_binding_hash TEXT NOT NULL CHECK (length(browser_binding_hash) > 0),
  code_verifier TEXT NOT NULL CHECK (length(code_verifier) > 0),
  code_challenge TEXT NOT NULL CHECK (length(code_challenge) > 0),
  client_id TEXT NOT NULL CHECK (length(client_id) > 0),
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) > 0),
  resource TEXT NOT NULL CHECK (length(resource) > 0),
  scopes_json TEXT NOT NULL,
  return_to TEXT NOT NULL CHECK (length(return_to) > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX platform_browser_oauth_transactions_expiry_idx
  ON platform_browser_oauth_transactions(expires_at_ms, state_hash);

