import type { ProjectionEventEnvelope } from "@communicator/contracts";

export const WEBHOOK_MESSAGE_CREATED = "message.created" as const;
export const WEBHOOK_MESSAGE_EDITED = "message.edited" as const;
export const WEBHOOK_MESSAGE_DELETED = "message.deleted" as const;
export const WEBHOOK_MESSAGE_TOMBSTONE = "deletion.tombstone" as const;

export type WebhookDeliveryEventType =
  | typeof WEBHOOK_MESSAGE_CREATED
  | typeof WEBHOOK_MESSAGE_EDITED
  | typeof WEBHOOK_MESSAGE_DELETED
  | typeof WEBHOOK_MESSAGE_TOMBSTONE;

/** Events that can create a durable webhook record for one message lineage. */
export const sourceMessageIdForWebhookEvent = (
  event: ProjectionEventEnvelope,
): string | null => {
  switch (event.event_type) {
    case WEBHOOK_MESSAGE_CREATED:
      return event.payload.direction === "inbound"
        ? event.payload.message_id
        : null;
    case WEBHOOK_MESSAGE_EDITED:
    case WEBHOOK_MESSAGE_DELETED:
      return event.payload.message_id;
    case "deletion.tombstone":
      return event.payload.resource_type === "message"
        ? event.payload.resource_id
        : null;
    default:
      return null;
  }
};

/**
 * The outgoing removal event remains message-scoped even when the projection
 * source is a message tombstone. The source event id is retained separately
 * on the delivery row for audit and idempotency.
 */
export const webhookDeliveryEventTypeFor = (
  event: ProjectionEventEnvelope,
): WebhookDeliveryEventType | null => {
  const sourceMessageId = sourceMessageIdForWebhookEvent(event);
  if (sourceMessageId === null) return null;
  switch (event.event_type) {
    case WEBHOOK_MESSAGE_CREATED:
      return WEBHOOK_MESSAGE_CREATED;
    case WEBHOOK_MESSAGE_EDITED:
      return WEBHOOK_MESSAGE_EDITED;
    case WEBHOOK_MESSAGE_DELETED:
      return WEBHOOK_MESSAGE_DELETED;
    case WEBHOOK_MESSAGE_TOMBSTONE:
      return WEBHOOK_MESSAGE_TOMBSTONE;
    default:
      return null;
  }
};

export const isWebhookRemovalDelivery = (
  eventType: WebhookDeliveryEventType,
): eventType is
  | typeof WEBHOOK_MESSAGE_DELETED
  | typeof WEBHOOK_MESSAGE_TOMBSTONE =>
  eventType === WEBHOOK_MESSAGE_DELETED ||
  eventType === WEBHOOK_MESSAGE_TOMBSTONE;

/**
 * Only live inbound creation and live/deletion message mutations can notify a
 * receiver. Backfill, replay, and correction events never resurrect a
 * delivery, and a tombstone for a conversation is handled by the removal
 * authority rather than as a message revision.
 */
export const isEligibleWebhookSource = (
  event: ProjectionEventEnvelope,
): boolean => {
  const eventType = webhookDeliveryEventTypeFor(event);
  if (eventType === null) return false;
  if (eventType === WEBHOOK_MESSAGE_CREATED) {
    return (
      event.event_type === WEBHOOK_MESSAGE_CREATED &&
      event.event_source === "live" &&
      event.payload.direction === "inbound"
    );
  }
  if (event.event_source !== "live" && event.event_source !== "deletion") {
    return false;
  }
  return true;
};
