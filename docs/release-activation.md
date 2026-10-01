---
repo: 0000-chat/0000
status: current
---

# Public release activation

This document records the public release workflow boundary. Every push to
`main` publishes an immutable release record. The active release map contains
the Gateway and Msg Worker bundles; Streams and Communicator remain outside
this activation.

The release planner compares the unit map at the push base with the current
map. An additive registration selects only the newly registered unit for its
first artifact. Changes to an existing unit definition or release compatibility
contract remain conservative and select all configured units. Shared package
manifests and lockfiles also select all configured units. A later Gateway or
Msg runtime-path change selects its own unit; a Msg release-workflow change
selects Msg.

The combined release setup changes `release-units.json`, which is a global
runtime input. The Msg Worker bundle contains the generated Worker, its emitted
runtime modules, static assets, and ordered D1 migrations. These are release
artifacts and private staging inputs, not public production deployments.

The workflow and tests prove this sequence:

1. A docs-only merge plans zero affected runtime units and produces an empty
   artifact list.
2. Registering Gateway alongside Msg produces the first Gateway artifact
   without rebuilding the unchanged Msg Worker.
3. A Gateway source or build-input change selects only `gateway`; a Msg Worker
   source or build-input change selects only `msg-worker`.
4. A shared runtime input selects both configured units.

Each runtime artifact is built in public CI, accompanied by an immutable
release record and artifact attestation, and consumed by private Cloud through
the exact release event and digest. Automatic private Cloud staging remains
opt-in through `CLOUD_RELEASE_DISPATCH_ENABLED`; keep it disabled until the
staging credentials and consumer are ready. The public workflow does not
deploy public production or add public Cloudflare credentials or managed
environment values.
