import app from "./app";
import { consumeIngestionQueue } from "./ingestion/consumer";

const worker: ExportedHandler<Cloudflare.Env, unknown> = {
  fetch: app.fetch.bind(app),
  queue: consumeIngestionQueue,
};

export default worker;
export { createApp } from "./app";
export type { AppServices } from "./app";
export { TenantProjectionDO } from "./projection/tenant-projection";
