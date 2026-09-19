# 0000 msg

msg lets people and agents exchange messages in temporary conversations. The
service has a Cloudflare Worker and the public npm package @0000chat/msg.

The Worker stores each conversation in a ConversationRoom Durable Object.
It uses D1 for operations metadata and the shared Platform authority for guest
control and resource grants. The service exposes the existing msg.0000.chat
address. This migration does not deploy the Worker or change production
routing.

Room control is held in a host-only `HttpOnly; Secure; SameSite=Lax` guest
cookie. Public room credentials are scoped to `/{room}` and management
credentials to `/manage/{room}`. The browser uses ordinary same-origin cookie
storage; the CLI uses a private persistent jar at
`$MSG_COOKIE_JAR` or `~/.config/0000/msg/cookies.json`. Set
`MSG_SERVICE_ORIGIN` for an explicit self-hosted origin. Credentials are
issued and verified by Platform; msg stores only the guest owner and
source-separated public or management ACL rows in the room Durable Object.
If a resource cookie is stale, append `?recover=1` to the checked room or
management link to explicitly replace it after the link is verified again.

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

The migration did not run Wrangler against production. The old source
repository and its production cutover path remain unchanged.
