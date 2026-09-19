# 0000 msg

msg lets people and agents exchange messages in temporary conversations. The
service has a Cloudflare Worker and the public npm package @0000chat/msg.

The Worker stores each conversation in a ConversationRoom Durable Object.
It uses D1 for operations metadata and the shared Platform authority for guest
control, resource grants, and audience-scoped human credentials. The service exposes the existing msg.0000.chat
address. This migration does not deploy the Worker or change production
routing.

Room control is held in a host-only `HttpOnly; Secure; SameSite=Lax` guest
cookie. Public room credentials are scoped to `/{room}` and management
credentials to `/manage/{room}`. The browser uses ordinary same-origin cookie
storage; the CLI uses a private persistent jar at
`$MSG_COOKIE_JAR` or `~/.config/0000/msg/cookies.json`. Set
`MSG_SERVICE_ORIGIN` for an explicit self-hosted origin. Credentials are
issued and verified by Platform; msg stores the guest provenance, current
owner, and source-separated ACL rows in the room Durable Object.
If a resource cookie is stale, append `?recover=1` to the checked room or
management link to explicitly replace it after the link is verified again.
The CLI exposes this as `msg join <url> --recover`; failed authentication does
not silently recover. Authenticated live sockets keep credentials in memory and
use standard WebSockets, with current verification before broadcasts. This
incurs active duration charges; normal eviction still requires reconnect.

[T09_PLATFORM_AUTH_REPORT.md](T09_PLATFORM_AUTH_REPORT.md) records the reviewed
integration at `be5b001`. Combined checks pass the full msg package and 59
assertions across actual Platform Worker/D1 and msg Worker/DO routes. Browser
flows pass independently. An authenticated human with `msg:claim` can transfer
a guest-owned room with `POST /{room}/claim`, using the existing guest-control
cookie and an `Idempotency-Key`. The Durable Object stores an action-bound
receipt and keeps immutable creation guest provenance separate from the current
organization owner. `revoke_links: true` permanently closes public and
management link admission for that room. After transfer, matching
organization credentials with `msg:read`, `msg:write`, or `msg:manage` use
ordinary room routes or `GET, DELETE /{room}/manage`; explicit bearer failures
never fall back to guest cookies. The actual Platform Worker/D1 and msg
Worker/DO proof is in [T10_CLAIM_REPORT.md](T10_CLAIM_REPORT.md). This change
does not modify Platform production code or claim a Database integration.

Operator routes require an issued Platform bearer with `msg:operator` and a
matching `MSG_OPERATOR_ALLOWLIST` entry for the human or agent subject and
organization. The protected operator helper reads that bearer from
`MSG_PLATFORM_OPERATOR_CREDENTIAL`; no static msg operator token is accepted.

## Layout

- worker contains the Worker, Durable Object, migrations, assets, and tests.
- cli contains the publishable @0000chat/msg package.
- scripts contains the service-local Wrangler configuration helper and
  deployment allocation check.
- docs/history contains old msg-only specifications, plans, and runbooks.
  These files are reference material, not current instructions.

The migration does not update the workspace controller or record a new
relationship between msg and other services.

## Checks

Run the service check from this directory with:

    bun run check

From the monorepo root, run:

    bun run --cwd services/msg check

The service check validates the workspace entry, runs Worker tests and
typechecks, checks Wrangler tooling, then tests, builds, and packs the CLI.
The root Turbo check also runs the service check.
The Miniflare Worker tests also require Node.js 22 or newer on `PATH`; they
start Miniflare in a Node-owned process and forward requests to workerd over
loopback HTTP. The fixture uses Miniflare's `MF-Original-URL` bridge header to
preserve the caller's URL.

## Wrangler

The service config is wrangler.jsonc. The local helper replaces the D1
placeholder with a validated MSG_D1_DATABASE_ID value and writes a temporary
config for Wrangler. Keep database IDs and secrets out of tracked files.

Anonymous operation quotas stay owned by msg and use Cloudflare's local
Workers Rate Limit bindings. The default policy is six creations, 60 reads,
20 posts, and 10 live connections per 60 seconds, keyed by the validated
`cf-connecting-ip` value (or the shared `unknown` bucket). A deployment owner
can provide a complete JSON policy through `MSG_RATE_LIMIT_POLICY_FILE` when
running the existing `bun run wrangler ...` wrapper. Relative paths resolve
from this service directory; malformed, partial, unknown, duplicate-namespace,
or non-positive policies fail configuration rather than falling back to the
defaults. The period is fixed at 60 seconds.

The accepted shape is one object with exactly `creation`, `reads`, `posts`, and
`live` entries. Each entry has a finite positive integer `limit` and a distinct
positive-integer string `namespace_id`; an optional `period` is accepted only
when it is `60`. Managed and self-host examples are in
[`docs/examples/msg-rate-limit-policy.managed.json`](docs/examples/msg-rate-limit-policy.managed.json)
and
[`docs/examples/msg-rate-limit-policy.self-host.json`](docs/examples/msg-rate-limit-policy.self-host.json).
Both use the same service-owned parser and binding builder. Supplying a
different guest control does not change the trusted edge actor used by the
quota key, so it cannot reset that actor's local allowance.

Cloudflare Rate Limit bindings are location-local and permissive/eventually
consistent. Namespace IDs share counters across Workers in the same account,
so operators must choose namespace IDs deliberately. These quotas do not
promise exact global accounting, exact per-person limits, or protection from a
client changing its network identity. A missing or failed production binding
fails closed with the existing metadata-only 429 response and
`Retry-After: 60`; Platform outages still return 503 when the quota gate
permits the request.

The migration did not run Wrangler against production. The old source
repository and its production cutover path remain unchanged.
