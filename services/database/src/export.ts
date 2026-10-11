export const EXPORT_MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
export const EXPORT_MAX_PER_DATABASE = 3;
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1_000;
export const EXPORT_MAX_PAGE_ITEMS = 100;
export const EXPORT_DEFAULT_PAGE_ITEMS = 20;

type Scalar = string | number | boolean | null;

export type ExportDatabaseMetadata = {
  name: string;
  description: string;
  createdAt: string;
  writeUntil: string;
  lastActivityAt: string;
  state: "writable" | "read_only";
};

export type ExportSourceTable = {
  id: string;
  name: string;
  description: string;
  schemaVersion: string;
};

export type ExportSourceColumn = {
  id: string;
  tableId: string;
  name: string;
  type: "string" | "number" | "boolean";
  nullable: boolean;
};

export type ExportSourceRecord = {
  id: string;
  tableId: string;
  values: Record<string, Scalar>;
  version: string;
};

export type ExportManifest = {
  exportId: string;
  formatVersion: 1;
  snapshotAt: string;
  expiresAt: string;
};

export type ExportItem =
  | ({ type: "database" } & ExportDatabaseMetadata)
  | ({ type: "table" } & ExportSourceTable)
  | {
      type: "column";
      id: string;
      tableId: string;
      name: string;
      columnType: ExportSourceColumn["type"];
      nullable: boolean;
    }
  | ({ type: "record" } & ExportSourceRecord)
  | {
      type: "record";
      tableId: string;
      id: string;
      version: string;
      chunk: {
        encoding: "json";
        offsetBytes: number;
        totalBytes: number;
      };
      data: string;
    };

export type ExportPage = ExportManifest & {
  items: ExportItem[];
  nextCursor: string | null;
};

export class ExportFault extends Error {
  constructor(
    readonly code: "VALIDATION_ERROR" | "RESULT_TOO_LARGE",
    readonly status: 400 | 413,
    readonly details: Record<string, unknown> = {},
  ) {
    super(
      code === "RESULT_TOO_LARGE"
        ? "The export page exceeds the response limit"
        : "The export cursor or page limit is invalid",
    );
    this.name = "ExportFault";
  }
}

type ExportCursor = {
  v: 1;
  exportId: string;
  itemIndex: number;
  byteOffset: number;
};

const encoder = new TextEncoder();
const MAX_RESPONSE_BYTES = 256 * 1024;

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function compareIds(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

export function buildExportItems(
  database: ExportDatabaseMetadata,
  tables: readonly ExportSourceTable[],
  columns: readonly ExportSourceColumn[],
  records: readonly ExportSourceRecord[],
): ExportItem[] {
  const items: ExportItem[] = [
    {
      type: "database",
      name: database.name,
      description: database.description,
      createdAt: database.createdAt,
      writeUntil: database.writeUntil,
      lastActivityAt: database.lastActivityAt,
      state: database.state,
    },
  ];
  const columnsByTable = new Map<string, ExportSourceColumn[]>();
  const recordsByTable = new Map<string, ExportSourceRecord[]>();

  for (const column of columns) {
    const siblings = columnsByTable.get(column.tableId) ?? [];
    siblings.push(column);
    columnsByTable.set(column.tableId, siblings);
  }
  for (const record of records) {
    const siblings = recordsByTable.get(record.tableId) ?? [];
    siblings.push(record);
    recordsByTable.set(record.tableId, siblings);
  }

  for (const table of [...tables].sort(compareIds)) {
    items.push({
      type: "table",
      id: table.id,
      name: table.name,
      description: table.description,
      schemaVersion: table.schemaVersion,
    });
    for (const column of [...(columnsByTable.get(table.id) ?? [])].sort(
      compareIds,
    )) {
      items.push({
        type: "column",
        id: column.id,
        tableId: column.tableId,
        name: column.name,
        columnType: column.type,
        nullable: column.nullable,
      });
    }
    for (const record of [...(recordsByTable.get(table.id) ?? [])].sort(
      compareIds,
    )) {
      items.push({
        type: "record",
        id: record.id,
        tableId: record.tableId,
        values: record.values,
        version: record.version,
      });
    }
  }

  return items;
}

export function serializeExportItems(items: readonly ExportItem[]): {
  json: string;
  bytes: number;
} {
  const json = stableJson(items);
  return { json, bytes: byteLength(json) };
}

function encodeCursor(cursor: ExportCursor): string {
  const bytes = encoder.encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(value: string, exportId: string): ExportCursor {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("invalid cursor");
    }
    const cursor = parsed as Partial<ExportCursor>;
    if (
      cursor.v !== 1 ||
      cursor.exportId !== exportId ||
      !Number.isSafeInteger(cursor.itemIndex) ||
      (cursor.itemIndex ?? -1) < 0 ||
      !Number.isSafeInteger(cursor.byteOffset) ||
      (cursor.byteOffset ?? -1) < 0
    ) {
      throw new Error("invalid cursor");
    }
    return cursor as ExportCursor;
  } catch {
    throw new ExportFault("VALIDATION_ERROR", 400, { field: "cursor" });
  }
}

export function exportCursorPosition(
  cursor: string | undefined,
  exportId: string,
): { itemIndex: number; byteOffset: number } {
  if (cursor === undefined) return { itemIndex: 0, byteOffset: 0 };
  const decoded = decodeCursor(cursor, exportId);
  return { itemIndex: decoded.itemIndex, byteOffset: decoded.byteOffset };
}

function cursorAt(
  exportId: string,
  itemIndex: number,
  byteOffset: number,
): string {
  return encodeCursor({ v: 1, exportId, itemIndex, byteOffset });
}

function pageJsonBytes(page: ExportPage): number {
  return byteLength(JSON.stringify(page));
}

function recordValuesJson(
  item: Extract<ExportItem, { type: "record" }>,
): string {
  if ("values" in item) return stableJson(item.values);
  throw new ExportFault("VALIDATION_ERROR", 400, { field: "cursor" });
}

function utf8Boundaries(value: string): {
  characters: string[];
  bytes: number[];
} {
  const characters: string[] = [];
  const bytes = [0];
  let total = 0;
  for (const character of value) {
    characters.push(character);
    total += byteLength(character);
    bytes.push(total);
  }
  return { characters, bytes };
}

function indexForByteOffset(
  boundaries: readonly number[],
  offset: number,
): number {
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (boundaries[middle] === offset) return middle;
    if (boundaries[middle] < offset) low = middle + 1;
    else high = middle - 1;
  }
  throw new ExportFault("VALIDATION_ERROR", 400, { field: "cursor" });
}

function recordChunk(
  item: Extract<ExportItem, { type: "record" }>,
  data: string,
  offsetBytes: number,
  totalBytes: number,
): ExportItem {
  return {
    type: "record",
    tableId: item.tableId,
    id: item.id,
    version: item.version,
    chunk: { encoding: "json", offsetBytes, totalBytes },
    data,
  };
}

function chunkRecordPage(
  manifest: ExportManifest,
  item: Extract<ExportItem, { type: "record" }>,
  itemIndex: number,
  byteOffset: number,
  totalItems: number,
  responseBudget: number,
): { item: ExportItem; nextItemIndex: number; nextByteOffset: number } {
  const serializedValues = recordValuesJson(item);
  const { characters, bytes } = utf8Boundaries(serializedValues);
  const startIndex = indexForByteOffset(bytes, byteOffset);
  const totalBytes = bytes[bytes.length - 1];
  let low = startIndex + 1;
  let high = characters.length;
  let bestIndex = -1;
  let bestItem: ExportItem | undefined;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const data = characters.slice(startIndex, middle).join("");
    const nextByteOffset = bytes[middle];
    const complete = nextByteOffset === totalBytes;
    const nextItemIndex = complete ? itemIndex + 1 : itemIndex;
    const nextOffset = complete ? 0 : nextByteOffset;
    const candidate = recordChunk(item, data, byteOffset, totalBytes);
    const candidatePage: ExportPage = {
      ...manifest,
      items: [candidate],
      nextCursor:
        nextItemIndex >= totalItems
          ? null
          : cursorAt(manifest.exportId, nextItemIndex, nextOffset),
    };
    if (pageJsonBytes(candidatePage) <= responseBudget) {
      bestIndex = middle;
      bestItem = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (bestIndex < 0 || bestItem === undefined) {
    throw new ExportFault("RESULT_TOO_LARGE", 413, {
      maxBytes: responseBudget,
    });
  }
  const endByteOffset = bytes[bestIndex];
  return {
    item: bestItem,
    nextItemIndex: endByteOffset === totalBytes ? itemIndex + 1 : itemIndex,
    nextByteOffset: endByteOffset === totalBytes ? 0 : endByteOffset,
  };
}

export function pageExportItemWindow(
  items: readonly ExportItem[],
  baseIndex: number,
  totalItems: number,
  manifest: ExportManifest,
  cursor: string | undefined,
  limit: number,
  responseBudget: number,
): ExportPage {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > EXPORT_MAX_PAGE_ITEMS ||
    !Number.isSafeInteger(responseBudget) ||
    responseBudget < 1
  ) {
    throw new ExportFault("VALIDATION_ERROR", 400, { field: "limit" });
  }
  if (
    !Number.isSafeInteger(baseIndex) ||
    baseIndex < 0 ||
    !Number.isSafeInteger(totalItems) ||
    totalItems < 0 ||
    baseIndex > totalItems ||
    items.length > totalItems - baseIndex ||
    items.length > limit
  ) {
    throw new ExportFault("VALIDATION_ERROR", 400, { field: "cursor" });
  }
  const start = exportCursorPosition(cursor, manifest.exportId);
  if (
    start.itemIndex !== baseIndex ||
    start.itemIndex > totalItems ||
    (start.itemIndex === totalItems && start.byteOffset !== 0) ||
    (start.itemIndex < totalItems && items.length === 0)
  ) {
    throw new ExportFault("VALIDATION_ERROR", 400, { field: "cursor" });
  }

  const budget = Math.min(responseBudget, MAX_RESPONSE_BYTES);
  const pageItems: ExportItem[] = [];
  let windowIndex = 0;
  let itemIndex = start.itemIndex;
  let byteOffset = start.byteOffset;

  while (
    windowIndex < items.length &&
    itemIndex < totalItems &&
    pageItems.length < limit
  ) {
    const item = items[windowIndex];
    const fullCandidate: ExportPage = {
      ...manifest,
      items: [...pageItems, item],
      nextCursor:
        itemIndex + 1 >= totalItems
          ? null
          : cursorAt(manifest.exportId, itemIndex + 1, 0),
    };
    if (byteOffset === 0 && pageJsonBytes(fullCandidate) <= budget) {
      pageItems.push(item);
      itemIndex += 1;
      windowIndex += 1;
      continue;
    }

    if (pageItems.length > 0) break;
    if (item.type !== "record") {
      throw new ExportFault("RESULT_TOO_LARGE", 413, { maxBytes: budget });
    }

    const chunk = chunkRecordPage(
      manifest,
      item,
      itemIndex,
      byteOffset,
      totalItems,
      budget,
    );
    pageItems.push(chunk.item);
    if (chunk.nextItemIndex > itemIndex) windowIndex += 1;
    itemIndex = chunk.nextItemIndex;
    byteOffset = chunk.nextByteOffset;
    if (byteOffset > 0) break;
  }

  const nextCursor =
    itemIndex >= totalItems
      ? null
      : cursorAt(manifest.exportId, itemIndex, byteOffset);
  const page: ExportPage = { ...manifest, items: pageItems, nextCursor };
  if (pageJsonBytes(page) > budget) {
    throw new ExportFault("RESULT_TOO_LARGE", 413, { maxBytes: budget });
  }
  return page;
}

export function pageExportItems(
  items: readonly ExportItem[],
  manifest: ExportManifest,
  cursor: string | undefined,
  limit: number,
  responseBudget: number,
): ExportPage {
  const start = exportCursorPosition(cursor, manifest.exportId);
  return pageExportItemWindow(
    items.slice(start.itemIndex, start.itemIndex + limit),
    start.itemIndex,
    items.length,
    manifest,
    cursor,
    limit,
    responseBudget,
  );
}
