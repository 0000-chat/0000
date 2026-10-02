-- Service principals may be bound to an explicit agent product identity when
-- they claim outbound work. Product identities remain human/agent; the
-- service principal itself never becomes a fabricated human identity.
DROP TRIGGER IF EXISTS platform_bindings_target_coherence;

CREATE TRIGGER platform_bindings_target_coherence
BEFORE INSERT ON platform_bindings
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM principals AS p
    JOIN memberships AS m
      ON m.tenant_id = NEW.local_tenant_id
     AND m.id = NEW.local_membership_id
     AND m.principal_id = p.id
    WHERE p.id = NEW.local_principal_id
      AND (
        (NEW.platform_kind = 'human' AND p.principal_type IN ('human', 'operator')) OR
        (NEW.platform_kind IN ('agent', 'service') AND p.principal_type = NEW.platform_kind)
      )
  ) AND (
    NEW.local_identity_id IS NULL OR (
      NEW.status = 'pending' AND EXISTS (
        SELECT 1
        FROM identities AS pending_identity
        WHERE pending_identity.tenant_id = NEW.local_tenant_id
          AND pending_identity.id = NEW.local_identity_id
          AND pending_identity.status = 'active'
          AND (
            (NEW.platform_kind = 'human' AND pending_identity.identity_kind = 'human') OR
            (NEW.platform_kind IN ('agent', 'service') AND pending_identity.identity_kind = 'agent')
          )
      )
    ) OR EXISTS (
      SELECT 1
      FROM identities AS i
      JOIN identity_grants AS ig
        ON ig.tenant_id = NEW.local_tenant_id
       AND ig.membership_id = NEW.local_membership_id
       AND ig.identity_id = NEW.local_identity_id
      WHERE i.tenant_id = NEW.local_tenant_id
        AND i.id = NEW.local_identity_id
        AND (
          (NEW.platform_kind = 'human' AND i.identity_kind = 'human') OR
          (NEW.platform_kind IN ('agent', 'service') AND i.identity_kind = 'agent')
        )
    )
  ) AND (
    NEW.local_installation_id IS NULL OR EXISTS (
      SELECT 1
      FROM oauth_client_installations AS oi
      WHERE oi.tenant_id = NEW.local_tenant_id
        AND oi.id = NEW.local_installation_id
        AND oi.client_id = NEW.local_client_id
        AND oi.principal_id = NEW.local_principal_id
        AND oi.membership_id = NEW.local_membership_id
        AND oi.identity_id = NEW.local_identity_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'platform_binding_target_mismatch');
END;
