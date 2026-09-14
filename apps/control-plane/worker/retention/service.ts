import {
  CONTROLLED_COPY_CLEANUP_MARGIN_MS,
  CONTROLLED_COPY_MAX_AGE_MS,
  CONTROLLED_COPY_STORES,
  ControlledCopyCompletionSchema,
  ControlledCopyEvidenceInputSchema,
  ControlledCopyEvidenceSchema,
  ControlledCopyOperationSchema,
  type ControlledCopyCompletion,
  type ControlledCopyEvidence,
  type ControlledCopyEvidenceInput,
  type ControlledCopyInventoryItem,
  type ControlledCopyLineage,
  type ControlledCopyOperation,
  type ControlledCopyStore,
} from "@communicator/contracts";
import { randomIdentifier } from "../oauth/crypto";
import { listAllRemovalAuthorities } from "../removals/ledger";
import type { RemovalAuthority } from "../../../../packages/contracts/src/removals";
import {
  createUnavailableAdapter,
  createUnavailableAuxiliaryAdapter,
  type ControlledCopyAdapter,
  type RetentionInventoryResult,
  type RetentionInventoryScope,
} from "./adapters";

export type RetentionDatabase = D1Database | D1DatabaseSession;

export const CONTROLLED_COPY_WORKER_LEASE_MS = 60_000;
export const MAX_CONTROLLED_COPY_BATCH = 100;

const OPERATION_COLUMNS = `
  id, tenant_id, removal_id, resource_type, resource_id, content_generation,
  deletion_epoch, store, owner, content_class, reference, deletion_method,
  required, copy_created_at, cleanup_margin_ms, cleanup_deadline,
  retention_deadline, status,
  lease_token, lease_expires_at, last_error, completed_at, created_at, updated_at
`;
const EVIDENCE_COLUMNS = `
  id, operation_id, tenant_id, removal_id, store, resource_id,
  content_generation, deletion_epoch, status, content_present, evidence_source,
  object_reference, detail, worker_token, observed_at
`;

type OperationRow = Record<string, unknown>;
type EvidenceRow = Record<string, unknown>;

const primarySession = (database: RetentionDatabase): D1DatabaseSession => {
  if ("withSession" in database && typeof database.withSession === "function") {
    return database.withSession("first-primary");
  }
  return database as D1DatabaseSession;
};

const timestamp = (value: Date): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("controlled copy timestamp invalid");
  }
  return value.toISOString();
};

const stringValue = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`controlled copy ${name} invalid`);
  }
  return value;
};

const nullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const integerValue = (value: unknown, name: string): number => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`controlled copy ${name} invalid`);
  }
  return number;
};

const booleanValue = (value: unknown, name: string): boolean => {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new Error(`controlled copy ${name} invalid`);
};

const parseOperation = (row: OperationRow | null): ControlledCopyOperation => {
  if (row === null) throw new Error("controlled copy operation missing");
  const parsed = ControlledCopyOperationSchema.safeParse({
    id: stringValue(row.id, "operation id"),
    tenant_id: stringValue(row.tenant_id, "tenant id"),
    removal_id: stringValue(row.removal_id, "removal id"),
    resource_type: stringValue(row.resource_type, "resource type"),
    resource_id: stringValue(row.resource_id, "resource id"),
    content_generation: stringValue(
      row.content_generation,
      "content generation",
    ),
    deletion_epoch: integerValue(row.deletion_epoch, "deletion epoch"),
    store: row.store,
    owner: stringValue(row.owner, "owner"),
    content_class: row.content_class,
    reference: stringValue(row.reference, "reference"),
    deletion_method: row.deletion_method,
    required: booleanValue(row.required, "required"),
    copy_created_at: stringValue(row.copy_created_at, "copy created at"),
    cleanup_margin_ms: integerValue(row.cleanup_margin_ms, "cleanup margin"),
    cleanup_deadline: stringValue(row.cleanup_deadline, "cleanup deadline"),
    retention_deadline: stringValue(
      row.retention_deadline,
      "retention deadline",
    ),
    status: row.status,
    lease_token: nullableString(row.lease_token),
    lease_expires_at: nullableString(row.lease_expires_at),
    last_error: nullableString(row.last_error),
    completed_at: nullableString(row.completed_at),
    created_at: stringValue(row.created_at, "created at"),
    updated_at: stringValue(row.updated_at, "updated at"),
  });
  if (!parsed.success) throw new Error("controlled copy operation row invalid");
  return parsed.data;
};

const parseEvidence = (row: EvidenceRow): ControlledCopyEvidence => {
  const parsed = ControlledCopyEvidenceSchema.safeParse({
    id: stringValue(row.id, "evidence id"),
    operation_id: stringValue(row.operation_id, "operation id"),
    tenant_id: stringValue(row.tenant_id, "tenant id"),
    removal_id: stringValue(row.removal_id, "removal id"),
    store: row.store,
    resource_id: stringValue(row.resource_id, "resource id"),
    content_generation: stringValue(
      row.content_generation,
      "content generation",
    ),
    deletion_epoch: integerValue(row.deletion_epoch, "deletion epoch"),
    status: row.status,
    content_present: booleanValue(row.content_present, "content present"),
    evidence_source: stringValue(row.evidence_source, "evidence source"),
    object_reference: nullableString(row.object_reference),
    detail: nullableString(row.detail),
    worker_token: stringValue(row.worker_token, "worker token"),
    observed_at: stringValue(row.observed_at, "observed at"),
  });
  if (!parsed.success) throw new Error("controlled copy evidence row invalid");
  return parsed.data;
};

const readOperationById = async (
  db: D1DatabaseSession,
  tenantId: string,
  operationId: string,
): Promise<ControlledCopyOperation | null> => {
  const row = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM controlled_copy_operations
       WHERE tenant_id = ? AND id = ? LIMIT 1`,
    )
    .bind(tenantId, operationId)
    .first<OperationRow>();
  return row === null ? null : parseOperation(row);
};

export const readControlledCopyOperations = async (
  database: RetentionDatabase,
  tenantId: string,
  removalId: string,
): Promise<ControlledCopyOperation[]> => {
  const db = primarySession(database);
  const result = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM controlled_copy_operations
       WHERE tenant_id = ? AND removal_id = ?
       ORDER BY store ASC, reference ASC, id ASC`,
    )
    .bind(tenantId, removalId)
    .all<OperationRow>();
  return result.results.map(parseOperation);
};

export const readControlledCopyEvidence = async (
  database: RetentionDatabase,
  tenantId: string,
  removalId: string,
): Promise<ControlledCopyEvidence[]> => {
  const db = primarySession(database);
  const result = await db
    .prepare(
      `SELECT ${EVIDENCE_COLUMNS}
       FROM controlled_copy_evidence
       WHERE tenant_id = ? AND removal_id = ?
       ORDER BY observed_at ASC, id ASC`,
    )
    .bind(tenantId, removalId)
    .all<EvidenceRow>();
  return result.results.map(parseEvidence);
};

const deadlinesFor = (
  copyCreatedAt: string,
  cleanupMarginMs = CONTROLLED_COPY_CLEANUP_MARGIN_MS,
): {
  cleanup_margin_ms: number;
  cleanup_deadline: string;
  retention_deadline: string;
} => {
  const createdAt = Date.parse(copyCreatedAt);
  if (!Number.isFinite(createdAt)) {
    throw new Error("controlled copy creation time invalid");
  }
  if (
    !Number.isSafeInteger(cleanupMarginMs) ||
    cleanupMarginMs < 0 ||
    cleanupMarginMs >= CONTROLLED_COPY_MAX_AGE_MS
  ) {
    throw new Error("controlled copy cleanup margin invalid");
  }
  const retentionDeadline = new Date(createdAt + CONTROLLED_COPY_MAX_AGE_MS);
  const cleanupDeadline = new Date(
    retentionDeadline.getTime() - cleanupMarginMs,
  );
  return {
    cleanup_margin_ms: cleanupMarginMs,
    cleanup_deadline: timestamp(cleanupDeadline),
    retention_deadline: timestamp(retentionDeadline),
  };
};

export const controlledCopyDeadlines = deadlinesFor;

const inventoryReference = (store: string, resourceId: string): string =>
  `inventory_${store}_${resourceId}`.slice(0, 2_048);

const inventoryItemFor = (
  adapter: ControlledCopyAdapter,
  copy: {
    resource_id?: string;
    content_generation?: string;
    reference: string;
    copy_created_at: Date | string;
    content_class?: ControlledCopyInventoryItem["content_class"];
  },
  scope: RetentionInventoryScope,
): ControlledCopyInventoryItem => ({
  store: adapter.store,
  owner: adapter.owner,
  content_class: copy.content_class ?? adapter.default_content_class,
  resource_id: copy.resource_id ?? scope.resource_id,
  content_generation: copy.content_generation ?? scope.content_generation,
  reference: copy.reference,
  copy_created_at:
    copy.copy_created_at instanceof Date
      ? timestamp(copy.copy_created_at)
      : timestamp(new Date(copy.copy_created_at)),
  deletion_method: adapter.deletion_method,
  required: adapter.required,
});

const insertOrReadOperation = async (
  db: D1DatabaseSession,
  lineage: ControlledCopyLineage,
  item: ControlledCopyInventoryItem,
  now: string,
): Promise<ControlledCopyOperation> => {
  const deadlines = deadlinesFor(item.copy_created_at);
  const id = randomIdentifier("controlled_copy");
  await db
    .prepare(
      `INSERT OR IGNORE INTO controlled_copy_operations (
        id, tenant_id, removal_id, resource_type, resource_id,
        content_generation, deletion_epoch, store, owner, content_class,
        reference, deletion_method, required, copy_created_at,
        cleanup_margin_ms, cleanup_deadline, retention_deadline, status,
        lease_token,
        lease_expires_at, last_error, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned',
        NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(
      id,
      lineage.tenant_id,
      lineage.removal_id,
      lineage.resource_type,
      item.resource_id,
      item.content_generation,
      lineage.deletion_epoch,
      item.store,
      item.owner,
      item.content_class,
      item.reference,
      item.deletion_method,
      item.required ? 1 : 0,
      item.copy_created_at,
      deadlines.cleanup_margin_ms,
      deadlines.cleanup_deadline,
      deadlines.retention_deadline,
      now,
      now,
    )
    .run();
  const operation = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM controlled_copy_operations
       WHERE tenant_id = ? AND removal_id = ? AND store = ?
         AND resource_id = ? AND content_generation = ? AND reference = ?
       LIMIT 1`,
    )
    .bind(
      lineage.tenant_id,
      lineage.removal_id,
      item.store,
      item.resource_id,
      item.content_generation,
      item.reference,
    )
    .first<OperationRow>();
  if (operation === null)
    throw new Error("controlled copy operation was not recorded");
  const parsed = parseOperation(operation);
  if (
    parsed.deletion_epoch !== lineage.deletion_epoch ||
    parsed.resource_type !== lineage.resource_type ||
    parsed.deletion_method !== item.deletion_method ||
    parsed.required !== item.required
  ) {
    throw new Error("controlled copy operation lineage conflict");
  }
  return parsed;
};

const inventoryPlaceholder = (
  adapter: ControlledCopyAdapter,
  scope: RetentionInventoryScope,
): ControlledCopyInventoryItem => ({
  store: adapter.store,
  owner: adapter.owner,
  content_class: "inventory",
  resource_id: scope.resource_id,
  content_generation: scope.content_generation,
  reference: inventoryReference(adapter.store, scope.resource_id),
  copy_created_at: timestamp(scope.now),
  deletion_method: adapter.deletion_method,
  required: adapter.required,
});

const inventoryEvidence = (
  result: RetentionInventoryResult,
): ControlledCopyEvidenceInput => ({
  status: result.complete ? "missing" : "unknown",
  content_present: result.complete ? false : true,
  evidence_source: result.evidence_source,
  object_reference: null,
  detail:
    result.detail ??
    (result.complete
      ? "Inventory completed without a copy"
      : "Inventory did not prove that all copies were discovered"),
});

const operationStatusForEvidence = (
  operation: ControlledCopyOperation,
  evidence: ControlledCopyEvidenceInput,
): "complete" | "preserved" | "incomplete" | "failed" => {
  if (evidence.status === "failed") return "failed";
  if (
    ["deleted", "quarantined", "expired", "aged_out", "missing"].includes(
      evidence.status,
    ) &&
    !evidence.content_present
  ) {
    return "complete";
  }
  if (
    evidence.status === "preserved" &&
    !operation.required &&
    evidence.content_present
  ) {
    return "preserved";
  }
  return "incomplete";
};

const appendEvidence = async (
  db: D1DatabaseSession,
  operation: ControlledCopyOperation,
  evidenceInput: ControlledCopyEvidenceInput,
  workerToken: string,
  now: Date,
  leaseRequired: boolean,
): Promise<ControlledCopyOperation> => {
  const evidence = ControlledCopyEvidenceInputSchema.parse(evidenceInput);
  const observedAt = timestamp(now);
  const evidenceId = randomIdentifier("controlled_copy_evidence");
  await db
    .prepare(
      `INSERT INTO controlled_copy_evidence (
        id, operation_id, tenant_id, removal_id, store, resource_id,
        content_generation, deletion_epoch, status, content_present,
        evidence_source, object_reference, detail, worker_token, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      evidenceId,
      operation.id,
      operation.tenant_id,
      operation.removal_id,
      operation.store,
      operation.resource_id,
      operation.content_generation,
      operation.deletion_epoch,
      evidence.status,
      evidence.content_present ? 1 : 0,
      evidence.evidence_source,
      evidence.object_reference,
      evidence.detail,
      workerToken,
      observedAt,
    )
    .run();

  const nextStatus = operationStatusForEvidence(operation, evidence);
  const terminal = nextStatus === "complete" || nextStatus === "preserved";
  const statement = leaseRequired
    ? terminal
      ? `UPDATE controlled_copy_operations
         SET status = ?, lease_token = NULL, lease_expires_at = NULL,
             last_error = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'leased' AND lease_token = ?`
      : `UPDATE controlled_copy_operations
         SET status = ?, last_error = ?, completed_at = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'leased' AND lease_token = ?`
    : `UPDATE controlled_copy_operations
       SET status = ?, lease_token = NULL, lease_expires_at = NULL,
           last_error = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?
         AND status IN ('planned', 'incomplete', 'failed')
         AND lease_token IS NULL`;
  const bindings = leaseRequired
    ? terminal
      ? [
          nextStatus,
          null,
          observedAt,
          observedAt,
          operation.id,
          operation.tenant_id,
          workerToken,
        ]
      : [
          nextStatus,
          evidence.detail,
          observedAt,
          operation.id,
          operation.tenant_id,
          workerToken,
        ]
    : [
        nextStatus,
        terminal ? null : evidence.detail,
        terminal ? observedAt : null,
        observedAt,
        operation.id,
        operation.tenant_id,
      ];
  await db
    .prepare(statement)
    .bind(...bindings)
    .run();
  const current = await readOperationById(
    db,
    operation.tenant_id,
    operation.id,
  );
  if (current === null)
    throw new Error("controlled copy operation disappeared");
  return current;
};

const recordInventoryResult = async (
  db: D1DatabaseSession,
  operation: ControlledCopyOperation,
  result: RetentionInventoryResult,
  now: Date,
): Promise<ControlledCopyOperation> => {
  const evidence = inventoryEvidence(result);
  return appendEvidence(
    db,
    operation,
    evidence,
    randomIdentifier("controlled_copy_inventory"),
    now,
    false,
  );
};

/**
 * A removal can be recorded before a provider endpoint is configured.  That
 * first pass creates an unavailable inventory operation.  When a later
 * scheduled pass reaches a real provider, preserve that original evidence
 * but move the operation's current owner to the configured adapter and let
 * the provider's inventory close the old placeholder.  Without this bridge,
 * a valid provider would be permanently blocked by its own earlier absence.
 */
const reconcileUnavailableInventory = async (
  db: D1DatabaseSession,
  lineage: ControlledCopyLineage,
  adapter: ControlledCopyAdapter,
  scope: RetentionInventoryScope,
  now: string,
): Promise<boolean> => {
  const row = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM controlled_copy_operations
       WHERE tenant_id = ? AND removal_id = ? AND store = ?
         AND resource_id = ? AND content_generation = ? AND reference = ?
       LIMIT 1`,
    )
    .bind(
      lineage.tenant_id,
      lineage.removal_id,
      adapter.store,
      scope.resource_id,
      scope.content_generation,
      inventoryReference(adapter.store, scope.resource_id),
    )
    .first<OperationRow>();
  if (row === null) return false;
  const operation = parseOperation(row);
  const nowMs = Date.parse(now);
  const leaseExpiryMs =
    operation.lease_expires_at === null
      ? null
      : Date.parse(operation.lease_expires_at);
  const leaseActive =
    operation.lease_token !== null &&
    (leaseExpiryMs === null || leaseExpiryMs > nowMs);
  if (
    operation.content_class !== "inventory" ||
    (!operation.owner.endsWith("-unavailable") &&
      !operation.owner.endsWith("-configuration")) ||
    leaseActive ||
    ["complete", "preserved"].includes(operation.status)
  ) {
    return false;
  }
  await db
    .prepare(
      `UPDATE controlled_copy_operations
       SET status = 'incomplete', owner = ?, deletion_method = ?, required = ?,
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND tenant_id = ?
         AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND status IN ('planned', 'incomplete', 'failed', 'leased')`,
    )
    .bind(
      adapter.owner,
      adapter.deletion_method,
      adapter.required ? 1 : 0,
      now,
      operation.id,
      operation.tenant_id,
      now,
    )
    .run();
  return true;
};

const safeInventory = async (
  adapter: ControlledCopyAdapter,
  scope: RetentionInventoryScope,
): Promise<RetentionInventoryResult> => {
  try {
    return await adapter.inventory(scope);
  } catch (error: unknown) {
    return {
      complete: false,
      copies: [],
      evidence_source: `${adapter.store}_inventory_error`,
      detail: errorMessage(error),
    };
  }
};

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 4_096) || "controlled copy operation failed";
};

export type CreateControlledCopyRetentionPlanInput = {
  database: RetentionDatabase;
  lineage: ControlledCopyLineage;
  adapters: readonly ControlledCopyAdapter[];
  now?: Date;
};

export type ControlledCopyPlanResult = {
  operations: ControlledCopyOperation[];
  inventory_errors: Array<{ store: string; error: string }>;
};

/**
 * Inventory all required stores before a worker can claim deletion.  Missing
 * adapters and incomplete inventories create visible placeholder operations;
 * they never disappear as an empty successful list.
 */
export const createControlledCopyRetentionPlan = async ({
  database,
  lineage,
  adapters,
  now = new Date(),
}: CreateControlledCopyRetentionPlanInput): Promise<ControlledCopyPlanResult> => {
  const db = primarySession(database);
  const nowIso = timestamp(now);
  const scope: RetentionInventoryScope = { ...lineage, now };
  const byStore = new Map<string, ControlledCopyAdapter>();
  for (const adapter of adapters) {
    if (byStore.has(adapter.store)) {
      throw new Error(`duplicate controlled copy adapter: ${adapter.store}`);
    }
    byStore.set(adapter.store, adapter);
  }

  const allAdapters = CONTROLLED_COPY_STORES.map(
    (store) => byStore.get(store) ?? createUnavailableAdapter(store),
  );
  for (const store of ["session_credentials", "account_keys"] as const) {
    allAdapters.push(
      byStore.get(store) ?? createUnavailableAuxiliaryAdapter(store),
    );
  }

  const operations: ControlledCopyOperation[] = [];
  const inventoryErrors: Array<{ store: string; error: string }> = [];
  for (const adapter of allAdapters) {
    const result = await safeInventory(adapter, scope);
    if (!result.complete) {
      inventoryErrors.push({
        store: adapter.store,
        error: result.detail ?? "inventory incomplete",
      });
    }
    const reconciledUnavailable = await reconcileUnavailableInventory(
      db,
      lineage,
      adapter,
      scope,
      nowIso,
    );
    const copies =
      result.copies.length > 0
        ? result.copies.map((copy) => inventoryItemFor(adapter, copy, scope))
        : [inventoryPlaceholder(adapter, scope)];
    for (const item of copies) {
      const operation = await insertOrReadOperation(db, lineage, item, nowIso);
      if (result.copies.length === 0) {
        operations.push(
          await recordInventoryResult(db, operation, result, now),
        );
      } else {
        // A provider may prove an exact reference while honestly reporting
        // that its bounded scan did not enumerate every historical copy.
        // Keep the known copy actionable; the separate inventory placeholder
        // below remains incomplete and blocks aggregate completion.
        operations.push(operation);
      }
    }
    if (
      (result.complete && result.copies.length > 0 && reconciledUnavailable) ||
      (!result.complete && result.copies.length > 0)
    ) {
      const inventoryGap = await insertOrReadOperation(
        db,
        lineage,
        inventoryPlaceholder(adapter, scope),
        nowIso,
      );
      operations.push(
        await recordInventoryResult(db, inventoryGap, result, now),
      );
    }
  }
  return { operations, inventory_errors: inventoryErrors };
};

const claimOperation = async (
  db: D1DatabaseSession,
  candidate: ControlledCopyOperation,
  now: Date,
  leaseMs: number,
): Promise<ControlledCopyOperation | null> => {
  const workerToken = randomIdentifier("controlled_copy_worker");
  const nowIso = timestamp(now);
  const leaseUntil = timestamp(new Date(now.getTime() + leaseMs));
  const result = await db
    .prepare(
      `UPDATE controlled_copy_operations
       SET status = 'leased', lease_token = ?, lease_expires_at = ?,
           last_error = NULL, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND (
         (status IN ('planned', 'incomplete', 'failed') AND
           (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)) OR
         (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
       )`,
    )
    .bind(
      workerToken,
      leaseUntil,
      nowIso,
      candidate.id,
      candidate.tenant_id,
      nowIso,
      nowIso,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return readOperationById(db, candidate.tenant_id, candidate.id);
};

export type ControlledCopyWorkerResult = {
  claimed: number;
  complete: ControlledCopyOperation[];
  incomplete: ControlledCopyOperation[];
  failed: Array<{ operation_id: string; error: string }>;
};

export const runControlledCopyRetentionWorker = async ({
  database,
  adapters,
  now = new Date(),
  limit = MAX_CONTROLLED_COPY_BATCH,
  leaseMs = CONTROLLED_COPY_WORKER_LEASE_MS,
  scope,
}: {
  database: RetentionDatabase;
  adapters: readonly ControlledCopyAdapter[];
  now?: Date;
  limit?: number;
  leaseMs?: number;
  scope?: Pick<ControlledCopyLineage, "tenant_id" | "removal_id">;
}): Promise<ControlledCopyWorkerResult> => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_CONTROLLED_COPY_BATCH
  ) {
    throw new Error("controlled copy batch limit invalid");
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error("controlled copy lease invalid");
  }
  const db = primarySession(database);
  const nowIso = timestamp(now);
  const scopeClause =
    scope === undefined ? "" : " AND tenant_id = ? AND removal_id = ?";
  const candidates = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS}
       FROM controlled_copy_operations
       WHERE (status IN ('planned', 'incomplete', 'failed') OR
         (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))${scopeClause}
       ORDER BY cleanup_deadline ASC, id ASC LIMIT ?`,
    )
    .bind(
      ...(scope === undefined
        ? [nowIso, limit]
        : [nowIso, scope.tenant_id, scope.removal_id, limit]),
    )
    .all<OperationRow>();
  const result: ControlledCopyWorkerResult = {
    claimed: 0,
    complete: [],
    incomplete: [],
    failed: [],
  };
  const adapterMap = new Map<string, ControlledCopyAdapter>();
  for (const adapter of adapters) {
    if (adapterMap.has(adapter.store)) {
      throw new Error(`duplicate controlled copy adapter: ${adapter.store}`);
    }
    adapterMap.set(adapter.store, adapter);
  }
  for (const row of candidates.results) {
    const candidate = parseOperation(row);
    const operation = await claimOperation(db, candidate, now, leaseMs);
    if (operation === null) continue;
    result.claimed += 1;
    const workerToken = operation.lease_token;
    if (workerToken === null) {
      result.failed.push({
        operation_id: operation.id,
        error: "controlled copy lease token missing",
      });
      continue;
    }
    const adapter = adapterMap.get(operation.store);
    if (adapter === undefined) {
      const current = await appendEvidence(
        db,
        operation,
        {
          status: "unknown",
          content_present: true,
          evidence_source: `${operation.store}_adapter_missing`,
          object_reference: null,
          detail: "No cleanup adapter is registered",
        },
        workerToken,
        now,
        true,
      );
      result.incomplete.push(current);
      continue;
    }
    try {
      if (operation.content_class === "inventory") {
        const current = await appendEvidence(
          db,
          operation,
          {
            status: "unknown",
            content_present: true,
            evidence_source: `${operation.store}_inventory_incomplete`,
            object_reference: operation.reference,
            detail:
              "Cleanup is blocked because inventory did not prove all copies were discovered",
          },
          workerToken,
          now,
          true,
        );
        result.incomplete.push(current);
        continue;
      }
      if (
        operation.deletion_method !== "preserve" &&
        now.getTime() > Date.parse(operation.retention_deadline)
      ) {
        const current = await appendEvidence(
          db,
          operation,
          {
            status: "failed",
            content_present: true,
            evidence_source: `${operation.store}_hard_deadline`,
            object_reference: null,
            detail: "The hard controlled-copy retention deadline has passed",
          },
          workerToken,
          now,
          true,
        );
        result.failed.push({
          operation_id: current.id,
          error: "controlled copy hard deadline missed",
        });
        continue;
      }
      const evidence = await adapter.cleanup(operation, now);
      const current = await appendEvidence(
        db,
        operation,
        evidence,
        workerToken,
        now,
        true,
      );
      if (current.status === "complete" || current.status === "preserved") {
        result.complete.push(current);
      } else {
        result.incomplete.push(current);
      }
    } catch (error: unknown) {
      const detail = errorMessage(error);
      try {
        const current = await appendEvidence(
          db,
          operation,
          {
            status: "failed",
            content_present: true,
            evidence_source: `${operation.store}_cleanup_error`,
            object_reference: null,
            detail,
          },
          workerToken,
          now,
          true,
        );
        result.failed.push({ operation_id: current.id, error: detail });
      } catch (evidenceError: unknown) {
        result.failed.push({
          operation_id: operation.id,
          error: `${detail}; evidence=${errorMessage(evidenceError)}`,
        });
      }
    }
  }
  return result;
};

const uniqueStores = (stores: ControlledCopyStore[]): ControlledCopyStore[] => [
  ...new Set(stores),
];

export const evaluateControlledCopyCompletion = async ({
  database,
  tenantId,
  removalId,
  resourceId,
  contentGeneration,
  deletionEpoch,
  canonicalArchive = "missing",
  now = new Date(),
}: {
  database: RetentionDatabase;
  tenantId: string;
  removalId: string;
  resourceId: string;
  contentGeneration: string;
  deletionEpoch: number;
  canonicalArchive?: "complete" | "incomplete" | "missing";
  now?: Date;
}): Promise<ControlledCopyCompletion> => {
  const operations = (
    await readControlledCopyOperations(database, tenantId, removalId)
  ).filter(
    (operation) =>
      operation.resource_id === resourceId &&
      operation.content_generation === contentGeneration &&
      operation.deletion_epoch === deletionEpoch,
  );
  const completedStores: ControlledCopyStore[] = [];
  const incompleteStores: ControlledCopyStore[] = [];
  const missingStores: ControlledCopyStore[] = [];
  const alerts: string[] = [];
  const lateStores = new Set<ControlledCopyStore>();
  for (const store of CONTROLLED_COPY_STORES) {
    const storeOperations = operations.filter(
      (operation) => operation.store === store && operation.required,
    );
    if (storeOperations.length === 0) {
      missingStores.push(store);
      alerts.push(`controlled_copy_${store}_inventory_missing`);
      continue;
    }
    const complete = storeOperations.every((operation) => {
      if (operation.status !== "complete") return false;
      const completionAt =
        operation.completed_at === null
          ? now
          : new Date(operation.completed_at);
      const cleanupMissed =
        completionAt.getTime() > Date.parse(operation.cleanup_deadline);
      const hardMissed =
        completionAt.getTime() > Date.parse(operation.retention_deadline);
      if (cleanupMissed) {
        lateStores.add(store);
        alerts.push(`controlled_copy_${store}_cleanup_deadline_missed`);
      }
      if (hardMissed) {
        lateStores.add(store);
        alerts.push(`controlled_copy_${store}_hard_deadline_missed`);
      }
      return !cleanupMissed && !hardMissed;
    });
    if (complete) completedStores.push(store);
    else {
      incompleteStores.push(store);
      alerts.push(`controlled_copy_${store}_incomplete`);
    }
    for (const operation of storeOperations) {
      if (operation.status === "complete") continue;
      if (Date.parse(timestamp(now)) > Date.parse(operation.cleanup_deadline)) {
        lateStores.add(store);
        alerts.push(`controlled_copy_${store}_cleanup_deadline_missed`);
      }
      if (
        Date.parse(timestamp(now)) > Date.parse(operation.retention_deadline)
      ) {
        lateStores.add(store);
        alerts.push(`controlled_copy_${store}_hard_deadline_missed`);
      }
    }
  }
  if (canonicalArchive !== "complete") {
    alerts.push(
      canonicalArchive === "missing"
        ? "canonical_archive_evidence_missing"
        : "canonical_archive_incomplete",
    );
  }
  for (const operation of operations.filter((item) => !item.required)) {
    if (!["complete", "preserved"].includes(operation.status)) {
      alerts.push(`controlled_copy_auxiliary_${operation.store}_incomplete`);
    }
    if (Date.parse(timestamp(now)) > Date.parse(operation.cleanup_deadline)) {
      alerts.push(
        `controlled_copy_auxiliary_${operation.store}_cleanup_deadline_missed`,
      );
    }
    if (Date.parse(timestamp(now)) > Date.parse(operation.retention_deadline)) {
      alerts.push(
        `controlled_copy_auxiliary_${operation.store}_hard_deadline_missed`,
      );
    }
  }
  const status =
    missingStores.length === 0 &&
    incompleteStores.length === 0 &&
    lateStores.size === 0 &&
    canonicalArchive === "complete"
      ? "complete"
      : "incomplete";
  return ControlledCopyCompletionSchema.parse({
    tenant_id: tenantId,
    removal_id: removalId,
    resource_id: resourceId,
    content_generation: contentGeneration,
    deletion_epoch: deletionEpoch,
    status,
    canonical_archive: canonicalArchive,
    required_stores: [...CONTROLLED_COPY_STORES],
    completed_stores: uniqueStores(completedStores),
    incomplete_stores: uniqueStores(incompleteStores),
    missing_stores: uniqueStores(missingStores),
    auxiliary_operations: operations.filter((operation) => !operation.required),
    alerts: [...new Set(alerts)],
    checked_at: timestamp(now),
  });
};

export type ControlledCopyRunResult = {
  plan: ControlledCopyPlanResult;
  worker: ControlledCopyWorkerResult;
  completion: ControlledCopyCompletion;
};

/**
 * Run the complete per-removal lifecycle.  The worker is scoped to the
 * removal so a user-triggered removal cannot opportunistically clean another
 * tenant's due copies; the cron sweep uses the same function for each row.
 */
export const runControlledCopyRetentionForRemoval = async ({
  database,
  lineage,
  adapters,
  canonicalArchive = "missing",
  now = new Date(),
}: {
  database: RetentionDatabase;
  lineage: ControlledCopyLineage;
  adapters: readonly ControlledCopyAdapter[];
  canonicalArchive?: "complete" | "incomplete" | "missing";
  now?: Date;
}): Promise<ControlledCopyRunResult> => {
  const plan = await createControlledCopyRetentionPlan({
    database,
    lineage,
    adapters,
    now,
  });
  const worker = await runControlledCopyRetentionWorker({
    database,
    adapters,
    now,
    scope: lineage,
  });
  const completion = await evaluateControlledCopyCompletion({
    database,
    tenantId: lineage.tenant_id,
    removalId: lineage.removal_id,
    resourceId: lineage.resource_id,
    contentGeneration: lineage.content_generation,
    deletionEpoch: lineage.deletion_epoch,
    canonicalArchive,
    now,
  });
  return { plan, worker, completion };
};

export type ControlledCopyRetentionSweepResult = {
  processed: number;
  complete: ControlledCopyCompletion[];
  incomplete: ControlledCopyCompletion[];
  errors: Array<{ removal_id: string; error: string }>;
};

const retentionErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 4_096) || "controlled copy sweep failed";
};

/**
 * Reconcile every durable removal authority during the scheduled wakeup.  A
 * missing archive callback is deliberately represented as `missing`, so the
 * aggregate can never infer archive completion from controlled-store success.
 */
export const runControlledCopyRetentionSweep = async ({
  database,
  adapters,
  now = new Date(),
  limit = MAX_CONTROLLED_COPY_BATCH,
  canonicalArchiveFor,
}: {
  database: RetentionDatabase;
  adapters: readonly ControlledCopyAdapter[];
  now?: Date;
  limit?: number;
  canonicalArchiveFor?: (
    authority: RemovalAuthority,
  ) => Promise<"complete" | "incomplete" | "missing">;
}): Promise<ControlledCopyRetentionSweepResult> => {
  const authorities = await listAllRemovalAuthorities(database, limit);
  const result: ControlledCopyRetentionSweepResult = {
    processed: 0,
    complete: [],
    incomplete: [],
    errors: [],
  };
  for (const authority of authorities) {
    try {
      const canonicalArchive =
        (await canonicalArchiveFor?.(authority)) ?? "missing";
      const run = await runControlledCopyRetentionForRemoval({
        database,
        adapters,
        lineage: {
          tenant_id: authority.tenant_id,
          removal_id: authority.id,
          resource_type: authority.resource_type,
          resource_id: authority.resource_id,
          content_generation: authority.content_generation,
          deletion_epoch: authority.deletion_epoch,
        },
        canonicalArchive,
        now,
      });
      result.processed += 1;
      if (run.completion.status === "complete") {
        result.complete.push(run.completion);
      } else {
        result.incomplete.push(run.completion);
      }
    } catch (error: unknown) {
      result.errors.push({
        removal_id: authority.id,
        error: retentionErrorMessage(error),
      });
    }
  }
  return result;
};

export const recordControlledCopyEvidence = async ({
  database,
  operation,
  evidence,
  workerToken,
  now = new Date(),
}: {
  database: RetentionDatabase;
  operation: ControlledCopyOperation;
  evidence: ControlledCopyEvidenceInput;
  workerToken: string;
  now?: Date;
}): Promise<ControlledCopyOperation> => {
  const parsedWorkerToken = workerToken.trim();
  if (parsedWorkerToken === "")
    throw new Error("controlled copy worker token required");
  return appendEvidence(
    primarySession(database),
    operation,
    evidence,
    parsedWorkerToken,
    now,
    operation.status === "leased",
  );
};

export type { ControlledCopyAdapter } from "./adapters";
