-- Consumer fixture for the shared Platform browser OAuth transaction boundary.
-- A real consumer owns this table and supplies the atomic consume operation.
CREATE TABLE IF NOT EXISTS fixture_browser_oauth_transaction (
  state_hash TEXT PRIMARY KEY NOT NULL,
  browser_binding_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS fixture_browser_oauth_transaction_expiry_idx
  ON fixture_browser_oauth_transaction(expires_at);
