# Public release artifacts

This branch carries the deterministic release engine and the public contract
for the first release unit: the Gateway Worker. The scaffolding is deliberately
dormant. There is no public release workflow in this branch, so merging it to
`main` creates no release record, no artifact, and no Cloud workflow dispatch.

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
with `runtime_redeployment: false` and an empty artifact list. That is the
required first activation proof: a separate follow-up activation PR may be
merged and must produce zero runtime artifacts before any Gateway runtime
change is released. The activation PR must not add Msg, Streams, or
Communicator units as a side effect.

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

Activation is a separate, reviewed follow-up PR. It may add the trusted public
workflow only after the dormant scaffold is merged and the docs-only/activation
plan is observed to contain zero runtime artifacts. The activation workflow
must dispatch Cloud only when the plan contains the single Gateway artifact,
must retain immutable release provenance, and must not make a `main` merge a
production deployment. A later Gateway source/config change is the first
change permitted to produce one runtime artifact.

Cloud should consume the archive and matching metadata from the same immutable
release, verify the digest and provenance, and own staging, canary,
production, and rollback promotion. These files do not claim that a staging
or production deployment has occurred.
