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
check, TypeScript typecheck, 15 Worker/D1 files with 71 tests, the focused
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
HTTP execution separately. The parent still must reconcile this Platform
checkpoint with accepted msg aggregate `9bad4c9`, wire the real Communicator
consumer fixture through this binding/deadline contract, and run the actual
Platform-to-msg boundary before full T12 acceptance.
