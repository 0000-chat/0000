# Release activation follow-up

This document records the activation boundary for the dormant public release
scaffold. It is documentation only: this change does not add a GitHub release
workflow and does not publish or dispatch a runtime artifact when merged.

The follow-up activation PR must be reviewed independently and prove the
following sequence:

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
