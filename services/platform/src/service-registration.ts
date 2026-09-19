import {
  hashOpaque,
  opaqueSecret,
  validCapabilities,
  validServiceAudience,
  validServiceId,
} from "./platform-state";

export interface ServiceRegistrationInput {
  serviceId: string;
  audience: string;
  capabilities: string[];
  displayName?: string;
}

export interface ProvisionedService extends ServiceRegistrationInput {
  verifier: string;
}

export interface ServiceMetadataUpdateInput {
  serviceId: string;
  capabilities: string[];
  displayName?: string;
}

export class ServiceRegistrationError extends Error {
  readonly code:
    | "invalid_service_id"
    | "invalid_audience"
    | "invalid_capabilities"
    | "invalid_display_name"
    | "service_conflict"
    | "service_not_found"
    | "service_disabled";

  constructor(code: ServiceRegistrationError["code"], message: string) {
    super(message);
    this.name = "ServiceRegistrationError";
    this.code = code;
  }
}

const DISPLAY_NAME_LIMIT = 120;

function validateInput(input: ServiceRegistrationInput): void {
  if (!validServiceId(input.serviceId)) {
    throw new ServiceRegistrationError(
      "invalid_service_id",
      "service IDs must be 1-64 characters using letters, numbers, '.', '_' or '-'.",
    );
  }
  if (!validServiceAudience(input.audience)) {
    throw new ServiceRegistrationError(
      "invalid_audience",
      "audience must be an exact HTTPS URL without credentials, query or fragment.",
    );
  }
  if (!validCapabilities(input.capabilities)) {
    throw new ServiceRegistrationError(
      "invalid_capabilities",
      "capabilities must be a unique nonempty list of bounded names.",
    );
  }
  if (
    input.displayName !== undefined &&
    (input.displayName.trim().length === 0 ||
      input.displayName.trim().length > DISPLAY_NAME_LIMIT ||
      /[\u0000-\u001f\u007f]/.test(input.displayName))
  ) {
    throw new ServiceRegistrationError(
      "invalid_display_name",
      "display name must be 1-120 characters without control characters.",
    );
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("SQL timestamps must be non-negative safe integers.");
  }
  return String(value);
}

function validateMetadataInput(input: ServiceMetadataUpdateInput): void {
  if (!validServiceId(input.serviceId)) {
    throw new ServiceRegistrationError(
      "invalid_service_id",
      "service IDs must be 1-64 characters using letters, numbers, '.', '_' or '-'.",
    );
  }
  if (!validCapabilities(input.capabilities)) {
    throw new ServiceRegistrationError(
      "invalid_capabilities",
      "capabilities must be a unique nonempty list of bounded names.",
    );
  }
  if (
    input.displayName !== undefined &&
    (input.displayName.trim().length === 0 ||
      input.displayName.trim().length > DISPLAY_NAME_LIMIT ||
      /[\u0000-\u001f\u007f]/.test(input.displayName))
  ) {
    throw new ServiceRegistrationError(
      "invalid_display_name",
      "display name must be 1-120 characters without control characters.",
    );
  }
}

export function serviceMetadataUpdateSql(
  input: ServiceMetadataUpdateInput,
  updatedAt: number,
): string {
  validateMetadataInput(input);
  const displayName =
    input.displayName === undefined
      ? "display_name"
      : sqlString(input.displayName.trim());
  return `UPDATE platform_service
    SET allowed_capabilities = ${sqlString(JSON.stringify(input.capabilities))},
        display_name = ${displayName}, updated_at = ${sqlInteger(updatedAt)}
    WHERE service_id = ${sqlString(input.serviceId)} AND disabled = 0;`;
}

export function serviceVerifierRotationSql(
  serviceId: string,
  verifierHash: string,
  updatedAt: number,
): string {
  if (!validServiceId(serviceId)) {
    throw new ServiceRegistrationError(
      "invalid_service_id",
      "service ID is invalid.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(verifierHash)) {
    throw new Error("Service verifier hash must be a SHA-256 hex digest.");
  }
  return `UPDATE platform_service
    SET verifier_hash = ${sqlString(verifierHash)}, updated_at = ${sqlInteger(updatedAt)}
    WHERE service_id = ${sqlString(serviceId)} AND disabled = 0;`;
}

export function serviceDisableSql(
  serviceId: string,
  updatedAt: number,
): string {
  if (!validServiceId(serviceId)) {
    throw new ServiceRegistrationError(
      "invalid_service_id",
      "service ID is invalid.",
    );
  }
  return `UPDATE platform_service SET disabled = 1, updated_at = ${sqlInteger(updatedAt)}
    WHERE service_id = ${sqlString(serviceId)} AND disabled = 0;`;
}

export function serviceRegistrationSql(
  input: ServiceRegistrationInput,
  verifierHash: string,
  createdAt: number,
): string {
  validateInput(input);
  if (!/^[a-f0-9]{64}$/.test(verifierHash)) {
    throw new Error("Service verifier hash must be a SHA-256 hex digest.");
  }
  return `INSERT INTO platform_service
    (service_id, audience, verifier_hash, allowed_capabilities, disabled, display_name, created_at, updated_at)
      VALUES (${sqlString(input.serviceId)}, ${sqlString(input.audience)}, ${sqlString(verifierHash)},
      ${sqlString(JSON.stringify(input.capabilities))}, 0,
      ${sqlString(input.displayName?.trim() ?? "")}, ${sqlInteger(createdAt)}, ${sqlInteger(createdAt)});`;
}

export async function registerService(
  database: D1Database,
  input: ServiceRegistrationInput,
  verifierOverride?: string,
): Promise<ProvisionedService> {
  validateInput(input);
  const verifier = verifierOverride ?? opaqueSecret("service_verify_");
  const now = Date.now();
  try {
    await database
      .prepare(serviceRegistrationSql(input, await hashOpaque(verifier), now))
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unique|constraint/i.test(message)) {
      throw new ServiceRegistrationError(
        "service_conflict",
        "service ID or audience is already registered; no verifier was rotated.",
      );
    }
    throw error;
  }
  return { ...input, verifier };
}

export async function updateServiceMetadata(
  database: D1Database,
  input: ServiceMetadataUpdateInput,
): Promise<void> {
  const current = await database
    .prepare("SELECT audience FROM platform_service WHERE service_id = ?")
    .bind(input.serviceId)
    .first<{ audience: string }>();
  if (!current) {
    throw new ServiceRegistrationError(
      "service_not_found",
      "service registration was not found.",
    );
  }
  validateInput({
    serviceId: input.serviceId,
    audience: current.audience,
    capabilities: input.capabilities,
    displayName: input.displayName,
  });
  const updated = await database
    .prepare(serviceMetadataUpdateSql(input, Date.now()))
    .run();
  if (updated.meta.changes !== 1) {
    throw new ServiceRegistrationError(
      "service_disabled",
      "disabled service registrations cannot be updated.",
    );
  }
}

export async function rotateServiceVerifier(
  database: D1Database,
  serviceId: string,
): Promise<string> {
  if (!validServiceId(serviceId)) {
    throw new ServiceRegistrationError(
      "invalid_service_id",
      "service ID is invalid.",
    );
  }
  const verifier = opaqueSecret("service_verify_");
  const updated = await database
    .prepare(
      serviceVerifierRotationSql(
        serviceId,
        await hashOpaque(verifier),
        Date.now(),
      ),
    )
    .run();
  if (updated.meta.changes !== 1) {
    const existing = await database
      .prepare("SELECT service_id FROM platform_service WHERE service_id = ?")
      .bind(serviceId)
      .first<{ service_id: string }>();
    throw new ServiceRegistrationError(
      existing ? "service_disabled" : "service_not_found",
      existing
        ? "disabled service registrations cannot rotate a verifier."
        : "service registration was not found.",
    );
  }
  return verifier;
}

export async function disableService(
  database: D1Database,
  serviceId: string,
): Promise<boolean> {
  if (!validServiceId(serviceId)) {
    throw new ServiceRegistrationError(
      "invalid_service_id",
      "service ID is invalid.",
    );
  }
  const result = await database
    .prepare(serviceDisableSql(serviceId, Date.now()))
    .run();
  if (result.meta.changes === 1) return true;
  const existing = await database
    .prepare("SELECT service_id FROM platform_service WHERE service_id = ?")
    .bind(serviceId)
    .first<{ service_id: string }>();
  if (!existing) {
    throw new ServiceRegistrationError(
      "service_not_found",
      "service registration was not found.",
    );
  }
  return false;
}
