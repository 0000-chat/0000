const fixtureTimestamp = "2026-08-29T00:00:00.000Z";

export async function seedDirectory(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "pilot", "Pilot", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("principal_human", "https://issuer.example/", "human-subject", "human", "Human", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("principal_agent", "https://issuer.example/", "agent-subject", "agent", "Agent", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("principal_operator", "https://issuer.example/", "operator-subject", "operator", "Operator", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("membership_human", "tenant_pilot", "principal_human", "owner", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("membership_agent", "tenant_pilot", "principal_agent", "member", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("membership_operator", "tenant_pilot", "principal_operator", "admin", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("identity_human", "tenant_pilot", "human", "Human", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("identity_agent", "tenant_pilot", "agent", "Agent", "active", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_human", "identity_human", "conversation.read", fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_human", "identity_human", "message.send", fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_human", "identity_human", "receipt.send", fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_human", "identity_human", "connection.read", fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_human", "identity_human", "connection.manage", fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_agent", "identity_agent", "conversation.read", fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_agent", "identity_agent", "message.send", fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_agent", "identity_agent", "connection.read", fixtureTimestamp),
    db.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("tenant_pilot", "membership_operator", "identity_human", "connection.read", fixtureTimestamp),
    db.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("connection_human_whatsapp", "tenant_pilot", "identity_human", "whatsapp", "Human WhatsApp", "ready", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("connection_agent_whatsapp", "tenant_pilot", "identity_agent", "whatsapp", "Agent WhatsApp", "ready", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("connection_human_whatsapp", "gateway_route_human", "bridge-human", "route-user-human", "route-room-human", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("connection_agent_whatsapp", "gateway_route_agent", "bridge-agent", "route-user-agent", "route-room-agent", fixtureTimestamp, fixtureTimestamp),
    db.prepare(
      "INSERT INTO connection_capabilities (tenant_id, connection_id, capability, created_at) VALUES (?, ?, ?, ?)",
    ).bind("tenant_pilot", "connection_human_whatsapp", "message.send", fixtureTimestamp),
    db.prepare(
      "INSERT INTO connection_capabilities (tenant_id, connection_id, capability, created_at) VALUES (?, ?, ?, ?)",
    ).bind("tenant_pilot", "connection_human_whatsapp", "receipt.read", fixtureTimestamp),
    db.prepare(
      "INSERT INTO connection_capabilities (tenant_id, connection_id, capability, created_at) VALUES (?, ?, ?, ?)",
    ).bind("tenant_pilot", "connection_human_whatsapp", "typing.send", fixtureTimestamp),
    db.prepare(
      "INSERT INTO connection_capabilities (tenant_id, connection_id, capability, created_at) VALUES (?, ?, ?, ?)",
    ).bind("tenant_pilot", "connection_agent_whatsapp", "message.send", fixtureTimestamp),
  ]);
}

export async function clearDirectory(db: D1Database): Promise<void> {
  // Ingestion history is intentionally append-only in production. Tests need
  // an isolated database between cases, so temporarily remove only the
  // ingestion triggers, clear fixture rows in FK order, and restore the exact
  // trigger definitions from sqlite_schema before returning.
  const triggerRows = await db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'ingestion_%' ORDER BY name",
  ).all<{ name: string; sql: string }>();
  for (const trigger of triggerRows.results) {
    if (!/^[A-Za-z0-9_]+$/.test(trigger.name)) throw new Error("unexpected trigger name");
    await db.prepare(`DROP TRIGGER IF EXISTS "${trigger.name}"`).run();
  }

  await db.batch([
    db.prepare("DELETE FROM audit_events"),
    db.prepare("DELETE FROM control_event_outbox"),
    db.prepare("DELETE FROM directory_mutations"),
    db.prepare("DELETE FROM break_glass_grants"),
    db.prepare("DELETE FROM revoked_tokens"),
    db.prepare("DELETE FROM connection_accounts"),
    db.prepare("DELETE FROM connection_capabilities"),
    db.prepare("DELETE FROM connection_routes"),
    db.prepare("DELETE FROM connections"),
    db.prepare("DELETE FROM identity_grants"),
    db.prepare("DELETE FROM identities"),
    db.prepare("DELETE FROM memberships"),
    db.prepare("DELETE FROM gateway_routes"),
    db.prepare("DELETE FROM principals"),
    db.prepare("DELETE FROM tenants"),
  ]);

  for (const trigger of triggerRows.results) {
    await db.prepare(trigger.sql).run();
  }
}
