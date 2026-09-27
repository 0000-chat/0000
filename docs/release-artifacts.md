# Public release artifacts

Public `main` merges create a deterministic release record. The release
version is `v0.0.0-<full main commit SHA>`, so a retry cannot silently point at
a different source revision. The record includes the source commit, the
affected runtime units, the `sha256:` digest of each artifact, and the
`api/config` compatibility pair consumed by private Cloud promotion.

The initial scaffold publishes deterministic gzip-compressed source bundles for
the deployable units currently present in the public repository:

- Gateway Worker;
- Streams Worker;
- msg Worker;
- Communicator control-plane Worker; and
- Communicator Matrix Gateway source for the private Docker host.

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

The source bundles are a release scaffold, not deployable runtime bundles and
not proof that a managed deployment has occurred. Cloud staging must currently
block before deployment, verify the digest and provenance, and add the runtime
packaging/build step before these artifacts can be deployed. Cloud owns the
staging, canary, production, and rollback promotion path. The old Gateway
workflow is retained as a disabled, manual-only record so its cutover is
reviewable; it no longer runs on a public `main` push and has no deployment
command. This release workflow does not invoke it.

After publishing the record and provenance evidence, public CI starts the
private Cloud `staging.yml` workflow through the GitHub Actions
`workflow_dispatch` endpoint. Its `release_event` input is the nested Cloud
contract (schema version, product/source repository, immutable release version
and commit, changed paths, selected artifact digests/compatibility, and
workflow provenance). Runtime events carry the exact attestation URL emitted by
the provenance action. Documentation-only events carry the workflow-run URL
instead because they have no artifact subject to attest. The exact event is
also uploaded as release evidence; Cloud rejects a runtime event that omits an
artifact and currently stops at validation/evidence because these source
bundles are not deployable runtime packages. This scaffold therefore does not
claim that staging deployment has occurred.

The trusted public-main workflow requires the `CLOUD_RELEASE_DISPATCH_TOKEN`
repository secret. It must be a narrowly scoped GitHub App installation token
with Actions:write for the private `0000-cloud` repository's workflow dispatch
endpoint (not Contents:write, Phase, Cloudflare, or production access), and it
is never available to pull-request workflows. The public workflow has no
Cloudflare credentials and no public production deployment path.
