import app from "./app";
import { consumeIngestionQueue } from "./ingestion/consumer";
import { runHistoryImportTick } from "./history/runner";
import { getTenantProjection } from "./projection/routing";
import {
  runWebhookRetryTick,
  type WebhookCredentialStore,
} from "./webhooks/delivery";
import { runRemovalExpiryAndSuppress } from "./removals/service";

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
    const removals = runRemovalExpiryAndSuppress(env.CONTROL_DB).catch(
      (error: unknown) => {
        console.error({
          event: "removal_expiry_schedule_error",
          error: error instanceof Error ? error.name : "unknown",
        });
      },
    );
    context.waitUntil(Promise.all([history, webhooks, removals]));
  },
};

export default worker;
export { createApp } from "./app";
export type { AppServices } from "./app";
export { TenantProjectionDO } from "./projection/tenant-projection";
export { LinkSessionDO } from "./linking/session";
