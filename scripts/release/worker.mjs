const PUBLIC_WRANGLER_KEYS = ["durable_objects", "migrations", "secrets", "observability"];

export function neutralWranglerConfig(unit, sourceConfig = undefined) {
  const publicContract = sourceConfig
    ? Object.fromEntries(
        PUBLIC_WRANGLER_KEYS
          .filter((key) => Object.prototype.hasOwnProperty.call(sourceConfig, key))
          .map((key) => [key, sourceConfig[key]]),
      )
    : (unit.build.wrangler ?? {});
  return {
    $schema: "https://developers.cloudflare.com/workers/wrangler/config-schema.json",
    main: unit.build.entrypoint,
    compatibility_date: sourceConfig?.compatibility_date ?? unit.build.compatibility_date,
    compatibility_flags: sourceConfig?.compatibility_flags ?? unit.build.compatibility_flags,
    workers_dev: false,
    ...publicContract
  };
}

/**
 * Return the exact manifest embedded in a prebuilt Worker bundle.
 *
 * Cloud owns the deployment name and route. Keep those values, and all
 * bindings or secrets, out of this public manifest.
 */
export function workerArtifactManifest(unit, plan) {
  return {
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
}
