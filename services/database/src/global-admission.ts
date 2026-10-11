import type { DatabaseBindings, DurableCallOutcome } from "./database-object";

export const REGISTRY_ID = "database-create-registry-v1";

// The first database JSON resource includes the caller's name/description and
// escaped JSON text. Reserve enough for their validated maxima before creating
// the Durable Object's SQLite state.
export const CREATE_LOGICAL_RESERVATION_BYTES = 16 * 1024;
export const MUTATION_LOGICAL_RESERVATION_BYTES = 512 * 1024;
export const MUTATION_REPLAY_RESERVATION_BYTES = 260 * 1024;

export type AdmissionKind = "http" | "mcp_tool";

export type ServiceClock = {
  suspended: boolean;
  pausedTotalMs: number;
  suspendedSince: number | null;
  policyRevision: number;
  maxPhysicalBytesPerDatabase: number;
};

export type DatabaseUsage = {
  logicalBytes: number;
  replayBytes: number;
  physicalBytes: number;
  version: number;
};

export type AdmissionReservation = {
  databaseId: string;
  operationKey: string;
  operationFingerprint: string;
  logicalBytes: number;
  replayBytes: number;
};

export type ExportReservation = {
  databaseId: string;
  exportKey: string;
  exportId: string;
  snapshotBytes: number;
  expiresAt: number;
};

export interface GlobalAdmissionStub {
  admitRequest(
    kind: AdmissionKind,
    requestId: string,
  ): Promise<DurableCallOutcome<ServiceClock>>;
  getServiceClock(): Promise<DurableCallOutcome<ServiceClock>>;
  isDatabaseServing(databaseId: string): Promise<DurableCallOutcome<boolean>>;
  isDatabaseRetiring(databaseId: string): Promise<DurableCallOutcome<boolean>>;
  reserveDatabase(input: {
    databaseId: string;
    creationKeyDigest: string;
    leaseToken: string;
  }): Promise<DurableCallOutcome<ServiceClock>>;
  completeDatabase(
    databaseId: string,
    usage: DatabaseUsage,
    leaseToken: string,
  ): Promise<DurableCallOutcome<void>>;
  getDatabaseUsage(
    databaseId: string,
  ): Promise<DurableCallOutcome<DatabaseUsage>>;
  reportDatabaseUsage(
    databaseId: string,
    usage: DatabaseUsage,
  ): Promise<DurableCallOutcome<void>>;
  authorizeDatabaseCreation(input: {
    databaseId: string;
    creationKeyDigest: string;
    leaseToken: string;
  }): Promise<DurableCallOutcome<ServiceClock & { mayInitialize: boolean }>>;
  reserveMutation(
    reservation: AdmissionReservation,
  ): Promise<DurableCallOutcome<void>>;
  settleMutation(
    databaseId: string,
    operationKey: string,
    usage: DatabaseUsage,
  ): Promise<DurableCallOutcome<void>>;
  releaseMutation(
    databaseId: string,
    operationKey: string,
  ): Promise<DurableCallOutcome<void>>;
  reconcileMutation(
    databaseId: string,
    operationKey: string,
  ): Promise<DurableCallOutcome<{ committed: boolean; usage?: DatabaseUsage }>>;
  reserveExport(
    reservation: ExportReservation,
  ): Promise<
    DurableCallOutcome<{ exportId: string; state: "pending" | "active" }>
  >;
  completeExport(input: {
    databaseId: string;
    exportKey: string;
    exportId: string;
    snapshotBytes: number;
    expiresAt: number;
  }): Promise<DurableCallOutcome<void>>;
  activateExport(
    databaseId: string,
    exportKey: string,
  ): Promise<DurableCallOutcome<void>>;
  releaseExport(
    databaseId: string,
    exportKey: string,
  ): Promise<DurableCallOutcome<void>>;
  reconcileExport(
    databaseId: string,
    exportKey: string,
  ): Promise<DurableCallOutcome<"active" | "missing" | "pending">>;
  retireDatabase(databaseId: string): Promise<DurableCallOutcome<boolean>>;
  completeRetirement(databaseId: string): Promise<DurableCallOutcome<void>>;
}

export function getGlobalAdmission(env: DatabaseBindings): GlobalAdmissionStub {
  const id = env.REGISTRY.idFromName(REGISTRY_ID);
  return env.REGISTRY.get(id) as unknown as GlobalAdmissionStub;
}
