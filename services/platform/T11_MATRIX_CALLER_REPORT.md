# T11 Matrix gateway credential caller prerequisite

Source: `b24780f21404b72e3b29be76f639a0cdfef60871`, applied to aggregate base
`5033cd0` as candidate `414fd5b`. This is a bounded caller prerequisite, not
completed Communicator authentication adoption.

The gateway reads its finite Platform ingestion credential from a protected
file at startup. It no longer requests or refreshes OAuth client-credentials
tokens. Authority claims have a separate protected credential; Matrix, bridge
and Worker-to-gateway transport secrets retain their own purposes and callers.

An ingestion 401 stops the coordinator with exit 78. The shipped systemd unit
uses `RestartPreventExitStatus=78`, so recovery requires credential replacement
and an explicit restart. The pending outbox batch retains its exact bytes.
Other supervisors must honor the documented stop behavior.

## Evidence

Both independent Standards and Spec reviews (Astra medium) cleared the final
source. A bounded adversarial retry/recovery review (Astra high) also found no
remaining defect. Grok authentication was unavailable at the live check, so the
prescribed internal fallback reduced model diversity.

Parent verification of final worker source passed 58 tests across
`config_bounds`, `config_security`, `ingestion_client` and
`service_failure_matrix`; the same 58 tests passed on aggregate candidate
`414fd5b`. Documentation formatting and diff checks also pass. The coordinator
test exercises an actual HTTP 401,
termination after one request, reopening SQLite with unchanged pending bytes,
atomic protected-file replacement, loading through the production startup
helper, and successful delivery of those same bytes using the replacement
credential. Configuration tests load distinct ingestion, authority, bridge and
gateway values through those same helpers.

The worker also reports formatting, strict clippy, deployment JSON and diff
checks passing. Its full Rust package run passed before the bounded scheduler
correction; final targeted checks cover that correction. The earlier full run
is not represented as full-suite execution against the final source.

## Remaining acceptance

The test recreates the coordinator, store and HTTP client. It does not launch
the binary under systemd or contact a live Matrix homeserver. Supervisor
behavior is supported by configuration and exit-path review. Wiremock responses
prove the caller boundary; the actual Rust-to-Platform-to-Communicator boundary
must still be exercised when Communicator adopts shared verification and local
principal bindings. Full T11 and MVP acceptance remain open.
