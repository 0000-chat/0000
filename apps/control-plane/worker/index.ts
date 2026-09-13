import app from "./app";
import { consumeIngestionQueue } from "./ingestion/consumer";
import { runHistoryImportTick } from "./history/runner";

const worker: ExportedHandler<Cloudflare.Env, unknown> = {
  fetch: app.fetch.bind(app),
  queue: consumeIngestionQueue,
  scheduled: (_controller, env, context) => {
    context.waitUntil(
      runHistoryImportTick(env).catch((error: unknown) => {
        console.error({
          event: "history_import_schedule_error",
          error: error instanceof Error ? error.name : "unknown",
        });
      }),
    );
  },
};

export default worker;
export { createApp } from "./app";
export type { AppServices } from "./app";
export { TenantProjectionDO } from "./projection/tenant-projection";
export { LinkSessionDO } from "./linking/session";
