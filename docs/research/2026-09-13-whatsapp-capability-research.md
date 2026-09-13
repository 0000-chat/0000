# WhatsApp capability research: mautrix-whatsapp, Synapse, and Matrix

**Assessment date:** 2026-09-13  
**Area:** 4 — WhatsApp provider capabilities and the Matrix gateway boundary  
**Evidence rule:** “Supported” means documented by a pinned release or primary
source. “Conditional” means the source/config supports it but permissions,
provider state, or a local setting still gates it. “Unverified” needs a live
linked-phone test. “Current local” describes this repository, not upstream
potential.

## Version and architecture boundary

This report covers personal WhatsApp through the unofficial linked-device
protocol used by `mautrix-whatsapp` and `whatsmeow`. It does not cover the
WhatsApp Business Cloud API. The upstream bridge describes itself as a
Matrix–WhatsApp puppeting bridge based on `whatsmeow` ([upstream v26.08 tree](https://github.com/mautrix/whatsapp/tree/v0.2608.0));
`whatsmeow` provides the web multi-device connection, message receive/send,
group management, contacts, and receipts ([whatsmeow README](https://github.com/tulir/whatsmeow)).

The repository pins `dock.mau.dev/mautrix/whatsapp:v26.08` at digest
`sha256:86237c4d0d33a1e08910b1f820e6c561f9b8e21dc26943caf266e01021087002`
and Synapse `v1.159.0` at digest
`sha256:edf259d2b575b669a3e81024918ab8d5cfb7d2fba5a53c9e09695f1abc5645cb`
([image lock](../../deploy/images.lock.env#L1)). The matching upstream release
is `v0.2608.0`, commit `e7e5e57` ([release](https://github.com/mautrix/whatsapp/releases/tag/v0.2608.0)).
The registry digest was not independently mapped to that Git commit. The
release's `go.mod` pins `maunium.net/go/mautrix v0.30.0`, so this release uses
the `mautrix-go` bridgev2 APIs ([pinned go.mod](https://raw.githubusercontent.com/mautrix/whatsapp/v0.2608.0/go.mod)).
The pinned source tree contains `pkg/connector/commands.go`,
`capabilities.go`, and `startchat.go` ([pinned connector tree](https://github.com/mautrix/whatsapp/tree/v0.2608.0/pkg/connector)).
Claims from upstream `main` or the Element fork remain current-source evidence,
not proof of this pinned image.

The local gateway starts its Matrix cursor at “now”; historical retrieval is a
separate operator-requested, bounded Matrix backfill with a room mapping and
time range ([gateway backfill design](../superpowers/specs/2026-09-09-communicator-matrix-gateway-design.md#L367-L379)).
That path is distinct from asking WhatsApp for an older history-sync blob.

## Capability matrix

| Capability | Primary-source result | Current local verdict |
|---|---|---|
| Initial history | WhatsApp sends a one-time history-sync blob from the phone. The v26.08 config defaults to about three months; `request_full_sync` raises the request to about one year, and its comment says the observed practical limit appears to be about three years. That is an observation, not a provider guarantee; size and phone storage still constrain the result ([v26.08 config](https://docs.mau.fi/configs/mautrix-whatsapp/v26.08.html)). | **Not product-available locally.** `max_initial_conversations: 0` suppresses automatic portal creation, while `request_full_sync: false` leaves the shorter request ([renderer](../../scripts/render-whatsapp-config.py#L62)); this setting alone does not prove WhatsApp sends no blob. With backfill disabled, there is no current path that makes that history retrievable in Communicator. There is no supported promise of unlimited history. |
| Backfill and retrieval | Mautrix documents backfill as primarily a one-time WhatsApp sync, with backfill applying to newly created Matrix rooms. It cannot re-request the original blob without logout/login, and Matrix appends imported events at the room tail ([backfill docs](https://docs.mau.fi/bridges/general/backfill.html)). `whatsmeow` has a history-sync request primitive, but the bridge docs say WhatsApp on-demand history is not implemented; v26.08 explicitly defaults `backwards_on_demand` to false and limits it to a backfill queue ([config](https://docs.mau.fi/configs/mautrix-whatsapp/v26.08.html)). | **Blocked locally and unsuitable as arbitrary retrieval.** Backfill is disabled and its limits are zero ([renderer](../../scripts/render-whatsapp-config.py#L66)). |
| Live import while old history loads | The bridge can receive new messages while a linked session runs, but its history path has no product-level import progress, known-gap model, or guarantee that recent messages appear in a separate live view while an old import is being appended. | **Unverified/partial.** The agreed behavior requires recent availability plus progress and known gaps ([product alignment](../product-alignment.md#L11)); the gap assessment records this as partial ([gap assessment](2026-09-13-built-vs-agreed-scope.md#L86-L90)). No live proof exists. |
| Text, image, document, voice | The pinned connector capabilities mark JPEG images fully supported; PNG/WebP partial; audio MPEG/MP4/Ogg/AAC/AMR fully supported; Opus voice (`audio/ogg; codecs=opus`) fully supported; generic files (`*/*`) fully supported. The pinned maximum file size is 2,000 MiB ([pinned capabilities](https://raw.githubusercontent.com/mautrix/whatsapp/v0.2608.0/pkg/connector/capabilities.go#L87-L157)). | **Conditional.** The types and size are documented upstream. Local `public_media` and `direct_media` are optional serving modes and are disabled ([renderer](../../scripts/render-whatsapp-config.py#L56)); this does not disable ordinary Matrix encrypted-MXC portal media, but Communicator has no live attachment proof or file API. |
| Encrypted media download | Synapse stores media as `mxc://` content. Current Matrix specifies authenticated `GET /_matrix/client/v1/media/download/{serverName}/{mediaId}` ([Matrix media API](https://spec.matrix.org/v1.14/client-server-api/#get_matrixclientv1mediadownloadservernamemediaid)). For encrypted rooms, the media bytes are ciphertext and the client must decrypt with the key in the event ([Synapse admin FAQ](https://element-hq.github.io/synapse/latest/usage/administration/admin_faq.html)). | **Conditional, then unverified.** A backend media adapter acting for an authorized agent needs Matrix access, media fetch, and E2EE key handling; the external agent should receive the agreed API result rather than a bridge token. Communicator has no authenticated file API today. |
| Expired WhatsApp media | The v26.08 config says expired media is no longer on WhatsApp servers; a recycle reaction can request media, and automatic requests apply during/after backfill ([config](https://docs.mau.fi/configs/mautrix-whatsapp/v26.08.html)). | **Unverified.** Local backfill is disabled, so the documented automatic backfill recovery cannot run; `direct_media` being disabled only removes an optional serving mode and does not by itself prove ordinary portal media failure. |
| Contacts and names | The pinned connector advertises contact-list lookup, phone lookup, identifier resolution, and user search (`ContactList`, `LookupPhone`, `ResolveIdentifier`, and the exported `GetContactList`, `SearchUsers`, `ResolveIdentifier` methods) ([pinned capabilities](https://raw.githubusercontent.com/mautrix/whatsapp/v0.2608.0/pkg/connector/capabilities.go#L15-L36), [pinned connector API](https://pkg.go.dev/go.mau.fi/mautrix-whatsapp@v0.2608.0/pkg/connector)). The config exposes PushName, BusinessName, phone, and contact-list FullName in display-name templates ([v26.08 config](https://docs.mau.fi/configs/mautrix-whatsapp/v26.08.html)). | **Conditional, with a product gap.** Name matches can be ambiguous; upstream support does not establish Communicator’s “never guess” policy. Persist a provider contact ID and account binding, and require explicit confirmation for multiple candidates. |
| Phone IDs and 1:1 creation | v26.08 release notes say direct chats switched to LIDs rather than phone numbers ([release](https://github.com/mautrix/whatsapp/releases/tag/v0.2608.0)). The pinned bridgev2 provisioning schema defines `GET /_matrix/provision/v3/resolve_identifier/{identifier}` and `POST /_matrix/provision/v3/create_dm/{identifier}`, with optional `login_id`; the result can include the resolved provider ID, Matrix user ID, and DM room ID ([pinned provisioning schema](https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.yaml#L401-L449)). The pinned WhatsApp capabilities set `CreateDM` and `LookupPhone` true ([pinned capabilities](https://raw.githubusercontent.com/mautrix/whatsapp/v0.2608.0/pkg/connector/capabilities.go#L15-L36)). | **Conditional upstream; unavailable locally.** Phone input must resolve to the account’s current JID/LID; phone number alone is not a stable conversation key. Provisioning is disabled ([renderer](../../scripts/render-whatsapp-config.py#L50)). |
| Group create/rename/add/remove | The pinned bridgev2 schema defines `POST /_matrix/provision/v3/create_group/{type}` with `GroupCreateParams`; WhatsApp advertises `type=group`, required participants (minimum one), name (maximum 100), and optional parent/disappearing settings ([pinned provisioning schema](https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.yaml#L451-L501), [pinned capabilities](https://raw.githubusercontent.com/mautrix/whatsapp/v0.2608.0/pkg/connector/capabilities.go#L15-L43)). The connector marks Matrix Invite/Kick/Leave and group name/avatar/topic state as supported; its group mapping represents admins at power 50 and superadmins at 75 ([pinned capabilities](https://raw.githubusercontent.com/mautrix/whatsapp/v0.2608.0/pkg/connector/capabilities.go#L158-L188), [pinned group mapping](https://github.com/mautrix/whatsapp/blob/v0.2608.0/pkg/connector/chatinfo.go#L1788-L1904)). | **Conditional/unverified.** A pinned route and connector capability exist, but Matrix room creation alone does not create a WhatsApp group, and no universal participant/group limit was found. Provider permissions and operation-specific results need live testing; this report does not assert that every creation/read operation requires admin. |
| Multiple accounts | Mautrix permissions are per Matrix user, and its bridge model supports multiple logged-in user sessions ([v26.08 permissions](https://docs.mau.fi/configs/mautrix-whatsapp/v26.08.html)); no upstream universal account-count promise was found. | **No product cap, implementation bound.** Product alignment says the pilot starts with two or three accounts ([alignment](../product-alignment.md#L11)). The local directory rejects more than 64 identity connections ([guard](../../apps/control-plane/worker/control-directory/read-repository.ts#L120), [constant](../../packages/contracts/src/projection.ts#L28)); 64 is a contract/implementation bound, not a WhatsApp product capacity claim. |
| Provider receipts | The pinned connector capability sets `ReadReceipts: true` and exports `HandleMatrixReadReceipt`; the roadmap also lists receipts in both directions ([pinned capabilities](https://raw.githubusercontent.com/mautrix/whatsapp/v0.2608.0/pkg/connector/capabilities.go#L158-L188), [pinned connector API](https://pkg.go.dev/go.mau.fi/mautrix-whatsapp@v0.2608.0/pkg/connector), [roadmap](https://github.com/mautrix/whatsapp/blob/v0.2608.0/ROADMAP.md#L195-L252)). The local renderer does not set a provider delivery-receipt policy; Matrix product reads are intended to be stored reads only. | **Conditional/unverified.** The pinned source has the capability, but a provider receipt acceptance test with a real phone is required before promising WhatsApp-side read/delivery state. |

## Exact Matrix and bridge access surface

For an authenticated Matrix agent client, the standard routes are defined by
the [Matrix Client–Server API](https://spec.matrix.org/v1.14/client-server-api/):

* receive and retrieve events with `GET /_matrix/client/v3/sync` and room
  pagination;
* send `m.room.message` with `PUT
  /_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}`;
* create a Matrix room with `POST /_matrix/client/v3/createRoom`, invite with
  `POST /_matrix/client/v3/rooms/{roomId}/invite`, and manage Matrix membership
  with `POST .../kick` or `POST .../leave`;
* change Matrix room name/topic or membership state with `PUT
  /_matrix/client/v3/rooms/{roomId}/state/{eventType}/{stateKey}`;
* set a Matrix read marker with `POST
  /_matrix/client/v3/rooms/{roomId}/read_markers`, typing with `PUT
  .../typing/{userId}`, and upload media using the Matrix content repository;
  the v1.14 upload endpoint is `POST /_matrix/media/v3/upload` (the spec is
  moving downloads to authenticated `/client/v1/media/*` routes);
* send a Matrix receipt explicitly with `POST
  /_matrix/client/v3/rooms/{roomId}/receipt/{receiptType}/{eventId}`. This is a
  Matrix receipt operation and does not establish that WhatsApp accepted a
  provider read receipt;
* download authenticated media using the v1 media route above.

These are Matrix capabilities, not proof that WhatsApp will accept the action.
The pinned roadmap says the bridge maps Matrix sends, room metadata, membership,
and receipts to WhatsApp, subject to WhatsApp permissions ([roadmap](https://github.com/mautrix/whatsapp/blob/v0.2608.0/ROADMAP.md)).
The bridge management command family in a current Element fork includes `login`,
`logout`, `list`, `search`, `open`, `pm`, `create`, `join`, `accept`, group
invite/link commands, `sync`, and connection commands
([current command source](https://github.com/element-hq/mautrix-whatsapp/blob/element-main/commands.go)).
The pinned v26.08 tree has a reorganized `cmd/mautrix-whatsapp` plus `pkg`
layout, and this read did not find a version-pinned `commands.go` or
`provisioning.go` equivalent to the fork files. The fork source is therefore
indicative only; exact command names, permission checks, and behavior remain
blocked on pinned-binary/source verification before making them an agent API.

The provisioning HTTP surface is also conditional and currently disabled. The
current fork source registers `/v1/ping`, WebSocket `/v1/login`, session controls,
`/v1/contacts`, `/v1/groups`, `/v1/resolve_identifier/{number}`,
`/v1/bulk_resolve_identifier`, `/v1/pm/{number}`, group open/resolve/join
routes, under the configured provisioning prefix ([provisioning source](https://github.com/element-hq/mautrix-whatsapp/blob/element-main/provisioning.go)).
The local config sets `shared_secret: disable` and `allow_matrix_auth: false`,
so an agent cannot call these routes in the existing deployment; the exact
pinned provisioning surface is unverified
([renderer](../../scripts/render-whatsapp-config.py#L50)).

The current Communicator Matrix gateway is narrower still. Its transport calls
only `/sync` and `/keys/query` ([HTTP transport](../../services/matrix-gateway/src/matrix_http.rs#L157-L200));
the design explicitly excludes message sends, reactions, read receipts, and
typing ([gateway design](../superpowers/specs/2026-09-09-communicator-matrix-gateway-design.md#L42-L48)).
It is therefore a receive-only ingestion path, not an agent bridge client.

## Reusable paths and bounded proof needed

Reusable pieces are the pinned appservice/Synapse topology, explicit
tenant/account/room ownership, the receive-side `/sync` and E2EE handling, and
the archive/projection boundary. The next proof should use a sacrificial linked
personal phone and record: initial history age and missing ranges; whether new
messages stay retrievable during import; image/document/voice download and E2EE
decryption; expired-media recovery; duplicate-name and LID resolution; 1:1 and
group creation; rename/add/remove as owner and non-owner; two or three sessions;
and provider delivery/read receipt responses. This was not run: no credentials,
mobile sessions, provider sends, or live connection flows were used for this
research.
