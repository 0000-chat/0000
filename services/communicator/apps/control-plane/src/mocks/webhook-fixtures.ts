import type {
  WebhookDelivery,
  WebhookSubscription,
} from "@communicator/contracts";

export function webhookSubscriptions(): WebhookSubscription[] {
  return ["audit", "support"].map((name) => ({
    id: `subscription_${name}`,
    tenant_id: "tenant_pilot",
    owner_installation_id: null,
    owner_principal_id: "principal_pilot",
    creator_principal_id: "principal_pilot",
    creator_membership_id: "membership_pilot",
    creator_identity_id: "identity_human",
    logical_agent_id: null,
    ownership_mode: "administrator",
    destination: { url: `https://${name}.example.test/webhook` },
    destination_version: 1,
    event_filter: { event_types: ["message.created"] },
    global_enabled: true,
    account_rules: [
      { account_id: "account_connection_human_whatsapp", enabled: true },
    ],
    chat_rules: [],
    status: "active",
    created_at: "2026-08-29T00:00:00.000Z",
    updated_at: "2026-08-29T00:00:00.000Z",
    revoked_at: null,
  }));
}

export function webhookDeliveries(): WebhookDelivery[] {
  const now = new Date();
  return ["support", "audit"].flatMap((name) => {
    const delivery: WebhookDelivery = {
      id: `delivery_${name}`,
      tenant_id: "tenant_pilot",
      subscription_id: `subscription_${name}`,
      source_event_id: "event_synthetic",
      source_message_id: "message_synthetic",
      destination_version: 1,
      status: name === "support" ? "failed" : "uncertain",
      first_pending_at: now.toISOString(),
      retry_deadline: new Date(now.getTime() + 86_400_000).toISOString(),
      attempt_count: 2,
      next_attempt_at: null,
      last_attempt_at: now.toISOString(),
      delivered_at: null,
      http_status: name === "support" ? 502 : null,
      error_code: name === "support" ? "http_error" : "transport_timeout",
      last_response_body: null,
      cancellation_reason: null,
      uncertain_at: name === "audit" ? now.toISOString() : null,
      uncertainty_reason: name === "audit" ? "response_lost" : null,
    };
    return name === "audit"
      ? [
          delivery,
          {
            ...delivery,
            id: "delivery_audit_z",
            status: "delivered",
            delivered_at: now.toISOString(),
            http_status: 202,
            error_code: null,
            uncertain_at: null,
            uncertainty_reason: null,
          },
        ]
      : [delivery];
  });
}
