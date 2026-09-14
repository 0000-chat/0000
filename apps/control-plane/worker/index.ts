import app from "./app";
import { consumeIngestionQueue } from "./ingestion/consumer";
import { runHistoryImportTick } from "./history/runner";
import { getTenantProjection } from "./projection/routing";
import {
  runWebhookRetryTick,
  type WebhookCredentialStore,
} from "./webhooks/delivery";
import {
  readArchiveStatusForRemoval,
  runRemovalExpiryAndArchive,
} from "./archive/lifecycle";
import {
  createConfiguredControlledCopyAdapters,
  runControlledCopyRetentionSweep,
} from "./retention";

const webhookCredentialStore = (
  env: Cloudflare.Env,
): WebhookCredentialStore | undefined => {
  const candidate = (env as unknown as Record<string, unknown>)[
    "COMMUNICATOR_WEBHOOK_CREDENTIALS_JSON"
  ];
  if (typeof candidate !== "string") return undefined;
  return { get: async () => candidate };
};

const worker: ExportedHandler<Cloudflare.Env, unknown> = {
  fetch: app.fetch.bind(app),
  queue: consumeIngestionQueue,
  scheduled: (_controller, env, context) => {
    const retentionAdapters = createConfiguredControlledCopyAdapters(
      env as unknown as Record<string, unknown>,
    );
    const history = runHistoryImportTick(env).catch((error: unknown) => {
      console.error({
        event: "history_import_schedule_error",
        error: error instanceof Error ? error.name : "unknown",
      });
    });
    const webhooks = runWebhookRetryTick({
      database: env.CONTROL_DB,
      projectionForTenant: (tenantId) => getTenantProjection(env, tenantId),
      services: { credentialStore: webhookCredentialStore(env) },
    }).catch((error: unknown) => {
      console.error({
        event: "webhook_retry_schedule_error",
        error: error instanceof Error ? error.name : "unknown",
      });
    });
    const removals = runRemovalExpiryAndArchive({
      database: env.CONTROL_DB,
      bucket: env.EVENT_ARCHIVE,
      retentionAdapters,
    })
      .catch((error: unknown) => {
        console.error({
          event: "removal_expiry_schedule_error",
          error: error instanceof Error ? error.name : "unknown",
        });
        return undefined;
      })
      .then(async (expiry) => {
        const sweep = await runControlledCopyRetentionSweep({
          database: env.CONTROL_DB,
          adapters: retentionAdapters,
          canonicalArchiveFor: async (authority) => {
            const archive = await readArchiveStatusForRemoval(
              { database: env.CONTROL_DB },
              authority.tenant_id,
              authority.id,
            );
            if (archive === null) return "missing";
            return archive.operation.status === "complete"
              ? "complete"
              : "incomplete";
          },
        });
        if (sweep.errors.length > 0) {
          console.error({
            event: "controlled_copy_retention_sweep_incomplete",
            failed_removals: sweep.errors.length,
          });
        }
        return { expiry, sweep };
      })
      .catch((error: unknown) => {
        console.error({
          event: "controlled_copy_retention_schedule_error",
          error: error instanceof Error ? error.name : "unknown",
        });
      });
    context.waitUntil(Promise.all([history, webhooks, removals]));
  },
};

export default worker;
export { createApp } from "./app";
export type { AppServices } from "./app";
export { TenantProjectionDO } from "./projection/tenant-projection";
export { LinkSessionDO } from "./linking/session";
