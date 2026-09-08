PRAGMA foreign_keys = ON;

CREATE TABLE gateway_routes (
  id TEXT PRIMARY KEY,
  service_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE TABLE connection_accounts (
  account_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE
    REFERENCES connections(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK (
    (status = 'retired' AND retired_at IS NOT NULL) OR
    (status = 'active' AND retired_at IS NULL)
  )
);

CREATE INDEX gateway_routes_service_status_idx
  ON gateway_routes(service_principal_id, status, id);
CREATE INDEX connection_accounts_connection_status_idx
  ON connection_accounts(connection_id, status, account_id);

CREATE TRIGGER ingestion_gateway_routes_insert_no_replace
BEFORE INSERT ON gateway_routes
WHEN EXISTS (
  SELECT 1 FROM gateway_routes
  WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'gateway_route_history_immutable');
END;

CREATE TRIGGER ingestion_gateway_routes_immutable
BEFORE UPDATE OF id, service_principal_id ON gateway_routes
BEGIN
  SELECT RAISE(ABORT, 'gateway_route_ownership_immutable');
END;

CREATE TRIGGER ingestion_gateway_routes_no_delete
BEFORE DELETE ON gateway_routes
BEGIN
  SELECT RAISE(ABORT, 'gateway_route_history_immutable');
END;

CREATE TRIGGER ingestion_connection_accounts_insert_no_replace
BEFORE INSERT ON connection_accounts
WHEN EXISTS (
  SELECT 1 FROM connection_accounts
  WHERE account_id = NEW.account_id
     OR connection_id = NEW.connection_id
)
BEGIN
  SELECT RAISE(ABORT, 'connection_account_history_immutable');
END;

CREATE TRIGGER ingestion_connection_accounts_require_route
BEFORE INSERT ON connection_accounts
WHEN NOT EXISTS (
  SELECT 1
  FROM connection_routes AS cr
  JOIN gateway_routes AS gr ON gr.id = cr.gateway_route_id
  WHERE cr.connection_id = NEW.connection_id
)
BEGIN
  SELECT RAISE(ABORT, 'connection_account_route_required');
END;

CREATE TRIGGER ingestion_connection_accounts_immutable
BEFORE UPDATE OF account_id, connection_id ON connection_accounts
BEGIN
  SELECT RAISE(ABORT, 'connection_account_ownership_immutable');
END;

CREATE TRIGGER ingestion_connection_accounts_no_delete
BEFORE DELETE ON connection_accounts
BEGIN
  SELECT RAISE(ABORT, 'connection_account_history_immutable');
END;

CREATE TRIGGER ingestion_connections_ownership_immutable
BEFORE UPDATE OF tenant_id, identity_id, provider ON connections
WHEN EXISTS (
  SELECT 1 FROM connection_accounts AS ca
  WHERE ca.connection_id = OLD.id
)
AND (
  OLD.tenant_id <> NEW.tenant_id OR
  OLD.identity_id <> NEW.identity_id OR
  OLD.provider <> NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'connection_ownership_immutable');
END;

CREATE TRIGGER ingestion_principals_ownership_immutable
BEFORE UPDATE OF issuer, subject, principal_type ON principals
WHEN EXISTS (
  SELECT 1 FROM gateway_routes AS gr
  WHERE gr.service_principal_id = OLD.id
)
AND (
  OLD.issuer <> NEW.issuer OR
  OLD.subject <> NEW.subject OR
  OLD.principal_type <> NEW.principal_type
)
BEGIN
  SELECT RAISE(ABORT, 'principal_ownership_immutable');
END;

CREATE TRIGGER ingestion_connection_routes_ownership_immutable
BEFORE UPDATE OF gateway_route_id ON connection_routes
WHEN EXISTS (
  SELECT 1 FROM connection_accounts AS ca
  WHERE ca.connection_id = OLD.connection_id
)
AND OLD.gateway_route_id <> NEW.gateway_route_id
BEGIN
  SELECT RAISE(ABORT, 'connection_route_ownership_immutable');
END;

CREATE TRIGGER ingestion_connection_routes_connection_immutable
BEFORE UPDATE OF connection_id ON connection_routes
BEGIN
  SELECT RAISE(ABORT, 'connection_route_connection_immutable');
END;

CREATE TRIGGER ingestion_connection_routes_insert_no_replace
BEFORE INSERT ON connection_routes
WHEN EXISTS (
  SELECT 1 FROM connection_accounts AS ca
  WHERE ca.connection_id = NEW.connection_id
)
BEGIN
  SELECT RAISE(ABORT, 'connection_route_history_immutable');
END;

CREATE TRIGGER ingestion_connection_routes_no_delete
BEFORE DELETE ON connection_routes
WHEN EXISTS (
  SELECT 1 FROM connection_accounts AS ca
  WHERE ca.connection_id = OLD.connection_id
)
BEGIN
  SELECT RAISE(ABORT, 'connection_route_history_immutable');
END;

CREATE TRIGGER ingestion_principals_revocation_insert_no_replace
BEFORE INSERT ON principals
WHEN EXISTS (
  SELECT 1
  FROM principals AS p
  WHERE p.id = NEW.id
    AND (p.status = 'revoked' OR p.revoked_at IS NOT NULL)
)
OR EXISTS (
  SELECT 1
  FROM principals AS p
  WHERE p.issuer = NEW.issuer
    AND p.subject = NEW.subject
    AND (p.status = 'revoked' OR p.revoked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'principal_revocation_terminal');
END;

CREATE TRIGGER ingestion_principals_revocation_no_delete
BEFORE DELETE ON principals
WHEN OLD.status = 'revoked' OR OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'principal_revocation_terminal');
END;

CREATE TRIGGER ingestion_principals_revocation_identity_immutable
BEFORE UPDATE OF id, issuer, subject, principal_type ON principals
WHEN (OLD.status = 'revoked' OR OLD.revoked_at IS NOT NULL)
AND (
  OLD.id <> NEW.id OR
  OLD.issuer <> NEW.issuer OR
  OLD.subject <> NEW.subject OR
  OLD.principal_type <> NEW.principal_type
)
BEGIN
  SELECT RAISE(ABORT, 'principal_revocation_identity_immutable');
END;

CREATE TRIGGER ingestion_principals_revocation_identity_conflict
BEFORE UPDATE ON principals
WHEN EXISTS (
  SELECT 1
  FROM principals AS p
  WHERE p.id = NEW.id
    AND p.id <> OLD.id
    AND (p.status = 'revoked' OR p.revoked_at IS NOT NULL)
)
OR EXISTS (
  SELECT 1
  FROM principals AS p
  WHERE p.issuer = NEW.issuer
    AND p.subject = NEW.subject
    AND p.id <> OLD.id
    AND (p.status = 'revoked' OR p.revoked_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'principal_revocation_identity_conflict');
END;

CREATE TRIGGER ingestion_principals_revocation_terminal
BEFORE UPDATE OF status, revoked_at ON principals
WHEN
  (OLD.status = 'revoked' AND (
    NEW.status <> 'revoked' OR
    (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  )) OR
  (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at) OR
  (NEW.status <> 'revoked' AND NEW.revoked_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'principal_revocation_terminal');
END;

CREATE TRIGGER ingestion_revoked_tokens_insert_no_replace
BEFORE INSERT ON revoked_tokens
WHEN EXISTS (
  SELECT 1 FROM revoked_tokens
  WHERE issuer = NEW.issuer
    AND token_id = NEW.token_id
)
BEGIN
  SELECT RAISE(ABORT, 'revoked_token_append_only');
END;

CREATE TRIGGER ingestion_revoked_tokens_append_only
BEFORE UPDATE ON revoked_tokens
BEGIN
  SELECT RAISE(ABORT, 'revoked_token_append_only');
END;

CREATE TRIGGER ingestion_revoked_tokens_no_delete
BEFORE DELETE ON revoked_tokens
BEGIN
  SELECT RAISE(ABORT, 'revoked_token_append_only');
END;

CREATE TRIGGER ingestion_connection_accounts_retirement_terminal
BEFORE UPDATE OF status, retired_at ON connection_accounts
WHEN
  (OLD.status = 'retired' AND (
    NEW.status <> 'retired' OR NEW.retired_at IS NOT OLD.retired_at
  )) OR
  (NEW.status = 'retired' AND NEW.retired_at IS NULL) OR
  (NEW.status = 'active' AND NEW.retired_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'connection_account_retirement_terminal');
END;

CREATE TRIGGER ingestion_gateway_routes_revocation_terminal
BEFORE UPDATE OF status, revoked_at ON gateway_routes
WHEN
  (OLD.status = 'revoked' AND (
    NEW.status <> 'revoked' OR NEW.revoked_at IS NOT OLD.revoked_at
  )) OR
  (NEW.status = 'revoked' AND NEW.revoked_at IS NULL) OR
  (NEW.status <> 'revoked' AND NEW.revoked_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'gateway_route_revocation_terminal');
END;
