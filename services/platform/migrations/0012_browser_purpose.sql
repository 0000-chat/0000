-- T11 first-party human browser installations.
-- Existing trusted clients, flows and installations remain personal harnesses.
-- Purpose is deployment-trusted and immutable; request data never changes it.

ALTER TABLE platform_oauth_client
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'personal_harness'
  CHECK (purpose IN ('personal_harness', 'first_party_browser'));

ALTER TABLE platform_oauth_flow
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'personal_harness'
  CHECK (purpose IN ('personal_harness', 'first_party_browser'));

ALTER TABLE platform_oauth_installation
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'personal_harness'
  CHECK (purpose IN ('personal_harness', 'first_party_browser'));

CREATE TRIGGER IF NOT EXISTS platform_oauth_client_purpose_immutable
BEFORE UPDATE OF purpose ON platform_oauth_client
WHEN NEW.purpose <> OLD.purpose
BEGIN
  SELECT RAISE(ABORT, 'oauth client purpose is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_flow_purpose_immutable
BEFORE UPDATE OF purpose ON platform_oauth_flow
WHEN NEW.purpose <> OLD.purpose
BEGIN
  SELECT RAISE(ABORT, 'oauth flow purpose is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_installation_purpose_immutable
BEFORE UPDATE OF purpose ON platform_oauth_installation
WHEN NEW.purpose <> OLD.purpose
BEGIN
  SELECT RAISE(ABORT, 'oauth installation purpose is immutable');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_installation_purpose_insert_guard
BEFORE INSERT ON platform_oauth_installation
WHEN EXISTS (
  SELECT 1 FROM platform_oauth_client
  WHERE client_id = NEW.client_id AND purpose <> NEW.purpose
)
 OR (
  NEW.purpose = 'first_party_browser'
  AND NOT EXISTS (
    SELECT 1 FROM platform_oauth_client
    WHERE client_id = NEW.client_id AND purpose = 'first_party_browser'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'oauth installation purpose mismatch');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_family_purpose_guard
BEFORE INSERT ON platform_oauth_refresh_family
WHEN EXISTS (
  SELECT 1 FROM platform_oauth_installation
  WHERE id = NEW.installation_id AND purpose <> 'personal_harness'
)
BEGIN
  SELECT RAISE(ABORT, 'first-party browser OAuth cannot refresh');
END;

DROP TRIGGER IF EXISTS platform_oauth_credential_shape_insert;
DROP TRIGGER IF EXISTS platform_oauth_credential_shape_update;

CREATE TRIGGER IF NOT EXISTS platform_oauth_credential_shape_insert
BEFORE INSERT ON platform_credential
WHEN NEW.oauth_origin IS NOT NULL
 AND NOT (
   NEW.oauth_origin = 'better-auth'
   AND NEW.oauth_installation_id IS NOT NULL
   AND NEW.oauth_provider_row_id IS NOT NULL
   AND NEW.oauth_provider_token_hash IS NOT NULL
   AND EXISTS (
     SELECT 1
     FROM platform_oauth_installation AS installation
     WHERE installation.id = NEW.oauth_installation_id
       AND installation.audience = NEW.audience
       AND (
         (installation.purpose = 'first_party_browser'
          AND NEW.kind = 'human'
          AND NEW.subject_id = installation.user_id
          AND NEW.organization_id = installation.organization_id
          AND NEW.membership_id = installation.membership_id
          AND NEW.grant_id IS NULL)
         OR
         (installation.purpose = 'personal_harness'
          AND NEW.kind = 'agent'
          AND NEW.subject_id = installation.subject_id
          AND NEW.organization_id = installation.organization_id
          AND NEW.membership_id = installation.membership_id
          AND NEW.grant_id = installation.grant_id)
       )
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid oauth credential binding');
END;

CREATE TRIGGER IF NOT EXISTS platform_oauth_credential_shape_update
BEFORE UPDATE OF oauth_origin, oauth_installation_id, oauth_provider_row_id,
  oauth_provider_token_hash, kind, subject_id, organization_id,
  membership_id, grant_id, audience ON platform_credential
WHEN NEW.oauth_origin IS NOT NULL
 AND NOT (
   NEW.oauth_origin = 'better-auth'
   AND NEW.oauth_installation_id IS NOT NULL
   AND NEW.oauth_provider_row_id IS NOT NULL
   AND NEW.oauth_provider_token_hash IS NOT NULL
   AND EXISTS (
     SELECT 1
     FROM platform_oauth_installation AS installation
     WHERE installation.id = NEW.oauth_installation_id
       AND installation.audience = NEW.audience
       AND (
         (installation.purpose = 'first_party_browser'
          AND NEW.kind = 'human'
          AND NEW.subject_id = installation.user_id
          AND NEW.organization_id = installation.organization_id
          AND NEW.membership_id = installation.membership_id
          AND NEW.grant_id IS NULL)
         OR
         (installation.purpose = 'personal_harness'
          AND NEW.kind = 'agent'
          AND NEW.subject_id = installation.subject_id
          AND NEW.organization_id = installation.organization_id
          AND NEW.membership_id = installation.membership_id
          AND NEW.grant_id = installation.grant_id)
       )
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid oauth credential binding');
END;

-- Refresh records are an external-harness capability. Keep their existing
-- binding guard and make the purpose invariant explicit for corrupt rows.
CREATE TRIGGER IF NOT EXISTS platform_oauth_refresh_family_purpose_update_guard
BEFORE UPDATE OF installation_id ON platform_oauth_refresh_family
WHEN EXISTS (
  SELECT 1 FROM platform_oauth_installation
  WHERE id = NEW.installation_id AND purpose <> 'personal_harness'
)
BEGIN
  SELECT RAISE(ABORT, 'first-party browser OAuth cannot refresh');
END;
