import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "bun:test";
import { REGISTRY_ID } from "../src/global-admission";
import { EXPORT_MAX_SNAPSHOT_BYTES } from "../src/export";

const BASE_URL = "https://database.0000.chat";
const DATABASES_PATH = "/v1/databases";
const workerEntry = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
const failAfterCreateWorkerEntry = fileURLToPath(
  new URL("./worker-fail-after-create.ts", import.meta.url),
);
const utcDayMs = 24 * 60 * 60 * 1_000;
const maxRequestBodyBytes = 64 * 1024;
const maxResponseBodyBytes = 256 * 1024;
const maxMutationResponseBytes = 255 * 1024;
const maxStorageBytes = 10 * 1024 * 1024;
const kibibyte = 1024;
const mebibyte = 1024 * kibibyte;
const maxDailyRequests = 1_000;
const maxDailyReturnedBytes = 100 * mebibyte;
const testAdmissionBindings = {
  CAPACITY_MAX_DATABASES: "32",
  CAPACITY_MAX_LOGICAL_BYTES: String(512 * mebibyte),
  CAPACITY_MAX_REPLAY_BYTES: String(1_024 * mebibyte),
  CAPACITY_MAX_PHYSICAL_BYTES: String(4_096 * mebibyte),
  CAPACITY_MAX_PHYSICAL_BYTES_PER_DATABASE: String(128 * mebibyte),
  CAPACITY_MAX_DAILY_REQUESTS: "50000",
  CAPACITY_MAX_REQUESTS_PER_MINUTE: "1000",
  CAPACITY_MAX_DAILY_MUTATIONS: "5000",
  CAPACITY_MAX_EXPORT_BYTES: String(128 * mebibyte),
  CAPACITY_MAX_CONTROL_BYTES: String(64 * mebibyte),
  CAPACITY_POLICY_REVISION: "1",
  SERVICE_SUSPENDED: "false",
} satisfies Record<string, string>;

type Database = {
  databaseId: string;
  databaseUrl: string;
  name: string;
  description: string;
  createdAt: string;
  writeUntil: string;
  lastActivityAt: string;
  state: "writable" | "read_only";
  accessWarning: string;
};

type Table = {
  id: string;
  name: string;
  description: string;
  schemaVersion: string;
};

type Column = {
  id: string;
  name: string;
  type: "string" | "number" | "boolean";
  nullable: boolean;
};

type RecordResource = {
  id: string;
  values: Record<string, string | number | boolean | null>;
  version: string;
};

type ApiError = {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
};

type Collection<T> = {
  items: T[];
  nextCursor: string | null;
};

type ExportManifest = {
  exportId: string;
  formatVersion: 1;
  snapshotAt: string;
  expiresAt: string;
};

type ExportItem = Record<string, unknown> & { type: string };

type ExportPage = ExportManifest & {
  items: ExportItem[];
  nextCursor: string | null;
};

type McpResult = Awaited<ReturnType<Client["callTool"]>>;

const workerScriptPromises = new Map<string, Promise<string>>();

function retryKey(label: string): string {
  return `${label}-${randomBytes(16).toString("hex")}`;
}

async function workerScript(entryPoint = workerEntry): Promise<string> {
  let workerScriptPromise = workerScriptPromises.get(entryPoint);
  if (!workerScriptPromise) {
    workerScriptPromise = (async () => {
      const build = await Bun.build({
        entrypoints: [entryPoint],
        external: ["cloudflare:workers"],
        format: "esm",
        target: "browser",
      });
      if (!build.success) {
        throw new Error(build.logs.map((log) => log.message).join("\n"));
      }
      const output = build.outputs.find(
        (candidate) => candidate.kind === "entry-point",
      );
      if (!output)
        throw new Error(
          "The database Worker test build did not emit an entry point.",
        );
      return await output.text();
    })();
    workerScriptPromises.set(entryPoint, workerScriptPromise);
  }
  return await workerScriptPromise;
}

async function startRuntime(
  persistenceDirectory: string,
  options: {
    failAfterCreate?: boolean;
    testClock?: boolean;
    admissionBindings?: Partial<typeof testAdmissionBindings>;
  } = {},
): Promise<Miniflare> {
  const testHarness =
    options.failAfterCreate === true || options.testClock === true;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: persistenceDirectory,
      workers: [
        {
          name: "database",
          compatibilityDate: "2026-09-11",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            ...testAdmissionBindings,
            ...options.admissionBindings,
          },
          durableObjects: {
            DATABASES: {
              className: options.failAfterCreate
                ? "FailOnceDatabaseObject"
                : options.testClock
                  ? "TestClockDatabaseObject"
                  : "DatabaseObject",
              useSQLite: true,
            },
            REGISTRY: {
              className: options.testClock
                ? "TestClockDatabaseRegistry"
                : "DatabaseRegistry",
              useSQLite: true,
            },
          },
          modules: true,
          script: await workerScript(
            testHarness ? failAfterCreateWorkerEntry : workerEntry,
          ),
        },
      ],
    }),
  );
  try {
    await runtime.ready;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  return runtime;
}

async function createPersistenceDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "0000-database-durable-"));
}

async function disposeRuntime(runtime: Miniflare | undefined): Promise<void> {
  if (runtime) await runtime.dispose();
}

async function request(
  runtime: Miniflare,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const worker = await runtime.getWorker();
  return worker.fetch(new Request(new URL(path, BASE_URL), init));
}

function jsonRequest(
  runtime: Miniflare,
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return request(runtime, path, {
    method,
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

async function jsonResponse<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as T;
}

async function expectApiError(
  response: Response,
  status: number,
  code: string,
): Promise<ApiError> {
  const body = await jsonResponse<ApiError>(response, status);
  expect(body.error.code).toBe(code);
  expect(body.error.message).toEqual(expect.any(String));
  expect(body.error.details).toEqual(expect.any(Object));
  return body;
}

async function createDatabase(
  runtime: Miniflare,
  name = "Durable acceptance",
  key = retryKey("create-database"),
): Promise<Database> {
  return await jsonResponse<Database>(
    await jsonRequest(
      runtime,
      DATABASES_PATH,
      "POST",
      { name },
      { "Idempotency-Key": key },
    ),
    201,
  );
}

function databasePath(databaseId: string): string {
  return `${DATABASES_PATH}/${databaseId}`;
}

function tablesPath(databaseId: string): string {
  return `${databasePath(databaseId)}/tables`;
}

function tablePath(databaseId: string, tableId: string): string {
  return `${tablesPath(databaseId)}/${tableId}`;
}

function columnsPath(databaseId: string, tableId: string): string {
  return `${tablePath(databaseId, tableId)}/columns`;
}

function recordsPath(databaseId: string, tableId: string): string {
  return `${tablePath(databaseId, tableId)}/records`;
}

function recordPath(
  databaseId: string,
  tableId: string,
  recordId: string,
): string {
  return `${recordsPath(databaseId, tableId)}/${recordId}`;
}

async function getDatabase(
  runtime: Miniflare,
  databaseId: string,
): Promise<Database> {
  return await jsonResponse<Database>(
    await request(runtime, databasePath(databaseId)),
    200,
  );
}

async function createTable(
  runtime: Miniflare,
  databaseId: string,
  name = "Shopping",
): Promise<Table> {
  return await jsonResponse<Table>(
    await jsonRequest(
      runtime,
      tablesPath(databaseId),
      "POST",
      { name },
      { "Idempotency-Key": retryKey("create-table") },
    ),
    201,
  );
}

async function getTable(
  runtime: Miniflare,
  databaseId: string,
  tableId: string,
): Promise<Table> {
  return await jsonResponse<Table>(
    await request(runtime, tablePath(databaseId, tableId)),
    200,
  );
}

async function createColumn(
  runtime: Miniflare,
  databaseId: string,
  table: Table,
  input: Pick<Column, "name" | "type" | "nullable">,
): Promise<Column> {
  return await jsonResponse<Column>(
    await jsonRequest(
      runtime,
      columnsPath(databaseId, table.id),
      "POST",
      input,
      {
        "Idempotency-Key": retryKey("create-column"),
        "X-Expected-Schema-Version": table.schemaVersion,
      },
    ),
    201,
  );
}

async function createRecord(
  runtime: Miniflare,
  databaseId: string,
  tableId: string,
  values: Record<string, string | number | boolean | null>,
  key = retryKey("create-record"),
): Promise<RecordResource> {
  return await jsonResponse<RecordResource>(
    await jsonRequest(
      runtime,
      recordsPath(databaseId, tableId),
      "POST",
      { values },
      { "Idempotency-Key": key },
    ),
    201,
  );
}

async function connectMcp(
  runtime: Miniflare,
  observeResponse?: (
    request: Request,
    response: Response,
  ) => Promise<void> | void,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL}/mcp`),
    {
      fetch: async (input, init) => {
        const worker = await runtime.getWorker();
        const request = new Request(input, init);
        const observedRequest = request.clone();
        const response = await worker.fetch(request);
        await observeResponse?.(observedRequest, response.clone());
        return response;
      },
    },
  );
  const client = new Client({
    name: "database-durable-acceptance",
    version: "0.0.0",
  });
  await client.connect(transport);
  return client;
}

function mcpBody(result: McpResult): Record<string, unknown> {
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return result.structuredContent as Record<string, unknown>;
  }
  const textBlock = result.content.find((item) => item.type === "text");
  if (!textBlock || textBlock.type !== "text")
    throw new Error("MCP result did not include JSON text content.");
  return JSON.parse(textBlock.text) as Record<string, unknown>;
}

function normalizeExportItems(pages: readonly ExportPage[]): ExportItem[] {
  const normalized: ExportItem[] = [];
  const encoder = new TextEncoder();
  let pending:
    | {
        item: ExportItem;
        data: string;
        byteLength: number;
        totalBytes: number;
      }
    | undefined;

  const finishChunkedRecord = () => {
    if (!pending) return;
    if (pending.byteLength !== pending.totalBytes)
      throw new Error("Export record chunks did not cover the full JSON value");
    normalized.push({
      type: "record",
      id: pending.item.id,
      tableId: pending.item.tableId,
      version: pending.item.version,
      values: JSON.parse(pending.data) as Record<string, unknown>,
    });
    pending = undefined;
  };

  for (const page of pages) {
    for (const item of page.items) {
      const chunk = item.chunk;
      if (typeof chunk === "object" && chunk !== null) {
        const details = chunk as {
          encoding?: unknown;
          offsetBytes?: unknown;
          totalBytes?: unknown;
        };
        if (
          details.encoding !== "json" ||
          typeof details.offsetBytes !== "number" ||
          typeof details.totalBytes !== "number" ||
          typeof item.data !== "string"
        ) {
          throw new Error("Export record chunk had an invalid shape");
        }
        if (!pending) {
          if (details.offsetBytes !== 0)
            throw new Error("Export record chunks did not start at byte zero");
          pending = {
            item,
            data: "",
            byteLength: 0,
            totalBytes: details.totalBytes,
          };
        }
        if (
          pending.item.id !== item.id ||
          pending.item.tableId !== item.tableId ||
          pending.item.version !== item.version ||
          pending.totalBytes !== details.totalBytes ||
          pending.byteLength !== details.offsetBytes
        ) {
          throw new Error("Export record chunks were not contiguous");
        }
        pending.data += item.data;
        pending.byteLength += encoder.encode(item.data).byteLength;
        continue;
      }

      finishChunkedRecord();
      normalized.push(item);
    }
  }
  finishChunkedRecord();
  return normalized;
}

async function callMcp(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError)
    throw new Error(`MCP ${name} failed: ${JSON.stringify(mcpBody(result))}`);
  return mcpBody(result);
}

function nextUtcMidday(timestamp: string): number {
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(12, 0, 0, 0);
  return date.getTime();
}

async function setTestClock(
  runtime: Miniflare,
  databaseId: string,
  nowMs: number,
): Promise<void> {
  const databaseNamespace = (await runtime.getDurableObjectNamespace(
    "DATABASES",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testSetClock: (nowMs: number) => Promise<void>;
    };
  };
  await databaseNamespace
    .get(databaseNamespace.idFromName(databaseId))
    .__testSetClock(nowMs);

  const registryNamespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testSetClock: (nowMs: number) => Promise<void>;
    };
  };
  await registryNamespace
    .get(registryNamespace.idFromName(REGISTRY_ID))
    .__testSetClock(nowMs);
}

async function setInvalidRegistryServiceClock(
  runtime: Miniflare,
  mode: "missingPhysicalBytesPerDatabase" | "zeroPolicyRevision" | null,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testSetInvalidServiceClock: (
        mode: "missingPhysicalBytesPerDatabase" | "zeroPolicyRevision" | null,
      ) => Promise<void>;
    };
  };
  await namespace
    .get(namespace.idFromName(REGISTRY_ID))
    .__testSetInvalidServiceClock(mode);
}

async function runDatabaseAlarm(
  runtime: Miniflare,
  databaseId: string,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "DATABASES",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { __testRunAlarm: () => Promise<void> };
  };
  await namespace.get(namespace.idFromName(databaseId)).__testRunAlarm();
}

async function runRegistryAlarm(runtime: Miniflare): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { __testRunAlarm: () => Promise<void> };
  };
  await namespace.get(namespace.idFromName(REGISTRY_ID)).__testRunAlarm();
}

async function failNextRegistryExportCompletion(
  runtime: Miniflare,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testFailNextExportCompletion: () => Promise<void>;
    };
  };
  await namespace
    .get(namespace.idFromName(REGISTRY_ID))
    .__testFailNextExportCompletion();
}

async function failNextDatabaseExportReconciliation(
  runtime: Miniflare,
  databaseId: string,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "DATABASES",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testFailNextExportReconciliation: () => Promise<void>;
    };
  };
  await namespace
    .get(namespace.idFromName(databaseId))
    .__testFailNextExportReconciliation();
}

async function reservePendingMutation(
  runtime: Miniflare,
  databaseId: string,
  operationKey: string,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testReservePendingMutation: (
        databaseId: string,
        operationKey: string,
      ) => Promise<{ ok: boolean }>;
    };
  };
  const result = await namespace
    .get(namespace.idFromName(REGISTRY_ID))
    .__testReservePendingMutation(databaseId, operationKey);
  expect(result.ok).toBe(true);
}

async function reservePendingExport(
  runtime: Miniflare,
  databaseId: string,
  exportKey: string,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testReservePendingExport: (
        databaseId: string,
        exportKey: string,
      ) => Promise<{ ok: boolean }>;
    };
  };
  const result = await namespace
    .get(namespace.idFromName(REGISTRY_ID))
    .__testReservePendingExport(databaseId, exportKey);
  expect(result.ok).toBe(true);
}

async function armRegistryServiceClockBarrier(
  runtime: Miniflare,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testArmServiceClockBarrier: () => Promise<void>;
    };
  };
  await namespace
    .get(namespace.idFromName(REGISTRY_ID))
    .__testArmServiceClockBarrier();
}

async function waitForRegistryServiceClockBarrier(
  runtime: Miniflare,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testWaitForServiceClockBarrier: () => Promise<void>;
    };
  };
  await namespace
    .get(namespace.idFromName(REGISTRY_ID))
    .__testWaitForServiceClockBarrier();
}

async function releaseRegistryServiceClockBarrier(
  runtime: Miniflare,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testReleaseServiceClockBarrier: () => Promise<void>;
    };
  };
  await namespace
    .get(namespace.idFromName(REGISTRY_ID))
    .__testReleaseServiceClockBarrier();
}

async function databaseStorageSnapshot(
  runtime: Miniflare,
  databaseId: string,
): Promise<{ databaseSize: number; applicationTables: string[] }> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "DATABASES",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testStorageSnapshot: () => Promise<{
        databaseSize: number;
        applicationTables: string[];
      }>;
    };
  };
  return await namespace
    .get(namespace.idFromName(databaseId))
    .__testStorageSnapshot();
}

async function databaseLastActivityAt(
  runtime: Miniflare,
  databaseId: string,
): Promise<number | null> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "DATABASES",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testLastActivityAt: () => Promise<number | null>;
    };
  };
  return await namespace
    .get(namespace.idFromName(databaseId))
    .__testLastActivityAt();
}

async function setDatabaseLastActivityAt(
  runtime: Miniflare,
  databaseId: string,
  nowMs: number,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "DATABASES",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testSetLastActivityAt: (nowMs: number) => Promise<void>;
    };
  };
  await namespace
    .get(namespace.idFromName(databaseId))
    .__testSetLastActivityAt(nowMs);
}

async function resetCapacityProjectionForLegacyDatabase(
  runtime: Miniflare,
  databaseId: string,
): Promise<void> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testResetCapacityProjection: (databaseId: string) => Promise<void>;
    };
  };
  const registry = namespace.get(namespace.idFromName(REGISTRY_ID));
  await registry.__testResetCapacityProjection(databaseId);
}

async function inspectCapacityProjection(
  runtime: Miniflare,
  databaseId: string,
): Promise<{
  capacity: {
    status: string;
    logicalBytes: number;
    replayBytes: number;
    physicalBytes: number;
    physicalReservedBytes: number;
  } | null;
  legacyBackfillDone: number | null;
  policyRevision: number | null;
}> {
  const namespace = (await runtime.getDurableObjectNamespace(
    "REGISTRY",
  )) as unknown as {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => {
      __testCapacityProjection: (databaseId: string) => Promise<{
        capacity: {
          status: string;
          logicalBytes: number;
          replayBytes: number;
          physicalBytes: number;
          physicalReservedBytes: number;
        } | null;
        legacyBackfillDone: number | null;
        policyRevision: number | null;
      }>;
    };
  };
  return await namespace
    .get(namespace.idFromName(REGISTRY_ID))
    .__testCapacityProjection(databaseId);
}

test.serial(
  "REST and MCP read the same shopping-list resources before and after a Worker restart",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory);
      const database = await createDatabase(runtime);
      expect(database.databaseId).toMatch(/^[A-Za-z0-9_-]{22,}$/);
      expect(database.databaseUrl).toBe(
        `${BASE_URL}${databasePath(database.databaseId)}`,
      );
      expect(database.writeUntil).toEqual(expect.any(String));
      expect(
        Date.parse(database.writeUntil) - Date.parse(database.createdAt),
      ).toBe(30 * utcDayMs);
      expect(database.lastActivityAt).toEqual(expect.any(String));
      expect(database.accessWarning).toEqual(expect.any(String));

      let table = await createTable(runtime, database.databaseId);
      const itemColumn = await createColumn(
        runtime,
        database.databaseId,
        table,
        {
          name: "Item",
          type: "string",
          nullable: false,
        },
      );
      table = await getTable(runtime, database.databaseId, table.id);
      const quantityColumn = await createColumn(
        runtime,
        database.databaseId,
        table,
        {
          name: "Quantity",
          type: "number",
          nullable: false,
        },
      );
      table = await getTable(runtime, database.databaseId, table.id);
      const boughtColumn = await createColumn(
        runtime,
        database.databaseId,
        table,
        {
          name: "Bought",
          type: "boolean",
          nullable: false,
        },
      );
      table = await getTable(runtime, database.databaseId, table.id);
      const record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        {
          [itemColumn.id]: "Milk",
          [quantityColumn.id]: 2,
          [boughtColumn.id]: false,
        },
      );

      const restRecord = await jsonResponse<RecordResource>(
        await request(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
        ),
        200,
      );
      expect(restRecord).toEqual(record);

      client = await connectMcp(runtime);
      const toolList = await client.listTools();
      expect(toolList.tools.map(({ name }) => name)).toContain("get_record");
      expect(toolList.tools.map(({ name }) => name)).toContain("list_records");
      const mcpRecord = await callMcp(client, "get_record", {
        databaseId: database.databaseId,
        tableId: table.id,
        recordId: record.id,
      });
      expect(mcpRecord).toEqual(record);
      const mcpList = (await callMcp(client, "list_records", {
        databaseId: database.databaseId,
        tableId: table.id,
        limit: 100,
      })) as unknown as Collection<RecordResource>;
      expect(mcpList).toEqual({ items: [record], nextCursor: null });
      await client.close();
      client = undefined;

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory);

      const restoredTable = await getTable(
        runtime,
        database.databaseId,
        table.id,
      );
      const restoredRecord = await jsonResponse<RecordResource>(
        await request(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
        ),
        200,
      );
      const restoredColumns = await jsonResponse<Collection<Column>>(
        await request(runtime, columnsPath(database.databaseId, table.id)),
        200,
      );
      expect(restoredTable).toEqual(table);
      expect(restoredRecord).toEqual(record);
      expect(
        [...restoredColumns.items].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      ).toEqual(
        [itemColumn, quantityColumn, boughtColumn].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      );
      expect(restoredColumns.nextCursor).toBeNull();
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "record version preconditions let only one concurrent update win",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory);
      const database = await createDatabase(runtime, "Version race");
      const table = await createTable(runtime, database.databaseId, "Counter");
      const column = await createColumn(runtime, database.databaseId, table, {
        name: "Value",
        type: "number",
        nullable: false,
      });
      const record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        { [column.id]: 0 },
      );
      const target = recordPath(database.databaseId, table.id, record.id);

      const [firstResponse, secondResponse] = await Promise.all([
        jsonRequest(
          runtime,
          target,
          "PATCH",
          { values: { [column.id]: 1 } },
          {
            "Idempotency-Key": retryKey("concurrent-update"),
            "X-Expected-Version": record.version,
          },
        ),
        jsonRequest(
          runtime,
          target,
          "PATCH",
          { values: { [column.id]: 2 } },
          {
            "Idempotency-Key": retryKey("concurrent-update"),
            "X-Expected-Version": record.version,
          },
        ),
      ]);
      const responses = [firstResponse, secondResponse];
      expect(
        responses.filter((response) => response.status === 200),
      ).toHaveLength(1);
      expect(
        responses.filter((response) => response.status === 409),
      ).toHaveLength(1);
      const successResponse = responses.find(
        (response) => response.status === 200,
      )!;
      const conflictResponse = responses.find(
        (response) => response.status === 409,
      )!;
      const updated = await jsonResponse<RecordResource>(successResponse, 200);
      await expectApiError(conflictResponse, 409, "VERSION_CONFLICT");

      const finalRecord = await jsonResponse<RecordResource>(
        await request(runtime, target),
        200,
      );
      expect(finalRecord).toEqual(updated);
      expect(finalRecord.id).toBe(record.id);
      expect(finalRecord.version).not.toBe(record.version);
      expect([1, 2]).toContain(finalRecord.values[column.id]);
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "MCP can create databases, tables, typed columns, and records that REST reads",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory);
      client = await connectMcp(runtime);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "create_database",
          "create_table",
          "create_column",
          "create_record",
        ]),
      );

      const createKey = retryKey("mcp-create-database");
      const database = (await callMcp(client, "create_database", {
        name: "MCP-created database",
        requestKey: createKey,
      })) as unknown as Database;
      expect(await getDatabase(runtime, database.databaseId)).toEqual(database);
      expect(
        await callMcp(client, "create_database", {
          name: "MCP-created database",
          requestKey: createKey,
        }),
      ).toEqual(database);

      const conflict = await client.callTool({
        name: "create_database",
        arguments: { name: "Different database", requestKey: createKey },
      });
      expect(conflict.isError).toBe(true);
      expect(mcpBody(conflict).error).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });

      const table = (await callMcp(client, "create_table", {
        databaseId: database.databaseId,
        name: "Items",
        requestKey: retryKey("mcp-create-table"),
      })) as unknown as Table;
      expect(await getTable(runtime, database.databaseId, table.id)).toEqual(
        table,
      );

      const column = await callMcp(client, "create_column", {
        databaseId: database.databaseId,
        tableId: table.id,
        name: "Item",
        type: "string",
        nullable: false,
        expectedSchemaVersion: table.schemaVersion,
        requestKey: retryKey("mcp-create-column"),
      });
      expect(typeof column.id).toBe("string");
      expect(column.name).toBe("Item");
      expect(column.type).toBe("string");
      expect(column.nullable).toBe(false);
      expect(column.schemaVersion).toBe("2");
      const restColumns = await jsonResponse<Collection<Column>>(
        await request(runtime, columnsPath(database.databaseId, table.id)),
        200,
      );
      expect(restColumns.items).toEqual([
        { id: column.id, name: "Item", type: "string", nullable: false },
      ]);

      const record = (await callMcp(client, "create_record", {
        databaseId: database.databaseId,
        tableId: table.id,
        values: { [String(column.id)]: "MCP wrote this" },
        requestKey: retryKey("mcp-create-record"),
      })) as unknown as RecordResource;
      expect(
        await jsonResponse<RecordResource>(
          await request(
            runtime,
            recordPath(database.databaseId, table.id, record.id),
          ),
          200,
        ),
      ).toEqual(record);
      expect(
        await callMcp(client, "get_record", {
          databaseId: database.databaseId,
          tableId: table.id,
          recordId: record.id,
        }),
      ).toEqual(record);
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "column replays preserve their original schema version across REST and MCP",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Column replay headers");
      const timeBeforeFirstColumn = Date.parse(database.createdAt) + 60_000;
      await setTestClock(runtime, database.databaseId, timeBeforeFirstColumn);
      const table = await createTable(runtime, database.databaseId);
      const requestKey = retryKey("column-schema-version-replay");
      const firstColumnInput = {
        name: "First",
        type: "string",
        nullable: true,
      };
      const firstResponse = await jsonRequest(
        runtime,
        columnsPath(database.databaseId, table.id),
        "POST",
        firstColumnInput,
        {
          "Idempotency-Key": requestKey,
          "X-Expected-Schema-Version": table.schemaVersion,
        },
      );
      const firstColumn = await jsonResponse<Column>(firstResponse, 201);
      expect(firstResponse.headers.get("x-schema-version")).toBe("2");

      const timeAfterSiblingColumn = timeBeforeFirstColumn + 1_000;
      await setTestClock(runtime, database.databaseId, timeAfterSiblingColumn);
      const siblingResponse = await jsonRequest(
        runtime,
        columnsPath(database.databaseId, table.id),
        "POST",
        { name: "Sibling", type: "number", nullable: true },
        {
          "Idempotency-Key": retryKey("sibling-column"),
          "X-Expected-Schema-Version": "2",
        },
      );
      await jsonResponse<Column>(siblingResponse, 201);
      expect(siblingResponse.headers.get("x-schema-version")).toBe("3");
      const currentTable = await getTable(
        runtime,
        database.databaseId,
        table.id,
      );
      expect(currentTable.schemaVersion).toBe("3");
      const activityAfterSibling = await getDatabase(
        runtime,
        database.databaseId,
      );
      expect(activityAfterSibling.lastActivityAt).toBe(
        new Date(timeAfterSiblingColumn).toISOString(),
      );

      const replayTime = timeAfterSiblingColumn + 1_000;
      await setTestClock(runtime, database.databaseId, replayTime);
      const restReplay = await jsonRequest(
        runtime,
        columnsPath(database.databaseId, table.id),
        "POST",
        firstColumnInput,
        {
          "Idempotency-Key": requestKey,
          "X-Expected-Schema-Version": table.schemaVersion,
        },
      );
      expect(await jsonResponse<Column>(restReplay, 201)).toEqual(firstColumn);
      expect(restReplay.headers.get("x-schema-version")).toBe("2");

      client = await connectMcp(runtime);
      const mcpReplay = await callMcp(client, "create_column", {
        databaseId: database.databaseId,
        tableId: table.id,
        ...firstColumnInput,
        expectedSchemaVersion: table.schemaVersion,
        requestKey,
      });
      expect(mcpReplay).toEqual({ ...firstColumn, schemaVersion: "2" });
      expect(await getTable(runtime, database.databaseId, table.id)).toEqual(
        currentTable,
      );
      expect(
        (await getDatabase(runtime, database.databaseId)).lastActivityAt,
      ).toBe(activityAfterSibling.lastActivityAt);
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "mutation retries are shared across REST and MCP and changed arguments conflict",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory);
      const database = await createDatabase(runtime, "Cross-transport retries");
      const table = await createTable(runtime, database.databaseId, "Items");
      const column = await createColumn(runtime, database.databaseId, table, {
        name: "Item",
        type: "string",
        nullable: false,
      });
      client = await connectMcp(runtime);

      const restKey = retryKey("rest-to-mcp");
      const restCreated = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        { [column.id]: "Milk" },
        restKey,
      );
      const replayedByMcp = await callMcp(client, "create_record", {
        databaseId: database.databaseId,
        tableId: table.id,
        values: { [column.id]: "Milk" },
        requestKey: restKey,
      });
      expect(replayedByMcp).toEqual(restCreated);

      const mcpKey = retryKey("mcp-to-rest");
      const mcpCreated = (await callMcp(client, "create_record", {
        databaseId: database.databaseId,
        tableId: table.id,
        values: { [column.id]: "Bread" },
        requestKey: mcpKey,
      })) as unknown as RecordResource;
      const replayedByRest = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        { [column.id]: "Bread" },
        mcpKey,
      );
      expect(replayedByRest).toEqual(mcpCreated);

      const changedReplay = await client.callTool({
        name: "create_record",
        arguments: {
          databaseId: database.databaseId,
          tableId: table.id,
          values: { [column.id]: "Changed" },
          requestKey: restKey,
        },
      });
      expect(changedReplay.isError).toBe(true);
      expect(mcpBody(changedReplay).error).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });

      const list = await jsonResponse<Collection<RecordResource>>(
        await request(
          runtime,
          `${recordsPath(database.databaseId, table.id)}?limit=100`,
        ),
        200,
      );
      expect(list.items.map((item) => item.id).sort()).toEqual(
        [restCreated.id, mcpCreated.id].sort(),
      );
      expect(list.items).toHaveLength(2);
      expect(list.nextCursor).toBeNull();
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "MCP delete and its REST replay return 204 and leave the record unavailable",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory);
      const database = await createDatabase(runtime, "Delete retry");
      const table = await createTable(runtime, database.databaseId, "Items");
      const column = await createColumn(runtime, database.databaseId, table, {
        name: "Item",
        type: "string",
        nullable: false,
      });
      const record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        {
          [column.id]: "Remove me",
        },
      );
      client = await connectMcp(runtime);
      const requestKey = retryKey("delete-through-mcp");
      const args = {
        databaseId: database.databaseId,
        tableId: table.id,
        recordId: record.id,
        expectedVersion: record.version,
        requestKey,
      };

      const deletedByMcp = await client.callTool({
        name: "delete_record",
        arguments: args,
      });
      expect(deletedByMcp.isError).not.toBe(true);
      expect(mcpBody(deletedByMcp)).toEqual({});

      const restReplay = await request(
        runtime,
        recordPath(database.databaseId, table.id, record.id),
        {
          method: "DELETE",
          headers: {
            "Idempotency-Key": requestKey,
            "X-Expected-Version": record.version,
          },
        },
      );
      expect(restReplay.status).toBe(204);
      expect(await restReplay.text()).toBe("");
      await expectApiError(
        await request(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
        ),
        404,
        "NOT_FOUND",
      );
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "creation retry recovers the same database after restart without public listing or deletion",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    const createKey = retryKey("creation-restart");
    try {
      runtime = await startRuntime(persistenceDirectory);
      const created = await createDatabase(
        runtime,
        "Creation recovery",
        createKey,
      );
      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory);

      const recovered = await createDatabase(
        runtime,
        "Creation recovery",
        createKey,
      );
      expect(recovered).toEqual(created);

      await expectApiError(
        await request(runtime, `${DATABASES_PATH}?limit=1`),
        404,
        "NOT_FOUND",
      );
      await expectApiError(
        await request(runtime, databasePath(created.databaseId), {
          method: "DELETE",
        }),
        404,
        "NOT_FOUND",
      );
      await expectApiError(
        await request(runtime, databasePath("unknown-database-slug")),
        404,
        "NOT_FOUND",
      );

      client = await connectMcp(runtime);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).not.toContain(
        "list_databases",
      );
      expect(tools.tools.map(({ name }) => name)).not.toContain(
        "delete_database",
      );
      const unknown = await client.callTool({
        name: "get_database",
        arguments: { databaseId: "unknown-database-slug" },
      });
      expect(unknown.isError).toBe(true);
      expect(mcpBody(unknown).error).toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "creation retry recovers after Registry reserved a slug and the database committed",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    const name = "Create retry after partial failure";
    const key = retryKey("creation-partial-failure");
    try {
      runtime = await startRuntime(persistenceDirectory, {
        failAfterCreate: true,
        admissionBindings: { CAPACITY_MAX_DATABASES: "1" },
      });
      await expectApiError(
        await jsonRequest(
          runtime,
          DATABASES_PATH,
          "POST",
          { name },
          { "Idempotency-Key": key },
        ),
        500,
        "INTERNAL_ERROR",
      );

      await expectApiError(
        await jsonRequest(
          runtime,
          DATABASES_PATH,
          "POST",
          { name: "Another database while commit is uncertain" },
          { "Idempotency-Key": retryKey("uncertain-commit-capacity") },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        failAfterCreate: true,
        admissionBindings: { CAPACITY_MAX_DATABASES: "1" },
      });
      const recovered = await createDatabase(runtime, name, key);
      expect(recovered.name).toBe(name);

      const replayed = await createDatabase(runtime, name, key);
      expect(replayed).toEqual(recovered);
      const stored = await getDatabase(runtime, recovered.databaseId);
      expect(stored).toEqual(recovered);

      await expectApiError(
        await jsonRequest(
          runtime,
          DATABASES_PATH,
          "POST",
          { name: "Another database after uncertain commit recovery" },
          { "Idempotency-Key": retryKey("recovered-capacity") },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "legacy create rows receive pessimistic global capacity before new writes are admitted",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const legacyDatabase = await createDatabase(
        runtime,
        "Legacy database before capacity projection",
      );
      await resetCapacityProjectionForLegacyDatabase(
        runtime,
        legacyDatabase.databaseId,
      );
      expect(
        await inspectCapacityProjection(runtime, legacyDatabase.databaseId),
      ).toMatchObject({ capacity: null, legacyBackfillDone: null });

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "2",
          CAPACITY_MAX_DATABASES: "2",
          CAPACITY_MAX_LOGICAL_BYTES: String(10 * mebibyte),
          CAPACITY_MAX_REPLAY_BYTES: String(51 * mebibyte),
        },
      });
      const createAttempt = await jsonRequest(
        runtime,
        DATABASES_PATH,
        "POST",
        { name: "Must account for legacy logical reservation" },
        { "Idempotency-Key": retryKey("legacy-logical-backfill") },
      );
      if (createAttempt.status !== 503) {
        throw new Error(
          `Legacy backfill admitted create with ${createAttempt.status}: ${await createAttempt
            .clone()
            .text()}; projection=${JSON.stringify(
            await inspectCapacityProjection(runtime, legacyDatabase.databaseId),
          )}`,
        );
      }
      const blockedCreate = await expectApiError(
        createAttempt,
        503,
        "CAPACITY_UNAVAILABLE",
      );
      expect(
        await inspectCapacityProjection(runtime, legacyDatabase.databaseId),
      ).toMatchObject({
        capacity: {
          status: "active",
          logicalBytes: 10 * mebibyte,
          replayBytes: 51 * mebibyte,
          physicalReservedBytes: 128 * mebibyte,
        },
        legacyBackfillDone: 1,
        policyRevision: 2,
      });
      expect(blockedCreate.error.details).toMatchObject({
        quota: "globalLogicalBytes",
      });
      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "3",
          CAPACITY_MAX_DATABASES: "2",
          CAPACITY_MAX_LOGICAL_BYTES: String(20 * mebibyte),
          CAPACITY_MAX_REPLAY_BYTES: String(51 * mebibyte),
        },
      });
      const writeKey = retryKey("legacy-replay-backfill");
      const blockedWrite = await expectApiError(
        await jsonRequest(
          runtime,
          tablesPath(legacyDatabase.databaseId),
          "POST",
          { name: "Must account for legacy replay reservation" },
          { "Idempotency-Key": writeKey },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );
      expect(blockedWrite.error.details).toMatchObject({
        quota: "globalReplayBytes",
      });
      expect(
        (await getDatabase(runtime, legacyDatabase.databaseId)).databaseId,
      ).toBe(legacyDatabase.databaseId);
      const tables = await jsonResponse<Collection<Table>>(
        await request(
          runtime,
          `${tablesPath(legacyDatabase.databaseId)}?limit=100`,
        ),
        200,
      );
      expect(tables.items).toEqual([]);
      expect(tables.nextCursor).toBeNull();
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "concurrent global admission at capacity allows one reservation and replays it after restart",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    const capacity = 2;
    const contenders = Array.from({ length: 12 }, (_, index) => ({
      name: `Capacity contender ${index}`,
      key: retryKey(`capacity-contender-${index}`),
    }));
    try {
      runtime = await startRuntime(persistenceDirectory, {
        admissionBindings: { CAPACITY_MAX_DATABASES: String(capacity) },
      });
      await createDatabase(runtime, "Occupies one global slot");

      const responses = await Promise.all(
        contenders.map(({ name, key }) =>
          jsonRequest(
            runtime!,
            DATABASES_PATH,
            "POST",
            { name },
            { "Idempotency-Key": key },
          ),
        ),
      );
      const successfulIndexes: number[] = [];
      for (const [index, response] of responses.entries()) {
        if (response.status === 201) {
          successfulIndexes.push(index);
          continue;
        }
        const capacityError = await expectApiError(
          response,
          503,
          "CAPACITY_UNAVAILABLE",
        );
        expect(capacityError.error.details).toMatchObject({
          quota: "databases",
          limit: capacity,
        });
      }
      expect(successfulIndexes).toHaveLength(1);

      const winner = contenders[successfulIndexes[0]!]!;
      const firstResult = await createDatabase(
        runtime,
        winner.name,
        winner.key,
      );
      const replay = await createDatabase(runtime, winner.name, winner.key);
      expect(replay).toEqual(firstResult);

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        admissionBindings: { CAPACITY_MAX_DATABASES: String(capacity) },
      });
      expect(await createDatabase(runtime, winner.name, winner.key)).toEqual(
        firstResult,
      );
      await expectApiError(
        await jsonRequest(
          runtime,
          DATABASES_PATH,
          "POST",
          { name: "Capacity remains full after restart" },
          { "Idempotency-Key": retryKey("capacity-after-restart") },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "health reports the admitted policy revision and fails closed for invalid policy",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory);
      expect(
        await jsonResponse<{
          status: string;
          service: string;
          policyRevision: number;
        }>(await request(runtime, "/health"), 200),
      ).toEqual({
        status: "ready",
        service: "0000-database",
        policyRevision: 1,
      });

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        admissionBindings: { CAPACITY_MAX_DATABASES: "0" },
      });
      await expectApiError(
        await request(runtime, "/health"),
        503,
        "CAPACITY_UNAVAILABLE",
      );

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "2",
          CAPACITY_MAX_DAILY_REQUESTS: "2",
        },
      });
      await jsonResponse(await request(runtime, "/health"), 200);
      const exhausted = await expectApiError(
        await request(runtime, "/health"),
        429,
        "QUOTA_EXCEEDED",
      );
      expect(exhausted.error.details).toMatchObject({
        quota: "globalDailyRequests",
        limit: 2,
      });

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "3",
          CAPACITY_MAX_DAILY_REQUESTS: "2",
          SERVICE_SUSPENDED: "true",
        },
      });
      await expectApiError(
        await request(runtime, "/health"),
        503,
        "SERVICE_SUSPENDED",
      );
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "health fails closed for an invalid service clock returned by global admission",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      for (const mode of [
        "missingPhysicalBytesPerDatabase",
        "zeroPolicyRevision",
      ] as const) {
        await setInvalidRegistryServiceClock(runtime, mode);
        const failure = await expectApiError(
          await request(runtime, "/health"),
          503,
          "CAPACITY_UNAVAILABLE",
        );
        expect(failure.error.details).toMatchObject({
          reason: "invalidGlobalAdmissionState",
        });
      }
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "an expired database keeps global capacity reserved until physical cleanup completes",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_MAX_PHYSICAL_BYTES: String(128 * mebibyte),
          CAPACITY_MAX_PHYSICAL_BYTES_PER_DATABASE: String(128 * mebibyte),
        },
      });
      const database = await createDatabase(runtime, "Expires before cleanup");
      const expiresAt = Date.parse(database.lastActivityAt) + 7 * utcDayMs;
      await setTestClock(runtime, database.databaseId, expiresAt);

      const expiredRead = await request(
        runtime,
        databasePath(database.databaseId),
      );
      if (expiredRead.status !== 404) {
        throw new Error(
          `Expired database GET returned ${expiredRead.status}: ${await expiredRead
            .clone()
            .text()}`,
        );
      }
      await expectApiError(expiredRead, 404, "NOT_FOUND");
      const heldCapacity = await expectApiError(
        await jsonRequest(
          runtime,
          DATABASES_PATH,
          "POST",
          { name: "Waits for physical cleanup" },
          { "Idempotency-Key": retryKey("before-expiry-cleanup") },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );
      expect(heldCapacity.error.details).toMatchObject({
        quota: "globalPhysicalBytes",
      });

      await runDatabaseAlarm(runtime, database.databaseId);
      await runRegistryAlarm(runtime);

      const retiredStorage = await databaseStorageSnapshot(
        runtime,
        database.databaseId,
      );
      expect(retiredStorage.applicationTables).toEqual([]);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const repeatedExpiredRead = await request(
          runtime,
          databasePath(database.databaseId),
        );
        if (repeatedExpiredRead.status !== 404) {
          throw new Error(
            `Retired database GET returned ${repeatedExpiredRead.status}: ${await repeatedExpiredRead
              .clone()
              .text()}`,
          );
        }
        await expectApiError(repeatedExpiredRead, 404, "NOT_FOUND");
      }
      const afterRepeatedReads = await databaseStorageSnapshot(
        runtime,
        database.databaseId,
      );
      expect(afterRepeatedReads.applicationTables).toEqual([]);
      expect(afterRepeatedReads.databaseSize).toBe(retiredStorage.databaseSize);

      const replacement = await createDatabase(
        runtime,
        "Admitted after physical cleanup",
      );
      expect(replacement.databaseId).not.toBe(database.databaseId);
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "pending mutation and export reservations prevent retirement until reconciliation",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Pending retirement work");
      await createTable(runtime, database.databaseId, "Retained until settled");
      const lastActivityAt = await databaseLastActivityAt(
        runtime,
        database.databaseId,
      );
      expect(lastActivityAt).not.toBeNull();
      const inactivityDeadline = lastActivityAt! + 7 * utcDayMs;
      await setTestClock(runtime, database.databaseId, inactivityDeadline);
      await reservePendingMutation(
        runtime,
        database.databaseId,
        retryKey("pending-retirement-mutation"),
      );
      await reservePendingExport(
        runtime,
        database.databaseId,
        retryKey("pending-retirement-export"),
      );

      await runDatabaseAlarm(runtime, database.databaseId);
      expect(
        (await databaseStorageSnapshot(runtime, database.databaseId))
          .applicationTables,
      ).toContain("tables");

      await setTestClock(
        runtime,
        database.databaseId,
        inactivityDeadline + 6 * 60 * 1_000,
      );
      await runRegistryAlarm(runtime);
      expect(
        (await databaseStorageSnapshot(runtime, database.databaseId))
          .applicationTables,
      ).toContain("tables");

      await runRegistryAlarm(runtime);
      expect(
        (await databaseStorageSnapshot(runtime, database.databaseId))
          .applicationTables,
      ).toEqual([]);
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "service suspension pauses inactivity while the thirty-day write cutoff stays fixed",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Suspension clock");
      const createdAt = Date.parse(database.createdAt);
      const writeUntil = Date.parse(database.writeUntil);
      expect(writeUntil).toBe(createdAt + 30 * utcDayMs);

      const pauseAt = createdAt + 6 * utcDayMs;
      await setTestClock(runtime, database.databaseId, pauseAt);
      await createTable(runtime, database.databaseId, "Before suspension");
      const beforeSuspension = await getDatabase(runtime, database.databaseId);
      expect(beforeSuspension.lastActivityAt).toBe(
        new Date(pauseAt).toISOString(),
      );

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "2",
          SERVICE_SUSPENDED: "true",
        },
      });
      await expectApiError(
        await request(runtime, databasePath(database.databaseId)),
        503,
        "SERVICE_SUSPENDED",
      );

      const resumeAt = pauseAt + 20 * utcDayMs;
      await setTestClock(runtime, database.databaseId, resumeAt);
      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "1",
          SERVICE_SUSPENDED: "false",
        },
      });
      await expectApiError(
        await request(runtime, databasePath(database.databaseId)),
        503,
        "CAPACITY_UNAVAILABLE",
      );
      const staleRevision = await expectApiError(
        await request(runtime, databasePath(database.databaseId)),
        503,
        "CAPACITY_UNAVAILABLE",
      );
      expect(staleRevision.error.details).toMatchObject({
        reason: "staleCapacityPolicyRevision",
        currentRevision: 2,
      });

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "3",
          SERVICE_SUSPENDED: "false",
        },
      });
      const resumed = await getDatabase(runtime, database.databaseId);
      expect(resumed.databaseId).toBe(database.databaseId);
      expect(resumed.writeUntil).toBe(database.writeUntil);
      expect(resumed.state).toBe("writable");

      await setTestClock(runtime, database.databaseId, writeUntil);
      const atFixedCutoff = await getDatabase(runtime, database.databaseId);
      expect(atFixedCutoff.state).toBe("read_only");
      expect(atFixedCutoff.writeUntil).toBe(database.writeUntil);

      await expectApiError(
        await jsonRequest(
          runtime,
          tablesPath(database.databaseId),
          "POST",
          { name: "Too late after suspension" },
          { "Idempotency-Key": retryKey("suspension-write-cutoff") },
        ),
        409,
        "DATABASE_READ_ONLY",
      );
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "failed reads and successful mutation replays do not renew database inactivity",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Activity accounting");
      const table = await createTable(runtime, database.databaseId, "Items");
      const column = await createColumn(runtime, database.databaseId, table, {
        name: "Item",
        type: "string",
        nullable: false,
      });
      const itemKey = retryKey("activity-item");
      const item = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        { [column.id]: "Milk" },
        itemKey,
      );

      const afterWrite = await getDatabase(runtime, database.databaseId);
      let fakeNow = Date.parse(afterWrite.lastActivityAt) + 1_000;
      await setTestClock(runtime, database.databaseId, fakeNow);
      await jsonResponse<RecordResource>(
        await request(
          runtime,
          recordPath(database.databaseId, table.id, item.id),
        ),
        200,
      );
      const afterSuccessfulRead = await getDatabase(
        runtime,
        database.databaseId,
      );
      expect(afterSuccessfulRead.lastActivityAt).not.toBe(
        afterWrite.lastActivityAt,
      );

      fakeNow += 1_000;
      await setTestClock(runtime, database.databaseId, fakeNow);
      const beforeFailure = await getDatabase(runtime, database.databaseId);
      expect(beforeFailure.lastActivityAt).toBe(
        afterSuccessfulRead.lastActivityAt,
      );
      await expectApiError(
        await request(
          runtime,
          recordPath(database.databaseId, table.id, "missing-record"),
        ),
        404,
        "NOT_FOUND",
      );
      const afterFailure = await getDatabase(runtime, database.databaseId);
      expect(afterFailure.lastActivityAt).toBe(beforeFailure.lastActivityAt);

      fakeNow += 1_000;
      await setTestClock(runtime, database.databaseId, fakeNow);
      client = await connectMcp(runtime);
      const replay = await callMcp(client, "create_record", {
        databaseId: database.databaseId,
        tableId: table.id,
        values: { [column.id]: "Milk" },
        requestKey: itemKey,
      });
      expect(replay).toEqual(item);
      const afterReplay = await getDatabase(runtime, database.databaseId);
      expect(afterReplay.lastActivityAt).toBe(afterFailure.lastActivityAt);
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "data remains accessible one millisecond before seven-day inactivity expiry and expires at the boundary",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Inactivity cutoff");
      const table = await createTable(runtime, database.databaseId, "Entries");
      const column = await createColumn(runtime, database.databaseId, table, {
        name: "Value",
        type: "string",
        nullable: false,
      });
      const record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        { [column.id]: "Still available" },
      );
      const lastActivityAt = Date.parse(
        (await getDatabase(runtime, database.databaseId)).lastActivityAt,
      );

      const justBeforeExpiry = lastActivityAt + 7 * utcDayMs - 1;
      await setTestClock(runtime, database.databaseId, justBeforeExpiry);
      expect(
        await jsonResponse<RecordResource>(
          await request(
            runtime,
            recordPath(database.databaseId, table.id, record.id),
          ),
          200,
        ),
      ).toEqual(record);

      const refreshedLastActivityAt = Date.parse(
        (await getDatabase(runtime, database.databaseId)).lastActivityAt,
      );
      expect(refreshedLastActivityAt).toBe(justBeforeExpiry);
      await setTestClock(
        runtime,
        database.databaseId,
        refreshedLastActivityAt + 7 * utcDayMs,
      );
      await expectApiError(
        await request(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
        ),
        404,
        "NOT_FOUND",
      );
      await expectApiError(
        await request(runtime, databasePath(database.databaseId)),
        404,
        "NOT_FOUND",
      );
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "request and ordinary response byte caps are enforced in the Worker",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory);
      const baseBody = JSON.stringify({ name: "Exact request body limit" });
      const exactBody = `${baseBody}${" ".repeat(maxRequestBodyBytes - new TextEncoder().encode(baseBody).byteLength)}`;
      expect(new TextEncoder().encode(exactBody).byteLength).toBe(
        maxRequestBodyBytes,
      );
      const exactLimitResponse = await request(runtime, DATABASES_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": retryKey("exact-size-create"),
        },
        body: exactBody,
      });
      expect((await jsonResponse<Database>(exactLimitResponse, 201)).name).toBe(
        "Exact request body limit",
      );

      const oversizedBody = `${exactBody} `;
      expect(new TextEncoder().encode(oversizedBody).byteLength).toBe(
        maxRequestBodyBytes + 1,
      );
      const tooLarge = await runtime.dispatchFetch(
        new Request(new URL(DATABASES_PATH, BASE_URL), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": retryKey("oversized-create"),
          },
          body: oversizedBody,
        }),
      );
      await expectApiError(tooLarge, 413, "REQUEST_TOO_LARGE");

      const database = await createDatabase(runtime, "Response paging");
      const table = await createTable(
        runtime,
        database.databaseId,
        "Large rows",
      );
      const columns: Column[] = [];
      let currentTable = table;
      for (let index = 0; index < 6; index += 1) {
        columns.push(
          await createColumn(runtime, database.databaseId, currentTable, {
            name: `Value${index}`,
            type: "string",
            nullable: false,
          }),
        );
        currentTable = await getTable(
          runtime,
          database.databaseId,
          currentTable.id,
        );
      }

      for (let recordIndex = 0; recordIndex < 5; recordIndex += 1) {
        const values = Object.fromEntries(
          columns.map((column, columnIndex) => [
            column.id,
            `${recordIndex}-${columnIndex}-${"v".repeat(9_500)}`,
          ]),
        );
        await createRecord(
          runtime,
          database.databaseId,
          currentTable.id,
          values,
        );
      }

      const items: RecordResource[] = [];
      let cursor: string | null = null;
      let firstPage = true;
      let pageLimit = 1;
      do {
        const query = new URLSearchParams({ limit: String(pageLimit) });
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          runtime,
          `${recordsPath(database.databaseId, currentTable.id)}?${query}`,
        );
        expect(response.status).toBe(200);
        const rawBody = await response.clone().arrayBuffer();
        expect(rawBody.byteLength).toBeLessThanOrEqual(maxResponseBodyBytes);
        const page = (await response.json()) as Collection<RecordResource>;
        expect(page.items.length).toBeGreaterThan(0);
        if (firstPage) {
          expect(page.items).toHaveLength(1);
          expect(page.nextCursor).toEqual(expect.any(String));
          firstPage = false;
          pageLimit = 2;
        } else {
          pageLimit = 100;
        }
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);

      expect(items).toHaveLength(5);
      expect(new Set(items.map(({ id }) => id)).size).toBe(5);

      const mcpListResponseBytes: number[] = [];
      client = await connectMcp(runtime, async (mcpRequest, mcpResponse) => {
        const body = (await mcpRequest.clone().json()) as {
          method?: string;
          params?: { name?: string };
        };
        if (
          body.method === "tools/call" &&
          body.params?.name === "list_records"
        ) {
          mcpListResponseBytes.push(
            (await mcpResponse.arrayBuffer()).byteLength,
          );
        }
      });
      const mcpItems: RecordResource[] = [];
      let mcpCursor: string | null = null;
      let mcpLimit = 100;
      do {
        const page = (await callMcp(client, "list_records", {
          databaseId: database.databaseId,
          tableId: currentTable.id,
          limit: mcpLimit,
          ...(mcpCursor === null ? {} : { cursor: mcpCursor }),
        })) as unknown as Collection<RecordResource>;
        mcpItems.push(...page.items);
        mcpCursor = page.nextCursor;
        mcpLimit = 2;
      } while (mcpCursor !== null);

      expect(mcpItems.map(({ id }) => id).sort()).toEqual(
        items.map(({ id }) => id).sort(),
      );
      expect(mcpListResponseBytes.length).toBeGreaterThan(0);
      expect(
        mcpListResponseBytes.every((bytes) => bytes <= maxResponseBodyBytes),
      ).toBe(true);
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "a near-limit record is readable over REST and MCP while an over-limit update rolls back",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Record response budget");
      let table = await createTable(
        runtime,
        database.databaseId,
        "Large record",
      );
      const columns: Column[] = [];
      for (let index = 0; index < 27; index += 1) {
        columns.push(
          await createColumn(runtime, database.databaseId, table, {
            name: `Value${index}`,
            type: "string",
            nullable: true,
          }),
        );
        table = await getTable(runtime, database.databaseId, table.id);
      }

      let record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        {},
      );
      await setTestClock(runtime, database.databaseId, Date.now() + 61_001);
      for (let start = 0; start < 26; start += 5) {
        const values = Object.fromEntries(
          columns
            .slice(start, Math.min(start + 5, 26))
            .map((column) => [column.id, "x".repeat(9_700)]),
        );
        const updateResponse = await jsonRequest(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
          "PATCH",
          { values },
          {
            "Idempotency-Key": retryKey("record-near-response-limit"),
            "X-Expected-Version": record.version,
          },
        );
        if (updateResponse.status !== 200) {
          throw new Error(
            `near-limit update batch ${start} returned ${updateResponse.status}: ${JSON.stringify(await updateResponse.clone().json())}`,
          );
        }
        record = await jsonResponse<RecordResource>(updateResponse, 200);
      }

      const restRead = await request(
        runtime,
        recordPath(database.databaseId, table.id, record.id),
      );
      expect(restRead.status).toBe(200);
      const restBytes = await restRead.clone().arrayBuffer();
      expect(restBytes.byteLength).toBeLessThanOrEqual(
        maxMutationResponseBytes,
      );
      expect(restBytes.byteLength).toBeGreaterThan(240 * 1024);
      expect(await restRead.json()).toEqual(record);

      const mcpReadResponseBytes: number[] = [];
      client = await connectMcp(runtime, async (mcpRequest, mcpResponse) => {
        const body = (await mcpRequest.clone().json()) as {
          method?: string;
          params?: { name?: string };
        };
        if (
          body.method === "tools/call" &&
          body.params?.name === "get_record"
        ) {
          mcpReadResponseBytes.push(
            (await mcpResponse.arrayBuffer()).byteLength,
          );
        }
      });
      const mcpRead = await callMcp(client, "get_record", {
        databaseId: database.databaseId,
        tableId: table.id,
        recordId: record.id,
      });
      expect(mcpRead).toEqual(record);
      expect(mcpReadResponseBytes).toHaveLength(1);
      expect(mcpReadResponseBytes[0]).toBeLessThanOrEqual(maxResponseBodyBytes);

      const finalColumn = columns[26]!;
      const tooLargeWrite = await jsonRequest(
        runtime,
        recordPath(database.databaseId, table.id, record.id),
        "PATCH",
        { values: { [finalColumn.id]: "x".repeat(9_700) } },
        {
          "Idempotency-Key": retryKey("record-over-response-limit"),
          "X-Expected-Version": record.version,
        },
      );
      const tooLargeError = await expectApiError(
        tooLargeWrite,
        413,
        "RESULT_TOO_LARGE",
      );
      expect(tooLargeError.error.details.maxBytes).toBe(
        maxMutationResponseBytes,
      );

      const afterRejectedWrite = await jsonResponse<RecordResource>(
        await request(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
        ),
        200,
      );
      expect(afterRejectedWrite).toEqual(record);
      expect(
        await callMcp(client, "get_record", {
          databaseId: database.databaseId,
          tableId: table.id,
          recordId: record.id,
        }),
      ).toEqual(record);
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "an inactivity alarm does not retire a database after a queued read renews activity",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let alarm: Promise<void> | undefined;
    let barrierArmed = false;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Alarm read race");
      const table = await createTable(runtime, database.databaseId, "Entries");
      const column = await createColumn(runtime, database.databaseId, table, {
        name: "Value",
        type: "string",
        nullable: false,
      });
      const record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        { [column.id]: "still available" },
      );
      const inactivityDeadline = Date.now() + 5_000;
      const staleActivityAt = inactivityDeadline - 7 * utcDayMs;
      await setDatabaseLastActivityAt(
        runtime,
        database.databaseId,
        staleActivityAt,
      );
      await armRegistryServiceClockBarrier(runtime);
      barrierArmed = true;

      alarm = runDatabaseAlarm(runtime, database.databaseId);
      await waitForRegistryServiceClockBarrier(runtime);
      const read = request(
        runtime,
        `${recordsPath(database.databaseId, table.id)}?limit=10`,
      );
      const readResponseBeforeRelease = await Promise.race([
        read,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 250),
        ),
      ]);
      const readCommittedBeforeRelease =
        readResponseBeforeRelease !== undefined;
      if (readCommittedBeforeRelease) {
        if (readResponseBeforeRelease.status !== 200) {
          throw new Error(
            `Pre-release read returned ${readResponseBeforeRelease.status}: ${await readResponseBeforeRelease
              .clone()
              .text()}; now=${Date.now()}, deadline=${inactivityDeadline}, activity=${await databaseLastActivityAt(
              runtime,
              database.databaseId,
            )}, previous=${staleActivityAt}`,
          );
        }
        const activityAtRead = await databaseLastActivityAt(
          runtime,
          database.databaseId,
        );
        if (activityAtRead === null || activityAtRead <= staleActivityAt) {
          throw new Error(
            `A successful pre-release read did not renew activity: status=${readResponseBeforeRelease.status}, body=${await readResponseBeforeRelease
              .clone()
              .text()}, activity=${activityAtRead}, previous=${staleActivityAt}`,
          );
        }
        expect(activityAtRead).toBeLessThan(inactivityDeadline);
        // A concurrent read has already committed while the alarm holds its
        // old metadata snapshot. Advance time before releasing that snapshot.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, inactivityDeadline - Date.now() + 1)),
        );
      }

      // If fetch and alarm are serialized, the read is still queued. Releasing
      // at the pre-expiry instant lets the alarm reschedule before it commits.
      if (!readCommittedBeforeRelease)
        expect(Date.now()).toBeLessThan(inactivityDeadline);
      await releaseRegistryServiceClockBarrier(runtime);
      barrierArmed = false;
      await alarm;
      alarm = undefined;

      const rows = await jsonResponse<Collection<RecordResource>>(
        await read,
        200,
      );
      expect(rows.items).toEqual([record]);
      const renewedAt = await databaseLastActivityAt(
        runtime,
        database.databaseId,
      );
      expect(renewedAt).toBeGreaterThan(staleActivityAt);

      // At the database's original inactivity boundary, the committed read
      // is recent and the next alarm must keep the database serving.
      await runDatabaseAlarm(runtime, database.databaseId);
      expect(
        await jsonResponse<Database>(
          await request(runtime, databasePath(database.databaseId)),
          200,
        ),
      ).toMatchObject({ databaseId: database.databaseId });
    } finally {
      if (barrierArmed && runtime)
        await releaseRegistryServiceClockBarrier(runtime);
      await alarm?.catch(() => undefined);
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "the request burst boundary is sixty reads per database",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory);
      const firstDatabase = await createDatabase(runtime, "Request quota one");
      const secondDatabase = await createDatabase(runtime, "Request quota two");

      const firstSixty = await Promise.all(
        Array.from({ length: 60 }, () =>
          request(runtime!, databasePath(firstDatabase.databaseId)),
        ),
      );
      expect(firstSixty.map((response) => response.status)).toEqual(
        Array(60).fill(200),
      );

      await expectApiError(
        await request(runtime, databasePath(firstDatabase.databaseId)),
        429,
        "QUOTA_EXCEEDED",
      );
      expect(
        (await getDatabase(runtime, secondDatabase.databaseId)).databaseId,
      ).toBe(secondDatabase.databaseId);
      await expectApiError(
        await request(runtime, databasePath(firstDatabase.databaseId)),
        429,
        "QUOTA_EXCEEDED",
      );
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "the daily request limit is shared by REST and MCP and resets at UTC rollover",
  { timeout: 300_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Daily request quota");
      let fakeNow = nextUtcMidday(database.createdAt);
      await setTestClock(runtime, database.databaseId, fakeNow);
      client = await connectMcp(runtime);

      let requestsInMinute = 0;
      for (let index = 0; index < maxDailyRequests; index += 1) {
        if (requestsInMinute >= 59) {
          fakeNow += 61_001;
          await setTestClock(runtime, database.databaseId, fakeNow);
          requestsInMinute = 0;
        }

        if (index % 2 === 0) {
          await jsonResponse<Database>(
            await request(runtime, databasePath(database.databaseId)),
            200,
          );
        } else {
          const result = await callMcp(client, "get_database", {
            databaseId: database.databaseId,
          });
          expect(result.databaseId).toBe(database.databaseId);
        }
        requestsInMinute += 1;
      }

      const dailyLimitError = await expectApiError(
        await request(runtime, databasePath(database.databaseId)),
        429,
        "QUOTA_EXCEEDED",
      );
      expect(dailyLimitError.error.details).toMatchObject({
        quota: "requests",
        limit: maxDailyRequests,
      });

      fakeNow = nextUtcMidday(new Date(fakeNow).toISOString());
      await setTestClock(runtime, database.databaseId, fakeNow);
      expect(
        await callMcp(client, "get_database", {
          databaseId: database.databaseId,
        }),
      ).toMatchObject({ databaseId: database.databaseId });
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "the daily mutation boundary counts schema writes and is scoped to one database",
  { timeout: 200_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Daily mutation quota");
      const otherDatabase = await createDatabase(
        runtime,
        "Independent mutation quota",
      );
      let fakeNow = nextUtcMidday(database.createdAt);
      await setTestClock(runtime, database.databaseId, fakeNow);
      await setTestClock(runtime, otherDatabase.databaseId, fakeNow);
      const table = await createTable(runtime, database.databaseId, "Entries");
      const valueColumn = await createColumn(
        runtime,
        database.databaseId,
        table,
        {
          name: "Value",
          type: "number",
          nullable: true,
        },
      );

      for (let index = 0; index < 58; index += 1) {
        await createRecord(runtime, database.databaseId, table.id, {});
      }
      fakeNow += 61_001;
      await setTestClock(runtime, database.databaseId, fakeNow);
      await setTestClock(runtime, otherDatabase.databaseId, fakeNow);

      for (let index = 0; index < 40; index += 1) {
        await createRecord(runtime, database.databaseId, table.id, {});
      }
      await expectApiError(
        await jsonRequest(
          runtime,
          recordsPath(database.databaseId, table.id),
          "POST",
          { values: {} },
          { "Idempotency-Key": retryKey("over-daily-mutation-limit") },
        ),
        429,
        "QUOTA_EXCEEDED",
      );

      const records = await jsonResponse<Collection<RecordResource>>(
        await request(
          runtime,
          `${recordsPath(database.databaseId, table.id)}?limit=100`,
        ),
        200,
      );
      expect(records.items).toHaveLength(98);
      expect(
        records.items.every((record) => record.values[valueColumn.id] === null),
      ).toBe(true);

      const independentTable = await createTable(
        runtime,
        otherDatabase.databaseId,
        "Still writable",
      );
      expect(independentTable.name).toBe("Still writable");
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "the daily returned-byte limit is shared by REST and MCP and resets at UTC rollover",
  { timeout: 300_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Daily byte quota");
      let fakeNow = nextUtcMidday(database.createdAt);
      await setTestClock(runtime, database.databaseId, fakeNow);

      let table = await createTable(runtime, database.databaseId, "Large rows");
      const columns: Column[] = [];
      for (let index = 0; index < 26; index += 1) {
        columns.push(
          await createColumn(runtime, database.databaseId, table, {
            name: `Value${index}`,
            type: "string",
            nullable: true,
          }),
        );
        table = await getTable(runtime, database.databaseId, table.id);
      }

      let record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        {},
      );
      fakeNow += 61_001;
      await setTestClock(runtime, database.databaseId, fakeNow);
      for (let start = 0; start < columns.length; start += 5) {
        const values = Object.fromEntries(
          columns
            .slice(start, Math.min(start + 5, columns.length))
            .map((column) => [column.id, "x".repeat(9_700)]),
        );
        record = await jsonResponse<RecordResource>(
          await jsonRequest(
            runtime,
            recordPath(database.databaseId, table.id, record.id),
            "PATCH",
            { values },
            {
              "Idempotency-Key": retryKey("daily-returned-byte-fixture"),
              "X-Expected-Version": record.version,
            },
          ),
          200,
        );
      }

      const bytesPerRead = new TextEncoder().encode(
        JSON.stringify(record),
      ).byteLength;
      expect(bytesPerRead).toBeGreaterThan(240 * kibibyte);
      expect(bytesPerRead).toBeLessThanOrEqual(maxMutationResponseBytes);

      fakeNow = nextUtcMidday(new Date(fakeNow).toISOString());
      await setTestClock(runtime, database.databaseId, fakeNow);
      client = await connectMcp(runtime);

      const permittedReads = Math.floor(maxDailyReturnedBytes / bytesPerRead);
      expect(permittedReads).toBeGreaterThan(100);
      let requestsInMinute = 0;
      for (let index = 0; index < permittedReads; index += 1) {
        if (requestsInMinute >= 59) {
          fakeNow += 61_001;
          await setTestClock(runtime, database.databaseId, fakeNow);
          requestsInMinute = 0;
        }

        if (index % 2 === 0) {
          expect(
            await jsonResponse<RecordResource>(
              await request(
                runtime,
                recordPath(database.databaseId, table.id, record.id),
              ),
              200,
            ),
          ).toEqual(record);
        } else {
          expect(
            await callMcp(client, "get_record", {
              databaseId: database.databaseId,
              tableId: table.id,
              recordId: record.id,
            }),
          ).toEqual(record);
        }
        requestsInMinute += 1;
      }

      if (requestsInMinute >= 59) {
        fakeNow += 61_001;
        await setTestClock(runtime, database.databaseId, fakeNow);
        requestsInMinute = 0;
      }
      const byteLimitError = await expectApiError(
        await request(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
        ),
        429,
        "QUOTA_EXCEEDED",
      );
      expect(byteLimitError.error.details).toMatchObject({
        quota: "returnedBytes",
        limitBytes: maxDailyReturnedBytes,
      });

      fakeNow = nextUtcMidday(new Date(fakeNow).toISOString());
      await setTestClock(runtime, database.databaseId, fakeNow);
      expect(
        await callMcp(client, "get_record", {
          databaseId: database.databaseId,
          tableId: table.id,
          recordId: record.id,
        }),
      ).toEqual(record);
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "the exact thirty-day write cutoff keeps reads available and rejects schema and record writes",
  { timeout: 60_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Write cutoff");
      const table = await createTable(runtime, database.databaseId, "Entries");
      const column = await createColumn(runtime, database.databaseId, table, {
        name: "Value",
        type: "string",
        nullable: false,
      });
      const record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        { [column.id]: "before cutoff" },
      );

      const createdAt = Date.parse(database.createdAt);
      const writeUntil = Date.parse(database.writeUntil);
      expect(writeUntil).toBe(createdAt + 30 * utcDayMs);
      for (const elapsedDays of [6, 12, 18, 24]) {
        await setTestClock(
          runtime,
          database.databaseId,
          createdAt + elapsedDays * utcDayMs,
        );
        expect(
          await jsonResponse<RecordResource>(
            await request(
              runtime,
              recordPath(database.databaseId, table.id, record.id),
            ),
            200,
          ),
        ).toEqual(record);
      }

      await setTestClock(runtime, database.databaseId, writeUntil);
      const readOnly = await getDatabase(runtime, database.databaseId);
      expect(readOnly.state).toBe("read_only");
      expect(readOnly.writeUntil).toBe(database.writeUntil);
      expect(
        await jsonResponse<RecordResource>(
          await request(
            runtime,
            recordPath(database.databaseId, table.id, record.id),
          ),
          200,
        ),
      ).toEqual(record);

      const tableWrite = await jsonRequest(
        runtime,
        tablesPath(database.databaseId),
        "POST",
        { name: "Too late" },
        { "Idempotency-Key": retryKey("table-after-cutoff") },
      );
      await expectApiError(tableWrite, 409, "DATABASE_READ_ONLY");

      const latestTable = await getTable(
        runtime,
        database.databaseId,
        table.id,
      );
      const columnWrite = await jsonRequest(
        runtime,
        columnsPath(database.databaseId, table.id),
        "POST",
        { name: "Too late", type: "string", nullable: true },
        {
          "Idempotency-Key": retryKey("column-after-cutoff"),
          "X-Expected-Schema-Version": latestTable.schemaVersion,
        },
      );
      await expectApiError(columnWrite, 409, "DATABASE_READ_ONLY");

      const recordWrite = await jsonRequest(
        runtime,
        recordPath(database.databaseId, table.id, record.id),
        "PATCH",
        { values: { [column.id]: "too late" } },
        {
          "Idempotency-Key": retryKey("record-after-cutoff"),
          "X-Expected-Version": record.version,
        },
      );
      await expectApiError(recordWrite, 409, "DATABASE_READ_ONLY");
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "the ten-megabyte logical storage limit rejects the first over-limit record",
  { timeout: 240_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Storage quota");
      let fakeNow = nextUtcMidday(database.createdAt);
      await setTestClock(runtime, database.databaseId, fakeNow);

      let table = await createTable(runtime, database.databaseId, "Large rows");
      const columns: Column[] = [];
      for (let index = 0; index < 6; index += 1) {
        columns.push(
          await createColumn(runtime, database.databaseId, table, {
            name: `Value${index}`,
            type: "string",
            nullable: false,
          }),
        );
        table = await getTable(runtime, database.databaseId, table.id);
      }

      let requestsInMinute = 13;
      const successfulRecordIds: string[] = [];
      const createLargeRecord = async (
        index: number,
        key: string,
      ): Promise<Response> => {
        if (requestsInMinute >= 60) {
          fakeNow += 61_001;
          await setTestClock(runtime!, database.databaseId, fakeNow);
          requestsInMinute = 0;
        }
        requestsInMinute += 1;
        const values = Object.fromEntries(
          columns.map((column, columnIndex) => [
            column.id,
            `${index}-${columnIndex}-${"x".repeat(9_800)}`,
          ]),
        );
        return await jsonRequest(
          runtime!,
          recordsPath(database.databaseId, table.id),
          "POST",
          { values },
          { "Idempotency-Key": key },
        );
      };

      for (let index = 0; index < 93; index += 1) {
        const created = await jsonResponse<RecordResource>(
          await createLargeRecord(index, retryKey("storage-first-day")),
          201,
        );
        successfulRecordIds.push(created.id);
      }

      fakeNow = nextUtcMidday(new Date(fakeNow).toISOString());
      await setTestClock(runtime, database.databaseId, fakeNow);
      requestsInMinute = 0;

      let storageFailure: ApiError | undefined;
      let failedIndex = -1;
      let failedKey = "";
      for (let index = 0; index < 100; index += 1) {
        const key = retryKey("storage-second-day");
        const response = await createLargeRecord(index + 93, key);
        if (response.status === 201) {
          successfulRecordIds.push(
            (await jsonResponse<RecordResource>(response, 201)).id,
          );
          continue;
        }
        storageFailure = await expectApiError(response, 429, "QUOTA_EXCEEDED");
        failedIndex = index;
        failedKey = key;
        break;
      }

      expect(storageFailure).toBeDefined();
      expect(storageFailure!.error.details).toMatchObject({
        quota: "storageBytes",
        limitBytes: maxStorageBytes,
      });
      expect(storageFailure!.error.details.usedBytes).toEqual(
        expect.any(Number),
      );
      expect(storageFailure!.error.details.usedBytes).toBeGreaterThan(
        maxStorageBytes,
      );
      expect(failedIndex).toBeGreaterThan(0);

      fakeNow += 61_001;
      await setTestClock(runtime, database.databaseId, fakeNow);
      const values = Object.fromEntries(
        columns.map((column, columnIndex) => [
          column.id,
          `${failedIndex + 93}-${columnIndex}-${"x".repeat(9_800)}`,
        ]),
      );
      const retry = await jsonRequest(
        runtime,
        recordsPath(database.databaseId, table.id),
        "POST",
        { values },
        { "Idempotency-Key": failedKey },
      );
      const retryError = await expectApiError(retry, 429, "QUOTA_EXCEEDED");
      expect(retryError.error.details).toMatchObject({
        quota: "storageBytes",
        limitBytes: maxStorageBytes,
      });

      const listedIds: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          runtime,
          `${recordsPath(database.databaseId, table.id)}?${query}`,
        );
        expect(response.status).toBe(200);
        expect(
          (await response.clone().arrayBuffer()).byteLength,
        ).toBeLessThanOrEqual(maxResponseBodyBytes);
        const page = (await response.json()) as Collection<RecordResource>;
        expect(page.items.length).toBeGreaterThan(0);
        listedIds.push(...page.items.map(({ id }) => id));
        cursor = page.nextCursor;
      } while (cursor !== null);

      expect(listedIds).toHaveLength(successfulRecordIds.length);
      expect(listedIds.sort()).toEqual(successfulRecordIds.sort());
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "REST and MCP read the same immutable bounded export across source changes, restart, and expiry",
  { timeout: 300_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    let client: Client | undefined;
    const mcpResponseBytes: number[] = [];
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Immutable export");
      let fakeNow = Date.parse(database.createdAt) + 1;
      await setTestClock(runtime, database.databaseId, fakeNow);

      let table = await createTable(
        runtime,
        database.databaseId,
        "Export rows",
      );
      const columns: Column[] = [];
      for (let index = 0; index < 64; index += 1) {
        if (index > 0 && index % 25 === 0) {
          fakeNow += 61_001;
          await setTestClock(runtime, database.databaseId, fakeNow);
        }
        columns.push(
          await createColumn(runtime, database.databaseId, table, {
            name: `Value${index}`,
            type: "string",
            nullable: true,
          }),
        );
        table = await getTable(runtime, database.databaseId, table.id);
      }

      let record = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        {},
      );
      const unicodeColumn = columns[0]!;
      const unicodeValue = `${'雪🙂"\\\n'.repeat(160)}${"u".repeat(2_500)}`;
      const patchCount = Math.ceil(columns.length / 5);
      const finalVersion = String(Number(record.version) + patchCount);
      const targetRecordBytes = maxMutationResponseBytes - 100;
      const candidateValues = (asciiLength: number) =>
        Object.fromEntries(
          columns.map((column, index) => [
            column.id,
            index === 0 ? unicodeValue : "x".repeat(asciiLength),
          ]),
        );
      let low = 0;
      let high = 5_000;
      let asciiLength = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = {
          id: record.id,
          values: candidateValues(middle),
          version: finalVersion,
        };
        const bytes = new TextEncoder().encode(
          JSON.stringify(candidate),
        ).byteLength;
        if (bytes <= targetRecordBytes) {
          asciiLength = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      const desiredValues = candidateValues(asciiLength);
      const expectedRecordBytes = new TextEncoder().encode(
        JSON.stringify({
          id: record.id,
          values: desiredValues,
          version: finalVersion,
        }),
      ).byteLength;
      expect(expectedRecordBytes).toBeGreaterThan(targetRecordBytes - 100);
      expect(expectedRecordBytes).toBeLessThanOrEqual(targetRecordBytes);

      for (let start = 0; start < columns.length; start += 5) {
        const values = Object.fromEntries(
          columns
            .slice(start, start + 5)
            .map((column) => [column.id, desiredValues[column.id]]),
        );
        const update = await jsonRequest(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
          "PATCH",
          { values },
          {
            "Idempotency-Key": retryKey("near-limit-export-value"),
            "X-Expected-Version": record.version,
          },
        );
        if (update.status !== 200)
          throw new Error(
            `Near-limit export source update returned ${update.status}: ${await update
              .clone()
              .text()}`,
          );
        record = await jsonResponse<RecordResource>(update, 200);
      }
      expect(record.version).toBe(finalVersion);
      expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBe(
        expectedRecordBytes,
      );

      const startKey = retryKey("immutable-export-start");
      const exportPath = `${databasePath(database.databaseId)}/exports`;
      const manifest = await jsonResponse<ExportManifest>(
        await jsonRequest(
          runtime,
          exportPath,
          "POST",
          {},
          { "Idempotency-Key": startKey },
        ),
        201,
      );
      expect(manifest.formatVersion).toBe(1);
      expect(Date.parse(manifest.expiresAt)).toBe(
        Date.parse(manifest.snapshotAt) + utcDayMs,
      );

      client = await connectMcp(runtime, async (_mcpRequest, response) => {
        mcpResponseBytes.push((await response.arrayBuffer()).byteLength);
      });
      expect(
        await callMcp(client, "start_export", {
          databaseId: database.databaseId,
          requestKey: startKey,
        }),
      ).toEqual(manifest);
      await callMcp(client, "start_export", {
        databaseId: database.databaseId,
        requestKey: retryKey("immutable-export-second"),
      });
      await callMcp(client, "start_export", {
        databaseId: database.databaseId,
        requestKey: retryKey("immutable-export-third"),
      });
      const fullRetentionError = await expectApiError(
        await jsonRequest(
          runtime,
          exportPath,
          "POST",
          {},
          { "Idempotency-Key": retryKey("immutable-export-fourth") },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );
      expect(fullRetentionError.error.details).toMatchObject({
        quota: "exportsPerDatabase",
        limit: 3,
      });

      const restPages: ExportPage[] = [];
      let restCursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (restCursor !== null) query.set("cursor", restCursor);
        const response = await request(
          runtime,
          `${exportPath}/${manifest.exportId}?${query}`,
        );
        expect(response.status).toBe(200);
        expect(
          (await response.clone().arrayBuffer()).byteLength,
        ).toBeLessThanOrEqual(maxResponseBodyBytes);
        const page = (await response.json()) as ExportPage;
        expect(page.exportId).toBe(manifest.exportId);
        restPages.push(page);
        restCursor = page.nextCursor;
      } while (restCursor !== null);

      const restItems = normalizeExportItems(restPages);
      expect(restItems[0]?.type).toBe("database");
      expect(Object.keys(restItems[0] ?? {})).not.toContain("databaseUrl");
      expect(Object.keys(restItems[0] ?? {})).not.toContain("accessWarning");
      const restRecord = restItems.find(
        (item) => item.type === "record" && item.id === record.id,
      );
      expect(restRecord?.values).toEqual(record.values);
      const restColumn = restItems.find(
        (item) => item.type === "column" && item.id === unicodeColumn.id,
      );
      expect(restColumn).toMatchObject({
        type: "column",
        columnType: "string",
        nullable: true,
      });

      const changedRecord = await jsonResponse<RecordResource>(
        await jsonRequest(
          runtime,
          recordPath(database.databaseId, table.id, record.id),
          "PATCH",
          { values: { [unicodeColumn.id]: "source changed after snapshot" } },
          {
            "Idempotency-Key": retryKey("change-export-source"),
            "X-Expected-Version": record.version,
          },
        ),
        200,
      );
      expect(changedRecord.version).not.toBe(record.version);
      expect(changedRecord.values[unicodeColumn.id]).toBe(
        "source changed after snapshot",
      );

      await client.close();
      client = undefined;
      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const justBeforeExpiry = Date.parse(manifest.expiresAt) - 1;
      await setTestClock(runtime, database.databaseId, justBeforeExpiry);
      client = await connectMcp(runtime, async (_mcpRequest, response) => {
        mcpResponseBytes.push((await response.arrayBuffer()).byteLength);
      });

      const mcpPages: ExportPage[] = [];
      let mcpCursor: string | null = null;
      do {
        const page = await callMcp(client, "read_export", {
          databaseId: database.databaseId,
          exportId: manifest.exportId,
          limit: 100,
          ...(mcpCursor === null ? {} : { cursor: mcpCursor }),
        });
        mcpPages.push(page as unknown as ExportPage);
        mcpCursor =
          typeof page.nextCursor === "string" ? page.nextCursor : null;
      } while (mcpCursor !== null);

      const mcpItems = normalizeExportItems(mcpPages);
      expect(mcpItems).toEqual(restItems);
      expect(
        mcpPages.some((page) =>
          page.items.some((item) => typeof item.chunk === "object"),
        ),
      ).toBe(true);
      expect(
        mcpItems.find((item) => item.type === "record" && item.id === record.id)
          ?.values,
      ).toEqual(record.values);
      expect(mcpResponseBytes.length).toBeGreaterThan(0);
      expect(Math.max(...mcpResponseBytes)).toBeLessThanOrEqual(
        maxResponseBodyBytes,
      );

      await setTestClock(
        runtime,
        database.databaseId,
        Date.parse(manifest.expiresAt),
      );
      await expectApiError(
        await request(runtime, `${exportPath}/${manifest.exportId}?limit=1`),
        410,
        "EXPORT_EXPIRED",
      );
      const afterExpiry = await callMcp(client, "start_export", {
        databaseId: database.databaseId,
        requestKey: retryKey("export-slot-after-expiry"),
      });
      expect(afterExpiry.exportId).not.toBe(manifest.exportId);
    } finally {
      await client?.close();
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "export recovery settles a committed snapshot after the global export cap is lowered",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    const exportKey = retryKey("export-recovery-after-policy-shrink");
    try {
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_MAX_EXPORT_BYTES: String(128 * mebibyte),
        },
      });
      const database = await createDatabase(runtime, "Export recovery");
      const exportPath = `${databasePath(database.databaseId)}/exports`;
      const beforeReservation = Date.now() + 1_000;
      await setTestClock(runtime, database.databaseId, beforeReservation);
      await failNextRegistryExportCompletion(runtime);
      await expectApiError(
        await jsonRequest(
          runtime,
          exportPath,
          "POST",
          {},
          { "Idempotency-Key": exportKey },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "2",
          CAPACITY_MAX_EXPORT_BYTES: String(EXPORT_MAX_SNAPSHOT_BYTES),
        },
      });
      await setTestClock(
        runtime,
        database.databaseId,
        beforeReservation + 6 * 60 * 1_000,
      );
      await runRegistryAlarm(runtime);

      const manifest = await jsonResponse<ExportManifest>(
        await jsonRequest(
          runtime,
          exportPath,
          "POST",
          {},
          { "Idempotency-Key": exportKey },
        ),
        201,
      );
      const page = await jsonResponse<ExportPage>(
        await request(runtime, `${exportPath}/${manifest.exportId}?limit=100`),
        200,
      );
      expect(page.items[0]?.type).toBe("database");

      const additionalExport = await expectApiError(
        await jsonRequest(
          runtime,
          exportPath,
          "POST",
          {},
          { "Idempotency-Key": retryKey("export-recovery-cap-shrunk") },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );
      expect(additionalExport.error.details).toMatchObject({
        quota: "globalExportBytes",
      });
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "expired export capacity stays charged until the Object confirms snapshot cleanup",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    try {
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_MAX_EXPORT_BYTES: String(EXPORT_MAX_SNAPSHOT_BYTES),
        },
      });
      const expiredDatabase = await createDatabase(
        runtime,
        "Export held until cleanup",
      );
      const replacementDatabase = await createDatabase(
        runtime,
        "Export waits for cleanup",
      );
      const exportPath = `${databasePath(expiredDatabase.databaseId)}/exports`;
      const replacementExportPath = `${databasePath(replacementDatabase.databaseId)}/exports`;
      const expiredManifest = await jsonResponse<ExportManifest>(
        await jsonRequest(
          runtime,
          exportPath,
          "POST",
          {},
          { "Idempotency-Key": retryKey("export-expiry-held") },
        ),
        201,
      );
      const expiry = Date.parse(expiredManifest.expiresAt);
      await setTestClock(runtime, expiredDatabase.databaseId, expiry);
      await setTestClock(runtime, replacementDatabase.databaseId, expiry);
      await failNextDatabaseExportReconciliation(
        runtime,
        expiredDatabase.databaseId,
      );

      await runRegistryAlarm(runtime);
      const stillCharged = await expectApiError(
        await jsonRequest(
          runtime,
          replacementExportPath,
          "POST",
          {},
          { "Idempotency-Key": retryKey("export-expiry-still-charged") },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );
      expect(stillCharged.error.details).toMatchObject({
        quota: "globalExportBytes",
      });

      await runRegistryAlarm(runtime);
      const afterCleanup = await jsonResponse<ExportManifest>(
        await jsonRequest(
          runtime,
          replacementExportPath,
          "POST",
          {},
          { "Idempotency-Key": retryKey("export-expiry-capacity-released") },
        ),
        201,
      );
      expect(afterCleanup.exportId).not.toBe(expiredManifest.exportId);
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);

test.serial(
  "a per-database physical-cap rejection leaves the record and replay key available",
  { timeout: 120_000 },
  async () => {
    const persistenceDirectory = await createPersistenceDirectory();
    let runtime: Miniflare | undefined;
    const updateKey = retryKey("physical-cap-rollback");
    const expandedValue = "x".repeat(9_000);
    try {
      runtime = await startRuntime(persistenceDirectory, { testClock: true });
      const database = await createDatabase(runtime, "Physical cap rollback");
      const table = await createTable(runtime, database.databaseId, "Rows");
      const column = await createColumn(runtime, database.databaseId, table, {
        name: "Value",
        type: "string",
        nullable: false,
      });
      const original = await createRecord(
        runtime,
        database.databaseId,
        table.id,
        { [column.id]: "unchanged" },
      );
      const baseline = await databaseStorageSnapshot(
        runtime,
        database.databaseId,
      );
      const physicalCap = baseline.databaseSize + 4 * kibibyte;
      const updatePath = recordPath(database.databaseId, table.id, original.id);
      expect(
        new TextEncoder().encode(
          JSON.stringify({ values: { [column.id]: expandedValue } }),
        ).byteLength,
      ).toBeLessThan(maxRequestBodyBytes);

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "2",
          CAPACITY_MAX_PHYSICAL_BYTES_PER_DATABASE: String(physicalCap),
        },
      });
      const physicalError = await expectApiError(
        await jsonRequest(
          runtime,
          updatePath,
          "PATCH",
          { values: { [column.id]: expandedValue } },
          {
            "Idempotency-Key": updateKey,
            "X-Expected-Version": original.version,
          },
        ),
        503,
        "CAPACITY_UNAVAILABLE",
      );
      expect(physicalError.error.details).toMatchObject({
        quota: "physicalBytesPerDatabase",
        maxBytes: physicalCap,
      });
      expect(physicalError.error.details.usedBytes).toEqual(expect.any(Number));
      const afterRejection = await databaseStorageSnapshot(
        runtime,
        database.databaseId,
      );
      expect(afterRejection.databaseSize).toBeLessThanOrEqual(physicalCap);

      const unchanged = await jsonResponse<RecordResource>(
        await request(runtime, updatePath),
        200,
      );
      expect(unchanged).toEqual(original);

      await runtime.dispose();
      runtime = await startRuntime(persistenceDirectory, {
        testClock: true,
        admissionBindings: {
          CAPACITY_POLICY_REVISION: "3",
          CAPACITY_MAX_PHYSICAL_BYTES:
            testAdmissionBindings.CAPACITY_MAX_PHYSICAL_BYTES,
          CAPACITY_MAX_PHYSICAL_BYTES_PER_DATABASE:
            testAdmissionBindings.CAPACITY_MAX_PHYSICAL_BYTES_PER_DATABASE,
        },
      });
      const updated = await jsonResponse<RecordResource>(
        await jsonRequest(
          runtime,
          updatePath,
          "PATCH",
          { values: { [column.id]: expandedValue } },
          {
            "Idempotency-Key": updateKey,
            "X-Expected-Version": original.version,
          },
        ),
        200,
      );
      expect(updated.version).toBe(String(Number(original.version) + 1));
      expect(updated.values[column.id]).toBe(expandedValue);
      expect(
        await jsonResponse<RecordResource>(
          await jsonRequest(
            runtime,
            updatePath,
            "PATCH",
            { values: { [column.id]: expandedValue } },
            {
              "Idempotency-Key": updateKey,
              "X-Expected-Version": original.version,
            },
          ),
          200,
        ),
      ).toEqual(updated);
    } finally {
      await disposeRuntime(runtime);
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
  },
);
