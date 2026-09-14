import {
  CanonicalEventEnvelopeSchema,
  type CanonicalEventEnvelope,
  type CanonicalJsonObject,
  type RemovalAuthority,
  RemovalAuthoritySchema,
  RestoreReplayEvidenceSchema,
  type RestoreReplayEvidence,
} from "@communicator/contracts";
import { archiveError } from "./errors";
import { readCommittedArchiveBatch, readReplayPage } from "./reader";
import { loadRestoreAuthority } from "../restore/gate";

type JsonRecord = Record<string, unknown>;

export type SanitizedArchiveEvents = {
  events: CanonicalEventEnvelope[];
  removed_event_ids: string[];
  retained_event_ids: string[];
  changed_event_ids: string[];
};

export type SanitizedArchiveBatch = {
  manifest: Awaited<ReturnType<typeof readCommittedArchiveBatch>>["manifest"];
  events: CanonicalEventEnvelope[];
  removed_event_ids: string[];
  retained_event_ids: string[];
  changed_event_ids: string[];
};

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const payloadValue = (event: CanonicalEventEnvelope, key: string): unknown =>
  isRecord(event.payload) ? event.payload[key] : undefined;

const scopeMatches = (
  event: CanonicalEventEnvelope,
  authority: RemovalAuthority,
): boolean =>
  (authority.account_id === null ||
    event.account_id === authority.account_id) &&
  (authority.conversation_id === null ||
    event.conversation_id === authority.conversation_id);

const generationMatches = (
  event: CanonicalEventEnvelope,
  authority: RemovalAuthority,
): boolean => {
  const generation = payloadValue(event, "content_generation");
  return (
    generation === undefined || generation === authority.content_generation
  );
};

const eventHasObjectKey = (value: unknown, objectKey: string): boolean => {
  if (typeof value === "string") return value === objectKey;
  if (Array.isArray(value))
    return value.some((item) => eventHasObjectKey(item, objectKey));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) =>
    eventHasObjectKey(item, objectKey),
  );
};

const isRemovalMarker = (event: CanonicalEventEnvelope): boolean =>
  event.event_type === "deletion.tombstone" ||
  event.event_type === "message.deleted" ||
  event.event_type === "replay.tombstone";

const removalReferenceKeys = [
  "resource_id",
  "message_id",
  "source_message_id",
  "command_id",
  "dispatch_id",
  "delivery_id",
  "webhook_id",
  "attachment_id",
] as const;

/**
 * Match the immutable resource lineage, independently of a message edit
 * revision.  The authority's generation is checked when an event carries one;
 * ordinary gateway events predate that field and are matched by their stable
 * resource identifiers instead.
 */
export const eventMatchesRemoval = (
  event: CanonicalEventEnvelope,
  authorityInput: RemovalAuthority,
): boolean => {
  const parsed = RemovalAuthoritySchema.safeParse(authorityInput);
  if (!parsed.success) throw archiveError("archive_invalid", parsed.error);
  const authority = parsed.data;

  if (event.tenant_id !== authority.tenant_id) {
    throw archiveError("archive_tenant_mismatch");
  }
  if (!scopeMatches(event, authority) || !generationMatches(event, authority)) {
    return false;
  }
  if (
    authority.source_event_id !== null &&
    event.event_id === authority.source_event_id
  ) {
    return true;
  }

  const resourceId = authority.resource_id;
  if (
    removalReferenceKeys.some((key) => payloadValue(event, key) === resourceId)
  ) {
    return true;
  }
  const payloadResourceId = payloadValue(event, "resource_id");
  if (payloadResourceId === resourceId) return true;

  switch (authority.resource_type) {
    case "message":
      return (
        event.remote_message_id === resourceId ||
        payloadValue(event, "message_id") === resourceId ||
        payloadValue(event, "source_message_id") === resourceId
      );
    case "conversation":
      return event.conversation_id === resourceId;
    case "attachment":
      return (
        payloadValue(event, "attachment_id") === resourceId ||
        (authority.source_object_key !== null &&
          eventHasObjectKey(event.payload, authority.source_object_key))
      );
    case "participant":
      return payloadValue(event, "participant_id") === resourceId;
    default:
      return (
        event.event_id === resourceId ||
        event.remote_message_id === resourceId ||
        payloadResourceId === resourceId
      );
  }
};

const attachmentReferenceKeys = new Set([
  "attachment_id",
  "r2_key",
  "media_key",
  "source_object_key",
]);

const attachmentReferenceMatches = (
  key: string,
  value: unknown,
  authority: RemovalAuthority,
): boolean => {
  if (!attachmentReferenceKeys.has(key)) return false;
  if (value === authority.resource_id) return true;
  return (
    authority.source_object_key !== null &&
    value === authority.source_object_key
  );
};

type SanitizedValue = { value: unknown; changed: boolean; removed: boolean };

const sanitizeAttachmentValue = (
  value: unknown,
  authority: RemovalAuthority,
): SanitizedValue => {
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    let changed = false;
    for (const item of value) {
      if (isRecord(item)) {
        const hasReference = Object.entries(item).some(([key, itemValue]) =>
          attachmentReferenceMatches(key, itemValue, authority),
        );
        if (hasReference) {
          changed = true;
          continue;
        }
      }
      const sanitized = sanitizeAttachmentValue(item, authority);
      changed ||= sanitized.changed;
      if (!sanitized.removed) next.push(sanitized.value);
      else changed = true;
    }
    return { value: next, changed, removed: false };
  }
  if (!isRecord(value)) return { value, changed: false, removed: false };

  const next: JsonRecord = {};
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if (attachmentReferenceMatches(key, child, authority)) {
      changed = true;
      continue;
    }
    const sanitized = sanitizeAttachmentValue(child, authority);
    changed ||= sanitized.changed;
    if (!sanitized.removed) next[key] = sanitized.value;
    else changed = true;
  }
  return { value: next, changed, removed: false };
};

/**
 * Remove content from a decoded batch while keeping retained event envelopes
 * byte-for-byte equivalent.  Attachment metadata can be removed in place so
 * a message body remains available when only the attachment was removed.
 */
export const sanitizeArchiveEvents = (
  events: readonly CanonicalEventEnvelope[],
  authorityInput: RemovalAuthority,
): SanitizedArchiveEvents => {
  const parsed = RemovalAuthoritySchema.safeParse(authorityInput);
  if (!parsed.success) throw archiveError("archive_invalid", parsed.error);
  const authority = parsed.data;
  const retained: CanonicalEventEnvelope[] = [];
  const removedEventIds: string[] = [];
  const retainedEventIds: string[] = [];
  const changedEventIds: string[] = [];

  for (const event of events) {
    const matches = eventMatchesRemoval(event, authority);
    if (!matches) {
      retained.push(event);
      retainedEventIds.push(event.event_id);
      continue;
    }

    // Tombstones are the durable, content-free marker needed by a rebuild.
    // The external removal authority remains the source of truth even if the
    // marker is absent, but retaining it avoids turning a purge into an
    // anti-resurrection bypass.
    if (isRemovalMarker(event)) {
      retained.push(event);
      retainedEventIds.push(event.event_id);
      continue;
    }

    if (
      authority.resource_type === "attachment" &&
      event.event_type !== "attachment.observed"
    ) {
      const sanitizedPayload = sanitizeAttachmentValue(
        event.payload,
        authority,
      );
      if (sanitizedPayload.changed) {
        const candidate = {
          ...event,
          payload: sanitizedPayload.value as CanonicalJsonObject,
        };
        const validated = CanonicalEventEnvelopeSchema.safeParse(candidate);
        if (!validated.success)
          throw archiveError("archive_corrupt", validated.error);
        retained.push(validated.data);
        retainedEventIds.push(event.event_id);
        changedEventIds.push(event.event_id);
        continue;
      }
    }

    removedEventIds.push(event.event_id);
  }

  return {
    events: retained,
    removed_event_ids: removedEventIds,
    retained_event_ids: retainedEventIds,
    changed_event_ids: changedEventIds,
  };
};

/** Read through the canonical validator before applying the removal authority. */
export const readSanitizedArchiveBatch = async (
  bucket: R2Bucket,
  tenantId: string,
  manifestKey: string,
  authority: RemovalAuthority,
): Promise<SanitizedArchiveBatch> => {
  const committed = await readCommittedArchiveBatch(
    bucket,
    tenantId,
    manifestKey,
  );
  const sanitized = sanitizeArchiveEvents(committed.events, authority);
  return { manifest: committed.manifest, ...sanitized };
};

/**
 * Projection-only replay helper for restore checks.  The returned page keeps
 * the validated manifest metadata but exposes only authority-filtered events;
 * callers must treat it as a sanitized view rather than a committed manifest.
 */
export const readSanitizedReplayPage = async (
  bucket: R2Bucket,
  tenantId: string,
  authority: RemovalAuthority,
  options?: { cursor?: string; pageSize?: number },
): Promise<{
  manifests: Awaited<ReturnType<typeof readReplayPage>>["manifests"];
  events: CanonicalEventEnvelope[];
  next_cursor: string | null;
}> => {
  const page = await readReplayPage(bucket, tenantId, options);
  const sanitized = sanitizeArchiveEvents(page.events, authority);
  return {
    manifests: page.manifests,
    events: sanitized.events,
    next_cursor: page.next_cursor,
  };
};

/**
 * Read one projection replay page only after the current removal ledger has
 * been loaded from primary D1. Every authority is applied to the decoded
 * page, so an old archive cannot reintroduce a message, attachment reference,
 * command, or delivery pointer that crossed a deletion epoch. The evidence
 * returned beside the page is consumed by the restore orchestrator before it
 * exposes a projection or starts a provider service.
 */
export const readRestoreReplayPage = async (
  bucket: R2Bucket,
  database: D1Database | D1DatabaseSession,
  tenantId: string,
  options?: { cursor?: string; pageSize?: number },
): Promise<{
  manifests: Awaited<ReturnType<typeof readReplayPage>>["manifests"];
  events: CanonicalEventEnvelope[];
  next_cursor: string | null;
  evidence: RestoreReplayEvidence;
}> => {
  const authority = await loadRestoreAuthority(database, tenantId);
  const page = await readReplayPage(bucket, tenantId, options);
  // A removal may be recorded while the R2 page is being listed and decoded.
  // Re-read the primary ledger after the page fetch and refuse to expose even
  // a sanitized page if the authority changed during that window.
  const currentAuthority = await loadRestoreAuthority(database, tenantId);
  if (
    currentAuthority.deletion_epoch !== authority.deletion_epoch ||
    JSON.stringify(currentAuthority.authorities) !==
      JSON.stringify(authority.authorities)
  ) {
    throw archiveError("archive_conflict");
  }
  let events = page.events;
  const removedEventIds: string[] = [];
  const changedEventIds: string[] = [];
  for (const removal of authority.authorities) {
    const sanitized = sanitizeArchiveEvents(events, removal);
    events = sanitized.events;
    removedEventIds.push(...sanitized.removed_event_ids);
    changedEventIds.push(...sanitized.changed_event_ids);
  }
  const evidence = RestoreReplayEvidenceSchema.parse({
    tenant_id: tenantId,
    deletion_epoch: authority.deletion_epoch,
    authority_ids: [...authority.authority_ids],
    removed_event_ids: [...new Set(removedEventIds)],
    changed_event_ids: [...new Set(changedEventIds)],
    rejected_event_ids: [...new Set(removedEventIds)],
    tombstones_reapplied: [...authority.authority_ids],
  });
  return {
    manifests: page.manifests,
    events,
    next_cursor: page.next_cursor,
    evidence,
  };
};
