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

export function serviceRegistrationSql(
  input: ServiceRegistrationInput,
  verifierHash: string,
  createdAt: number,
): string {
  validateInput(input);
  return `INSERT INTO platform_service
    (service_id, audience, verifier_hash, allowed_capabilities, disabled, display_name, created_at, updated_at)
    VALUES (${sqlString(input.serviceId)}, ${sqlString(input.audience)}, ${sqlString(verifierHash)},
      ${sqlString(JSON.stringify(input.capabilities))}, 0,
      ${sqlString(input.displayName?.trim() ?? "")}, ${createdAt}, ${createdAt});`;
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
      .prepare(
        `INSERT INTO platform_service
         (service_id, audience, verifier_hash, allowed_capabilities, disabled, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        input.serviceId,
        input.audience,
        await hashOpaque(verifier),
        JSON.stringify(input.capabilities),
        input.displayName?.trim() ?? "",
        now,
        now,
      )
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
  input: {
    serviceId: string;
    capabilities: string[];
    displayName?: string;
  },
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
    .prepare(
      `UPDATE platform_service
       SET allowed_capabilities = ?, display_name = ?, updated_at = ?
       WHERE service_id = ? AND disabled = 0`,
    )
    .bind(
      JSON.stringify(input.capabilities),
      input.displayName?.trim() ?? "",
      Date.now(),
      input.serviceId,
    )
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
      `UPDATE platform_service SET verifier_hash = ?, updated_at = ?
       WHERE service_id = ? AND disabled = 0`,
    )
    .bind(await hashOpaque(verifier), Date.now(), serviceId)
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
    .prepare(
      "UPDATE platform_service SET disabled = 1, updated_at = ? WHERE service_id = ? AND disabled = 0",
    )
    .bind(Date.now(), serviceId)
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
