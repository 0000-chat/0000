# Public release artifacts

Public `main` merges create a deterministic release record. The release
version is `v0.0.0-<full main commit SHA>`, so a retry cannot silently point at
a different source revision. The record includes the source commit, the
affected runtime units, the `sha256:` digest of each artifact, and the
`api/config` compatibility pair consumed by private Cloud promotion.

The release currently publishes these units:

- Gateway as a deterministic, prebuilt Cloudflare Worker bundle;
- Streams Worker;
- msg Worker;
- Communicator control-plane Worker; and
- Communicator Matrix Gateway source for the private Docker host.

The other units remain source archives until their own runtime packagers are
implemented. They are not valid prebuilt Worker deployment inputs merely
because they have a release digest.

Platform, Database, and Brain remain validation-only until they have a real
runtime artifact. The SDK placeholder and the `@0000chat/msg` CLI remain
checks-only and are never release artifacts. Private `0000-cloud` content is
never included.

The release planner selects units from runtime paths and conservatively treats
root manifests and lockfiles as affecting every unit. Documentation-only and
other non-runtime changes still get a release record with zero artifacts and no
runtime redeployment. A private Cloud workflow may consume a release record and
pin the exact artifact digest for staging; this public workflow does not deploy
any public production service or grant production credentials.

Gateway's `gateway-<version>.tar.gz` is an `application/gzip` archive with
these root-level files:

```text
worker.js             # Wrangler's bundled Worker entrypoint
wrangler.json         # generated route-free compatibility metadata
artifact-manifest.json
```

The manifest is validated by
[`schemas/cloudflare-worker-artifact.schema.json`](schemas/cloudflare-worker-artifact.schema.json).
It contains exactly the release identity, `source_commit`, API/config
compatibility, `worker.js` entrypoint, and the Wrangler compatibility date and
flags. The matching `gateway.artifact.json` release asset carries the
SHA-256 digest of both the complete gzip archive and `worker.js`; the release
record and Cloud dispatch event carry the archive digest. The archive is built
with fixed tar ownership, mtime, ordering, and gzip settings; Wrangler's
timestamped README and absolute-path source map are intentionally not
included.

Cloud should fetch the archive and its matching `gateway.artifact.json` from
the same immutable GitHub release tag, verify the release-record digest and the
asset digest before extraction, and reject any archive whose manifest does not
match the event's release identity, kind, media type, compatibility, and
entrypoint contract.

The route-free `wrangler.json` in the archive contains only the entrypoint and
compatibility settings. The Gateway bundle contains no Worker name, route,
custom domain, binding, or secret. Cloud ignores that public config for
deployment, writes an environment-owned staging config for
`0000-gateway-staging` and `gateway-staging.0000.chat`, and invokes:

```sh
wrangler deploy \
  --config wrangler.staging.json \
  --no-bundle \
  --strict \
  --message "Gateway staging <release-version>"
```

The staging config is generated beside the extracted bundle and is never
published as a public artifact. The live `gateway.0000.chat` name and route
are invalid staging targets. Cloud owns staging, canary, production, and
rollback promotion; this repository does not deploy or claim live staging
health.

After publishing the record and provenance evidence, public CI starts the
private Cloud `staging.yml` workflow through the GitHub Actions
`workflow_dispatch` endpoint. Its `release_event` input is the nested Cloud
contract (schema version, product/source repository, immutable release version
and commit, changed paths, selected artifact digests/compatibility, and
workflow provenance). Every event carries its workflow-run URL. Runtime events
also carry the exact attestation URL emitted by the provenance action;
documentation-only events have no artifact subject to attestation. The exact event is
also uploaded as release evidence; Cloud rejects a runtime event that omits an
artifact or supplies a source-only Gateway artifact. This public workflow
still does not claim that staging deployment has occurred.

The trusted public-main workflow requires the `CLOUD_RELEASE_DISPATCH_TOKEN`
repository secret and `CLOUD_RELEASE_REPOSITORY` repository variable. The
variable names the private receiver as `owner/repository`; it is configuration,
not a public source dependency. The token must be a narrowly scoped GitHub App
installation token with Actions:write for that receiver's workflow-dispatch
endpoint (not Contents:write, Phase, Cloudflare, or production access), and it
is never available to pull-request workflows. The public workflow has no
Cloudflare credentials and no public production deployment path.
