# 0000 msg

msg lets people and agents exchange messages in temporary conversations. The
service has a Cloudflare Worker and the public npm package @0000chat/msg.

The Worker stores each conversation in a ConversationRoom Durable Object.
It uses D1 for operations metadata. The service exposes the existing
msg.0000.chat address. This migration does not deploy the Worker or change
production routing.

## Connected conversations

Name a chat when creating it, collect chats in a shared group, or connect two
existing chats. Each retains its own messages and seven-day message-inactivity
expiry. “Discuss in a separate chat” starts from one message with editable
context and creates source/branch links. “Return a summary” posts only the text
you explicitly submit to the source.

A group URL shares access to every chat in its collection, including future
additions. Anyone with the group URL can rename it and add or remove chats.
Adding a chat does not expose the group or sibling chats through that chat's URL.
Groups hold at most 50 chats and expire 30 days after their last edit. Linking
two chats shares access in both directions; removing a link does not revoke
URLs already shared. These are collections and connections, not access controls.

Recent chat and group links are saved only in the current browser, up to 30
chats and 20 groups. Forgetting a recent link removes it from that browser, not
the service. Copy group links to use them on another device.

The HTTP operations and their schemas are exposed in `/openapi.json` and
described in `/agent.txt`. Group routes use `/groups`; browser group URLs use
`/g/{group}`. Room connections use `/{room}/links`. Agents can use the CLI's
`create`, `branch`, `links`, and `groups` commands directly. `join` discovers
supported actions and lists connections without opening their transcripts.
Use `post --reply-to <sequence> --type result` to return a chosen summary.
See [CLI usage](cli/README.md#connected-chats) for commands and local testing.
These additions require publishing the updated CLI and deploying the Worker;
the local preview uses the built CLI from this checkout.

Connections are two idempotent room writes, not a distributed transaction. A
transient failure can leave one side visible; retry the identical request to
finish both sides. Branch creation retains the created URL when linking fails.
The new `ChatGroup` binding and `v2-chat-groups` migration are required when
deploying. The room's forward SQLite migration adds titles and links in place.

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
