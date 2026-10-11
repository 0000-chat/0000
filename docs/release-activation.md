---
repo: 0000-chat/0000
status: current
---

# Public release activation

This document records the public release workflow boundary. Every push to
`main` publishes an immutable release record. The active release map contains
the Gateway, Msg Worker, and Database Worker bundles; Streams and Communicator
remain outside this activation.

The release planner compares the unit map at the push base with the current
map. An additive registration selects only the newly registered unit for its
first artifact. Changes to an existing unit definition or release compatibility
contract remain conservative and select all configured units. Shared package
manifests and lockfiles also select all configured units. A later Gateway or
Msg runtime-path change selects its own unit; a Msg release-workflow change
selects Msg.

The Database registration is additive: the first release plan containing the
new `database-worker` unit selects only that unit when the existing Gateway
and Msg definitions are unchanged. The Msg Worker bundle contains the
generated Worker, its emitted runtime modules, static assets, and ordered D1
migrations. The Database bundle contains its generated Worker and the
`DATABASES`/`REGISTRY` SQLite Durable Object migration contract. These are
release artifacts and private staging inputs, not public production
deployments.

The workflow and tests prove this sequence:

1. A docs-only merge plans zero affected runtime units and produces an empty
   artifact list.
2. Registering Database alongside Gateway and Msg produces the first Database
   artifact without rebuilding either unchanged unit.
3. A Gateway source or build-input change selects only `gateway`; a Msg Worker
   source or build-input change selects only `msg-worker`; a Database source
   or build-input change selects only `database-worker`.
4. A shared runtime input selects all configured units.

Each runtime artifact is built in public CI, accompanied by an immutable
release record and artifact attestation, and consumed by private Cloud through
the exact release event and digest. Automatic private Cloud staging remains
opt-in through `CLOUD_RELEASE_DISPATCH_ENABLED`; keep it disabled until the
staging credentials and consumer are ready. The public workflow does not
deploy public production or add public Cloudflare credentials or managed
environment values.
