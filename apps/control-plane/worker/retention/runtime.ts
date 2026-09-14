import {
  ControlledCopyEvidenceInputSchema,
  type ControlledCopyAuxiliaryStore,
  type ControlledCopyStore,
} from "@communicator/contracts";
import {
  createAccountKeyAdapter,
  createBridgeDatabaseAdapter,
  createMediaStoreAdapter,
  createProjectionBackupAdapter,
  createQueueAdapter,
  createResticSnapshotAdapter,
  createSessionCredentialAdapter,
  createUnavailableAdapter,
  createUnavailableAuxiliaryAdapter,
  createSynapseAdapter,
  type ControlledCopyAdapter,
  type RetentionBackendCopy,
  type RetentionCleanupContext,
  type RetentionInventoryResult,
  type RetentionInventoryScope,
  type RetentionStoreBackend,
} from "./adapters";

/**
 * External controlled-copy services are configured as Worker secrets/vars.
 * The Worker does not pretend that a Queue, Synapse database, or restic
 * repository is directly enumerable merely because another binding exists.
 * Each configured endpoint must implement this small, authenticated boundary.
 */
export const CONTROLLED_COPY_RUNTIME_PROTOCOL = "controlled-copy-v1";

export const CONTROLLED_COPY_BACKEND_ENV = {
  projection_backup: {
    endpoint: "COMMUNICATOR_RETENTION_PROJECTION_BACKUP_URL",
    token: "COMMUNICATOR_RETENTION_PROJECTION_BACKUP_TOKEN",
    owner: "COMMUNICATOR_RETENTION_PROJECTION_BACKUP_OWNER",
  },
  synapse: {
    endpoint: "COMMUNICATOR_RETENTION_SYNAPSE_URL",
    token: "COMMUNICATOR_RETENTION_SYNAPSE_TOKEN",
    owner: "COMMUNICATOR_RETENTION_SYNAPSE_OWNER",
  },
  bridge_database: {
    endpoint: "COMMUNICATOR_RETENTION_BRIDGE_DATABASE_URL",
    token: "COMMUNICATOR_RETENTION_BRIDGE_DATABASE_TOKEN",
    owner: "COMMUNICATOR_RETENTION_BRIDGE_DATABASE_OWNER",
  },
  media_store: {
    endpoint: "COMMUNICATOR_RETENTION_MEDIA_STORE_URL",
    token: "COMMUNICATOR_RETENTION_MEDIA_STORE_TOKEN",
    owner: "COMMUNICATOR_RETENTION_MEDIA_STORE_OWNER",
  },
  queue: {
    endpoint: "COMMUNICATOR_RETENTION_QUEUE_URL",
    token: "COMMUNICATOR_RETENTION_QUEUE_TOKEN",
    owner: "COMMUNICATOR_RETENTION_QUEUE_OWNER",
  },
  restic_snapshot: {
    endpoint: "COMMUNICATOR_RETENTION_RESTIC_SNAPSHOT_URL",
    token: "COMMUNICATOR_RETENTION_RESTIC_SNAPSHOT_TOKEN",
    owner: "COMMUNICATOR_RETENTION_RESTIC_SNAPSHOT_OWNER",
  },
  session_credentials: {
    endpoint: "COMMUNICATOR_RETENTION_SESSION_CREDENTIALS_URL",
    token: "COMMUNICATOR_RETENTION_SESSION_CREDENTIALS_TOKEN",
    owner: "COMMUNICATOR_RETENTION_SESSION_CREDENTIALS_OWNER",
  },
  account_keys: {
    endpoint: "COMMUNICATOR_RETENTION_ACCOUNT_KEYS_URL",
    token: "COMMUNICATOR_RETENTION_ACCOUNT_KEYS_TOKEN",
    owner: "COMMUNICATOR_RETENTION_ACCOUNT_KEYS_OWNER",
  },
} as const satisfies Record<
  ControlledCopyStore | ControlledCopyAuxiliaryStore,
  { endpoint: string; token: string; owner: string }
>;

export type RetentionRuntimeEnvironment = Record<string, unknown>;
export type RetentionRuntimeFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type RuntimeStore = ControlledCopyStore | ControlledCopyAuxiliaryStore;
type RuntimeFactory = (
  backend: RetentionStoreBackend,
  owner: string,
) => ControlledCopyAdapter;

type RuntimeDescriptor = {
  store: RuntimeStore;
  required: boolean;
  factory: RuntimeFactory;
};

const RUNTIME_DESCRIPTORS: readonly RuntimeDescriptor[] = [
  {
    store: "projection_backup",
    required: true,
    factory: createProjectionBackupAdapter,
  },
  { store: "synapse", required: true, factory: createSynapseAdapter },
  {
    store: "bridge_database",
    required: true,
    factory: createBridgeDatabaseAdapter,
  },
  {
    store: "media_store",
    required: true,
    factory: createMediaStoreAdapter,
  },
  { store: "queue", required: true, factory: createQueueAdapter },
  {
    store: "restic_snapshot",
    required: true,
    factory: createResticSnapshotAdapter,
  },
  {
    store: "session_credentials",
    required: false,
    factory: createSessionCredentialAdapter,
  },
  {
    store: "account_keys",
    required: false,
    factory: createAccountKeyAdapter,
  },
];

const stringValue = (
  environment: RetentionRuntimeEnvironment,
  key: string,
): string | undefined => {
  const value = environment[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const ownerFor = (
  environment: RetentionRuntimeEnvironment,
  key: string,
  store: RuntimeStore,
): string => stringValue(environment, key) ?? `configured-${store}`;

const isAuxiliaryStore = (
  store: RuntimeStore,
): store is ControlledCopyAuxiliaryStore =>
  store === "session_credentials" || store === "account_keys";

const endpointFor = (endpoint: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("configured controlled-copy endpoint is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("configured controlled-copy endpoint protocol is invalid");
  }
  return parsed.toString().replace(/\/+$/u, "");
};

const endpointForOperation = (endpoint: string, operation: string): string =>
  new URL(`${operation}`, `${endpoint}/`).toString();

const recordValue = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("controlled-copy backend response must be an object");
  }
  return value as Record<string, unknown>;
};

const responseBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new Error("controlled-copy backend response is not JSON");
  }
};

const inventoryResponse = (value: unknown): RetentionInventoryResult => {
  const body = recordValue(value);
  if (typeof body.complete !== "boolean") {
    throw new Error("controlled-copy backend inventory completion is invalid");
  }
  if (!Array.isArray(body.copies)) {
    throw new Error("controlled-copy backend inventory copies are invalid");
  }
  const copies = body.copies.map((value): RetentionBackendCopy => {
    const copy = recordValue(value);
    if (
      typeof copy.reference !== "string" ||
      typeof copy.copy_created_at !== "string"
    ) {
      throw new Error("controlled-copy backend inventory copy is invalid");
    }
    const normalized: RetentionBackendCopy = {
      reference: copy.reference,
      copy_created_at: copy.copy_created_at,
    };
    if (typeof copy.resource_id === "string") {
      normalized.resource_id = copy.resource_id;
    }
    if (typeof copy.content_generation === "string") {
      normalized.content_generation = copy.content_generation;
    }
    if (typeof copy.content_class === "string") {
      normalized.content_class = copy.content_class as NonNullable<
        RetentionBackendCopy["content_class"]
      >;
    }
    if (Array.isArray(copy.content_classes)) {
      normalized.content_classes = copy.content_classes.filter(
        (item): item is string => typeof item === "string",
      ) as NonNullable<RetentionBackendCopy["content_classes"]>;
    }
    return normalized;
  });
  if (typeof body.evidence_source !== "string") {
    throw new Error(
      "controlled-copy backend inventory evidence source is invalid",
    );
  }
  return {
    complete: body.complete,
    copies,
    evidence_source: body.evidence_source,
    detail: typeof body.detail === "string" ? body.detail : null,
  };
};

const cleanupResponse = (value: unknown) =>
  ControlledCopyEvidenceInputSchema.parse(recordValue(value));

const request = async (
  fetcher: RetentionRuntimeFetcher,
  endpoint: string,
  token: string,
  store: RuntimeStore,
  operation: string,
  body: Record<string, unknown>,
): Promise<unknown> => {
  const response = await fetcher(endpointForOperation(endpoint, operation), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Keep response bodies out of errors: providers sometimes echo secrets or
    // connection details, while the durable ledger only needs the HTTP class.
    throw new Error(`controlled-copy ${store} backend HTTP ${response.status}`);
  }
  return responseBody(response);
};

export const createHttpRetentionBackend = ({
  store,
  endpoint,
  token,
  fetcher = globalThis.fetch.bind(globalThis),
}: {
  store: RuntimeStore;
  endpoint: string;
  token: string;
  fetcher?: RetentionRuntimeFetcher;
}): RetentionStoreBackend => {
  const normalizedEndpoint = endpointFor(endpoint);
  if (token.trim() === "")
    throw new Error("controlled-copy backend token required");
  return {
    inventory: async (scope: RetentionInventoryScope) =>
      inventoryResponse(
        await request(fetcher, normalizedEndpoint, token, store, "inventory", {
          protocol: CONTROLLED_COPY_RUNTIME_PROTOCOL,
          operation: "inventory",
          store,
          scope: {
            tenant_id: scope.tenant_id,
            removal_id: scope.removal_id,
            resource_type: scope.resource_type,
            resource_id: scope.resource_id,
            content_generation: scope.content_generation,
            deletion_epoch: scope.deletion_epoch,
            now: scope.now.toISOString(),
          },
        }),
      ),
    cleanup: async (
      copy: Parameters<RetentionStoreBackend["cleanup"]>[0],
      context: RetentionCleanupContext,
    ) =>
      cleanupResponse(
        await request(fetcher, normalizedEndpoint, token, store, "cleanup", {
          protocol: CONTROLLED_COPY_RUNTIME_PROTOCOL,
          operation: "cleanup",
          store,
          removal_id: context.operation.removal_id,
          operation_id: context.operation.id,
          resource_type: context.operation.resource_type,
          resource_id: copy.resource_id,
          content_generation: copy.content_generation,
          deletion_epoch: context.operation.deletion_epoch,
          reference: copy.reference,
          content_class: copy.content_class,
          deletion_method: copy.deletion_method,
          now: context.now.toISOString(),
        }),
      ),
  };
};

const configuredAdapter = (
  environment: RetentionRuntimeEnvironment,
  descriptor: RuntimeDescriptor,
  fetcher: RetentionRuntimeFetcher,
): ControlledCopyAdapter | null => {
  const keys = CONTROLLED_COPY_BACKEND_ENV[descriptor.store];
  const endpoint = stringValue(environment, keys.endpoint);
  const token = stringValue(environment, keys.token);
  const owner = ownerFor(environment, keys.owner, descriptor.store);

  if (endpoint === undefined && token === undefined) {
    if (descriptor.required) return null;
    if (!isAuxiliaryStore(descriptor.store)) {
      throw new Error("auxiliary controlled-copy store is invalid");
    }
    return createUnavailableAuxiliaryAdapter(
      descriptor.store,
      `${descriptor.store}-unavailable`,
    );
  }
  if (endpoint === undefined || token === undefined) {
    const reason =
      "Controlled-copy endpoint and credential must be configured together";
    if (descriptor.required && !isAuxiliaryStore(descriptor.store)) {
      return createUnavailableAdapter(
        descriptor.store,
        `${descriptor.store}-configuration`,
        reason,
      );
    }
    if (!isAuxiliaryStore(descriptor.store)) {
      throw new Error("auxiliary controlled-copy store is invalid");
    }
    return createUnavailableAuxiliaryAdapter(
      descriptor.store,
      `${descriptor.store}-configuration`,
      reason,
    );
  }
  try {
    return descriptor.factory(
      createHttpRetentionBackend({
        store: descriptor.store,
        endpoint,
        token,
        fetcher,
      }),
      owner,
    );
  } catch {
    const reason = "Configured controlled-copy endpoint is invalid";
    if (descriptor.required && !isAuxiliaryStore(descriptor.store)) {
      return createUnavailableAdapter(
        descriptor.store,
        `${descriptor.store}-configuration`,
        reason,
      );
    }
    if (!isAuxiliaryStore(descriptor.store)) {
      throw new Error("auxiliary controlled-copy store is invalid");
    }
    return createUnavailableAuxiliaryAdapter(
      descriptor.store,
      `${descriptor.store}-configuration`,
      reason,
    );
  }
};

/**
 * Build the adapters used by both the removal lifecycle and the cron wakeup.
 * A missing required endpoint is intentionally omitted: the planner then
 * creates its standard required-store unavailable operation. Auxiliary
 * credential stores remain explicit preservation-only operations.
 */
export const createConfiguredControlledCopyAdapters = (
  environment: RetentionRuntimeEnvironment,
  fetcher: RetentionRuntimeFetcher = globalThis.fetch.bind(globalThis),
): ControlledCopyAdapter[] =>
  RUNTIME_DESCRIPTORS.map((descriptor) =>
    configuredAdapter(environment, descriptor, fetcher),
  ).filter((adapter): adapter is ControlledCopyAdapter => adapter !== null);
