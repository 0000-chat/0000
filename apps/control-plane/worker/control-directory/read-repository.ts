import {
  CapabilitySchema,
  ConnectionSchema,
  MAX_IDENTITY_CONNECTIONS,
  type Capability,
  type Connection,
} from "@communicator/contracts";

export type DirectoryConnection = Connection & {
  sort_position: number;
};

export type DirectoryReadErrorCode =
  | "read_directory_invalid"
  | "read_directory_too_large"
  | "read_directory_unavailable";

const SAFE_MESSAGES: Record<DirectoryReadErrorCode, string> = {
  read_directory_invalid: "Invalid connection directory data",
  read_directory_too_large: "Connection directory is too large",
  read_directory_unavailable: "Connection directory is unavailable",
};

const directoryReadErrorCauses = new WeakMap<DirectoryReadError, unknown>();

export class DirectoryReadError extends Error {
  readonly code!: DirectoryReadErrorCode;

  constructor(code: DirectoryReadErrorCode, cause?: unknown) {
    super(SAFE_MESSAGES[code]);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "DirectoryReadError",
      writable: true,
    });
    Object.defineProperty(this, "code", {
      configurable: true,
      enumerable: true,
      value: code,
      writable: false,
    });
    if (cause !== undefined) directoryReadErrorCauses.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const getDirectoryReadErrorCause = (
  error: DirectoryReadError,
): unknown => directoryReadErrorCauses.get(error);

const directoryReadError = (
  code: DirectoryReadErrorCode,
  cause?: unknown,
): DirectoryReadError => new DirectoryReadError(code, cause);

type ConnectionReadRow = {
  connection_id: string;
  tenant_id: string;
  identity_id: string;
  provider: string;
  display_label: string;
  status: string;
  last_synced_at: string | null;
  attention_code: string | null;
  sort_position: number;
  capability: string | null;
};

const CONNECTION_READ_QUERY = `
  WITH bounded_connections AS (
    SELECT
      c.id AS connection_id,
      c.tenant_id,
      c.identity_id,
      c.provider,
      c.display_label,
      c.status,
      c.last_synced_at,
      c.attention_code,
      c.sort_position
    FROM connections AS c
    WHERE c.tenant_id = ? AND c.identity_id = ?
    ORDER BY c.sort_position ASC, c.id ASC
    LIMIT ?
  )
  SELECT
    c.connection_id,
    c.tenant_id,
    c.identity_id,
    c.provider,
    c.display_label,
    c.status,
    c.last_synced_at,
    c.attention_code,
    c.sort_position,
    cc.capability
  FROM bounded_connections AS c
  LEFT JOIN connection_capabilities AS cc
    ON cc.tenant_id = c.tenant_id AND cc.connection_id = c.connection_id
  ORDER BY c.sort_position ASC, c.connection_id ASC, cc.capability ASC
`;

const isValidSortPosition = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const mapConnectionRows = (
  rows: readonly ConnectionReadRow[],
): DirectoryConnection[] => {
  const grouped = new Map<
    string,
    {
      row: ConnectionReadRow;
      capabilities: Set<Capability>;
    }
  >();

  for (const row of rows) {
    if (!isValidSortPosition(row.sort_position)) {
      throw directoryReadError("read_directory_invalid");
    }

    let group = grouped.get(row.connection_id);
    if (group === undefined) {
      if (grouped.size >= MAX_IDENTITY_CONNECTIONS) {
        throw directoryReadError("read_directory_too_large");
      }
      group = { row, capabilities: new Set<Capability>() };
      grouped.set(row.connection_id, group);
    } else if (
      row.tenant_id !== group.row.tenant_id ||
      row.identity_id !== group.row.identity_id ||
      row.provider !== group.row.provider ||
      row.display_label !== group.row.display_label ||
      row.status !== group.row.status ||
      row.last_synced_at !== group.row.last_synced_at ||
      row.attention_code !== group.row.attention_code ||
      row.sort_position !== group.row.sort_position
    ) {
      throw directoryReadError("read_directory_invalid");
    }

    if (row.capability !== null) {
      const capability = CapabilitySchema.safeParse(row.capability);
      if (!capability.success) {
        throw directoryReadError("read_directory_invalid");
      }
      group.capabilities.add(capability.data);
    }
  }

  return [...grouped.values()].map(({ row, capabilities }) => {
    try {
      const connection = ConnectionSchema.parse({
        id: row.connection_id,
        tenant_id: row.tenant_id,
        identity_id: row.identity_id,
        provider: row.provider,
        display_label: row.display_label,
        status: row.status,
        capabilities: [...capabilities].sort((left, right) =>
          left.localeCompare(right),
        ),
        last_synced_at: row.last_synced_at,
        ...(row.attention_code === null
          ? {}
          : { attention_code: row.attention_code }),
      });
      return { ...connection, sort_position: row.sort_position };
    } catch (error) {
      throw directoryReadError("read_directory_invalid", error);
    }
  });
};

export async function listConnectionsForIdentity(
  db: D1DatabaseSession,
  tenantId: string,
  identityId: string,
): Promise<DirectoryConnection[]> {
  let result: { results: ConnectionReadRow[] };
  try {
    result = await db
      .prepare(CONNECTION_READ_QUERY)
      .bind(tenantId, identityId, MAX_IDENTITY_CONNECTIONS + 1)
      .all<ConnectionReadRow>();
  } catch (error) {
    throw directoryReadError("read_directory_unavailable", error);
  }

  try {
    return mapConnectionRows(result.results);
  } catch (error) {
    if (error instanceof DirectoryReadError) throw error;
    throw directoryReadError("read_directory_invalid", error);
  }
}
