import fixtureWorker, {
  TenantProjectionDO,
  LinkSessionDO,
} from "./communicator.mjs";
import {
  fanOutIncomingWebhookDeliveries,
  runWebhookRetryTick,
} from "../../apps/control-plane/worker/webhooks/delivery.ts";

export { TenantProjectionDO, LinkSessionDO };

// Local-only fixture entry. Never configure this entry for deployment. All
// application traffic still goes through the production entry and middleware.
export default {
  async fetch(request, env, context) {
    return (
      (await handleWebhookFixture(request, env)) ??
      fixtureWorker.fetch(request, env, context)
    );
  },
};

export async function handleWebhookFixture(request, env) {
  const pathname = new URL(request.url).pathname;
  if (
    !["/__fixture/webhook-emit", "/__fixture/webhook-tick"].includes(pathname)
  )
    return null;
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const input = await request.json();
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime()))
    return new Response(null, { status: 400 });
  const tenantId = "tenant_pilot";
  const projection = env.TENANT_PROJECTION.getByName(tenantId);
  if (pathname === "/__fixture/webhook-tick") {
    return Response.json(
      await runWebhookRetryTick({
        database: env.CONTROL_DB,
        projectionForTenant: (tenant) =>
          env.TENANT_PROJECTION.getByName(tenant),
        services: { now: () => now },
      }),
    );
  }
  if (!/^webhook_proof_[a-z_]+$/.test(input.key))
    return new Response(null, { status: 400 });
  const event = {
    schema_version: 1,
    event_id: `event_${input.key}`,
    event_type: "message.created",
    event_source: "live",
    tenant_id: tenantId,
    identity_id: "identity_human",
    platform: "whatsapp",
    account_id: "account_human",
    conversation_id: "conversation_integrated",
    matrix_room_id: "!integrated:example.test",
    matrix_event_id: `$${input.key}:example.test`,
    remote_message_id: null,
    occurred_at: now.toISOString(),
    observed_at: now.toISOString(),
    payload: {
      message_id: `message_${input.key}`,
      direction: "inbound",
      sender_participant_id: null,
      sender_label: "Controlled webhook participant",
      body: "Controlled local webhook fixture",
      reply_to_message_id: null,
      delivery_status: "unknown",
      unread: true,
    },
  };
  await projection.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: {
      schema_version: 1,
      tenant_id: tenantId,
      principal_id: "principal_human",
      allowed_identity_ids: ["identity_human"],
      scopes: ["projection.write"],
    },
    mode: "live",
    rebuild_id: null,
    connections: [
      {
        account_id: "account_human",
        connection_id: "connection_human_whatsapp",
        identity_id: "identity_human",
        platform: "whatsapp",
      },
    ],
    events: [event],
    checkpoint: null,
  });
  const deliveryIds = await fanOutIncomingWebhookDeliveries({
    database: env.CONTROL_DB,
    tenantId,
    events: [event],
    now: () => now,
  });
  return Response.json({ delivery_ids: deliveryIds });
}
