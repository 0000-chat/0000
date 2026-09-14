import {
  RestoreAuthorityExportSchema,
  RestoreDatabaseTargetSchema,
  RestoreStoreStatusSchema,
  type RestoreAuthorityExport,
  type RestoreDatabaseTarget,
  type RestoreStoreStatus,
} from "@communicator/contracts";
import type { RemovalAuthority } from "../../../../packages/contracts/src/removals";
import { listArchivePurgeOperations } from "../archive/purge";
import { evaluateControlledCopyCompletion } from "../retention/service";
import type { ControlledCopyAdapter } from "../retention/adapters";
import { loadRestoreAuthority } from "./gate";

type RestoreAuthorityDatabase = D1Database | D1DatabaseSession;

const RESTORE_AUTHORITY_TTL_MS = 120_000;

const primaryDatabase = (
  database: RestoreAuthorityDatabase,
): D1DatabaseSession => {
  if ("withSession" in database && typeof database.withSession === "function") {
    return database.withSession("first-primary");
  }
  return database as D1DatabaseSession;
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("restore authority head is not JSON");
  return serialized;
};

const hexDigest = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const statusForStore = ({
  store,
  required,
  completions,
  generation,
  targetCoverageComplete,
}: {
  store: RestoreStoreStatus["store"];
  required: boolean;
  completions: readonly Awaited<
    ReturnType<typeof evaluateControlledCopyCompletion>
  >[];
  generation: string;
  targetCoverageComplete: boolean;
}): RestoreStoreStatus => {
  if (completions.length === 0) {
    return RestoreStoreStatusSchema.parse({
      store,
      generation,
      status: required ? "complete" : "preserved",
      content_present: !required,
      evidence_source: "current_removal_ledger",
      detail: null,
    });
  }
  const complete =
    targetCoverageComplete &&
    completions.every((completion) =>
      required
        ? completion.status === "complete" &&
          completion.completed_stores.includes(store as never) &&
          !completion.incomplete_stores.includes(store as never) &&
          !completion.missing_stores.includes(store as never)
        : completion.auxiliary_operations.some(
            (operation) =>
              operation.store === store && operation.status === "preserved",
          ),
    );
  const status = complete
    ? required
      ? "complete"
      : "preserved"
    : "incomplete";
  return RestoreStoreStatusSchema.parse({
    store,
    generation,
    status,
    content_present: !required || !complete,
    evidence_source: "current_removal_ledger",
    detail: complete
      ? null
      : targetCoverageComplete
        ? "Current controlled-copy evidence does not prove this store is safe to restore"
        : "Exact restore targets are unavailable for one or more removal authorities",
  });
};

const archiveEvidenceFor = (
  authorities: readonly RemovalAuthority[],
  operations: Awaited<ReturnType<typeof listArchivePurgeOperations>>,
  deletionEpoch: number,
) => {
  const latest = new Map<string, (typeof operations)[number]>();
  for (const operation of operations) {
    const current = latest.get(operation.removal_id);
    if (
      current === undefined ||
      Date.parse(operation.updated_at) >= Date.parse(current.updated_at)
    ) {
      latest.set(operation.removal_id, operation);
    }
  }
  const complete = authorities.every(
    (authority) => latest.get(authority.id)?.status === "complete",
  );
  const generation =
    [...latest.values()]
      .map((operation) => operation.updated_at)
      .sort()
      .at(-1) ?? `deletion-epoch:${deletionEpoch}`;
  return {
    status: complete
      ? "complete"
      : authorities.length === 0
        ? "complete"
        : "incomplete",
    generation,
    evidence_source: "archive_purge_ledger",
  } as const;
};

const targetsForAuthority = async (
  adapters: readonly ControlledCopyAdapter[],
  authority: RemovalAuthority,
  now: Date,
): Promise<RestoreDatabaseTarget[]> => {
  const targets: RestoreDatabaseTarget[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (adapter.store !== "synapse" && adapter.store !== "bridge_database") {
      continue;
    }
    let inventory;
    try {
      inventory = await adapter.inventory({
        tenant_id: authority.tenant_id,
        removal_id: authority.id,
        resource_type: authority.resource_type,
        resource_id: authority.resource_id,
        content_generation: authority.content_generation,
        deletion_epoch: authority.deletion_epoch,
        now,
      });
    } catch {
      continue;
    }
    for (const copy of inventory.copies) {
      const raw = copy.restore_target;
      if (raw === undefined) continue;
      const parsed = RestoreDatabaseTargetSchema.safeParse({
        ...raw,
        resource_id:
          raw.resource_id ?? copy.resource_id ?? authority.resource_id,
        content_generation:
          raw.content_generation ??
          copy.content_generation ??
          authority.content_generation,
      });
      if (!parsed.success) continue;
      if (
        parsed.data.resource_id !== authority.resource_id ||
        parsed.data.content_generation !== authority.content_generation
      ) {
        continue;
      }
      const key = JSON.stringify(parsed.data);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(parsed.data);
    }
  }
  return targets;
};

/**
 * Publish the current primary removal ledger for an isolated host restore.
 * The route caller supplies normal administrator authentication; the host
 * gate also compares this export's head after sanitation, so a response
 * captured before a new removal cannot authorize activation.
 *
 * Exact database/media mappings are intentionally carried by each authority.
 * Until a producer records one, ``targets`` is empty and the host gate fails
 * closed.  That preserves the no-guessing rule for mixed custom PostgreSQL
 * dumps while making the missing mapping visible to the administrator.
 */
export const createRestoreAuthorityExport = async (
  database: RestoreAuthorityDatabase,
  tenantId: string,
  now = new Date(),
  adapters: readonly ControlledCopyAdapter[] = [],
): Promise<RestoreAuthorityExport> => {
  // Every ledger read uses one first-primary session.  A separately supplied
  // JSON file cannot establish the current head; this export is generated from
  // the authoritative D1 session and checked again after external inventory
  // adapters finish.
  const primary = primaryDatabase(database);
  const snapshot = await loadRestoreAuthority(primary, tenantId);
  const archiveOperations = await listArchivePurgeOperations(primary, tenantId);
  const authorities = snapshot.authorities;
  const deletionEpoch = snapshot.deletion_epoch;

  const completions = await Promise.all(
    authorities.map(async (authority) =>
      evaluateControlledCopyCompletion({
        database: primary,
        tenantId,
        removalId: authority.id,
        resourceId: authority.resource_id,
        contentGeneration: authority.content_generation,
        deletionEpoch: authority.deletion_epoch,
        canonicalArchive:
          archiveOperations.find(
            (operation) => operation.removal_id === authority.id,
          )?.status === "complete"
            ? "complete"
            : "incomplete",
        now,
      }),
    ),
  );
  const exportAuthorities = await Promise.all(
    authorities.map(async (authority) => ({
      ...authority,
      // A real inventory backend publishes exact room/event or bridge row and
      // exhaustive media mappings.  An unavailable backend leaves this empty;
      // the host gate blocks instead of inferring from an opaque id.
      targets: await targetsForAuthority(adapters, authority, now),
    })),
  );
  const authorityIds = exportAuthorities.map((authority) => authority.id);
  const head = await hexDigest(
    canonicalJson({
      tenant_id: tenantId,
      deletion_epoch: deletionEpoch,
      authorities: exportAuthorities,
    }),
  );
  const current = await loadRestoreAuthority(primary, tenantId);
  if (
    current.deletion_epoch !== deletionEpoch ||
    canonicalJson(current.authorities) !== canonicalJson(authorities)
  ) {
    throw new Error("restore authority changed while it was being exported");
  }
  const stores: RestoreStoreStatus[] = [
    ...(
      [
        "projection_backup",
        "synapse",
        "bridge_database",
        "media_store",
        "queue",
        "restic_snapshot",
      ] as const
    ).map((store) =>
      statusForStore({
        store,
        required: true,
        completions,
        generation: head,
        targetCoverageComplete: exportAuthorities.every(
          (authority) => authority.targets.length > 0,
        ),
      }),
    ),
    ...(["session_credentials", "account_keys"] as const).map((store) =>
      statusForStore({
        store,
        required: false,
        completions,
        generation: head,
        targetCoverageComplete: true,
      }),
    ),
  ];
  const archive = {
    ...archiveEvidenceFor(authorities, archiveOperations, deletionEpoch),
    // A host must be able to associate every store observation with the exact
    // ledger head it fetched.  The operation timestamp remains available in
    // the durable archive ledger itself.
    generation: head,
  } as const;
  const issuedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + RESTORE_AUTHORITY_TTL_MS,
  ).toISOString();
  return RestoreAuthorityExportSchema.parse({
    version: 1,
    tenant_id: tenantId,
    deletion_epoch: deletionEpoch,
    authority_ids: authorityIds,
    authority_count: exportAuthorities.length,
    authorities: exportAuthorities,
    ledger_head: head,
    stores,
    archive,
    issued_at: issuedAt,
    expires_at: expiresAt,
  });
};
