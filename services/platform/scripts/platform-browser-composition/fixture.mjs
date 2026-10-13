const FIXTURE_TIME = "2026-09-20T00:00:00.000Z";

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const FIXTURE = Object.freeze({
  tenantId: "tenant_composition_human",
  principalId: "principal_composition_human",
  membershipId: "membership_composition_human",
  identityId: "identity_composition_human",
  allowedConnectionId: "connection_composition_allowed",
  deniedConnectionId: "connection_composition_denied",
  allowedAccountId: "account_composition_allowed",
  deniedAccountId: "account_composition_denied",
  allowedGatewayRouteId: "gateway_composition_allowed",
  deniedGatewayRouteId: "gateway_composition_denied",
  allowedConversationId: "conversation_composition_allowed",
  deniedConversationId: "conversation_composition_denied",
});

export const fixtureTimestamp = FIXTURE_TIME;

export function baseDirectorySql() {
  const f = FIXTURE;
  return `PRAGMA foreign_keys = ON;
INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES
  (${sql(f.tenantId)}, 'composition-human', 'Composition Human', 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)});
INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at, revoked_at) VALUES
  (${sql(f.principalId)}, 'composition-local', 'composition-human', 'human', 'Composition Human', 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}, NULL);
INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at, revoked_at) VALUES
  (${sql(f.membershipId)}, ${sql(f.tenantId)}, ${sql(f.principalId)}, 'owner', 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}, NULL);
INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES
  (${sql(f.identityId)}, ${sql(f.tenantId)}, 'human', 'Composition Human Identity', 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)});
INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES
  (${sql(f.tenantId)}, ${sql(f.membershipId)}, ${sql(f.identityId)}, 'conversation.read', ${sql(FIXTURE_TIME)}),
  (${sql(f.tenantId)}, ${sql(f.membershipId)}, ${sql(f.identityId)}, 'message.send', ${sql(FIXTURE_TIME)}),
  (${sql(f.tenantId)}, ${sql(f.membershipId)}, ${sql(f.identityId)}, 'connection.read', ${sql(FIXTURE_TIME)});
INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES
  (${sql(f.allowedGatewayRouteId)}, ${sql(f.principalId)}, 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}),
  (${sql(f.deniedGatewayRouteId)}, ${sql(f.principalId)}, 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)});
INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES
  (${sql(f.allowedConnectionId)}, ${sql(f.tenantId)}, ${sql(f.identityId)}, 'whatsapp', 'Composition allowed connection', 'ready', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}),
  (${sql(f.deniedConnectionId)}, ${sql(f.tenantId)}, ${sql(f.identityId)}, 'whatsapp', 'Composition denied connection', 'ready', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)});
INSERT INTO connection_capabilities (tenant_id, connection_id, capability, created_at) VALUES
  (${sql(f.tenantId)}, ${sql(f.allowedConnectionId)}, 'message.send', ${sql(FIXTURE_TIME)});
INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES
  (${sql(f.allowedConnectionId)}, ${sql(f.allowedGatewayRouteId)}, 'composition-bridge-allowed', '@composition-allowed:example.test', '!composition-allowed:example.test', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}),
  (${sql(f.deniedConnectionId)}, ${sql(f.deniedGatewayRouteId)}, 'composition-bridge-denied', '@composition-denied:example.test', '!composition-denied:example.test', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)});
INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at, retired_at) VALUES
  (${sql(f.allowedAccountId)}, ${sql(f.allowedConnectionId)}, 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}, NULL),
  (${sql(f.deniedAccountId)}, ${sql(f.deniedConnectionId)}, 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}, NULL);
INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at, revoked_at) VALUES
  ('grant_composition_allowed', ${sql(f.tenantId)}, ${sql(f.membershipId)}, ${sql(f.identityId)}, ${sql(f.allowedAccountId)}, 'conversation.read', 'all_chats', 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}, NULL);
`;
}

export function humanBindingSql({
  authority,
  subjectId,
  organizationId,
  membershipId,
}) {
  const f = FIXTURE;
  return `PRAGMA foreign_keys = ON;
INSERT INTO platform_bindings (
  binding_id, platform_authority, platform_kind, platform_subject_id,
  platform_organization_id, platform_membership_id, platform_grant_id,
  local_tenant_id, local_principal_id, local_membership_id, local_identity_id,
  local_installation_id, local_client_id, status, created_at, updated_at, revoked_at
) VALUES (
  'binding_composition_human', ${sql(authority)}, 'human', ${sql(subjectId)},
  ${sql(organizationId)}, ${sql(membershipId)}, NULL,
  ${sql(f.tenantId)}, ${sql(f.principalId)}, ${sql(f.membershipId)}, ${sql(f.identityId)},
  NULL, NULL, 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}, NULL
);
`;
}

export function alternateBindingSql({
  authority,
  subjectId,
  organizationId,
  membershipId,
}) {
  return `PRAGMA foreign_keys = ON;
INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at)
  VALUES ('tenant_composition_alternate', 'composition-alternate', 'Composition Alternate', 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)});
INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at, revoked_at)
  VALUES ('membership_composition_alternate', 'tenant_composition_alternate', 'principal_composition_human', 'owner', 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}, NULL);
INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at)
  VALUES ('identity_composition_alternate', 'tenant_composition_alternate', 'human', 'Composition Alternate Identity', 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)});
INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES
  ('tenant_composition_alternate', 'membership_composition_alternate', 'identity_composition_alternate', 'conversation.read', ${sql(FIXTURE_TIME)}),
  ('tenant_composition_alternate', 'membership_composition_alternate', 'identity_composition_alternate', 'message.send', ${sql(FIXTURE_TIME)}),
  ('tenant_composition_alternate', 'membership_composition_alternate', 'identity_composition_alternate', 'connection.read', ${sql(FIXTURE_TIME)});
INSERT INTO platform_bindings (
  binding_id, platform_authority, platform_kind, platform_subject_id,
  platform_organization_id, platform_membership_id, platform_grant_id,
  local_tenant_id, local_principal_id, local_membership_id, local_identity_id,
  local_installation_id, local_client_id, status, created_at, updated_at, revoked_at
) VALUES (
  'binding_composition_alternate', ${sql(authority)}, 'human', ${sql(subjectId)},
  ${sql(organizationId)}, ${sql(membershipId)}, NULL,
  'tenant_composition_alternate', 'principal_composition_human', 'membership_composition_alternate', 'identity_composition_alternate',
  NULL, NULL, 'active', ${sql(FIXTURE_TIME)}, ${sql(FIXTURE_TIME)}, NULL
);
`;
}

function projectionEvent({
  eventId,
  accountId,
  connectionId,
  conversationId,
  observedAt,
}) {
  const f = FIXTURE;
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: "conversation.updated",
    event_source: "live",
    tenant_id: f.tenantId,
    identity_id: f.identityId,
    platform: "whatsapp",
    account_id: accountId,
    conversation_id: conversationId,
    matrix_room_id: null,
    matrix_event_id: null,
    remote_message_id: null,
    occurred_at: observedAt,
    observed_at: observedAt,
    payload: {
      title: "Composition fixture conversation",
      archived: false,
      muted: false,
    },
  };
}

export function projectionInitialization() {
  const f = FIXTURE;
  return {
    schema_version: 1,
    tenant_id: f.tenantId,
    initialized_at: FIXTURE_TIME,
    authorization: {
      schema_version: 1,
      tenant_id: f.tenantId,
      principal_id: f.principalId,
      allowed_identity_ids: [f.identityId],
      scopes: ["projection.initialize"],
    },
  };
}

export function projectionBatch(events) {
  const f = FIXTURE;
  return {
    schema_version: 1,
    tenant_id: f.tenantId,
    authorization: {
      schema_version: 1,
      tenant_id: f.tenantId,
      principal_id: f.principalId,
      allowed_identity_ids: [f.identityId],
      scopes: ["projection.write"],
    },
    mode: "live",
    rebuild_id: null,
    connections: [
      {
        account_id: f.allowedAccountId,
        connection_id: f.allowedConnectionId,
        identity_id: f.identityId,
        platform: "whatsapp",
      },
      {
        account_id: f.deniedAccountId,
        connection_id: f.deniedConnectionId,
        identity_id: f.identityId,
        platform: "whatsapp",
      },
    ],
    events,
    checkpoint: null,
  };
}

export function initialProjectionEvents() {
  return [
    projectionEvent({
      eventId: "composition_initial_allowed",
      accountId: FIXTURE.allowedAccountId,
      connectionId: FIXTURE.allowedConnectionId,
      conversationId: FIXTURE.allowedConversationId,
      observedAt: "2026-09-20T00:00:01.000Z",
    }),
    projectionEvent({
      eventId: "composition_initial_denied",
      accountId: FIXTURE.deniedAccountId,
      connectionId: FIXTURE.deniedConnectionId,
      conversationId: FIXTURE.deniedConversationId,
      observedAt: "2026-09-20T00:00:02.000Z",
    }),
  ];
}

export function postRevocationProjectionEvents() {
  return [
    projectionEvent({
      eventId: "composition_after_platform_revocation",
      accountId: FIXTURE.allowedAccountId,
      connectionId: FIXTURE.allowedConnectionId,
      conversationId: "conversation_composition_after_revocation",
      observedAt: "2026-09-20T00:00:03.000Z",
    }),
    projectionEvent({
      eventId: "composition_after_platform_revocation_denied",
      accountId: FIXTURE.deniedAccountId,
      connectionId: FIXTURE.deniedConnectionId,
      conversationId: "conversation_composition_after_revocation_denied",
      observedAt: "2026-09-20T00:00:04.000Z",
    }),
  ];
}
