import type { ProfileGrantStore } from "./access";

export interface D1Result<Row> {
  readonly results: readonly Row[];
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
  run(): Promise<{ readonly meta: { readonly changes: number } }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1Statement;
  batch<Row = Record<string, unknown>>(
    statements: D1Statement[],
  ): Promise<readonly D1Result<Row>[]>;
  withSession(constraint?: "first-primary" | "first-unconstrained"): {
    prepare(sql: string): D1Statement;
    batch<Row = Record<string, unknown>>(
      statements: D1Statement[],
    ): Promise<readonly D1Result<Row>[]>;
  };
}

export class GatewayProfileNotFoundError extends Error {
  constructor(organizationId: string, profileId: string) {
    super(`Gateway profile ${organizationId}/${profileId} does not exist.`);
    this.name = "GatewayProfileNotFoundError";
  }
}

export class GatewayProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayProfileInputError";
  }
}

export interface ProfileGrantAdmin extends ProfileGrantStore {
  createProfile(organizationId: string, profileId: string): Promise<boolean>;
  setGrantedOperationIds(
    organizationId: string,
    profileId: string,
    operationIds: readonly string[],
  ): Promise<void>;
  revokeGrantedOperationId(
    organizationId: string,
    profileId: string,
    operationId: string,
  ): Promise<boolean>;
}

/** D1-backed organization/profile records and explicit operation grants. */
export class D1ProfileGrantStore implements ProfileGrantAdmin {
  readonly #database: D1DatabaseLike;
  readonly #knownOperationIds: ReadonlySet<string>;
  readonly #knownOperationIdsProvider:
    | (() => Promise<Iterable<string>>)
    | undefined;

  constructor(
    database: D1DatabaseLike,
    knownOperationIds: Iterable<string>,
    knownOperationIdsProvider?: () => Promise<Iterable<string>>,
  ) {
    this.#database = database;
    this.#knownOperationIds = new Set(knownOperationIds);
    this.#knownOperationIdsProvider = knownOperationIdsProvider;
  }

  /** Returns null for a missing profile and [] for a profile without grants. */
  async getGrantedOperationIds(
    organizationId: string,
    profileId: string,
  ): Promise<readonly string[] | null> {
    requireScope(organizationId, profileId);
    const session = this.#database.withSession("first-primary");
    const [profiles, grants] = await session.batch<{
      profile_id?: string;
      operation_id?: string;
    }>([
      session
        .prepare(
          `SELECT profile_id
           FROM gateway_profiles
           WHERE organization_id = ? AND profile_id = ?`,
        )
        .bind(organizationId, profileId),
      session
        .prepare(
          `SELECT operation_id
           FROM gateway_profile_tool_grants
           WHERE organization_id = ? AND profile_id = ?
           ORDER BY operation_id`,
        )
        .bind(organizationId, profileId),
    ]);
    if (profiles?.results.length !== 1) return null;
    return (grants?.results ?? []).flatMap((row) =>
      typeof row.operation_id === "string" ? [row.operation_id] : [],
    );
  }

  async createProfile(
    organizationId: string,
    profileId: string,
  ): Promise<boolean> {
    requireScope(organizationId, profileId);
    const result = await this.#database
      .prepare(
        `INSERT INTO gateway_profiles (organization_id, profile_id)
         VALUES (?, ?)
         ON CONFLICT (organization_id, profile_id) DO NOTHING`,
      )
      .bind(organizationId, profileId)
      .run();
    return result.meta.changes === 1;
  }

  async setGrantedOperationIds(
    organizationId: string,
    profileId: string,
    operationIds: readonly string[],
  ): Promise<void> {
    requireScope(organizationId, profileId);
    const uniqueIds = new Set(operationIds);
    if (uniqueIds.size !== operationIds.length) {
      throw new GatewayProfileInputError(
        "Gateway operation grants must not contain duplicates.",
      );
    }
    let knownOperationIds = this.#knownOperationIds;
    if (this.#knownOperationIdsProvider) {
      try {
        knownOperationIds = new Set([
          ...knownOperationIds,
          ...(await this.#knownOperationIdsProvider()),
        ]);
      } catch {
        throw new GatewayProfileInputError(
          "Gateway operation catalog is unavailable.",
        );
      }
    }
    for (const operationId of uniqueIds) {
      if (!isNonEmpty(operationId) || !knownOperationIds.has(operationId)) {
        throw new GatewayProfileInputError(
          "Gateway operation is not in the current catalog.",
        );
      }
    }
    await this.#requireProfile(organizationId, profileId);
    const statements = [
      this.#database
        .prepare(
          `DELETE FROM gateway_profile_tool_grants
           WHERE organization_id = ? AND profile_id = ?`,
        )
        .bind(organizationId, profileId),
      ...[...uniqueIds].map((operationId) =>
        this.#database
          .prepare(
            `INSERT INTO gateway_profile_tool_grants
               (organization_id, profile_id, operation_id)
             VALUES (?, ?, ?)`,
          )
          .bind(organizationId, profileId, operationId),
      ),
    ];
    await this.#database.batch(statements);
  }

  async revokeGrantedOperationId(
    organizationId: string,
    profileId: string,
    operationId: string,
  ): Promise<boolean> {
    requireScope(organizationId, profileId);
    if (!isNonEmpty(operationId)) {
      throw new GatewayProfileInputError("Gateway operation ID is required.");
    }
    await this.#requireProfile(organizationId, profileId);
    const result = await this.#database
      .prepare(
        `DELETE FROM gateway_profile_tool_grants
         WHERE organization_id = ? AND profile_id = ? AND operation_id = ?`,
      )
      .bind(organizationId, profileId, operationId)
      .run();
    return result.meta.changes === 1;
  }

  async #requireProfile(
    organizationId: string,
    profileId: string,
  ): Promise<void> {
    const profile = await this.#database
      .withSession("first-primary")
      .prepare(
        `SELECT profile_id
         FROM gateway_profiles
         WHERE organization_id = ? AND profile_id = ?`,
      )
      .bind(organizationId, profileId)
      .first<{ profile_id: string }>();
    if (!profile) {
      throw new GatewayProfileNotFoundError(organizationId, profileId);
    }
  }
}

function requireScope(organizationId: string, profileId: string): void {
  if (!isNonEmpty(organizationId) || !isNonEmpty(profileId)) {
    throw new GatewayProfileInputError(
      "Organization ID and profile ID are required.",
    );
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
