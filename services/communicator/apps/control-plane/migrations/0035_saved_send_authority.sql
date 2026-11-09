-- NULL is deliberately not backfilled: old work has no originating authority.
ALTER TABLE outbound_acceptance_intents ADD COLUMN saved_authority TEXT;

CREATE TRIGGER outbound_saved_authority_immutable
BEFORE UPDATE OF saved_authority ON outbound_acceptance_intents
WHEN NEW.saved_authority IS NOT OLD.saved_authority
BEGIN
  SELECT RAISE(ABORT, 'saved send authority is immutable');
END;
