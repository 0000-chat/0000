import { runDormantTenantBootstrapTick } from "../../apps/control-plane/worker/tenant-wakeup-bootstrap.ts";

// Lifecycle fixture only. The production runner writes every observed outcome;
// the sole explicit target mutation recreates a legacy persisted input state.
export async function handleBootstrapFixture(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const tenant = "tenant_t13_pristine";
  const now = new Date().toISOString();
  await env.CONTROL_DB.prepare(
    "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, 'Controlled bootstrap lifecycle', 'active', ?, ?)",
  )
    .bind(tenant, tenant, now, now)
    .run();
  const target = () =>
    env.CONTROL_DB.prepare(
      "SELECT state, outcome, attempts FROM tenant_wakeup_targets WHERE tenant_id = ?",
    )
      .bind(tenant)
      .first();
  await runDormantTenantBootstrapTick(env);
  const pristine = await target();
  const projection = env.TENANT_PROJECTION.getByName(tenant);
  const authorization = (scopes) => ({
    schema_version: 1,
    tenant_id: tenant,
    principal_id: "principal_t13_bootstrap",
    allowed_identity_ids: ["identity_t13_bootstrap"],
    scopes,
  });
  let uninitialized = false;
  try {
    await projection.getStatus({
      schema_version: 1,
      tenant_id: tenant,
      authorization: authorization(["projection.status"]),
    });
  } catch (error) {
    if (error.code !== "projection_not_found") throw error;
    uninitialized = true;
  }
  await projection.initialize({
    schema_version: 1,
    tenant_id: tenant,
    initialized_at: now,
    authorization: authorization(["projection.initialize"]),
  });
  await projection.applyBatch({
    schema_version: 1,
    tenant_id: tenant,
    mode: "live",
    rebuild_id: null,
    authorization: authorization(["projection.write"]),
    connections: [
      {
        account_id: "account_t13_bootstrap",
        connection_id: "connection_t13_bootstrap",
        identity_id: "identity_t13_bootstrap",
        platform: "whatsapp",
      },
    ],
    events: [
      {
        schema_version: 1,
        tenant_id: tenant,
        event_id: "event_t13_bootstrap",
        event_type: "conversation.updated",
        event_source: "live",
        identity_id: "identity_t13_bootstrap",
        platform: "whatsapp",
        account_id: "account_t13_bootstrap",
        conversation_id: "conversation_t13_bootstrap",
        matrix_room_id: "!bootstrap:example.test",
        matrix_event_id: "$bootstrap:example.test",
        remote_message_id: null,
        occurred_at: now,
        observed_at: now,
        payload: {
          title: "Controlled bootstrap ingestion",
          archived: false,
          muted: false,
        },
      },
    ],
    checkpoint: null,
  });
  for (let tick = 0; tick < 5; tick++) await runDormantTenantBootstrapTick(env);
  const initialized = await target();
  await env.CONTROL_DB.prepare(
    "UPDATE tenant_wakeup_targets SET state = 'gap', outcome = 'uninitialized', attempts = 3, due_at_ms = 0 WHERE tenant_id = ?",
  )
    .bind(tenant)
    .run();
  await runDormantTenantBootstrapTick(env);
  return Response.json({
    pristine,
    uninitialized_before_explicit_initialization: uninitialized,
    initialized,
    legacy_rechecked: await target(),
  });
}
