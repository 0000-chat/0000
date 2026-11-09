import type { PermissionRequestCreate } from "@communicator/contracts";
import { hasPlatformCapabilities } from "../auth/capability";
import {
  createPermissionRequest,
  listAccountGrants,
  listPermissionRequests,
} from "../control-directory/grants";
import { isAdministratorSession } from "../read/authorization";
import type { ReadHandlerContext } from "../read/handlers";

type PermissionContext = Pick<
  ReadHandlerContext,
  "env" | "authorization" | "platformCapabilities"
>;
export type GrantInspection = {
  identity_id?: string | undefined;
  account_id?: string | undefined;
  status?: "active" | "revoked" | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};
export type PermissionRequestInspection = {
  identity_id?: string | undefined;
  status?: "pending" | "approved" | "rejected" | "cancelled" | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export class PermissionDeniedError extends Error {}

const requireCapability = (
  context: PermissionContext,
  capability: string,
): void => {
  if (!hasPlatformCapabilities(context.platformCapabilities, capability)) {
    throw new PermissionDeniedError("Forbidden");
  }
};

const ownIdentity = (context: PermissionContext, identityId: string): boolean =>
  context.authorization.identities.some(
    (identity) => identity.identity_id === identityId,
  );

const inspectedIdentity = (
  context: PermissionContext,
  identityId: string | undefined,
  subject: string,
) => {
  if (isAdministratorSession(context.authorization)) return identityId;
  if (identityId !== undefined && !ownIdentity(context, identityId)) {
    throw new PermissionDeniedError(
      `An agent may inspect only its own ${subject}`,
    );
  }
  return identityId ?? context.authorization.identities[0]?.identity_id;
};

export async function inspectGrants(
  context: PermissionContext,
  query: GrantInspection,
) {
  requireCapability(context, "directory.read");
  const admin = isAdministratorSession(context.authorization);
  const identityId = inspectedIdentity(context, query.identity_id, "grants");
  if (!admin && identityId === undefined)
    return { items: [], next_cursor: null };
  return listAccountGrants(
    context.env.CONTROL_DB.withSession("first-primary"),
    {
      tenantId: context.authorization.tenant.id,
      ...(!admin ? { membershipId: context.authorization.membership.id } : {}),
      ...(identityId === undefined ? {} : { identityId }),
      ...(query.account_id === undefined
        ? {}
        : { accountId: query.account_id }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    },
  );
}

export async function inspectPermissionRequests(
  context: PermissionContext,
  query: PermissionRequestInspection,
) {
  requireCapability(context, "directory.read");
  const admin = isAdministratorSession(context.authorization);
  const identityId = inspectedIdentity(context, query.identity_id, "requests");
  if (!admin && identityId === undefined)
    return { items: [], next_cursor: null };
  return listPermissionRequests(
    context.env.CONTROL_DB.withSession("first-primary"),
    {
      tenantId: context.authorization.tenant.id,
      ...(!admin
        ? { requesterMembershipId: context.authorization.membership.id }
        : {}),
      ...(identityId === undefined ? {} : { identityId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    },
  );
}

export async function requestPermissions(
  context: PermissionContext,
  body: PermissionRequestCreate,
) {
  requireCapability(context, "directory.request");
  if (!ownIdentity(context, body.identity_id)) {
    throw new PermissionDeniedError(
      "A principal may request access only for its own identity",
    );
  }
  return createPermissionRequest(context.env.CONTROL_DB, {
    idempotencyKey: body.idempotency_key,
    tenantId: context.authorization.tenant.id,
    requesterPrincipalId: context.authorization.principal.id,
    requesterMembershipId: context.authorization.membership.id,
    identityId: body.identity_id,
    accountId: body.account_id,
    operationScope: body.operation_scope,
    chatScope: body.chat_scope,
    chatIds: body.chat_ids,
    reason: body.reason,
    occurredAt: new Date().toISOString(),
  });
}
