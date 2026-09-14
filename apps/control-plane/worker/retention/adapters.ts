import {
  ControlledCopyAuxiliaryStoreSchema,
  ControlledCopyContentClassSchema,
  ControlledCopyEvidenceInputSchema,
  ControlledCopyInventoryItemSchema,
  ControlledCopyStoreSchema,
  type ControlledCopyContentClass,
  type ControlledCopyEvidenceInput,
  type ControlledCopyInventoryItem,
  type ControlledCopyOperation,
  type ControlledCopyStore,
} from "@communicator/contracts";

export type RetentionInventoryScope = {
  tenant_id: string;
  removal_id: string;
  resource_type: string;
  resource_id: string;
  content_generation: string;
  deletion_epoch: number;
  now: Date;
};

export type RetentionBackendCopy = {
  resource_id?: string;
  content_generation?: string;
  reference: string;
  copy_created_at: Date | string;
  content_class?: ControlledCopyContentClass;
  /**
   * Backends that cannot isolate a snapshot object must report every class it
   * contains.  The adapter rejects mixed classes rather than deleting a
   * credential-bearing object as if it were a message copy.
   */
  content_classes?: readonly ControlledCopyContentClass[];
  /** Exact core-dump row/media mapping supplied by a real inventory backend. */
  restore_target?: Record<string, unknown>;
};

export type RetentionInventoryResult = {
  complete: boolean;
  copies: readonly RetentionBackendCopy[];
  evidence_source: string;
  detail?: string | null;
};

export type RetentionCleanupContext = {
  operation: ControlledCopyOperation;
  now: Date;
};

export type RetentionStoreBackend = {
  inventory: (
    scope: RetentionInventoryScope,
  ) => Promise<RetentionInventoryResult>;
  cleanup: (
    copy: ControlledCopyInventoryItem,
    context: RetentionCleanupContext,
  ) => Promise<ControlledCopyEvidenceInput>;
};

export type ControlledCopyAdapter = {
  store: ControlledCopyStore | "session_credentials" | "account_keys";
  owner: string;
  default_content_class: ControlledCopyContentClass;
  deletion_method: "delete" | "quarantine" | "expire" | "age_out" | "preserve";
  required: boolean;
  inventory: (
    scope: RetentionInventoryScope,
  ) => Promise<RetentionInventoryResult>;
  cleanup: (
    operation: ControlledCopyOperation,
    now: Date,
  ) => Promise<ControlledCopyEvidenceInput>;
};

const normalizeTimestamp = (value: Date | string): string => {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("controlled copy timestamp invalid");
  }
  return new Date(timestamp).toISOString();
};

const normalizeInventory = (
  result: RetentionInventoryResult,
  adapter: Pick<
    ControlledCopyAdapter,
    "store" | "owner" | "default_content_class" | "deletion_method" | "required"
  >,
  scope: RetentionInventoryScope,
): RetentionInventoryResult => {
  if (
    typeof result.evidence_source !== "string" ||
    result.evidence_source.trim() === ""
  ) {
    throw new Error("controlled copy inventory evidence source required");
  }
  const rawCopies: unknown = result.copies;
  if (!Array.isArray(rawCopies)) {
    throw new Error("controlled copy inventory copies invalid");
  }
  const references = new Set<string>();
  const copies = (rawCopies as RetentionBackendCopy[]).map((copy) => {
    const contentClasses = copy.content_classes ?? [
      copy.content_class ?? adapter.default_content_class,
    ];
    if (
      contentClasses.length !== 1 ||
      contentClasses.some(
        (contentClass) =>
          !ControlledCopyContentClassSchema.safeParse(contentClass).success,
      )
    ) {
      throw new Error(
        "controlled copy inventory must isolate content classes per reference",
      );
    }
    const contentClass = contentClasses[0];
    if (contentClass === undefined) {
      throw new Error("controlled copy inventory content class missing");
    }
    if (
      adapter.required &&
      (contentClass === "session_credential" || contentClass === "account_key")
    ) {
      throw new Error(
        "required controlled copy inventory cannot include session material",
      );
    }
    if (references.has(copy.reference)) {
      throw new Error("controlled copy inventory reference is duplicated");
    }
    references.add(copy.reference);
    const item = ControlledCopyInventoryItemSchema.parse({
      store: adapter.store,
      owner: adapter.owner,
      content_class: contentClass,
      resource_id: copy.resource_id ?? scope.resource_id,
      content_generation: copy.content_generation ?? scope.content_generation,
      reference: copy.reference,
      copy_created_at: normalizeTimestamp(copy.copy_created_at),
      deletion_method: adapter.deletion_method,
      required: adapter.required,
    });
    if (
      copy.restore_target !== undefined &&
      (copy.restore_target === null ||
        typeof copy.restore_target !== "object" ||
        Array.isArray(copy.restore_target))
    ) {
      throw new Error("controlled copy inventory restore target is invalid");
    }
    return copy.restore_target === undefined
      ? item
      : { ...item, restore_target: copy.restore_target };
  });
  return {
    complete: result.complete === true,
    copies,
    evidence_source: result.evidence_source.trim().slice(0, 256),
    detail: result.detail?.trim().slice(0, 4_096) ?? null,
  };
};

const normalizeEvidence = (
  evidence: ControlledCopyEvidenceInput,
  adapter: ControlledCopyAdapter,
): ControlledCopyEvidenceInput => {
  const parsed = ControlledCopyEvidenceInputSchema.parse(evidence);
  if (adapter.deletion_method === "preserve") {
    if (parsed.status !== "preserved" || !parsed.content_present) {
      throw new Error("credential cleanup must preserve content");
    }
  } else if (
    ["deleted", "quarantined", "expired", "aged_out"].includes(parsed.status) &&
    parsed.content_present
  ) {
    throw new Error("cleanup evidence still contains content");
  }
  return parsed;
};

export const createStoreAdapter = ({
  store,
  owner,
  defaultContentClass,
  deletionMethod,
  required,
  backend,
}: {
  store: ControlledCopyAdapter["store"];
  owner: string;
  defaultContentClass: ControlledCopyContentClass;
  deletionMethod: ControlledCopyAdapter["deletion_method"];
  required: boolean;
  backend: RetentionStoreBackend;
}): ControlledCopyAdapter => {
  const parsedStore =
    ControlledCopyStoreSchema.safeParse(store).success ||
    ControlledCopyAuxiliaryStoreSchema.safeParse(store).success;
  if (!parsedStore) throw new Error("controlled copy store invalid");
  const parsedClass =
    ControlledCopyContentClassSchema.safeParse(defaultContentClass);
  if (!parsedClass.success)
    throw new Error("controlled copy content class invalid");
  if (owner.trim() === "") throw new Error("controlled copy owner required");
  if (
    required &&
    (defaultContentClass === "session_credential" ||
      defaultContentClass === "account_key")
  ) {
    throw new Error(
      "required controlled copy adapter cannot own session material",
    );
  }

  const adapter: ControlledCopyAdapter = {
    store,
    owner: owner.trim().slice(0, 128),
    default_content_class: defaultContentClass,
    deletion_method: deletionMethod,
    required,
    inventory: async (scope) =>
      normalizeInventory(await backend.inventory(scope), adapter, scope),
    cleanup: async (operation, now) => {
      if (
        required &&
        (operation.content_class === "session_credential" ||
          operation.content_class === "account_key")
      ) {
        throw new Error(
          "required controlled copy cleanup cannot delete session material",
        );
      }
      return normalizeEvidence(
        await backend.cleanup(
          {
            store,
            owner: adapter.owner,
            content_class: operation.content_class,
            resource_id: operation.resource_id,
            content_generation: operation.content_generation,
            reference: operation.reference,
            copy_created_at: operation.copy_created_at,
            deletion_method: deletionMethod,
            required,
          },
          { operation, now },
        ),
        adapter,
      );
    },
  };
  return adapter;
};

export const createProjectionBackupAdapter = (
  backend: RetentionStoreBackend,
  owner = "projection-backup",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store: "projection_backup",
    owner,
    defaultContentClass: "message",
    deletionMethod: "delete",
    required: true,
    backend,
  });

export const createSynapseAdapter = (
  backend: RetentionStoreBackend,
  owner = "synapse",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store: "synapse",
    owner,
    defaultContentClass: "message",
    deletionMethod: "delete",
    required: true,
    backend,
  });

export const createBridgeDatabaseAdapter = (
  backend: RetentionStoreBackend,
  owner = "bridge-database",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store: "bridge_database",
    owner,
    defaultContentClass: "bridge_mapping",
    deletionMethod: "delete",
    required: true,
    backend,
  });

export const createMediaStoreAdapter = (
  backend: RetentionStoreBackend,
  owner = "media-store",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store: "media_store",
    owner,
    defaultContentClass: "attachment",
    deletionMethod: "delete",
    required: true,
    backend,
  });

export const createQueueAdapter = (
  backend: RetentionStoreBackend,
  owner = "queue",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store: "queue",
    owner,
    defaultContentClass: "queue_item",
    deletionMethod: "delete",
    required: true,
    backend,
  });

export const createResticSnapshotAdapter = (
  backend: RetentionStoreBackend,
  owner = "restic",
): ControlledCopyAdapter =>
  // Existing restic snapshots bundle database, media, and credential files.
  // The backend must return isolated object references before this adapter can
  // age anything out; mixed references are rejected by normalizeInventory.
  createStoreAdapter({
    store: "restic_snapshot",
    owner,
    defaultContentClass: "message",
    deletionMethod: "age_out",
    required: true,
    backend,
  });

/**
 * Account/session credentials have a separate lifecycle.  The backend is
 * still invoked so the operation has real evidence, but it can only preserve
 * the credential copy; it cannot accidentally delete it with message data.
 */
export const createSessionCredentialAdapter = (
  backend: RetentionStoreBackend,
  owner = "session-credentials",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store: "session_credentials",
    owner,
    defaultContentClass: "session_credential",
    deletionMethod: "preserve",
    required: false,
    backend,
  });

export const createAccountKeyAdapter = (
  backend: RetentionStoreBackend,
  owner = "account-keys",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store: "account_keys",
    owner,
    defaultContentClass: "account_key",
    deletionMethod: "preserve",
    required: false,
    backend,
  });

/**
 * An adapter with no configured backend is explicit and incomplete.  It is
 * useful for deployments that have not yet proved a store's semantics and
 * prevents an absent binding from becoming a false completion.
 */
export const createUnavailableAdapter = (
  store: ControlledCopyStore,
  owner = `${store}-unavailable`,
  reason = "No controlled cleanup adapter is configured",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store,
    owner,
    defaultContentClass: "inventory",
    deletionMethod: "delete",
    required: true,
    backend: {
      inventory: async () => ({
        complete: false,
        copies: [],
        evidence_source: `${store}_adapter_unavailable`,
        detail: reason,
      }),
      cleanup: async () => ({
        status: "unknown",
        content_present: true,
        evidence_source: `${store}_adapter_unavailable`,
        object_reference: null,
        detail: reason,
      }),
    },
  });

/**
 * An unavailable auxiliary store is visible in the same durable ledger, but
 * its lifecycle remains preservation-only and never becomes a required
 * message-copy deletion target.
 */
export const createUnavailableAuxiliaryAdapter = (
  store: "session_credentials" | "account_keys",
  owner = `${store}-unavailable`,
  reason = "No controlled credential lifecycle adapter is configured",
): ControlledCopyAdapter =>
  createStoreAdapter({
    store,
    owner,
    defaultContentClass:
      store === "session_credentials" ? "session_credential" : "account_key",
    deletionMethod: "preserve",
    required: false,
    backend: {
      inventory: async () => ({
        complete: false,
        copies: [],
        evidence_source: `${store}_adapter_unavailable`,
        detail: reason,
      }),
      cleanup: async () => ({
        status: "unknown",
        content_present: true,
        evidence_source: `${store}_adapter_unavailable`,
        object_reference: null,
        detail: reason,
      }),
    },
  });
