# T12 Platform server safeguards

This report records the Platform server safeguard implementation and the
boundaries of its local evidence. It does not claim deployed or full T12
acceptance.

Platform now classifies protected routes before request body, provider or D1
work and gates them with five native Cloudflare Rate Limit bindings:

| Group | Binding | Namespace | Default budget |
| --- | --- | ---: | ---: |
| Login and recovery | `PLATFORM_RATE_LIMIT_LOGIN` | `2026092001` | 30 / 60 seconds |
| Credential and OAuth issuance | `PLATFORM_RATE_LIMIT_ISSUANCE` | `2026092002` | 60 / 60 seconds |
| Account and organization management | `PLATFORM_RATE_LIMIT_MANAGEMENT` | `2026092003` | 60 / 60 seconds |
| Credential verification and introspection | `PLATFORM_RATE_LIMIT_VERIFICATION` | `2026092004` | 600 / 60 seconds |
| Guest control | `PLATFORM_RATE_LIMIT_GUEST_CONTROL` | `2026092005` | 120 / 60 seconds |

The policy builder in `src/rate-limit-policy.ts` validates a complete policy,
rejects unknown or partial keys, rejects duplicate namespaces and generates
both Wrangler and Miniflare native binding shapes. The native limit is a
per-location, eventually consistent Cloudflare limit. It is an abuse ceiling,
not an exact globally serialized counter. Missing or throwing bindings fail
closed with `503 {"status":"authority_unavailable"}`. Exhaustion returns `429`
with `Retry-After: 60` and `{ "status": "rate_limited" }`. The stable namespace
range is distinct from msg's accepted managed policy range,
`2026080901` through `2026080904`.

Protected work has one validated deadline: the default is 8 seconds and the
maximum accepted configuration is 30 seconds. The deadline covers native
limiting, handler execution and completed response-body reading. The request
is aborted when supported, while the caller still receives a finite 503 if a
dependency ignores abort. A late dependency result is observed and cannot
replace the timeout response.

Diagnostics use one allowlisted structured sink. Events contain only a fixed
event name, outcome, server time, server-generated correlation ID and verified
identifiers already available at the mutation boundary. Better Auth's logger
and `onAPIError` hook publish metadata only; raw errors, SQL/provider details,
headers, bodies, cookies and credential material are excluded. Lifecycle
success events are emitted after the relevant response or supported Better Auth
database hook confirms the committed mutation. A sink failure is best effort
and cannot change the authorization response or mutation result. Timeout and
later lifecycle completion use the same server correlation when both exist.

The final review fixes are covered by bounded actual checks. The Wrangler
wrapper now places its temporary policy config beside the service config, so
`.dev.vars` and default `.wrangler/state` stay service-relative; an isolated
fixture observes a generated-config `.dev.vars` marker and carries a local D1
migration/write/read across separate wrapper invocations before cleanup. Direct
provider unlink emits `platform.provider.unlinked` only after a one-row delete,
and the concurrent/last-account route check finds one success event with no
event for the denied operation. OAuth installation revoke emits its lifecycle
event after the first durable refresh-family phase; an injected later-batch
failure leaves the family revoked, returns unavailable, and preserves one
correlated event. Authentication success is emitted only after session creation;
the account-insertion failure callback remains an error redirect with no success
event, while the retry creates one confirmed success event.

The standalone Platform fixtures use the same native binding builder through
`scripts/test-rate-limits.ts`, with an explicit 10,000-request test policy so
long lifecycle suites do not accidentally exhaust production defaults. The
native proof in `scripts/test-native-rate-limits.mjs` starts two Miniflare
workers with the Platform binding names and verifies shared namespace/key
exhaustion, an independent source key and an independent namespace. The
Communicator consumer fixture must pass these five native bindings through its
Platform Miniflare worker using `convertV4MiniflareOptions`; it must not create
a second Platform limiter or reuse the Communicator namespace range. Set
`PLATFORM_SERVER_DEADLINE_MS` to the chosen value (default `8000`) and leave
`PLATFORM_RATE_LIMIT_POLICY_FILE` unset when using the reviewed defaults. The
Platform `wrangler` wrapper accepts that file variable (or a complete inline
`PLATFORM_RATE_LIMIT_POLICY` JSON value), validates the policy before starting
Wrangler, emits the native `ratelimits` section and writes the same canonical
policy into the Worker variable. Its config tests prove that a nondefault
policy changes the emitted native budgets and malformed policy fails before
deployment.

Local checks completed for this implementation include the Platform format
check, TypeScript typecheck, 15 Worker/D1 files with 72 tests, the focused
safeguard suite, config validation, the standalone native limiter proof, the
actual two-worker Platform HTTP boundary proof, restart persistence, and the
existing browser fixture configuration. The actual Platform boundary proof
shows shared login and issuance exhaustion across two workers, an independent
source key, positive body and D1 work on permitted requests, and zero body/D1
work after exhaustion. A separate streamed response test proves the same
finite deadline covers response-body reading.

The actual Worker/D1 OAuth tests exercise a direct Better Auth provider
access-token lookup and a generic GitHub callback with injected D1 failures.
They verify the client lookup precedes the token lookup, return 503, and find
neither message nor stack sentinels across error, warning, log, info and debug
channels. Actual guest-route tests prove a timeout and later committed
bootstrap event share one correlation ID, and that a throwing diagnostic sink
does not prevent the guest mutation. Organization tests cover zero-row
suppression and a committed event before a failing follow-up read.

The delayed guest proxy starts the D1 batch before waiting and dispatches the
original batch after the timeout; it is not a deployed Worker post-response
lifetime proof. The native boundary measures body and D1 work, not provider
HTTP execution separately. The accepted msg checkpoint is now reconciled with
this branch's isolated fixture proof and full msg check. The actual
Communicator composition and final combined T12 acceptance remain pending.

The three actual msg Platform integration scenarios now run in separately
owned Bun test children. This isolates the pre-existing same-process
Bun/workerd startup failure while preserving each scenario's production
Platform Worker/D1, msg Worker/DO, restart and concurrency paths. The worker-
cwd command with an explicit file list (`bun test
src/t13-quota.integration.test.ts
src/t09-platform.integration.test.ts src/t10-claim.integration.test.ts`) passed
3 parent tests; the children passed their 3 real tests with 183 assertions
(13 + 84 + 86), recorded in
`/tmp/platform-t12-msg-isolated-forced-order-final.log`. Each wrapper emits a
bounded structured child summary with its scenario, test count and assertion
count. Bun's explicit CLI file list selects the files but does not guarantee
their execution order; these runs observed T13 -> T09 -> T10, as shown in the
log. The normal three-file worker-cwd invocation also passed 3 parent tests in
`/tmp/platform-t12-msg-isolated-combined-worker-final.log`. The required
`bun run check` passed 270 Worker tests with 1,901 parent-level assertions, 13
tooling tests with 34 assertions, 67 CLI tests with 254 assertions, and 3
packaging tests with 18 assertions; its complete output is in
`/tmp/platform-t12-msg-isolated-full-check-final.log`. Child assertions are
reported separately because the parent wrapper intentionally does not
duplicate them.

The runner terminates the owned detached process group even if the Bun leader
has already exited, with bounded SIGTERM/SIGKILL escalation. A deliberate
child failure whose descendant retained the output pipe exited the parent with
1, left no owned descendant, and retained the bounded child output in a
mode-600 ignored artifact under
`services/msg/worker/.miniflare-tests/isolated-scenario-diagnostics/`; the
proof log is `/tmp/platform-t12-msg-isolation-descendant-failure.log`. The
existing browser smoke evidence remains valid because the browser fixture
source was unchanged (`/tmp/platform-t12-msg-browser-smoke.log`, exit 0). The
prior same-process T13 -> T09 -> T10 failure remains a local runtime-order
caveat. The parent baseline proof used a separate dynamic-import importer to
intentionally import T13, then T09, then T10 on pristine accepted baseline
`0509fc4`; that run reproduced the failure before this repair. The adapted
normal test commands use fresh process ownership for each scenario. On the
aggregate e9 source, the parent's dynamic-import importer then passed the same
intentional T13 -> T09 -> T10 sequence: 3 parent tests and 183 child
assertions in 22.55 seconds, exit 0 (`/tmp/platform-parent-final-msg-order.test.ts`,
`/tmp/platform-parent-final-msg-order.log`). Full Communicator adoption and
final combined T12 acceptance remain pending.
