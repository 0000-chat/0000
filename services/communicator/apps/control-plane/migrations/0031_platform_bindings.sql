PRAGMA foreign_keys = ON;

-- A binding is the service-owned, explicit bridge between one already
-- verified Platform principal tuple and one local control-directory target.
-- The Platform membership/grant reference is deliberately retained as part of
-- the immutable history: a replacement authority record needs a new binding.
CREATE TABLE platform_bindings (
  binding_id TEXT PRIMARY KEY CHECK (length(binding_id) > 0),
  platform_authority TEXT NOT NULL CHECK (length(platform_authority) > 0),
  platform_kind TEXT NOT NULL CHECK (platform_kind IN ('human', 'agent', 'service')),
  platform_subject_id TEXT NOT NULL CHECK (length(platform_subject_id) > 0),
  platform_organization_id TEXT NOT NULL CHECK (length(platform_organization_id) > 0),
  platform_membership_id TEXT,
  platform_grant_id TEXT,
  local_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  local_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  local_membership_id TEXT NOT NULL,
  local_identity_id TEXT,
  local_installation_id TEXT,
  local_client_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (local_tenant_id, local_membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (local_tenant_id, local_identity_id)
    REFERENCES identities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (local_tenant_id, local_installation_id)
    REFERENCES oauth_client_installations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (local_client_id)
    REFERENCES oauth_clients(client_id) ON DELETE RESTRICT,
  CHECK (
    (platform_kind = 'human' AND platform_membership_id IS NOT NULL AND platform_grant_id IS NULL) OR
    (platform_kind IN ('agent', 'service') AND platform_membership_id IS NULL AND platform_grant_id IS NOT NULL)
  ),
  CHECK (
    (local_installation_id IS NULL AND local_client_id IS NULL) OR
    (local_installation_id IS NOT NULL AND local_client_id IS NOT NULL)
  ),
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status IN ('pending', 'active') AND revoked_at IS NULL)
  )
);

-- A historical tuple remains reserved after revocation. Partial unique indexes
-- keep the human membership and machine grant namespaces discriminated while
-- still allowing a principal to receive a new binding for a replacement
-- Platform membership/grant.
CREATE UNIQUE INDEX platform_bindings_human_tuple_idx
  ON platform_bindings(
    platform_authority,
    platform_kind,
    platform_subject_id,
    platform_organization_id,
    platform_membership_id
  )
  WHERE platform_kind = 'human' AND platform_membership_id IS NOT NULL;

CREATE UNIQUE INDEX platform_bindings_machine_tuple_idx
  ON platform_bindings(
    platform_authority,
    platform_kind,
    platform_subject_id,
    platform_organization_id,
    platform_grant_id
  )
  WHERE platform_kind IN ('agent', 'service') AND platform_grant_id IS NOT NULL;

CREATE INDEX platform_bindings_lookup_idx
  ON platform_bindings(
    platform_authority,
    platform_organization_id,
    platform_kind,
    platform_subject_id,
    status,
    local_tenant_id
  );

CREATE INDEX platform_bindings_local_tenant_idx
  ON platform_bindings(local_tenant_id, status, binding_id);

-- SQLite's INSERT OR REPLACE deletes a conflicting row before inserting the new
-- one. With recursive_triggers disabled, that implicit delete does not invoke
-- the history trigger below, so reserve row IDs and Platform tuples before the
-- conflict handler can remove their historical rows.
CREATE TRIGGER platform_bindings_insert_history_immutable
BEFORE INSERT ON platform_bindings
WHEN EXISTS (
  SELECT 1
  FROM platform_bindings AS existing
  WHERE existing.binding_id = NEW.binding_id
     OR (
       existing.platform_authority = NEW.platform_authority AND
       existing.platform_kind = NEW.platform_kind AND
       existing.platform_subject_id = NEW.platform_subject_id AND
       existing.platform_organization_id = NEW.platform_organization_id AND
       existing.platform_membership_id IS NEW.platform_membership_id AND
       existing.platform_grant_id IS NEW.platform_grant_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'platform_binding_history_immutable');
END;

-- Every Platform organization is associated with one local tenant, and a local
-- tenant is associated with one Platform organization. Keeping this invariant
-- in a trigger preserves it across pending and terminal rows as well as across
-- future changes to the table's indexes.
CREATE TRIGGER platform_bindings_association_immutable
BEFORE INSERT ON platform_bindings
WHEN EXISTS (
  SELECT 1
  FROM platform_bindings AS existing
  WHERE (
    existing.platform_authority = NEW.platform_authority AND
    existing.platform_organization_id = NEW.platform_organization_id AND
    existing.local_tenant_id <> NEW.local_tenant_id
  ) OR (
    existing.local_tenant_id = NEW.local_tenant_id AND
    (
      existing.platform_authority <> NEW.platform_authority OR
      existing.platform_organization_id <> NEW.platform_organization_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'platform_binding_association_immutable');
END;

-- Foreign keys prove row existence and tenant ownership. This trigger proves
-- the remaining identity links and the kind-specific local target rules at the
-- database boundary before a binding can enter its immutable history.
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
    NEW.local_identity_id IS NULL OR EXISTS (
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
          (NEW.platform_kind = 'agent' AND i.identity_kind = 'agent')
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

CREATE TRIGGER platform_bindings_immutable
BEFORE UPDATE OF
  binding_id,
  platform_authority,
  platform_kind,
  platform_subject_id,
  platform_organization_id,
  platform_membership_id,
  platform_grant_id,
  local_tenant_id,
  local_principal_id,
  local_membership_id,
  local_identity_id,
  local_installation_id,
  local_client_id,
  created_at
ON platform_bindings
WHEN NEW.binding_id <> OLD.binding_id
  OR NEW.platform_authority <> OLD.platform_authority
  OR NEW.platform_kind <> OLD.platform_kind
  OR NEW.platform_subject_id <> OLD.platform_subject_id
  OR NEW.platform_organization_id <> OLD.platform_organization_id
  OR NEW.platform_membership_id IS NOT OLD.platform_membership_id
  OR NEW.platform_grant_id IS NOT OLD.platform_grant_id
  OR NEW.local_tenant_id <> OLD.local_tenant_id
  OR NEW.local_principal_id <> OLD.local_principal_id
  OR NEW.local_membership_id <> OLD.local_membership_id
  OR NEW.local_identity_id IS NOT OLD.local_identity_id
  OR NEW.local_installation_id IS NOT OLD.local_installation_id
  OR NEW.local_client_id IS NOT OLD.local_client_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'platform_binding_immutable');
END;

CREATE TRIGGER platform_bindings_status_terminal
BEFORE UPDATE OF status ON platform_bindings
WHEN (
  OLD.status = 'revoked' AND NEW.status <> 'revoked'
) OR (
  OLD.status = 'active' AND NEW.status NOT IN ('active', 'revoked')
)
BEGIN
  SELECT RAISE(ABORT, 'platform_binding_status_terminal');
END;

CREATE TRIGGER platform_bindings_revocation_immutable
BEFORE UPDATE OF revoked_at ON platform_bindings
WHEN OLD.revoked_at IS NOT NULL
  AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  SELECT RAISE(ABORT, 'platform_binding_revocation_immutable');
END;

CREATE TRIGGER platform_bindings_no_delete
BEFORE DELETE ON platform_bindings
BEGIN
  SELECT RAISE(ABORT, 'platform_binding_history_immutable');
END;
