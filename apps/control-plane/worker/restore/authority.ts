import {
  CONTROLLED_COPY_STORES,
  type ControlledCopyAuxiliaryStore,
  type ControlledCopyStore,
  RestoreAuthorityExportSchema,
  RestoreDatabaseTargetSchema,
  RestoreInventoryCopySchema,
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
type RestoreStore = ControlledCopyStore | ControlledCopyAuxiliaryStore;
type InventoryScope = {
  id: string;
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  content_generation: string;
  deletion_epoch: number;
};

type InventoryObservation = {
  complete: boolean;
  evidence_source: string;
  detail: string | null;
  references: string[];
  copies: Array<{
    reference: string;
    copy_created_at: string;
    resource_id: string;
    content_generation: string;
  }>;
};

type AuthorityInventory = {
  targets: RestoreDatabaseTarget[];
  stores: Map<RestoreStore, InventoryObservation>;
};

const RESTORE_STORES: readonly RestoreStore[] = [
  ...CONTROLLED_COPY_STORES,
  "session_credentials",
  "account_keys",
];

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
  inventoryComplete,
  inventoryDetail,
  inventorySource,
  references,
  copies,
}: {
  store: RestoreStoreStatus["store"];
  required: boolean;
  completions: readonly Awaited<
    ReturnType<typeof evaluateControlledCopyCompletion>
  >[];
  generation: string;
  targetCoverageComplete: boolean;
  inventoryComplete: boolean;
  inventoryDetail: string | null;
  inventorySource: string;
  references: readonly string[];
  copies: readonly {
    reference: string;
    copy_created_at: string;
    resource_id: string;
    content_generation: string;
  }[];
}): RestoreStoreStatus => {
  if (completions.length === 0) {
    return RestoreStoreStatusSchema.parse({
      store,
      generation,
      status: inventoryComplete
        ? required
          ? "complete"
          : "preserved"
        : "incomplete",
      content_present: !required || !inventoryComplete,
      evidence_source: inventorySource,
      detail: inventoryComplete ? null : inventoryDetail,
      references: [...references],
      copies: [...copies],
    });
  }
  const complete =
    inventoryComplete &&
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
    evidence_source: inventorySource,
    detail: complete
      ? null
      : (inventoryDetail ??
        (targetCoverageComplete
          ? "Current controlled-copy evidence does not prove this store is safe to restore"
          : "Exact restore targets are unavailable for one or more removal authorities")),
    references: [...references],
    copies: [...copies],
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

const inventoryDetail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 4_096) || "controlled-copy inventory failed";
};

const inventoryCopies = (
  copies: readonly {
    reference: string;
    copy_created_at: Date | string;
    resource_id?: string;
    content_generation?: string;
  }[],
  scope: { resource_id: string; content_generation: string },
) =>
  copies
    .map((copy) =>
      RestoreInventoryCopySchema.parse({
        reference: copy.reference,
        copy_created_at:
          copy.copy_created_at instanceof Date
            ? copy.copy_created_at.toISOString()
            : new Date(copy.copy_created_at).toISOString(),
        resource_id: copy.resource_id ?? scope.resource_id,
        content_generation: copy.content_generation ?? scope.content_generation,
      }),
    )
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

const inventoryForAuthority = async (
  adapters: readonly ControlledCopyAdapter[],
  authority: InventoryScope,
  now: Date,
  targetAuthority?: RemovalAuthority,
): Promise<AuthorityInventory> => {
  const targets: RestoreDatabaseTarget[] = [];
  const seen = new Set<string>();
  const stores = new Map<RestoreStore, InventoryObservation>();
  const byStore = new Map<RestoreStore, ControlledCopyAdapter>();
  for (const adapter of adapters) {
    if (byStore.has(adapter.store)) {
      throw new Error(`duplicate controlled-copy adapter: ${adapter.store}`);
    }
    byStore.set(adapter.store, adapter);
  }
  for (const store of RESTORE_STORES) {
    const adapter = byStore.get(store);
    if (adapter === undefined) {
      stores.set(store, {
        complete: false,
        evidence_source: `${store}_inventory_unavailable`,
        detail: "No configured inventory adapter is available",
        references: [],
        copies: [],
      });
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
    } catch (error) {
      stores.set(store, {
        complete: false,
        evidence_source: `${store}_inventory_error`,
        detail: inventoryDetail(error),
        references: [],
        copies: [],
      });
      continue;
    }
    const copies = inventoryCopies(inventory.copies, authority);
    stores.set(store, {
      complete: inventory.complete,
      evidence_source: inventory.evidence_source,
      detail: inventory.complete
        ? null
        : (inventory.detail ?? "Inventory is incomplete"),
      references: copies.map((copy) => copy.reference),
      copies,
    });
    if (
      targetAuthority === undefined ||
      (store !== "synapse" && store !== "bridge_database")
    )
      continue;
    for (const copy of inventory.copies) {
      const raw = copy.restore_target;
      if (raw === undefined) continue;
      const parsed = RestoreDatabaseTargetSchema.safeParse({
        ...raw,
        resource_id:
          raw.resource_id ?? copy.resource_id ?? targetAuthority.resource_id,
        content_generation:
          raw.content_generation ??
          copy.content_generation ??
          targetAuthority.content_generation,
      });
      if (!parsed.success) continue;
      if (
        parsed.data.resource_id !== targetAuthority.resource_id ||
        parsed.data.content_generation !== targetAuthority.content_generation
      ) {
        continue;
      }
      const key = JSON.stringify(parsed.data);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(parsed.data);
    }
  }
  return { targets, stores };
};

const inventoryScopeForTenant = (
  tenantId: string,
  deletionEpoch: number,
): InventoryScope => ({
  id: `restore_inventory_${tenantId}`,
  tenant_id: tenantId,
  resource_type: "tenant",
  resource_id: tenantId,
  content_generation: `ledger_${deletionEpoch}`,
  deletion_epoch: deletionEpoch,
});

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
  const authorityInventories = await Promise.all(
    authorities.map(async (authority) => ({
      authority,
      inventory: await inventoryForAuthority(
        adapters,
        authority,
        now,
        authority,
      ),
    })),
  );
  const ledgerInventory =
    authorities.length === 0
      ? await inventoryForAuthority(
          adapters,
          inventoryScopeForTenant(tenantId, deletionEpoch),
          now,
        )
      : undefined;
  const exportAuthorities = authorityInventories.map(
    ({ authority, inventory }) => ({
      ...authority,
      // A real inventory backend publishes exact room/event or bridge row and
      // exhaustive media mappings.  An unavailable backend leaves this empty;
      // the host gate blocks instead of inferring from an opaque id.
      targets: inventory.targets,
    }),
  );
  const authorityIds = exportAuthorities.map((authority) => authority.id);
  const inventoryEvidence =
    authorities.length === 0
      ? [
          {
            // A tenant with no removal rows still needs an explicit current
            // ledger inventory. This synthetic entry keeps the zero-row
            // ledger head bound to every provider copy observed for it.
            authority_id: tenantId,
            targets: [],
            stores: RESTORE_STORES.map((store) => ({
              store,
              ...(ledgerInventory?.stores.get(store) ?? {
                complete: false,
                evidence_source: `${store}_inventory_unavailable`,
                detail: "No configured inventory adapter is available",
                references: [],
                copies: [],
              }),
            })),
          },
        ]
      : authorityInventories.map(({ authority, inventory }) => ({
          authority_id: authority.id,
          targets: inventory.targets,
          stores: RESTORE_STORES.map((store) => ({
            store,
            ...(inventory.stores.get(store) ?? {
              complete: false,
              evidence_source: `${store}_inventory_unavailable`,
              detail: "No configured inventory adapter is available",
              references: [],
              copies: [],
            }),
          })),
        }));
  const head = await hexDigest(
    canonicalJson({
      tenant_id: tenantId,
      deletion_epoch: deletionEpoch,
      authorities: exportAuthorities,
      inventory: inventoryEvidence,
    }),
  );
  const current = await loadRestoreAuthority(primary, tenantId);
  if (
    current.deletion_epoch !== deletionEpoch ||
    canonicalJson(current.authorities) !== canonicalJson(authorities)
  ) {
    throw new Error("restore authority changed while it was being exported");
  }
  const storeEvidence = new Map<
    RestoreStore,
    {
      complete: boolean;
      evidence_source: string;
      detail: string | null;
      references: string[];
      copies: Array<{
        reference: string;
        copy_created_at: string;
        resource_id: string;
        content_generation: string;
      }>;
    }
  >();
  for (const store of RESTORE_STORES) {
    const observations =
      authorities.length === 0
        ? [ledgerInventory?.stores.get(store)]
        : authorityInventories.map(({ inventory }) =>
            inventory.stores.get(store),
          );
    const missing = observations.some(
      (observation) => observation === undefined,
    );
    const incomplete = observations.some(
      (observation) =>
        observation === undefined || observation.complete !== true,
    );
    const firstIncomplete = observations.find(
      (observation) =>
        observation === undefined || observation.complete !== true,
    );
    storeEvidence.set(store, {
      complete: !missing && !incomplete,
      evidence_source: firstIncomplete?.evidence_source ?? `${store}_inventory`,
      detail:
        firstIncomplete === undefined
          ? null
          : (firstIncomplete.detail ?? "Inventory is incomplete"),
      references: [
        ...new Set(
          observations.flatMap((observation) => observation?.references ?? []),
        ),
      ].sort(),
      copies: observations
        .flatMap((observation) => observation?.copies ?? [])
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
    });
  }
  const storeGeneration = async (
    store: RestoreStore,
    ledgerHead: string,
    evidence: ReadonlyMap<
      RestoreStore,
      {
        complete: boolean;
        evidence_source: string;
        detail: string | null;
        references: string[];
        copies: Array<{
          reference: string;
          copy_created_at: string;
          resource_id: string;
          content_generation: string;
        }>;
      }
    >,
  ): Promise<string> => {
    const observation = evidence.get(store);
    if (observation === undefined)
      throw new Error("restore store evidence missing");
    return hexDigest(
      canonicalJson({
        ledger_head: ledgerHead,
        store,
        complete: observation.complete,
        evidence_source: observation.evidence_source,
        detail: observation.detail,
        references: observation.references,
        copies: observation.copies,
      }),
    );
  };
  const storeGenerations = new Map<RestoreStore, string>();
  for (const store of RESTORE_STORES) {
    storeGenerations.set(
      store,
      await storeGeneration(store, head, storeEvidence),
    );
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
      (() => {
        const evidence = storeEvidence.get(store);
        if (evidence === undefined)
          throw new Error("restore store evidence missing");
        return statusForStore({
          store,
          required: true,
          completions,
          generation: storeGenerations.get(store)!,
          targetCoverageComplete: exportAuthorities.every(
            (authority) => authority.targets.length > 0,
          ),
          inventoryComplete: evidence.complete,
          inventoryDetail: evidence.detail,
          inventorySource: evidence.evidence_source,
          references: evidence.references,
          copies: evidence.copies,
        });
      })(),
    ),
    ...(["session_credentials", "account_keys"] as const).map((store) =>
      (() => {
        const evidence = storeEvidence.get(store);
        if (evidence === undefined)
          throw new Error("restore store evidence missing");
        return statusForStore({
          store,
          required: false,
          completions,
          generation: storeGenerations.get(store)!,
          targetCoverageComplete: true,
          inventoryComplete: evidence.complete,
          inventoryDetail: evidence.detail,
          inventorySource: evidence.evidence_source,
          references: evidence.references,
          copies: evidence.copies,
        });
      })(),
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
    inventory: inventoryEvidence,
    ledger_head: head,
    stores,
    archive,
    issued_at: issuedAt,
    expires_at: expiresAt,
  });
};
