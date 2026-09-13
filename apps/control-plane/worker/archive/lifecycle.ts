import type {
  RecordRemovalInput,
  RemovalAuthority,
} from "../../../../packages/contracts/src/removals";
import {
  recordRemovalWithSuppression,
  runRemovalExpiryAndSuppress,
} from "../removals/service";
import type { RemovalExpiryTickResult } from "../removals/ledger";
import {
  listArchivePurgeCandidates,
  purgeArchiveForRemoval,
  readArchivePurgeForRemoval,
  type ArchivePurgeResult,
} from "./purge";
import { readRemovalAuthorityById } from "../removals/ledger";

type RemovalDatabase = D1Database | D1DatabaseSession;

/** Bindings required to run archive work after authorized suppression. */
export type ArchiveRemovalLifecycleContext = {
  database: RemovalDatabase;
  bucket: R2Bucket;
  safetyWindowMs?: number;
};

export type RecordedRemovalArchiveResult = {
  authority: RemovalAuthority;
  archive: ArchivePurgeResult;
};

/**
 * Run the archive side of an already-authorized removal.  The authority and
 * delivery cancellation are written first, so an archive outage leaves active
 * suppression enforced and reports archive work as incomplete.
 */
export const purgeRecordedRemoval = async (
  context: ArchiveRemovalLifecycleContext,
  authority: RemovalAuthority,
  now?: Date,
): Promise<ArchivePurgeResult> =>
  purgeArchiveForRemoval({
    database: context.database,
    bucket: context.bucket,
    tenantId: authority.tenant_id,
    removalId: authority.id,
    ...(now === undefined ? {} : { now }),
    ...(context.safetyWindowMs === undefined
      ? {}
      : { safetyWindowMs: context.safetyWindowMs }),
  });

/**
 * Application-facing removal lifecycle entrypoint.  Callers must provide the
 * authenticated/authorized removal input; this function records suppression
 * before invoking durable archive cleanup.
 */
export const recordRemovalWithArchivePurge = async (
  context: ArchiveRemovalLifecycleContext,
  input: RecordRemovalInput,
  now?: Date,
): Promise<RecordedRemovalArchiveResult> => {
  const authority = await recordRemovalWithSuppression(
    context.database,
    input,
    now,
  );
  const archive = await purgeRecordedRemoval(context, authority, now);
  return { authority, archive };
};

export type RemovalExpiryArchiveTickResult = RemovalExpiryTickResult & {
  archived: RecordedRemovalArchiveResult[];
};

/**
 * Scheduled removal expiry entrypoint.  Expiry first records the authority
 * and cancels undelivered work in the existing tick, then runs the same archive
 * operation for every newly completed expiry.  Archive status stays separate
 * from the global removal ledger because other controlled stores may remain.
 */
export const runRemovalExpiryAndArchive = async (
  context: ArchiveRemovalLifecycleContext,
  now = new Date(),
  limit?: number,
): Promise<RemovalExpiryArchiveTickResult> => {
  const result = await runRemovalExpiryAndSuppress(
    context.database,
    now,
    limit,
  );
  const candidates = await listArchivePurgeCandidates(
    context.database,
    limit ?? 100,
  );
  const authorities = new Map<string, RemovalAuthority>();
  for (const authority of result.completed) {
    authorities.set(`${authority.tenant_id}\u0000${authority.id}`, authority);
  }
  for (const candidate of candidates) {
    const authority = await readRemovalAuthorityById(
      context.database,
      candidate.tenantId,
      candidate.removalId,
    );
    if (authority !== null) {
      authorities.set(`${authority.tenant_id}\u0000${authority.id}`, authority);
    }
  }

  const archived: RecordedRemovalArchiveResult[] = [];
  for (const authority of authorities.values()) {
    archived.push({
      authority,
      archive: await purgeRecordedRemoval(context, authority, now),
    });
  }
  return { ...result, archived };
};

/** Read visible archive progress without changing suppression authority. */
export const readArchiveStatusForRemoval = (
  context: Pick<ArchiveRemovalLifecycleContext, "database">,
  tenantId: string,
  removalId: string,
): Promise<ArchivePurgeResult | null> =>
  readArchivePurgeForRemoval(context.database, tenantId, removalId);
