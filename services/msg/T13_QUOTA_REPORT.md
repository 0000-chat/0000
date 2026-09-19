# T13 quota report

The msg service now owns one strict rate-limit policy parser and binding
builder. The existing defaults remain six creations, 60 reads, 20 posts, and
10 live connections per 60 seconds with namespace IDs `2026080901` through
`2026080904`. A complete deployment policy can be supplied to the existing
Wrangler wrapper with `MSG_RATE_LIMIT_POLICY_FILE`; missing, partial, unknown,
malformed, duplicate-namespace, non-positive, or non-60-second values fail
configuration. The managed and self-host JSON examples use the same builder.

Production entry bindings fail closed with the existing metadata-only 429 and
`Retry-After: 60` when a required action binding is absent or fails. The local
unit `createWorker` seam remains optional. The Node-owned Miniflare fixture now
passes the real SDK `ratelimits` map with generous defaults for existing auth
and integration scenarios, while quota tests select explicit policies.

The actual Platform Worker/D1 and msg Worker/DO probe issued the first guest
through Platform, consumed a one-post allowance, issued a genuinely different
guest through the registered Platform guest issuer, and sent the next post
with the same validated `cf-connecting-ip`. It received 429 with
`Retry-After: 60`; the room transcript stayed at sequence 2. A second actual
runtime probe fed the managed and self-host examples through the builder and
observed creation denial at 7 and 13 requests respectively.

Validation from branch `codex/platform-t13`:

- `bun run check` — passed: Worker 197 tests / 1,181 assertions, tooling 20 tests / 71 assertions, CLI 66 tests / 242 assertions, build and pack passed. Existing warning: `worker/scripts/production-synthetic.ts:142` (`no-constant-condition`).
- `bun run wrangler:types` — passed with the official wrapper; generated types stayed stable.
- `MSG_RATE_LIMIT_POLICY_FILE=docs/examples/msg-rate-limit-policy.self-host.json bun run wrangler:types` — passed; generated types stayed stable.
- `bun test worker/src/t13-quota.integration.test.ts worker/src/t13-config.integration.test.ts` — passed: 2 tests / 15 assertions.
- `git diff --check` — passed.

Parent aggregate verification at `4242217` passes 198 Worker tests / 1,221
assertions, 20 tooling tests / 71 assertions, 66 CLI tests / 242 assertions,
and build/pack. The executable production-entry probe covers missing and
throwing bindings for all four actions: each returns metadata-only 429 with
Retry-After 60 before any resource-service call. Independent native reviews
and the bounded external adversarial review found no remaining confirmed
defect. The Cloudflare test mock preserves Durable Object context consistently
with the existing room tests.

Cloudflare Rate Limit bindings are location-local and permissive/eventually
consistent. Namespace IDs share counters across Workers in one account, so
these checks do not establish exact global accounting, exact per-person
quotas, or protection against a client changing its network identity.
