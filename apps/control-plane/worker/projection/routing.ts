import { CanonicalResourceIdSchema } from "@communicator/contracts";
import { ProjectionError, projectionError } from "./errors";
import type { TenantProjectionDO } from "./tenant-projection";

export function getTenantProjection(
  env: Pick<Cloudflare.Env, "TENANT_PROJECTION">,
  tenantId: unknown,
): DurableObjectStub<TenantProjectionDO> {
  // Reject non-strings before invoking schema parsing so hostile objects cannot
  // influence validation through a getter, proxy, or custom prototype.
  if (typeof tenantId !== "string") {
    throw projectionError("projection_invalid");
  }

  try {
    const result = CanonicalResourceIdSchema.safeParse(tenantId);
    if (!result.success) throw projectionError("projection_invalid", result.error);
    return env.TENANT_PROJECTION.getByName(result.data);
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    throw projectionError("projection_unavailable", error);
  }
}
