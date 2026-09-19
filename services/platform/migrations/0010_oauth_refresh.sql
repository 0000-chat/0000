-- T07 refresh families and Platform-owned rotation lineage.
-- Provider rows are deliberately referenced by opaque IDs only.  Better Auth
-- may delete those rows after a rotation; Platform retains the hashes and
-- lineage needed to recognize replay.

ALTER TABLE platform_oauth_client
  ADD COLUMN refresh_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (refresh_enabled IN (0, 1));

CREATE TABLE IF NOT EXISTS platform_oauth_refresh_family (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL UNIQUE
    REFERENCES platform_oauth_installation(id) ON DELETE RESTRICT,
  client_id TEXT NOT NULL REFERENCES oauthClient(clientId),
  user_id TEXT NOT NULL REFERENCES "user"(id),
  membership_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  service_id TEXT NOT NULL REFERENCES platform_service(service_id),
  audience TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  family_epoch_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'pending', 'revoked', 'quarantined', 'expired')),
  pending_token_id TEXT,
  pending_consumption_nonce TEXT,
  revoked_at INTEGER,
  revoked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'pending' AND pending_token_id IS NOT NULL
          AND pending_consumption_nonce IS NOT NULL)
         OR (state <> 'pending' AND pending_token_id IS NULL
             AND pending_consumption_nonce IS NULL))
);

CREATE INDEX IF NOT EXISTS platform_oauth_refresh_family_owner_idx
  ON platform_oauth_refresh_family(user_id, organization_id, state);
CREATE INDEX IF NOT EXISTS platform_oauth_refresh_family_service_idx
  ON platform_oauth_refresh_family(service_id, audience, state);

CREATE TABLE IF NOT EXISTS platform_oauth_refresh_token (
  id TEXT PRIMARY KEY NOT NULL,
  family_id TEXT NOT NULL
    REFERENCES platform_oauth_refresh_family(id) ON DELETE RESTRICT,
  installation_id TEXT NOT NULL,
  provider_refresh_row_id TEXT NOT NULL UNIQUE,
  provider_refresh_token_hash TEXT NOT NULL UNIQUE,
  provider_access_row_id TEXT UNIQUE,
  predecessor_id TEXT REFERENCES platform_oauth_refresh_token(id) ON DELETE RESTRICT,
  predecessor_consumption_nonce TEXT,
  sequence INTEGER NOT NULL,
  resources TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'pending', 'consumed', 'replayed', 'revoked', 'quarantined', 'expired')),
  consumption_nonce TEXT,
  consumed_at INTEGER,
  replayed_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (family_id, sequence),
  UNIQUE (family_id, predecessor_id),
  CHECK ((sequence = 0 AND predecessor_id IS NULL
          AND predecessor_consumption_nonce IS NULL)
         OR (sequence > 0 AND predecessor_id IS NOT NULL
             AND predecessor_consumption_nonce IS NOT NULL)),
  CHECK ((state IN ('pending', 'consumed', 'replayed')
          AND consumption_nonce IS NOT NULL)
         OR state NOT IN ('pending', 'consumed', 'replayed'))
);

CREATE INDEX IF NOT EXISTS platform_oauth_refresh_token_family_state_idx
  ON platform_oauth_refresh_token(family_id, state, sequence);
CREATE INDEX IF NOT EXISTS platform_oauth_refresh_token_installation_idx
  ON platform_oauth_refresh_token(installation_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS platform_oauth_refresh_consumption_nonce_unique
  ON platform_oauth_refresh_token(consumption_nonce)
  WHERE consumption_nonce IS NOT NULL;

ALTER TABLE platform_credential
  ADD COLUMN oauth_refresh_token_id TEXT
    REFERENCES platform_oauth_refresh_token(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS platform_credential_oauth_refresh_token_unique
  ON platform_credential(oauth_refresh_token_id)
  WHERE oauth_refresh_token_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_family_insert_guard
BEFORE INSERT ON platform_oauth_refresh_family
WHEN NOT EXISTS (
  SELECT 1
  FROM platform_oauth_installation AS i
  JOIN platform_oauth_client AS c ON c.client_id = i.client_id
   AND c.refresh_enabled = 1 AND c.active = 1
  JOIN platform_service AS s ON s.service_id = i.service_id
   AND s.audience = i.audience AND s.disabled = 0
  JOIN platform_oauth_flow AS f ON f.installation_id = i.id
  WHERE i.id = NEW.installation_id
    AND NEW.client_id = i.client_id
    AND NEW.user_id = i.user_id
    AND NEW.membership_id = i.membership_id
    AND NEW.organization_id = i.organization_id
    AND NEW.service_id = i.service_id
    AND NEW.audience = i.audience
    AND NEW.subject_id = i.subject_id
    AND NEW.grant_id = i.grant_id
    AND NEW.capabilities = i.capabilities
    AND NEW.state = 'pending'
    AND i.active = 0 AND i.revoked_at IS NULL
    AND f.status = 'consumed' AND f.organization_id = i.organization_id
    AND f.membership_id = i.membership_id
    AND f.user_id = i.user_id
    AND f.expires_at > NEW.family_epoch_at
)
BEGIN
  SELECT RAISE(ABORT, 'oauth refresh family authority mismatch');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_family_immutable
BEFORE UPDATE OF installation_id, client_id, user_id, membership_id,
  organization_id, service_id, audience, subject_id, grant_id, capabilities,
  family_epoch_at, expires_at, created_at
ON platform_oauth_refresh_family
BEGIN
  SELECT RAISE(ABORT, 'oauth refresh family authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_family_terminal_guard
BEFORE UPDATE OF state ON platform_oauth_refresh_family
WHEN OLD.state IN ('revoked', 'quarantined', 'expired') AND NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'oauth refresh family is terminal');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_token_insert_guard
BEFORE INSERT ON platform_oauth_refresh_token
WHEN NOT EXISTS (
  SELECT 1
  FROM platform_oauth_refresh_family AS f
  JOIN platform_oauth_installation AS i ON i.id = f.installation_id
  WHERE f.id = NEW.family_id
    AND NEW.installation_id = f.installation_id
    AND NEW.state IN ('pending', 'issued')
    AND (
      (NEW.sequence = 0 AND NEW.predecessor_id IS NULL
       AND NEW.predecessor_consumption_nonce IS NULL)
      OR
      (NEW.sequence > 0 AND NEW.predecessor_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM platform_oauth_refresh_token AS predecessor
         WHERE predecessor.id = NEW.predecessor_id
           AND predecessor.family_id = NEW.family_id
           AND predecessor.state = 'consumed'
           AND predecessor.consumption_nonce = NEW.predecessor_consumption_nonce
           AND predecessor.sequence + 1 = NEW.sequence
       ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.capabilities) AS requested
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(f.capabilities) AS ceiling
        WHERE ceiling.value = requested.value
      )
    )
    AND (
      NEW.sequence = 0 OR NOT EXISTS (
        SELECT 1 FROM json_each(NEW.capabilities) AS requested
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each((SELECT capabilities FROM platform_oauth_refresh_token
                                   WHERE id = NEW.predecessor_id)) AS predecessor
          WHERE predecessor.value = requested.value
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'oauth refresh token lineage mismatch');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_token_immutable
BEFORE UPDATE OF family_id, installation_id, provider_refresh_row_id,
  provider_refresh_token_hash, provider_access_row_id, predecessor_id,
  predecessor_consumption_nonce, sequence, resources, capabilities,
  expires_at, created_at
ON platform_oauth_refresh_token
BEGIN
  SELECT RAISE(ABORT, 'oauth refresh token binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_family_consume_fence
AFTER UPDATE OF state ON platform_oauth_refresh_family
WHEN OLD.state = 'active' AND NEW.state = 'pending'
BEGIN
  UPDATE platform_oauth_refresh_token
  SET state = 'pending', consumption_nonce = NEW.pending_consumption_nonce,
      updated_at = NEW.updated_at
  WHERE id = NEW.pending_token_id AND family_id = NEW.id
    AND state = 'issued';
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'oauth refresh token consume fence failed') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM platform_oauth_refresh_token
    WHERE id = NEW.pending_token_id AND family_id = NEW.id
      AND state = 'pending' AND consumption_nonce = NEW.pending_consumption_nonce
  ) THEN RAISE(ABORT, 'oauth refresh token consume nonce mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_root_publish_guard
BEFORE UPDATE OF state ON platform_oauth_refresh_family
WHEN OLD.state = 'pending' AND NEW.state = 'active'
 AND EXISTS (
   SELECT 1 FROM platform_oauth_refresh_token
   WHERE id = OLD.pending_token_id AND family_id = OLD.id
     AND predecessor_id IS NULL AND state = 'issued'
 )
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM platform_oauth_refresh_token AS t
    JOIN platform_oauth_installation AS i ON i.id = NEW.installation_id
    JOIN platform_oauth_flow AS f ON f.installation_id = i.id
     AND f.status = 'activated'
    JOIN oauthRefreshToken AS r ON r.id = t.provider_refresh_row_id
     AND r.token = t.provider_refresh_token_hash
     AND r.referenceId = i.id AND r.clientId = i.client_id
     AND r.userId = i.user_id AND r.revoked IS NULL
    JOIN oauthAccessToken AS a ON a.id = t.provider_access_row_id
     AND a.refreshId = t.provider_refresh_row_id
     AND a.referenceId = i.id AND a.revoked IS NULL
    JOIN platform_credential AS c ON c.oauth_refresh_token_id = t.id
     AND c.oauth_provider_row_id = a.id AND c.revoked_at IS NULL
    WHERE t.id = OLD.pending_token_id AND t.family_id = NEW.id
      AND t.state = 'issued'
      AND i.id = NEW.installation_id AND i.active = 1
      AND f.installation_id = i.id
      AND OLD.pending_consumption_nonce = t.consumption_nonce
  ) THEN RAISE(ABORT, 'oauth refresh root publication incomplete') END;
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_successor_publish_guard
BEFORE UPDATE OF state ON platform_oauth_refresh_family
WHEN OLD.state = 'pending' AND NEW.state = 'active'
 AND EXISTS (
   SELECT 1 FROM platform_oauth_refresh_token AS t
   WHERE t.id = OLD.pending_token_id AND t.family_id = OLD.id
     AND t.predecessor_id IS NOT NULL
 )
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM platform_oauth_refresh_token AS successor
    JOIN platform_oauth_refresh_token AS predecessor
      ON predecessor.id = successor.predecessor_id
     AND predecessor.family_id = successor.family_id
     AND predecessor.state = 'consumed'
     AND predecessor.consumption_nonce = successor.predecessor_consumption_nonce
    JOIN platform_oauth_installation AS i ON i.id = NEW.installation_id
    JOIN platform_oauth_client AS pc ON pc.client_id = i.client_id
     AND pc.active = 1 AND pc.refresh_enabled = 1
    JOIN oauthClient AS oc ON oc.clientId = i.client_id AND oc.disabled = 0
    JOIN platform_service AS service ON service.service_id = i.service_id
     AND service.audience = i.audience AND service.disabled = 0
    JOIN oauthResource AS resource ON resource.identifier = i.audience
     AND resource.disabled = 0 AND resource.refreshTokenTtl IS NOT NULL
     AND resource.refreshTokenTtl > 0
    JOIN member AS membership ON membership.id = i.membership_id
     AND membership.userId = i.user_id AND membership.organizationId = i.organization_id
    JOIN "user" AS subject_user ON subject_user.id = i.user_id
     AND subject_user.disabledAt IS NULL
    JOIN organization AS owning_org ON owning_org.id = i.organization_id
     AND owning_org.suspendedAt IS NULL
    JOIN oauthConsent AS consent ON consent.clientId = i.client_id
     AND consent.userId = i.user_id AND consent.referenceId = i.id
    JOIN oauthRefreshToken AS r ON r.id = successor.provider_refresh_row_id
     AND r.token = successor.provider_refresh_token_hash
     AND r.referenceId = i.id AND r.clientId = i.client_id
     AND r.userId = i.user_id AND r.revoked IS NULL
    JOIN oauthAccessToken AS a ON a.id = successor.provider_access_row_id
     AND a.refreshId = successor.provider_refresh_row_id
     AND a.referenceId = i.id AND a.revoked IS NULL
    JOIN platform_credential AS c ON c.oauth_refresh_token_id = successor.id
     AND c.oauth_provider_row_id = a.id AND c.revoked_at IS NULL
    JOIN platform_credential AS predecessor_credential
     ON predecessor_credential.oauth_refresh_token_id = predecessor.id
     AND predecessor_credential.revoked_at IS NOT NULL
     AND predecessor_credential.replaced_by_id = successor.id
    WHERE successor.id = OLD.pending_token_id AND successor.family_id = NEW.id
      AND successor.state = 'issued'
      AND OLD.pending_consumption_nonce = successor.predecessor_consumption_nonce
      AND i.id = NEW.installation_id AND i.active = 1
  ) THEN RAISE(ABORT, 'oauth refresh successor publication incomplete') END;
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_credential_shape_insert
BEFORE INSERT ON platform_credential
WHEN NEW.oauth_refresh_token_id IS NOT NULL
 AND (NEW.oauth_origin <> 'better-auth' OR NEW.kind <> 'agent'
      OR NEW.oauth_installation_id IS NULL OR NEW.oauth_provider_row_id IS NULL
      OR NEW.oauth_provider_token_hash IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM platform_oauth_refresh_token AS t
        JOIN platform_oauth_refresh_family AS f ON f.id = t.family_id
        WHERE t.id = NEW.oauth_refresh_token_id
          AND t.installation_id = NEW.oauth_installation_id
          AND t.provider_access_row_id = NEW.oauth_provider_row_id
          AND t.state = 'issued' AND f.state = 'pending'
      ))
BEGIN
  SELECT RAISE(ABORT, 'invalid oauth refresh credential binding');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_credential_shape_update
BEFORE UPDATE OF oauth_refresh_token_id ON platform_credential
WHEN NEW.oauth_refresh_token_id IS NOT OLD.oauth_refresh_token_id
BEGIN
  SELECT RAISE(ABORT, 'oauth refresh credential binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_credential_immutable
BEFORE UPDATE OF credential_hash, kind, subject_id, organization_id,
  membership_id, grant_id, audience, capabilities, resource_ids, expires_at,
  oauth_origin, oauth_installation_id, oauth_provider_row_id,
  oauth_provider_token_hash, oauth_refresh_token_id
ON platform_credential
WHEN OLD.oauth_refresh_token_id IS NOT NULL
 AND (NEW.credential_hash IS NOT OLD.credential_hash
      OR NEW.kind IS NOT OLD.kind
      OR NEW.subject_id IS NOT OLD.subject_id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.membership_id IS NOT OLD.membership_id
      OR NEW.grant_id IS NOT OLD.grant_id
      OR NEW.audience IS NOT OLD.audience
      OR NEW.capabilities IS NOT OLD.capabilities
      OR NEW.resource_ids IS NOT OLD.resource_ids
      OR NEW.expires_at IS NOT OLD.expires_at
      OR NEW.oauth_origin IS NOT OLD.oauth_origin
      OR NEW.oauth_installation_id IS NOT OLD.oauth_installation_id
      OR NEW.oauth_provider_row_id IS NOT OLD.oauth_provider_row_id
      OR NEW.oauth_provider_token_hash IS NOT OLD.oauth_provider_token_hash
      OR NEW.oauth_refresh_token_id IS NOT OLD.oauth_refresh_token_id)
BEGIN
  SELECT RAISE(ABORT, 'oauth refresh credential binding is immutable');
END;
