import {
  registerGuestIssuer,
  registerService,
} from "../../../src/service-registration";

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
  await registerGuestIssuer(
    database,
    registration.serviceId,
    registration.guestGrantIssuer,
  );
  return registration;
}
