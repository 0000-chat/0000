import { hashOpaque } from "../../../src/platform-state";

export interface TestService {
  serviceId: string;
  audience: string;
  verifier: string;
  guestGrantIssuer: string;
  allowedCapabilities: string[];
}

export async function registerTestService(
  database: D1Database,
  registration: TestService,
): Promise<TestService> {
  await database
    .prepare(
      `INSERT INTO platform_service (service_id, audience, verifier_hash, allowed_capabilities, disabled)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(service_id) DO UPDATE SET
         audience = excluded.audience,
         verifier_hash = excluded.verifier_hash,
         allowed_capabilities = excluded.allowed_capabilities,
         disabled = 0`,
    )
    .bind(
      registration.serviceId,
      registration.audience,
      await hashOpaque(registration.verifier),
      JSON.stringify(registration.allowedCapabilities),
    )
    .run();
  await database
    .prepare(
      `INSERT INTO platform_service_grant_issuer (credential_hash, service_id, capabilities, disabled)
       VALUES (?, ?, '["guest:grant"]', 0)
       ON CONFLICT(credential_hash) DO UPDATE SET
         service_id = excluded.service_id,
         capabilities = excluded.capabilities,
         disabled = 0`,
    )
    .bind(
      await hashOpaque(registration.guestGrantIssuer),
      registration.serviceId,
    )
    .run();
  return registration;
}
