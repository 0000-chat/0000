import type { CanonicalEventEnvelope, CanonicalJsonObject } from "@communicator/contracts";

export const TENANT_ID = "tenant_pilot";
export const OTHER_TENANT_ID = "tenant_other";
export const BATCH_ID = "batch_01abc";
export const ARCHIVED_AT = "2026-09-07T02:00:00.000Z";

export const makeEvent = (
  overrides: Partial<CanonicalEventEnvelope> = {},
): CanonicalEventEnvelope => ({
  schema_version: 1,
  event_id: "$event-1:server",
  event_type: "message.created",
  event_source: "live",
  tenant_id: TENANT_ID,
  identity_id: "identity_human",
  platform: "telegram",
  account_id: "account_human_telegram",
  conversation_id: "conversation_human_one",
  matrix_room_id: "!room:server",
  matrix_event_id: "$event:server",
  remote_message_id: "remote-message-1",
  occurred_at: "2026-09-07T01:02:02.000Z",
  observed_at: "2026-09-07T01:02:03.000Z",
  payload: { body: "fixture message body", order: 1 },
  ...overrides,
});

export const makeEvents = (count: number): CanonicalEventEnvelope[] =>
  Array.from({ length: count }, (_, index) =>
    makeEvent({
      event_id: `$event-${index + 1}:server`,
      payload: { body: `fixture message body ${index + 1}`, order: index + 1 },
      occurred_at: `2026-09-07T01:02:${String(index % 60).padStart(2, "0")}.000Z`,
      observed_at: `2026-09-07T01:02:${String(index % 60).padStart(2, "0")}.000Z`,
    }),
  );

export const cloneEvents = (
  events: readonly CanonicalEventEnvelope[],
): CanonicalEventEnvelope[] => structuredClone(events) as CanonicalEventEnvelope[];

export const nestedPayload = (depth: number): CanonicalJsonObject => {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const child: Record<string, unknown> = {};
    cursor.child = child;
    cursor = child;
  }
  return root as CanonicalJsonObject;
};

let archiveScopeCounter = 0;

export const makeArchiveScope = (): { tenantId: string; batchId: string } => {
  archiveScopeCounter += 1;
  return {
    tenantId: `tenant_writer_${archiveScopeCounter}`,
    batchId: `batch_writer_${archiveScopeCounter}`,
  };
};

export const cleanupArchiveTenant = async (
  bucket: R2Bucket,
  tenantId: string,
): Promise<void> => {
  for (const prefix of [`events/${tenantId}/`, `manifests/${tenantId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
      const keys = page.objects.map((object) => object.key);
      if (keys.length > 0) await bucket.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor) {
        throw new Error("archive cleanup returned truncated page without cursor");
      }
    } while (cursor !== undefined);
  }
};
