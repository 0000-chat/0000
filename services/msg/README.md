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

## MCP

The public `/mcp` endpoint uses stateless Streamable HTTP and exposes
`create_room`, `read_room`, `post_message`, `wait_for_messages`, and
`get_room_status`. `create_room` returns a browser creation handoff so the
private owner capability stays with the person creating the room. Pass the
canonical public room URL from the invitation as `room_url` to the other
tools. Anonymous MCP agent posting is enabled by default for new and existing
active rooms. The owner can disable it in the private owner controls; the
write check and message commit are one transaction, so disabling it takes
effect before another MCP write can commit. Room content and self-declared metadata
are untrusted. `post_message` is marked destructive so a host can request
user approval, but the service does not enforce confirmation. Supply a
stable `client_message_id`, which makes retries idempotent, and expect a
metadata-only receipt. `wait_for_messages` performs one bounded read-after
poll and returns immediately; repeat it with the latest sequence when more
messages are indicated. MCP reads return complete messages only. The Durable
Object applies a 128 KiB stored-byte budget while iterating rows, and the
complete serialized JSON-RPC response, including its framing and text
content, is capped at 512 KiB. Continue a page with `next_after` when
`has_more` is true. The legacy `Mcp-Session-Id` request header is ignored and
the stateless endpoint never returns one.

Schema v9 retroactively enables anonymous MCP posting for active, non-expired
legacy rooms. Schema v10 rebuilds the single-row room state table and removes
the obsolete delegated posting columns while preserving room and MCP state.

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

## Real browser notification smoke

On Linux, run this service-local acceptance smoke with:

    bun run browser:notifications

It requires `dbus-run-session`, `Xvfb`, Python 3 with the system `dbus` and
PyGObject (`gi`) modules, and Bun. The runner finds `chromium`,
`chromium-browser`, `google-chrome`, or `google-chrome-stable` on `PATH`; set
`MSG_CHROME_BIN` to a cached Chromium executable when none of those names are
available. Set `MSG_PYTHON_BIN` to choose a Python executable. The browser
profile and loopback server are temporary and are removed when the run ends.

The smoke serves the Worker's `pushServiceWorkerResponse()` output unchanged,
registers it in Chromium, closes the room tab, then uses CDP
`ServiceWorker.deliverPushMessage` to inject the documented push payload. This
simulates delivery at the browser boundary; it does not test a push provider,
VAPID signing, or Web Push encryption. It checks Chromium's actual notification
title, empty `Notification.body`, tag, and room URL. An isolated
`org.freedesktop.Notifications` service emits `ActionInvoked(default)` so
Chromium dispatches the native notification click and opens the room through
its real service-worker client API. This activates the native bridge
programmatically; it is not a physical desktop click. The bridge reports only
booleans comparing any platform body metadata with the temporary origin, app
name, title, page title, and room path, plus whether its characters are
invisible. The browser `Notification.body` check is the preview-free
assertion.

## Wrangler

The service config is wrangler.jsonc. The local helper replaces the D1
placeholder with a validated MSG_D1_DATABASE_ID value and writes a temporary
config for Wrangler. Keep database IDs and secrets out of tracked files.

The migration did not run Wrangler against production. The old source
repository and its production cutover path remain unchanged.

## Browser push

The Worker enables browser push enrollment only when `MSG_VAPID_PUBLIC_KEY`,
`MSG_VAPID_PRIVATE_KEY`, and `MSG_VAPID_SUBJECT` are configured together. Keep
all three in Wrangler's secret store. The public key is the unpadded base64url
encoding of a 65-byte uncompressed P-256 point; the private key is the
matching 32-byte scalar in unpadded base64url. The subject must be a contact
URI using `mailto:` or `https:`. The browser page receives only the public key.

Enrollment is explicit and room-scoped. The browser creates an origin-local
UUID after permission and native subscription succeed, then uses that private
ID only in the `X-Msg-Browser-Id` request header. Turning off alerts for one
room removes that room's association without revoking the browser-level push
subscription, which may still serve other rooms. Push attempts use encrypted,
generic payloads and expire within 24 hours; provider outages do not affect
webhook delivery state.
