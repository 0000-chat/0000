# Public release artifacts

This repository carries the deterministic release engine, public release
workflow, and public contract for the first release unit: the Gateway Worker.
Every merge pushed to `main` creates an immutable release record. Runtime
plans publish the selected artifacts and may dispatch private Cloud staging;
the workflow never deploys public production.

`release-units.json` is the public path-to-unit map. It contains exactly one
runtime unit, `gateway`, and its only deployable output is a prebuilt,
environment-neutral Cloudflare Worker bundle. Msg, Streams, and Communicator
release units are intentionally outside this slice; their release features
remain on the existing release work.

## Planning and zero-artifact changes

The planner derives a deterministic release version as
`v0.0.0-<full main commit SHA>`. A Gateway runtime path selects only Gateway.
Root package and lockfile inputs conservatively select every configured unit;
because this slice has one unit, that still means Gateway only.

Documentation changes and an activation-workflow-only change produce a plan
with `runtime_redeployment: false` and an empty artifact list. The combined
release-setup merge also changes `release-units.json`, a global runtime input,
so its first-main-merge plan intentionally selects Gateway and publishes one
prebuilt Worker artifact. This makes the first public-main merge a complete
release setup while keeping production deployment private and manual-only.
The activation workflow must not add Msg, Streams, or Communicator units as a
side effect.

Run the local contract tests with:

```sh
node --test scripts/release/release.test.mjs
```

## Gateway bundle

Gateway's `gateway-<version>.tar.gz` is an `application/gzip` archive with
these root-level files:

```text
worker.js             # Wrangler's bundled Worker entrypoint
wrangler.json         # route-free compatibility metadata
artifact-manifest.json
```

The embedded manifest is validated by
[`schemas/cloudflare-worker-artifact.schema.json`](schemas/cloudflare-worker-artifact.schema.json).
It contains the release identity, `source_commit`, API/config compatibility,
the `worker.js` entrypoint, and Wrangler's compatibility date and flags. The
matching `gateway.artifact.json` metadata carries the archive and entrypoint
digests plus the staging deployment contract.

The generated `wrangler.json` is route-free and contains no Worker name,
custom domain, binding, or secret. Private Cloud owns the environment config,
staging hostname, credentials, and promotion. Public CI has no Cloudflare or
production credentials and does not deploy the bundle.

## Activation boundary

The trusted public workflow is reviewed together with the release scaffold. It
dispatches Cloud only when the plan contains the single Gateway artifact,
retains immutable release provenance, and never makes a `main` merge a
production deployment. Later Gateway source/config changes also produce one
runtime artifact; changes outside the configured runtime paths remain
zero-artifact releases.

Cloud should consume the archive and matching metadata from the same immutable
release, verify the digest and provenance, and own staging, canary,
production, and rollback promotion. These files do not claim that a staging
or production deployment has occurred.
