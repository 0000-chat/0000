PRAGMA foreign_keys = ON;

-- Subscription definitions are control-plane state. Delivery execution is a
-- later ticket, but its durable work rows are created here so destination
-- cutover and revocation can cancel pending work without touching another
-- subscription.
CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  creation_idempotency_key TEXT NOT NULL UNIQUE,
  owner_installation_id TEXT,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  creator_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  creator_membership_id TEXT NOT NULL,
  creator_identity_id TEXT,
  logical_agent_id TEXT,
  ownership_mode TEXT NOT NULL CHECK (ownership_mode IN (
    'installation', 'shared_installation', 'human_owner', 'administrator'
  )),
  destination_url TEXT NOT NULL CHECK (length(destination_url) BETWEEN 12 AND 2048),
  -- Opaque deployment-owned label only. T14/T15 must resolve credentials from
  -- an owner-scoped registry before any network delivery is implemented.
  destination_credential_ref TEXT CHECK (
    destination_credential_ref IS NULL OR length(destination_credential_ref) BETWEEN 1 AND 256
  ),
  destination_version INTEGER NOT NULL DEFAULT 1 CHECK (destination_version >= 1),
  event_filter_json TEXT NOT NULL CHECK (json_valid(event_filter_json)),
  global_enabled INTEGER NOT NULL CHECK (global_enabled IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, creator_membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, creator_identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, logical_agent_id)
    REFERENCES identities(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_installation_id)
    REFERENCES oauth_client_installations(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status = 'active' AND revoked_at IS NULL)
  )
);

CREATE TABLE webhook_subscription_account_rules (
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, account_id),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES webhook_subscriptions(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE webhook_subscription_chat_rules (
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, account_id, chat_id),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES webhook_subscriptions(tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER webhook_account_rule_tenant_match
BEFORE INSERT ON webhook_subscription_account_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM connection_accounts AS ca
  JOIN connections AS c ON c.id = ca.connection_id
  WHERE ca.account_id = NEW.account_id
    AND c.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'webhook_account_rule_tenant_mismatch');
END;

CREATE TRIGGER webhook_chat_rule_tenant_match
BEFORE INSERT ON webhook_subscription_chat_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM connection_accounts AS ca
  JOIN connections AS c ON c.id = ca.connection_id
  WHERE ca.account_id = NEW.account_id
    AND c.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'webhook_chat_rule_tenant_mismatch');
END;

-- This ledger is deliberately transport-neutral. T14 owns HTTP delivery and
-- retries; T13 only needs pending rows to be cancellable during cutover.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  destination_version INTEGER NOT NULL CHECK (destination_version >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'delivered', 'failed', 'cancelled'
  )),
  first_pending_at TEXT NOT NULL,
  retry_deadline TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  UNIQUE (subscription_id, source_event_id),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES webhook_subscriptions(tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL) OR
    (status <> 'cancelled' AND cancelled_at IS NULL)
  )
);

CREATE INDEX webhook_subscriptions_tenant_status_idx
  ON webhook_subscriptions(tenant_id, status, id);
CREATE INDEX webhook_subscriptions_owner_installation_idx
  ON webhook_subscriptions(owner_installation_id, status, id);
CREATE INDEX webhook_account_rules_account_idx
  ON webhook_subscription_account_rules(tenant_id, account_id, subscription_id);
CREATE INDEX webhook_chat_rules_chat_idx
  ON webhook_subscription_chat_rules(tenant_id, account_id, chat_id, subscription_id);
CREATE INDEX webhook_deliveries_cancel_idx
  ON webhook_deliveries(subscription_id, destination_version, status, id);
