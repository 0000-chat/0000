import { executeOutboundCommand } from "../../apps/control-plane/worker/outbound/acceptance.ts";
import { sha256Hex } from "../../apps/control-plane/worker/archive/codec.ts";
import { revalidateSavedSend } from "../../apps/control-plane/worker/outbound/saved-authority.ts";

const tenant = "tenant_pilot";

// Local wrapper only. DO RPCs get an explicit lifecycle/executor clock; no
// global clock, Platform authentication, transport, or ledger SQL is replaced.
export async function handleRecoveryFixture(request, env) {
  const operation = new URL(request.url).pathname.replace(
    "/__fixture/recovery/",
    "",
  );
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (operation !== "step") return new Response(null, { status: 404 });
  const input = await request.json();
  if (
    typeof input.command_id !== "string" ||
    !/^command_[A-Za-z0-9_-]+$/.test(input.command_id) ||
    !Number.isSafeInteger(Date.parse(input.now))
  ) {
    return Response.json({ error: "invalid_fixture_input" }, { status: 400 });
  }
  const now = new Date(input.now).toISOString();
  const projection = env.TENANT_PROJECTION.getByName(tenant);
  const reconcile = () =>
    projection.reconcileOutbound({
      schema_version: 1,
      tenant_id: tenant,
      command_id: input.command_id,
      now,
    });
  let result = await reconcile();
  if (
    result.dispatch.status === "pending" ||
    result.dispatch.status === "wakeup_failed"
  ) {
    await executeOutboundCommand(env, projection, tenant, input.command_id, {
      now: () => new Date(now),
    });
    result = await reconcile();
  }
  const dispatch = result.dispatch;
  const authority = dispatch.authority;
  const authorityHash =
    authority?.saved === undefined
      ? null
      : await sha256Hex(
          new TextEncoder().encode(JSON.stringify(authority.saved)),
        );
  const validation =
    authority?.saved === undefined
      ? null
      : await revalidateSavedSend(env, authority.saved, {
          tenant_id: tenant,
          membership_id: authority.membership_id,
          identity_id: authority.identity_id,
        });
  return Response.json({
    command: {
      id: result.command.id,
      status: result.command.status,
      failure_code: result.command.failure_code,
    },
    authority_validation: validation?.status ?? "missing",
    authority_expires_at:
      validation?.status === "allowed" ? validation.expiresAt : null,
    dispatch: {
      status: dispatch.status,
      account_id: dispatch.account_id,
      connection_id: dispatch.connection_id,
      transaction_id: dispatch.transaction_id,
      created_at: dispatch.created_at,
      confirmation_due_at: dispatch.confirmation_due_at,
      uncertainty_reason: dispatch.uncertainty_reason,
      confirmation_decision: dispatch.confirmation_decision,
      confirmation_actor_principal_id: dispatch.confirmation_actor_principal_id,
      last_action: dispatch.last_action,
      last_action_actor_principal_id: dispatch.last_action_actor_principal_id,
      resend_of_command_id: dispatch.resend_of_command_id,
      duplicate_risk: dispatch.duplicate_risk,
      saved_authority_sha256: authorityHash,
    },
    clock: now,
  });
}
