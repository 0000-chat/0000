import { createConfiguredControlledCopyAdapters } from "../../apps/control-plane/worker/retention/runtime.ts";
import { runControlledCopyRetentionSweep } from "../../apps/control-plane/worker/retention/service.ts";
import { listArchivePurgeOperations } from "../../apps/control-plane/worker/archive/purge.ts";
import { purgeArchiveForRemoval } from "../../apps/control-plane/worker/archive/purge.ts";

// Local wrapper only: route /__fixture/retention/sweep here before production.
// Reads the actual D1 authorities and executes the production planner/worker.
// No authority, cleanup ledger, archive status, or activation result is forged.
export async function handleRetentionFixture(request, env) {
  if (new URL(request.url).pathname !== "/__fixture/retention/sweep")
    return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // Advance only the purge worker's explicit clock past its persisted safety
  // deadline. Do not edit the ledger or reduce the production safety window.
  const purges = await listArchivePurgeOperations(
    env.CONTROL_DB,
    "tenant_pilot",
  );
  for (const operation of purges)
    await purgeArchiveForRemoval({
      database: env.CONTROL_DB,
      bucket: env.EVENT_ARCHIVE,
      tenantId: operation.tenant_id,
      removalId: operation.removal_id,
      now: new Date(
        Math.max(Date.now(), Date.parse(operation.safety_deadline) + 1),
      ),
    });
  const result = await runControlledCopyRetentionSweep({
    database: env.CONTROL_DB,
    adapters: createConfiguredControlledCopyAdapters(env),
    canonicalArchiveFor: async (authority) => {
      const operations = await listArchivePurgeOperations(
        env.CONTROL_DB,
        authority.tenant_id,
      );
      const operation = operations
        .filter((item) => item.removal_id === authority.id)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
      return operation === undefined
        ? "missing"
        : operation.status === "complete"
          ? "complete"
          : "incomplete";
    },
  });
  return Response.json({
    processed: result.processed,
    complete: result.complete.length,
    incomplete: result.incomplete.length,
    errors: result.errors.length,
  });
}
