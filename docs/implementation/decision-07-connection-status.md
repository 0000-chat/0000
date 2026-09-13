# Decision 07: authoritative connection status and capability publication

Status: implementation direction, not closed acceptance.

The control-plane D1 directory is the authoritative publisher of effective
connection status and capabilities. A bridge adapter publishes provider proof;
the Matrix gateway publishes transport health only. A reconciler accepts
updates only after authenticating the immutable tuple
`tenant/account/connection/identity/provider/route`, the session generation,
and a monotonic sequence. An old generation cannot reactivate a revoked or
disconnected connection.

Each feature reports one of `supported`, `conditional`, `unverified`, or
`unsupported`. That result is separate from freshness, which is one of
`fresh`, `stale`, `unknown`, or `unavailable`. A timeout or stale observation
never becomes an `unsupported` claim. Worker #15 must choose and test the
configurable freshness policy.

The existing `packages/contracts/src/connection.ts`, control-directory
migrations (including `0003_connection_read_metadata.sql`), and read handlers
provide extension points. The actual provider pin API remains unverified and
must not be presented as proven by this decision. See the worker ledger and
aggregate plan for the implementation dependency and evidence pointer.
