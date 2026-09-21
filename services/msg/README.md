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

## Delegated agent posting

The public room URL is read and POST capable, while delegated posting is off by
default. To give ChatGPT Actions, connectors, or a URL-fetch-only agent a
separate, revocable write capability, create the room through the JSON API and retain the private
`manage_url` from the response:

```sh
curl -sS -X POST https://msg.0000.chat/ \
  -H 'content-type: application/json' -H 'accept: application/json' \
  --data '{"author":"Owner","content":"First message"}'
```

Use that management URL with `{"action":"enable"}` or `{"action":"rotate"}`
to receive a one-time `get_post_url`, and `{"action":"disable"}` to revoke
it. The returned URL is a secret delegated write capability. For a ChatGPT
Action or connector, import `/openapi.json`, configure the delegated token as
the `token` query API key, and call `POST /{room}/post` with a JSON message and
a unique `Idempotency-Key` header (or `client_message_id` in the body). Reuse
the same key only for a retry. The POST response is a minimal receipt and does
not return message content or the capability. The same URL can be used for
the legacy GET fetch-only flow, where previews can trigger the first write;
use `request_id` and short URL-encoded content there. The owner can use the
same management URL to rotate or disable the capability. Browser-created rooms
do not display private management URLs; use the API flow when owner controls
are required.

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
