import { hashOpaque } from "../../../src/platform-state";
import { registerService } from "../../../src/service-registration";

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
  await registerService(
    database,
    {
      serviceId: registration.serviceId,
      audience: registration.audience,
      capabilities: registration.allowedCapabilities,
    },
    registration.verifier,
  );
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
