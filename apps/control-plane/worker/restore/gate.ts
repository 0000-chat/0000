import {
  CONTROLLED_COPY_STORES,
  RestoreReadinessSchema,
  RestoreInventoryCopySchema,
  RestoreStoreStatusSchema,
  type ControlledCopyStore,
  type RestoreReadiness,
  type RestoreStoreStatus,
} from "@communicator/contracts";
import {
  listRemovalAuthorities,
  readTenantDeletionEpoch,
} from "../removals/ledger";
import {
  evaluateControlledCopyCompletion,
  readControlledCopyOperations,
} from "../retention/service";
import type { RemovalAuthority } from "../../../../packages/contracts/src/removals";

type RestoreDatabase = D1Database | D1DatabaseSession;

export type RestoreAuthoritySnapshot = {
  tenant_id: string;
  deletion_epoch: number;
  authorities: readonly RemovalAuthority[];
  authority_ids: readonly string[];
};

/**
 * The removal ledger head binds immutable suppression identity. Mutable
 * lifecycle fields such as purge status, failure detail, and timestamps may
 * advance while a restore is in flight without changing which content is
 * forbidden to expose.
 */
export const immutableRestoreAuthority = (
  authority: RemovalAuthority,
): Pick<
  RemovalAuthority,
  | "id"
  | "tenant_id"
  | "resource_type"
  | "resource_id"
  | "content_generation"
  | "account_id"
  | "conversation_id"
  | "source_event_id"
  | "source_object_key"
  | "reason"
  | "removed_at"
  | "deletion_epoch"
  | "created_at"
> => ({
  id: authority.id,
  tenant_id: authority.tenant_id,
  resource_type: authority.resource_type,
  resource_id: authority.resource_id,
  content_generation: authority.content_generation,
  account_id: authority.account_id,
  conversation_id: authority.conversation_id,
  source_event_id: authority.source_event_id,
  source_object_key: authority.source_object_key,
  reason: authority.reason,
  removed_at: authority.removed_at,
  deletion_epoch: authority.deletion_epoch,
  created_at: authority.created_at,
});

export type RestoreStoreObservation = {
  store: RestoreStoreStatus["store"];
  generation: string;
  status: RestoreStoreStatus["status"];
  content_present: boolean;
  evidence_source: string;
  detail?: string | null;
  references?: readonly string[];
  copies?: readonly {
    reference: string;
    copy_created_at: string;
    resource_id: string;
    content_generation: string;
  }[];
};

const isoNow = (now: Date): string => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("restore gate clock is invalid");
  }
  return now.toISOString();
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const assertAuthoritySequence = (
  tenantId: string,
  deletionEpoch: number,
  authorities: readonly RemovalAuthority[],
): void => {
  if (!Number.isSafeInteger(deletionEpoch) || deletionEpoch < 0) {
    throw new Error("restore deletion epoch is invalid");
  }
  const seenIds = new Set<string>();
  const seenLineage = new Set<string>();
  for (let index = 0; index < authorities.length; index += 1) {
    const authority = authorities[index];
    if (authority === undefined || authority.tenant_id !== tenantId) {
      throw new Error("restore authority tenant mismatch");
    }
    if (seenIds.has(authority.id)) {
      throw new Error("restore authority id is duplicated");
    }
    seenIds.add(authority.id);
    const lineage = `${authority.resource_type}\u0000${authority.resource_id}\u0000${authority.content_generation}`;
    if (seenLineage.has(lineage)) {
      throw new Error("restore authority lineage is duplicated");
    }
    seenLineage.add(lineage);
    if (
      authority.deletion_epoch < 1 ||
      authority.deletion_epoch > deletionEpoch
    ) {
      throw new Error("restore authority epoch is outside the current ledger");
    }
    const previous = authorities[index - 1];
    if (
      previous !== undefined &&
      authority.deletion_epoch < previous.deletion_epoch
    ) {
      throw new Error("restore authorities are out of epoch order");
    }
  }
  if (deletionEpoch !== 0 && authorities.length === 0) {
    throw new Error("restore deletion epoch has no authority records");
  }
  const epochs = new Set(
    authorities.map((authority) => authority.deletion_epoch),
  );
  for (let epoch = 1; epoch <= deletionEpoch; epoch += 1) {
    if (!epochs.has(epoch)) {
      throw new Error("restore removal authority has a missing deletion epoch");
    }
  }
};

/**
 * Load the non-rebuildable removal ledger before a restore caller reads a
 * projection, archive page, bridge database, or message service.  The ledger
 * is read from a primary D1 session and its epoch sequence is checked so a
 * partial replica cannot silently authorize an old snapshot.
 */
export const loadRestoreAuthority = async (
  database: RestoreDatabase,
  tenantId: string,
): Promise<RestoreAuthoritySnapshot> => {
  const [authorities, deletionEpoch] = await Promise.all([
    listRemovalAuthorities(database, tenantId),
    readTenantDeletionEpoch(database, tenantId),
  ]);
  assertAuthoritySequence(tenantId, deletionEpoch, authorities);
  return {
    tenant_id: tenantId,
    deletion_epoch: deletionEpoch,
    authorities,
    authority_ids: authorities.map((authority) => authority.id),
  };
};

const checkedStoreStatus = (
  observation: RestoreStoreObservation,
): RestoreStoreStatus =>
  RestoreStoreStatusSchema.parse({
    store: observation.store,
    generation: observation.generation,
    status: observation.status,
    content_present: observation.content_present,
    evidence_source: observation.evidence_source,
    detail: observation.detail ?? null,
    references: [...(observation.references ?? [])],
    copies: (observation.copies ?? []).map((copy) =>
      RestoreInventoryCopySchema.parse(copy),
    ),
  });

/** Validate an externally produced restore inventory before startup. */
export const validateRestoreStoreEvidence = (
  observations: readonly RestoreStoreObservation[],
): RestoreStoreStatus[] => {
  const parsed = observations.map(checkedStoreStatus);
  const byStore = new Map<string, RestoreStoreStatus>();
  for (const observation of parsed) {
    if (byStore.has(observation.store)) {
      throw new Error(
        `restore store evidence is duplicated: ${observation.store}`,
      );
    }
    byStore.set(observation.store, observation);
  }
  const missing = CONTROLLED_COPY_STORES.filter((store) => !byStore.has(store));
  if (missing.length > 0) {
    throw new Error(`restore store evidence is missing: ${missing.join(",")}`);
  }
  return parsed;
};

const statusForStore = (
  store: ControlledCopyStore,
  completions: Awaited<ReturnType<typeof evaluateControlledCopyCompletion>>[],
  deletionEpoch: number,
  inventory?: RestoreStoreStatus,
): RestoreStoreStatus => {
  if (inventory !== undefined) {
    if (
      inventory.status === "complete" &&
      (inventory.references.length === 0 || inventory.copies.length === 0)
    ) {
      return RestoreStoreStatusSchema.parse({
        ...inventory,
        status: "incomplete",
        content_present: true,
        detail: "Current store evidence has no concrete copy reference",
      });
    }
    return inventory;
  }
  const complete =
    completions.every(
      (completion) =>
        completion.status === "complete" &&
        completion.completed_stores.includes(store) &&
        !completion.incomplete_stores.includes(store) &&
        !completion.missing_stores.includes(store),
    ) && completions.length > 0;
  const incomplete = completions.some(
    (completion) =>
      completion.incomplete_stores.includes(store) ||
      completion.missing_stores.includes(store),
  );
  return checkedStoreStatus({
    store,
    generation: `deletion-epoch:${deletionEpoch}`,
    status: complete ? "complete" : incomplete ? "incomplete" : "unknown",
    content_present: !complete,
    evidence_source: "controlled_copy_completion",
    detail: complete
      ? null
      : "The controlled-copy completion ledger does not prove this store is safe to restore",
    references: [],
    copies: [],
  });
};

/**
 * Compose archive and controlled-copy evidence into the startup decision.
 * This report is deliberately separate from removal completion: a missing or
 * partial store blocks readiness even when active suppression is already
 * enforced.
 */
export const restoreReadinessForTenant = async ({
  database,
  tenantId,
  canonicalArchiveFor,
  storeEvidence,
  now = new Date(),
}: {
  database: RestoreDatabase;
  tenantId: string;
  canonicalArchiveFor?: (
    authority: RemovalAuthority,
  ) => Promise<"complete" | "incomplete" | "missing">;
  storeEvidence?: readonly RestoreStoreStatus[];
  now?: Date;
}): Promise<RestoreReadiness> => {
  const snapshot = await loadRestoreAuthority(database, tenantId);
  const completions = await Promise.all(
    snapshot.authorities.map(async (authority) =>
      evaluateControlledCopyCompletion({
        database,
        tenantId,
        removalId: authority.id,
        resourceId: authority.resource_id,
        contentGeneration: authority.content_generation,
        deletionEpoch: authority.deletion_epoch,
        canonicalArchive: canonicalArchiveFor
          ? await canonicalArchiveFor(authority)
          : "missing",
        now,
      }),
    ),
  );
  const stores = CONTROLLED_COPY_STORES.map((store) =>
    statusForStore(
      store,
      completions,
      snapshot.deletion_epoch,
      storeEvidence?.find((evidence) => evidence.store === store),
    ),
  );
  const blockedReasons = unique(
    completions.flatMap((completion) => completion.alerts),
  );
  const incompleteStores = unique(
    stores
      .filter((store) => store.status !== "complete")
      .map((store) => store.store)
      .filter((store): store is ControlledCopyStore =>
        CONTROLLED_COPY_STORES.includes(store as ControlledCopyStore),
      ),
  );
  const state = incompleteStores.length === 0 ? "ready" : "incomplete";
  return RestoreReadinessSchema.parse({
    tenant_id: tenantId,
    deletion_epoch: snapshot.deletion_epoch,
    authority_ids: [...snapshot.authority_ids],
    authority_count: snapshot.authorities.length,
    required_stores: [...CONTROLLED_COPY_STORES],
    stores,
    incomplete_stores: incompleteStores,
    blocked_reasons: blockedReasons,
    state,
    checked_at: isoNow(now),
  });
};

/**
 * Return all controlled-copy operations for a restore report consumer.  This
 * narrow wrapper keeps callers from bypassing the primary-session read used by
 * the retention service when composing an authority snapshot.
 */
export const readRestoreOperations = async (
  database: RestoreDatabase,
  tenantId: string,
  removalId: string,
) => readControlledCopyOperations(database, tenantId, removalId);
