export function neutralWranglerConfig(unit) {
  const config = {
    $schema: "https://developers.cloudflare.com/workers/wrangler/config-schema.json",
    main: unit.build.entrypoint,
    compatibility_date: unit.build.compatibility_date,
    compatibility_flags: unit.build.compatibility_flags,
    workers_dev: false
  };
  const build = unit.build;
  const wrangler = build.wrangler ?? {};
  if (build.assets) {
    config.assets = {
      binding: build.assets.binding,
      directory: build.assets.directory,
      run_worker_first: build.assets.run_worker_first
    };
  }
  if (wrangler.durable_objects) config.durable_objects = wrangler.durable_objects;
  if (wrangler.migrations) config.migrations = wrangler.migrations;
  if (wrangler.d1_databases) config.d1_databases = wrangler.d1_databases;
  if (wrangler.observability) config.observability = wrangler.observability;
  if (build.runtime?.triggers) config.triggers = build.runtime.triggers;
  return config;
}

/**
 * Return the exact manifest embedded in a prebuilt Worker bundle.
 *
 * Cloud owns the deployment name and route. Keep those values, environment
 * resource IDs, and secret values out of this public manifest.
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
  return { ...manifest, ...extra };
}
