---
repo: 0000-chat/0000
status: current
---

# Communicator release bundle contract

Communicator releases contain prebuilt public product artifacts, not a source
checkout. A consumer needs Node 24, GitHub CLI with attestation verification,
and its selected runtime tools. It does not need a sibling repository, Cargo,
pnpm, or unpublished workspace packages to verify and extract a release.

This contract describes packaging, not a deployed candidate. A release used
for readiness acceptance must include the later integrated product fixes and
their verification. No release, signature, route, or deployment is established
by a local build.

## Artifact identities

All four artifacts in a composition have the same full source revision,
`v0.0.0-<revision>` version, and `api` and `config` compatibility pair.

| Release unit | Kind | Contents |
| --- | --- | --- |
| `communicator-control-plane` | `communicator-worker-bundle` | Prebuilt `worker.js`, production live-mode UI in `assets/`, neutral `wrangler.json`, and ordered `migrations/` |
| `communicator-matrix-gateway` | `communicator-native-bundle` | Executable `communicator-matrix-gateway` and generic `deploy/matrix-gateway` supervisor and configuration examples |
| `communicator-bridge-images` | `communicator-bridge-bundle` | `compose.yaml`, `deploy/images.lock.env`, generic Caddy and Synapse templates, and initialization, rendering, and validation scripts |
| `platform-worker` | `cloudflare-worker-bundle` | Existing [Platform artifact](../../../docs/release-artifacts.md#platform-worker-bundle), including its identity implementation and D1 ledger |

The three Communicator kinds use `artifact_format`:
`0000-communicator-bundle-v1`. They are **not** compatible with the generic
`0000-cloudflare-worker-bundle-v1` consumer. They remain outside
`cloud_selection`. Their record and release-event entries are still published
and attested by the public release workflow. Platform retains its existing
format and selection policy.

Changes to any Communicator unit select the full composition. Shared public
contracts and Platform-client runtime changes select all configured release
units. The Vite build bundles `@0000/contracts`, `@0000/platform-client`,
`@communicator/contracts`, and `@communicator/test-fixtures`. The consumer
rejects missing dependency declarations rather than resolving a workspace
package after extraction. Test fixtures remain a current application import,
not a requirement for a consumer to install a development workspace.

## Manifest version 1

Each Communicator archive contains `artifact-manifest.json`, license texts,
and the standalone `verify-communicator.mjs` consumer. Its matching
`<unit>.artifact.json` metadata and the release record include the archive
`digest` and the `manifest_digest`, both SHA-256 values. The public
[release-record schema](../../../docs/schemas/public-release-record.schema.json)
defines those outer fields. The following fields define the embedded contract:

- `schema_version: 1`, `product: "0000"`, `artifact_format`, `name`, `kind`,
  `role`, `version`, `source_commit`, and `compatibility` identify the bundle.
  `role` is `worker`, `native`, or `bridge` and must match the unit and kind.
- `files` lists every payload file except the manifest itself. Each entry has
  a relative `name`, a `sha256:` digest, and an `executable` boolean. Extra
  files, missing files, links, special files, duplicate paths, and traversal
  paths are rejected before extraction.
- `dependencies` records each bundled workspace's name, `delivery: "bundled"`,
  and its ordered public `source_files` ledger of names and SHA-256 digests.
  Only the Worker has these dependencies.
- `state` declares `compatibility: "communicator-state-v1"`,
  `migration_policy: "forward-only"`, `rollback: "restore-compatible-backup"`,
  and a `persistent` list. Worker and native state also record
  `embedded_schema` source fingerprints. These fingerprints are conservative:
  a change requires explicit migration review, even if the change is only code
  within the same source file.

The Worker adds `entrypoint: "worker.js"`, `bindings` equal to the neutral
Wrangler config, and `migration_files` as ordered `{name, digest}` SQL entries.
The config preserves the source compatibility settings, SPA asset routing,
SQLite Durable Object exports, cron, D1 binding, R2 binding, and Queue policy.
Resource names are generic placeholders. Account IDs, database IDs, routes,
runtime vars, and credentials are not included. The operator supplies the
Platform authority, audience, browser registration, service verifier, and
other runtime settings required by the
[Platform authenticator](../apps/control-plane/worker/auth/platform.ts) and
[browser client](../apps/control-plane/worker/auth/browser-routes.ts).

For this revision, authentication requires `COMMUNICATOR_PLATFORM_BASE_URL`,
`COMMUNICATOR_PLATFORM_AUTHORITY`, `COMMUNICATOR_PLATFORM_AUDIENCE`, and the
secret `COMMUNICATOR_PLATFORM_SERVICE_VERIFIER`. Browser login additionally
requires `COMMUNICATOR_PLATFORM_BROWSER_CLIENT_ID`, the secret
`COMMUNICATOR_PLATFORM_BROWSER_CLIENT_SECRET`,
`COMMUNICATOR_PLATFORM_BROWSER_REDIRECT_URI`,
`COMMUNICATOR_PLATFORM_BROWSER_RESOURCE`, and
`COMMUNICATOR_PLATFORM_BROWSER_SCOPES`. The operator supplies all values and
registrations. Select `COMMUNICATOR_DATA_MODE=live` for the Worker explicitly;
the live-mode UI build does not configure Worker runtime vars. These names
describe configuration inputs, not a selected public address or auth resource.

The native bundle adds `entrypoint`, and `native` records the pinned Rust
version, `x86_64-unknown-linux-gnu` target, build glibc version, and required
glibc symbols. This is not a portable static binary. The operator must match
its host ABI. Its state contract preserves `matrix_store_dir`, `state_db_path`,
and protected secret files, with `restart_prevent_exit_status: 78`. The
[supervisor package](../deploy/matrix-gateway/README.md) retains that stop
condition instead of retrying a credential failure.

The bridge bundle adds `images`, containing all six digest-pinned image
references. It does not contain image layers, runtime data, registrations, or
credentials. A consumer can validate the deployment inputs offline, but its
container engine must obtain those exact image digests before starting them.
The `state.upgrade_policy` requires upstream migration review and backups
before any image digest changes. Generic `.example.invalid` hostnames in the
templates must be replaced deliberately. They are not product endpoints.

Digest pinning preserves the exact image reference. It does not prove an
upstream source revision or build provenance. The
[pinned WhatsApp assessment](implementation/pinned-whatsapp-linking-contract.md#pin-and-source-mapping)
records release/source correspondence but no cryptographic image-digest-to-Git
mapping. A signature on this public deployment-input bundle does not supply
that missing upstream attestation or prove live bridge/provider behavior.

## Consumer verification

The consumer accepts an independently selected full revision and compatibility
pair. It verifies archive digests, authenticates each archive using
`gh attestation verify`, then checks manifests, dependency closure, payload
digests, ordered migrations, and composition versions. Signature verification
requires the public repository's `release.yml`, source `refs/heads/main`, the
selected source digest, and a GitHub-hosted runner. A matching checksum alone
does not prove provenance. The release record is not a substitute for a signed
archive.

From a directory containing downloaded release assets and a trusted copy of
the public consumer, the verification command is:

```sh
node verify-communicator.mjs --record 0000-release-record.json \
	--artifact-dir assets --commit "$REVIEWED_COMMIT" --api v1 --config v1 \
	--extract verified-composition
```

`--extract` requires a new destination and writes nothing until every required
archive passes. `--attestation-dir DIR` uses downloaded Sigstore bundles named
`<archive-name>.jsonl` instead of fetching attestations. Missing or invalid
attestation bundles fail verification.

Attestation reads a private temporary snapshot of the same bytes checked and
parsed by the consumer. Replacing a downloaded archive during verification
cannot substitute a different signed subject. The snapshot is removed on
success or failure; the consumer does not lock the download directory. Both
the input archive and decompressed payload are limited to 256 MiB.

For an upgrade, `--previous-record FILE --previous-artifact-dir DIR` verifies
both compositions before comparison. Existing D1 migrations cannot change or
disappear. Only numerically later migrations may be appended. Persistent
storage identities, state compatibility, embedded schemas, and bridge images
must remain compatible. An embedded-schema or image change fails closed and
requires a reviewed extension to this migration contract. The verifier never
applies migrations, starts containers, or deploys a Worker.

`--local-integrity-only` skips signature verification and prints that
provenance is **not verified**. That mode is for local packaging tests, never
promotion. `bun run test:release:communicator` builds the real artifacts,
copies the consumer outside the checkout, exercises rejection cases, applies
the packaged D1 migrations locally, and restarts the packaged Worker with
persistent D1 and SQLite Durable Object state. It also checks the native
protected-configuration exit. Tests do not publish, deploy, pair accounts, or
send provider messages.

## MCP and deployment limits

The maintained [MCP topology](../../../docs/architecture/mcp-topology.md#communicator-discovery-and-authentication)
defines `https://communicator.0000.chat/mcp` as the standalone target transport
URL and `https://communicator.0000.chat` as its registered resource and
audience. Self-hosted consumers use their operator's registered resource from
discovery. The [authentication runbook](runbooks/oauth-remote-mcp.md) describes
the Platform-backed verifier and browser login flow, not the retired local
issuer. The bundle test checks the implemented discovery aliases, resource
metadata challenge, Platform verification, MCP transport, and denial cases
through the extracted Worker with a controlled local authority.

The target and local implementation contract does not establish DNS, TLS,
routes, registrations, Gateway catalog inclusion, deployment, or external-client
acceptance. Local bundles carry the current worktree, not proof that its edits
are published at HEAD. Release acceptance requires the reviewed integrated
tree to be committed and published through the authorized attesting release
workflow, then verified in normal signed mode. Local integrity mode never
satisfies that publication/provenance step. Publication and deployment require
separate approval; neither is a packaging-test side effect.
