import {
  SavedSendAuthoritySchema,
  type SavedSendAuthority,
} from "@communicator/contracts";
import {
  createPlatformClientForRevalidation,
  getPlatformRuntimeConfig,
} from "../auth/platform";
import { resolvePlatformBinding } from "../control-directory/platform-bindings";
import { ReadError } from "../read/errors";
import type { OutboundAcceptanceContext } from "./acceptance";
import type { OutboundTuple } from "./authority-types";

export const savedSendOperationId = (
  tenantId: string,
  digest: string,
): string => `communicator:message.send:${tenantId}:${digest}`;

export async function revalidateSavedSend(
  env: Cloudflare.Env,
  saved: SavedSendAuthority,
  tuple: Pick<OutboundTuple, "tenant_id" | "membership_id" | "identity_id">,
): Promise<
  | { status: "allowed"; expiresAt: string }
  | { status: "denied" }
  | { status: "authority_unavailable" }
> {
  const client = createPlatformClientForRevalidation(env);
  if (client === null) return { status: "authority_unavailable" };
  const result = await client.revalidateSavedOperation(saved.platform);
  if (result.status !== "allowed") return result;
  const binding = await resolvePlatformBinding(
    env.CONTROL_DB,
    result.principal,
    tuple.tenant_id,
  );
  if (!binding.ok)
    return {
      status: binding.code === "not_found" ? "denied" : "authority_unavailable",
    };
  return binding.binding.bindingId === saved.binding_id &&
    binding.binding.localMembershipId === tuple.membership_id &&
    (binding.binding.localIdentityId === null ||
      binding.binding.localIdentityId === tuple.identity_id)
    ? { status: "allowed", expiresAt: result.principal.expiresAt }
    : { status: "denied" };
}

/** Capture only at acceptance, never while resuming or confirming saved work. */
export async function captureSavedSend(
  context: OutboundAcceptanceContext,
  tuple: OutboundTuple,
  requestDigest: string,
): Promise<SavedSendAuthority | undefined> {
  // Imported component fixtures can still save legacy rows. Those rows are
  // intentionally unsendable at the deployed final claim boundary.
  if (
    context.credential === undefined &&
    getPlatformRuntimeConfig(context.env) === null
  )
    return undefined;
  const client = createPlatformClientForRevalidation(context.env);
  if (client === null || context.credential === undefined)
    throw new ReadError("service_unavailable");
  const captured = await client.captureSavedOperation({
    credential: context.credential,
    operationId: savedSendOperationId(tuple.tenant_id, requestDigest),
    capability: "message.send",
  });
  if (captured.status !== "allowed")
    throw new ReadError(
      captured.status === "denied" ? "forbidden" : "service_unavailable",
    );
  const verified = await client.revalidateSavedOperation(
    captured.authorization,
  );
  if (verified.status !== "allowed")
    throw new ReadError(
      verified.status === "denied" ? "forbidden" : "service_unavailable",
    );
  const binding = await resolvePlatformBinding(
    context.env.CONTROL_DB,
    verified.principal,
    tuple.tenant_id,
  );
  if (!binding.ok)
    throw new ReadError(
      binding.code === "not_found" ? "forbidden" : "service_unavailable",
    );
  if (
    binding.binding.localPrincipalId !== context.authorization.principal.id ||
    binding.binding.localMembershipId !== tuple.membership_id ||
    (binding.binding.localIdentityId !== null &&
      binding.binding.localIdentityId !== tuple.identity_id)
  )
    throw new ReadError("forbidden");
  const route = await context.env.CONTROL_DB.withSession("first-primary")
    .prepare(`
    SELECT c.updated_at AS session_generation, cr.updated_at AS route_generation,
           cr.gateway_route_id, cr.bridge_instance_id, cr.matrix_user_id, cr.matrix_room_namespace
    FROM connections c
    JOIN connection_accounts ca ON ca.connection_id = c.id AND ca.status = 'active'
    JOIN connection_routes cr ON cr.connection_id = c.id
    JOIN gateway_routes gr ON gr.id = cr.gateway_route_id AND gr.status = 'active'
    WHERE c.tenant_id = ? AND c.id = ? AND ca.account_id = ?
  `)
    .bind(tuple.tenant_id, tuple.connection_id, tuple.account_id)
    .first<{
      session_generation: string;
      route_generation: string;
      gateway_route_id: string;
      bridge_instance_id: string;
      matrix_user_id: string;
      matrix_room_namespace: string;
    }>();
  if (route === null) throw new ReadError("forbidden");
  return SavedSendAuthoritySchema.parse({
    platform: captured.authorization,
    binding_id: binding.binding.bindingId,
    session_generation: route.session_generation,
    route_generation: route.route_generation,
    route: {
      gateway_route_id: route.gateway_route_id,
      bridge_instance_id: route.bridge_instance_id,
      matrix_user_id: route.matrix_user_id,
      matrix_room_namespace: route.matrix_room_namespace,
    },
  });
}
