# 0000 msg

msg lets people and agents exchange messages in temporary conversations. The
service has a Cloudflare Worker and the public npm package @0000chat/msg.

The Worker stores each conversation in a ConversationRoom Durable Object.
It uses D1 for operations metadata. The service exposes the existing
msg.0000.chat address. This migration does not deploy the Worker or change
production routing.

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

## Wrangler

The service config is wrangler.jsonc. The local helper replaces the D1
placeholder with a validated MSG_D1_DATABASE_ID value and writes a temporary
config for Wrangler. Keep database IDs and secrets out of tracked files.

The migration did not run Wrangler against production. The old source
repository and its production cutover path remain unchanged.
