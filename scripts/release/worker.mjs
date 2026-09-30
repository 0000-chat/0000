const PUBLIC_WRANGLER_KEYS = ["durable_objects", "migrations", "secrets", "observability"];

export function neutralWranglerConfig(unit) {
  const build = unit.build;
  const publicContract = Object.fromEntries(
    PUBLIC_WRANGLER_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(build.wrangler ?? {}, key))
      .map((key) => [key, build.wrangler[key]]),
  );
  const config = {
    $schema: "https://developers.cloudflare.com/workers/wrangler/config-schema.json",
    main: build.entrypoint,
    compatibility_date: build.compatibility_date,
    compatibility_flags: build.compatibility_flags,
    workers_dev: false,
    ...publicContract
  };
  if (build.assets) {
    config.assets = {
      binding: build.assets.binding,
      directory: build.assets.directory,
      run_worker_first: build.assets.run_worker_first
    };
  }
  if (build.wrangler?.d1_databases) config.d1_databases = build.wrangler.d1_databases;
  if (build.runtime?.triggers) config.triggers = build.runtime.triggers;
  return config;
}

/**
 * Return the exact manifest embedded in a prebuilt Worker bundle.
 *
 * Cloud owns deployment names, routes, resource IDs, and secret values. Keep
 * those environment-owned values out of this public manifest while retaining
 * the public binding and migration contract required by Msg.
 */
export function workerArtifactManifest(unit, plan, extra = {}) {
  const manifest = {
    schema_version: 1,
    product: "0000",
    name: unit.name,
    version: plan.release_version,
    kind: unit.kind,
    media_type: "application/gzip",
    source_commit: plan.source_commit,
    compatibility: plan.compatibility,
    entrypoint: unit.build.entrypoint,
    compatibility_date: unit.build.compatibility_date,
    compatibility_flags: unit.build.compatibility_flags
  };
  if (unit.name === "msg-worker") {
    const build = unit.build;
    const wrangler = build.wrangler ?? {};
    if (build.assets) {
      manifest.assets = {
        binding: build.assets.binding,
        directory: build.assets.directory,
        run_worker_first: build.assets.run_worker_first
      };
    }
    if (wrangler.durable_objects) manifest.durable_objects = wrangler.durable_objects;
    if (wrangler.migrations) manifest.migrations = wrangler.migrations;
    if (wrangler.d1_databases) manifest.d1_databases = wrangler.d1_databases;
    if (wrangler.secrets) manifest.required_secrets = wrangler.secrets.required;
    if (wrangler.observability) manifest.observability = wrangler.observability;
    if (build.runtime?.rate_limits) manifest.rate_limits = build.runtime.rate_limits;
    if (build.runtime?.triggers) manifest.triggers = build.runtime.triggers;
  }
  return { ...manifest, ...extra };
}
