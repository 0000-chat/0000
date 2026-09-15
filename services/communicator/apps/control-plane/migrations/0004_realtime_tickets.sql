CREATE TABLE realtime_tickets (
  ticket_digest TEXT PRIMARY KEY CHECK(length(ticket_digest) = 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL,
  subscriptions_json TEXT NOT NULL CHECK(json_valid(subscriptions_json)),
  resume_json TEXT NOT NULL CHECK(json_valid(resume_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX realtime_tickets_expiry_idx
  ON realtime_tickets(expires_at_ms, ticket_digest);
