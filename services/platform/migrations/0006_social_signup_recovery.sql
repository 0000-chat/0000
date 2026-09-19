ALTER TABLE "user" ADD COLUMN pendingSocialProviderId TEXT;
ALTER TABLE "user" ADD COLUMN pendingSocialSubject TEXT;

CREATE UNIQUE INDEX platform_user_pending_social_unique
  ON "user" (pendingSocialProviderId, pendingSocialSubject)
  WHERE pendingSocialProviderId IS NOT NULL
    AND pendingSocialSubject IS NOT NULL;

CREATE UNIQUE INDEX account_provider_account_unique
  ON "account" (providerId, accountId);

CREATE TRIGGER platform_pending_social_shape_insert
BEFORE INSERT ON "user"
WHEN (NEW.pendingSocialProviderId IS NULL) <> (NEW.pendingSocialSubject IS NULL)
  OR NEW.pendingSocialProviderId IS NOT NULL
     AND NEW.pendingSocialProviderId NOT IN ('github', 'google')
  OR NEW.pendingSocialProviderId IS NOT NULL
     AND length(trim(NEW.pendingSocialSubject)) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid pending social binding');
END;

CREATE TRIGGER platform_pending_social_shape_update
BEFORE UPDATE OF pendingSocialProviderId, pendingSocialSubject ON "user"
WHEN (NEW.pendingSocialProviderId IS NULL) <> (NEW.pendingSocialSubject IS NULL)
  OR NEW.pendingSocialProviderId IS NOT NULL
     AND NEW.pendingSocialProviderId NOT IN ('github', 'google')
  OR NEW.pendingSocialProviderId IS NOT NULL
     AND length(trim(NEW.pendingSocialSubject)) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid pending social binding');
END;

CREATE TRIGGER platform_pending_social_existing_account
BEFORE INSERT ON "user"
WHEN NEW.pendingSocialProviderId IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "account"
    WHERE providerId = NEW.pendingSocialProviderId
      AND accountId = NEW.pendingSocialSubject
  )
BEGIN
  SELECT RAISE(ABORT, 'pending social binding already has an account');
END;

CREATE TRIGGER platform_pending_social_clear
AFTER INSERT ON "account"
WHEN EXISTS (
  SELECT 1
  FROM "user"
  WHERE "user".id = NEW.userId
    AND pendingSocialProviderId = NEW.providerId
    AND pendingSocialSubject = NEW.accountId
)
BEGIN
  UPDATE "user"
  SET pendingSocialProviderId = NULL,
      pendingSocialSubject = NULL
  WHERE id = NEW.userId
    AND pendingSocialProviderId = NEW.providerId
    AND pendingSocialSubject = NEW.accountId;
END;
