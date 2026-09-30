# Public release activation

This document records the activation boundary for the public release
scaffold and workflow. The Msg activation is intended to land in one reviewed
`main` merge: the public workflow runs for every subsequent push to `main` and
publishes an immutable release record. It dispatches private Cloud only when
the release plan contains the Msg runtime artifact and the repository variable
`CLOUD_RELEASE_DISPATCH_ENABLED` is explicitly set to `true`.

The combined release-setup merge changes `release-units.json`, which is a
global runtime input. Its first-main-merge plan therefore selects exactly one
unit, `msg-worker`, and produces one prebuilt Worker bundle containing the
generated Worker, its emitted runtime modules, static assets, and ordered D1
migrations. This is a release artifact and private staging dispatch, not a
public production deployment.

The workflow and tests prove the following sequence for later merges:

1. A docs-only merge plans zero affected runtime units and produces an empty
   artifact list.
2. A release workflow change is a Msg runtime input and selects exactly one
   unit, `msg-worker`, so the publication protocol change receives a fresh
   tested bundle.
3. A later Msg Worker source or build-input change selects exactly one unit,
   `msg-worker`, and produces exactly one deterministic prebuilt Worker
   bundle.
4. Gateway, Streams, and Communicator remain outside this activation until
   their own release units and staging consumers are reviewed.

Activation must retain immutable release provenance. Automatic private Cloud
staging is an explicit opt-in while the private consumer and its credentials
are being provisioned; an owner can promote the same attested immutable
artifact through the private Cloud workflow when that variable is disabled.
The public workflow must not deploy public production on a `main` push, and it
must not add public credentials or managed environment configuration to this
repository.
