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

This activation publishes five runtime units:

- `gateway`, a deterministic, prebuilt Cloudflare Worker bundle.
- `msg-worker`, a deterministic, prebuilt Cloudflare Worker bundle.
- `database-worker`, a deterministic, prebuilt Cloudflare Worker bundle with
  its SQLite Durable Object contract.
- `platform-worker`, a deterministic, prebuilt Cloudflare Worker bundle with
  the public identity authority, D1 migration ledger, and rate-limit contract.
- `msg-webhook-dispatcher`, a deterministic, prebuilt Bun runtime bundle for
  self-hosted secure MCP Events delivery.

Streams and Communicator remain outside this activation. Brain remains
validation-only until its own runtime artifact and staging consumer are
reviewed. The SDK placeholder and the `@0000chat/msg` CLI remain
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

Platform runtime paths select the released `platform-worker` artifact. Its
route-free bundle carries the public Worker, D1 migration ledger, neutral
bindings, rate-limit contract, and provisioning helper described below.
Platform documentation, examples, and validation-only tooling remain
Cloud-silent. Unmapped changes under the other fail-closed service roots
(`services/database` and `services/brain`) or under `apps/` are treated as
possible runtime changes and fail release planning until an explicit release
unit is configured. This fail-closed guard prevents new source, configuration,
or migration code from being silently skipped.

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
migrations/0005_mcp_oauth.sql
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

## Platform Worker bundle

`platform-worker-<version>.tar.gz` is a deterministic, prebuilt Cloudflare
Worker bundle for the public identity authority. Its root-level files and
directories are:

```text
worker.js
wrangler.json
artifact-manifest.json
provision-service.js
migrations/0001_better_auth.sql
...
migrations/0012_browser_purpose.sql
```

The route-free `wrangler.json` declares the `IDENTITY_DB` D1 binding and the
ordered migration directory. The embedded manifest declares all five
Platform rate-limit bindings without their environment-owned namespace IDs.
Neither file contains a Worker name, route, custom domain, account ID,
database ID, rate-limit namespace ID, provider ID, or secret value. The release manifest
records the same D1 and rate-limit contract, the required
`BETTER_AUTH_SECRET`, optional provider secret names, ordered migration
digests, and the SHA-256 digest of the bundled `provision-service.js` helper.

`BETTER_AUTH_SECRET` is required for the authority. Google and GitHub OAuth
credentials are optional: the Worker registers a provider only when both its
client ID and secret are present. A self-hosted deployment can therefore run
the anonymous guest authority and service-to-service flows without human OAuth
credentials; its human login endpoints remain unavailable until an operator
configures a real provider client ID and secret. Provider secrets are never
embedded in the artifact.

The bundled `provision-service.js` helper registers and manages service and
guest-issuer rows in the `IDENTITY_DB` binding. It accepts explicit
`--config PATH` and `--wrangler PATH` options so an extracted artifact can use
its neutral `wrangler.json` and an operator-selected Wrangler executable; its
default invocation remains compatible with the source checkout. It prints
one-time verifier or issuer values only on successful registration, so capture
those values in a protected environment.

Cloud supplies the Worker name, route, custom domain, account and database
IDs, rate-limit namespace IDs, authority URL, non-secret public policy vars,
and any optional OAuth provider configuration. The public release workflow
builds and attests this artifact; it does not deploy Platform or claim live
staging health.

## Msg webhook dispatcher bundle

`msg-webhook-dispatcher-<version>.tar.gz` is a deterministic, prebuilt Bun
runtime bundle for operators who need secure outbound MCP Events delivery from
a Cloudflare Worker. Its root-level files are:

```text
mcp-webhook-dispatcher.js
artifact-manifest.json
```

The entrypoint bundles the first-party dispatcher and its secure transport. The
transport resolves the recipient, rejects any non-public result, connects to
the validated address, retains the recipient hostname for TLS verification,
and does not follow redirects. The dispatcher accepts only the fixed
administrator-configured relay endpoint, authenticates its bearer token in
constant time, forwards only the signed webhook header allowlist, and applies
bounded request, response, concurrency, rate, and deadline limits.

The embedded manifest records the exact Bun version, entrypoint command,
required token variable, optional host/port/TLS/proxy variables, source commit,
and entrypoint digest. It contains no token, endpoint, certificate, or private
environment value. Start the extracted bundle with:

```sh
MSG_MCP_WEBHOOK_DISPATCH_TOKEN='operator-owned-secret' \
MSG_MCP_WEBHOOK_DISPATCH_HOST='0.0.0.0' \
MSG_MCP_WEBHOOK_DISPATCH_PORT='8787' \
MSG_MCP_WEBHOOK_DISPATCH_TLS_CERT_FILE='/etc/msg/dispatcher.crt' \
MSG_MCP_WEBHOOK_DISPATCH_TLS_KEY_FILE='/etc/msg/dispatcher.key' \
bun mcp-webhook-dispatcher.js
```

For a private HTTPS reverse proxy that terminates TLS, omit the certificate and
key variables and explicitly enable the trusted proxy mode:

```sh
MSG_MCP_WEBHOOK_DISPATCH_TOKEN='operator-owned-secret' \
MSG_MCP_WEBHOOK_DISPATCH_HOST='127.0.0.1' \
MSG_MCP_WEBHOOK_DISPATCH_PORT='8787' \
MSG_MCP_WEBHOOK_DISPATCH_TRUSTED_INTERNAL_PROXY='1' \
bun mcp-webhook-dispatcher.js
```

Direct non-loopback listeners require both certificate and key files. The
Worker must use the administrator-configured HTTPS dispatcher URL and relay token. The
public release workflow packages this companion runtime; it does not deploy
the dispatcher or claim its TLS, host, or process supervision is configured.
Its release record remains available as a public artifact, while the private
Cloud selection contains only Cloudflare Worker bundles.

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
