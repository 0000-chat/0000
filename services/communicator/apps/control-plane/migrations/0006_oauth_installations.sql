PRAGMA foreign_keys = ON;

-- Client registrations are deployment-owned.  A registration is an exact
-- client/redirect pair; dynamic registration is deliberately outside T02.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The installation is separate from the human who consented and from the
-- logical agent identity that administrators may later grant accounts to.
CREATE TABLE oauth_client_installations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  human_issuer TEXT NOT NULL,
  human_subject TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, membership_id, identity_id, client_id, resource),
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status = 'active' AND revoked_at IS NULL)
  )
);

-- Client-facing AS transactions retain only the challenge.  The client owns
-- the verifier and sends it to /oauth/token; this table never stores it.
CREATE TABLE oauth_authorization_transactions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  client_state TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  human_issuer TEXT NOT NULL,
  human_subject TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consent_hash TEXT NOT NULL,
  consented_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE oauth_authorization_codes (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE
    REFERENCES oauth_authorization_transactions(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

-- This row is used only when the authorization endpoint is acting as an
-- upstream OIDC client.  Its encrypted verifier is separate from the
-- client-facing PKCE transaction and is deleted by the callback path.
CREATE TABLE oauth_upstream_login_transactions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  client_state TEXT NOT NULL,
  client_code_challenge TEXT NOT NULL,
  upstream_nonce TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  verifier_iv TEXT NOT NULL,
  tenant_hint TEXT,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX oauth_installations_client_idx
  ON oauth_client_installations(client_id, status, resource, id);
CREATE INDEX oauth_installations_principal_idx
  ON oauth_client_installations(principal_id, status, id);
CREATE INDEX oauth_transactions_expiry_idx
  ON oauth_authorization_transactions(expires_at, completed_at, id);
CREATE INDEX oauth_codes_expiry_idx
  ON oauth_authorization_codes(expires_at, consumed_at, id);
CREATE INDEX oauth_upstream_expiry_idx
  ON oauth_upstream_login_transactions(expires_at, completed_at, id);
