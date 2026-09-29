# Public release activation

This document records the activation boundary for the public release
scaffold and workflow. The scaffold and activation are intended to land in one
reviewed `main` merge: the public workflow runs for every subsequent push to
`main`, publishes an immutable release record, and dispatches private Cloud
only when the release plan contains a runtime artifact.

The combined release-setup merge changes `release-units.json`, which is a
global runtime input. Its first-main-merge plan therefore selects exactly one
unit, `gateway`, and produces one prebuilt Worker bundle. This is a release
artifact and private staging dispatch, not a public production deployment.

The workflow and tests prove the following sequence for later merges:

1. A docs-only or activation-workflow-only merge plans zero affected runtime
   units and produces an empty artifact list.
2. A later Gateway source or Gateway build-input change selects exactly one
   unit, `gateway`, and produces exactly one prebuilt Worker bundle.
3. Msg, Streams, and Communicator remain outside the Gateway activation until
   their own release units and staging consumers are reviewed.

Activation must retain immutable release provenance and dispatch private Cloud
only for a runtime plan containing the Gateway artifact. It must not deploy
public production on a `main` push, and it must not add public credentials or
managed environment configuration to this repository.
