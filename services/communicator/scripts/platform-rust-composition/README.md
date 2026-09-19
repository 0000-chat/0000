# Platform-issued Rust caller composition

This fixture exercises the production Rust HTTP callers against a local
Platform Worker and a separate local Communicator Worker/D1 state. Every setup
input is checked in beside this file. The runner creates a temporary state
directory, starts both Workers, provisions a service principal, grant, and two
finite credentials through Platform's account HTTP endpoints, seeds only the
Communicator binding/resource rows, and removes the local processes and state
when it finishes.

The simulated GitHub responses live inside the checked-in Platform bridge. They
only establish the human Platform session required to call the service
principal and credential endpoints. No `platform_credential` row is inserted by
the fixture. The Communicator SQL template contains no credential value.

Run from the Communicator workspace:

```sh
node scripts/platform-rust-composition/run.mjs
```

The runner executes these stages in order:

1. start a fresh Platform Worker from the current `services/platform/src` and
   apply all current Platform migrations;
2. use the public account routes to create one service principal, one grant,
   and two finite credentials;
3. apply all current Communicator migrations and seed the exact local binding,
   gateway route, account capability grants, and four committed reservations;
4. run the checked-in ignored Rust test
   `issued_platform_credential_reaches_live_ingestion_and_claim`;
5. revoke the first credential through the public Platform revoke route; and
6. run
   `revoked_credential_pauses_and_replacement_credential_recovers_both_callers`.

The first test has two assertions: ingestion returns `Accepted` and the
outbound claim returns `Allowed`. The recovery test has six assertions: the
revoked ingestion caller is `Paused` with `ingestion_unauthorized`, the direct
revoked claim request is HTTP 401, the Rust claim caller is `Uncertain`, and the
replacement credential returns `Accepted` and `Allowed` for the two callers.
The direct 401 check distinguishes credential revocation from a transport or
malformed-response uncertainty.

The runner prints only fixed statuses, exit codes, ports, and cleanup state. It
does not print credentials, OAuth callback values, claim bodies, or response
payloads. The combined safe run log is written to
`/tmp/platform-t11-rust-composition.log`; set `T11_RUST_RUN_LOG` to choose a
different path. Set `T11_KEEP_STATE=1` to retain the temporary local state for
inspection after the runner stops both processes. The default cleanup removes
that state and leaves no issued credential artifact behind.

The test uses the explicit Rust `loopback-test` feature because the local
Workers use HTTP. Production Rust constructors remain HTTPS-only. No remote
Wrangler, deployment, or external provider write is performed.
