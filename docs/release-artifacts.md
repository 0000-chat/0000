---
repo: 0000-chat/0000
status: current
---

# Public release artifacts

Every merge pushed to `main` creates a deterministic release record. The
release version is `v0.0.0-<full main commit SHA>`, so a retry cannot silently
point at another source revision. The record carries the exact source commit,
affected runtime units, artifact digests, and the `api/config` compatibility
pair consumed by private Cloud promotion.

This activation publishes three runtime units:

- `gateway`, a deterministic, prebuilt Cloudflare Worker bundle.
- `msg-worker`, a deterministic, prebuilt Cloudflare Worker bundle.
- `database-worker`, a deterministic, prebuilt Cloudflare Worker bundle with
  its SQLite Durable Object contract.

Streams and Communicator remain outside this activation. Platform and Brain
remain validation-only until their own runtime artifacts and staging
consumers are reviewed. The SDK placeholder and the `@0000chat/msg` CLI remain
checks-only and are never release artifacts. Private Cloud content is never
included.

The planner selects each Worker from its runtime paths. The public release
workflow is a Msg runtime input, so changes to the publication protocol
select `msg-worker`. Adding a new entry to `release-units.json` selects that
new unit for its first artifact without rebuilding unchanged units. Changes to
existing unit definitions or the release compatibility contract remain
conservative and select all configured units. Root manifests and lockfiles
also select every configured unit. Documentation-only and other non-runtime
changes publish a release record with zero artifacts and no runtime
redeployment. The public workflow
dispatches private Cloud staging only when the plan contains a runtime
artifact and the opt-in repository variable `CLOUD_RELEASE_DISPATCH_ENABLED`
is `true`; a missing variable fails closed.

Any other changed path under the validation-only service roots or under
`apps/` is treated as a possible runtime change and fails release planning
until an explicit release unit is configured. This fail-closed guard prevents
new source, configuration, or migration code from being silently skipped.

## Msg Worker bundle

`msg-worker-<version>.tar.gz` is an `application/gzip` prebuilt Cloudflare
Worker bundle. Its root-level files and directories are:

```text
worker.js
wrangler.json
artifact-manifest.json
<generated Wrangler module files, such as hashed SVG text modules>
assets/_msg/asset/mermaid-11.17.2.min.js
migrations/0001_operations.sql
migrations/0002_operations_retention.sql
migrations/0003_creation_plan.sql
```

The public build runs the pinned Mermaid asset generator before copying
`services/msg/worker/public` into `assets/`. The Worker is bundled with the
service-local pinned Wrangler binary. The archive uses fixed tar ownership,
mtime, ordering, and gzip settings; Wrangler's generated README and absolute
source map are not included.

Wrangler's generated relative runtime modules are copied with their emitted
filenames unchanged. The neutral config and embedded manifest carry the
reviewed `Text` rule for `**/*.svg`; the manifest also records each generated
module's path, rule type, and SHA-256 digest. Only modules reachable from the
generated Worker entrypoint are included, and unexpected Wrangler output is
rejected before attestation.

The route-free `wrangler.json` contains the Worker entrypoint and
compatibility settings, the public `ASSETS` static asset binding, the
`ConversationRoom` Durable Object and migration declaration, the `MSG_DB`
D1 binding and migration directory, required secret names, observability
settings, and the cron trigger. It contains no Worker name, route, custom
domain, account, database ID, rate-limit namespace ID, or secret value.
Environment-owned rate-limit IDs and credentials are supplied by private Cloud.

The embedded manifest records the exact release identity and source commit,
compatibility contract, the public bindings and migration declarations, the
required secret names, runtime rate-limit contracts, the cron contract, and
the SHA-256 digest of every ordered D1 migration file. The matching
`msg-worker.artifact.json` release asset carries the archive and Worker
entrypoint digests plus the prebuilt deployment contract.

Cloud must verify the archive, manifest, metadata, and attestation from the
same immutable release before generating its environment-owned staging
configuration. It rejects edits or removals to migrations already present at
the release base, verifies the ordered migration ledger, applies the D1
migrations in numeric order, then deploys the prebuilt Worker with
`--no-bundle`. It owns staging, canary, production, and rollback promotion;
this repository does not deploy or claim live staging health.

## Gateway Worker bundle

`gateway-<version>.tar.gz` is an `application/gzip` prebuilt Cloudflare Worker
bundle containing:

```text
worker.js
wrangler.json
artifact-manifest.json
```

The embedded manifest records the exact release version, source commit,
compatibility contract, and Worker entrypoint. The matching
`gateway.artifact.json` release asset carries the archive and entrypoint
digests plus the prebuilt deployment contract. The generated `wrangler.json`
contains compatibility settings only; it excludes the public Worker name and
route. Cloud supplies the environment-owned deployment name, route, bindings,
and credentials.

Cloud must verify the Gateway archive, metadata, release event, and
attestation from the same immutable release before staging. Public CI builds
and publishes the artifact but does not deploy it or claim live staging health.

## Database Worker bundle

`database-worker-<version>.tar.gz` is an `application/gzip` prebuilt
Cloudflare Worker bundle containing:

```text
worker.js
wrangler.json
artifact-manifest.json
```

The embedded manifest and `database-worker.artifact.json` metadata record the
release identity, source commit, compatibility contract, `DATABASES` and
`REGISTRY` Durable Object bindings, the `v1` SQLite class migration, and the
finite public capacity policy. The policy includes its monotonic revision,
the configured service-wide ceilings, and the suspension flag. Its values are
public service configuration, not credentials.

The route-free `wrangler.json` contains compatibility settings, the public
Durable Object bindings and migration, the public policy values, and disabled
`workers_dev`. It contains no Worker name, route, custom domain, account ID, or
secret value. The Worker bundles both Durable Object classes into the same
prebuilt artifact. This unit has no separate SQL migration directory; its
SQLite class migration is declared in Wrangler metadata.

The public build uses the pinned Wrangler binary from the root workspace and
archives the emitted Worker with fixed tar ownership, mtime, ordering, and gzip
settings. Local release tests extract the archive, compare its manifest and
neutral Wrangler config with the release contract, then boot the Worker with
persistent SQLite Durable Objects and read a created database after runtime
restart. This proves the packaged artifact's local behavior; it does not prove
managed staging or public production deployment.

The configured caps are conservative public policy inputs. They do not bound
provider-level ingress charges, and the separate global physical and logical
limits do not establish an exact physical-to-logical storage ratio. The
Database service documentation records the acceptance boundaries and
remaining operating limits.

## Release provenance and staging boundary

After publishing the release record and provenance evidence, public CI can
start the private Cloud `staging.yml` workflow through the GitHub Actions
`workflow_dispatch` endpoint when `CLOUD_RELEASE_DISPATCH_ENABLED` is `true`.
Its `release_event` input contains the immutable release version and commit,
changed paths, each selected Worker artifact digest and compatibility, and
workflow provenance. Runtime events carry the attestation URL emitted by
the provenance action; documentation-only events have no artifact subject to
attestation. The exact event is uploaded as release evidence. When automatic
dispatch is disabled, the public workflow still publishes the same immutable
release assets; an owner can promote an attested artifact through the private
Cloud workflow. The public workflow never deploys public production.

Before enabling the trusted public-main workflow, immutable releases must be
enabled for the repository. The workflow checks that setting, creates a
SHA-derived draft release, uploads and verifies its record, event, metadata,
and artifact assets, and publishes only after the full set is present. A retry
reuses the same draft or published release, verifies existing asset digests,
fills only missing draft assets, and refuses to mutate a published release.

The release job uses the configured project GitHub App credentials through
short-lived installation tokens. The public workflow has no Cloudflare
credentials, managed environment values, or production deployment path.
