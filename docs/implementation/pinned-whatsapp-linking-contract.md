# Pinned mautrix-whatsapp account-linking contract

Assessment: 2026-09-13. Research only; no live account, send, deploy, or
issue write was performed.

## Pin and source mapping

- Local lock: `dock.mau.dev/mautrix/whatsapp:v26.08@sha256:86237c4d0d33a1e08910b1f820e6c561f9b8e21dc26943caf266e01021087002` (`deploy/images.lock.env:4`).
- A registry-only `docker buildx imagetools inspect` verified that `v26.08` currently resolves to that exact index digest. It has linux/amd64 manifest `sha256:f9d46d...` (config blob `sha256:4d4533...`) and arm64 manifest `sha256:76035b...`; no image layers were pulled.
- The upstream release page maps `v26.08` to Git tag `v0.2608.0`, commit `e7e5e57`: <https://github.com/mautrix/whatsapp/releases/tag/v0.2608.0>. The pinned source sets bridge version `26.08` and `SemCalVer: true`: <https://github.com/mautrix/whatsapp/blob/v0.2608.0/cmd/mautrix-whatsapp/main.go#L15-L21>.
- `v0.2608.0/go.mod` pins `maunium.net/go/mautrix v0.30.0`: <https://raw.githubusercontent.com/mautrix/whatsapp/v0.2608.0/go.mod#L8-L21>. The amd64 OCI config was only 2.3 KB and had no labels/source revision. Therefore the tag/release correspondence is verified, but a cryptographic image-digest-to-Git-commit mapping is **not proven**. Do not cite current `main` or the Element fork as proof of the image.

## Exact bridgev2 HTTP contract

The base path is `/_matrix/provision`; mautrix-go v0.30.0 registers these
routes in the bridge appservice: <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.go#L110-L179>.

- `GET /_matrix/provision/v3/login/flows` returns two pinned WhatsApp flows:
  `qr` (QR) and `phone` (pairing code): <https://github.com/mautrix/whatsapp/blob/v0.2608.0/pkg/connector/login.go#L1180-L1214>.
- `POST /_matrix/provision/v3/login/start/qr` starts a process and returns a
  `LoginStep` containing a process `login_id`, `step_id`, opaque `txn_id`, and
  `display_and_wait: {type: "qr", data: ...}`. The optional `login_id` query
  parameter is an existing login to override/relink; `client_http=1` is an
  unrelated client-proxy option. Generic start/step semantics are in
  <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioninglogin.go#L72-L137> and the step schema is
  <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.yaml#L768-L812>.
- There is no dedicated poll or refresh route. For a QR (or pairing code)
  `display_and_wait` step, call
  `POST /_matrix/provision/v3/login/step/{process_id}/{step_id}/display_and_wait?txn_id={txn_id}`
  with no body. The bridge blocks until the next step/QR, then returns a new
  transaction ID. QR rotation is 1 minute, then five 20-second intervals;
  after the final QR the process is cancelled and returns
  `FI.MAU.WHATSAPP.LOGIN_TIMEOUT`: <https://github.com/mautrix/whatsapp/blob/v0.2608.0/pkg/connector/login.go#L1546-L1588> and <https://github.com/mautrix/whatsapp/blob/v0.2608.0/pkg/connector/login.go#L1693-L1776>.
- For phone-code login, start `phone`, then submit
  `POST /.../login/step/{process_id}/fi.mau.whatsapp.login.phone/user_input?txn_id=...`
  with `{"phone_number":"+<international number>"}`. The response is a
  `display_and_wait` code step; submit that step to wait for completion. The
  connector calls `whatsmeow.Client.PairPhone`: <https://github.com/mautrix/whatsapp/blob/v0.2608.0/pkg/connector/login.go#L1477-L1544>.
- `POST /_matrix/provision/v3/login/cancel/{process_id}` cancels the process,
  calls the connector's `Cancel`, removes it from the in-memory process map,
  and returns `{}`: <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioninglogin.go#L189-L200>.
- `POST /_matrix/provision/v3/logout/{login_id}` logs out one login;
  `/logout/all` logs out all. The handler verifies the selected login belongs
  to the authenticated Matrix user: <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.go#L367-L386>.

## Auth and scope

- In the pinned local renderer, provisioning is disabled (`shared_secret:
  disable`, `allow_matrix_auth: false`): [renderer](https://github.com/0000-chat/0000-communicator/blob/main/scripts/render-whatsapp-config.py#L50-L54).
  mautrix-go returns `403 Provisioning API is disabled` whenever the secret
  is shorter than 16 characters: <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.go#L220-L243>.
- If enabled for the trusted backend, the default auth is
  `Authorization: Bearer <shared_secret>` plus `?user_id=@...`; matrix access
  token auth is only accepted when `allow_matrix_auth: true`. The middleware
  validates the token/current user, then requires `user.Permissions.Login`:
  <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.go#L239-L288>. Keep this secret backend-only; do not proxy it to the browser, API/MCP agent, or logs.
- Account scope is per bridge Matrix user. `GET /v3/logins` returns that
  user's IDs; an explicit `login_id` is accepted only when its `UserMXID`
  equals the authenticated user: <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioning.go#L388-L427>.
- Caveat: `PostLoginStep` and `PostLoginCancel` look up the random process ID
  but do not repeat an owner check against the authenticated user:
  <https://raw.githubusercontent.com/mautrix/go/v0.30.0/bridgev2/matrix/provisioninglogin.go#L138-L200>. The Communicator adapter must bind process ID to its own administrator/attempt generation and reject cross-user or stale callbacks; do not expose raw bridge process IDs to agents.

## Provider identity evidence

- The pinned connector waits for `whatsmeow` `PairSuccess`, then creates a
  `UserLogin` with `newLoginID := waid.MakeUserLoginID(wl.LoginSuccess.ID)`;
  `RemoteName`/profile phone are `+<ID.User>`, `RemoteProfile.Name` is
  `BusinessName`, and metadata stores `WADeviceID: ID.Device`. The complete
  step returns `user_login_id`: <https://github.com/mautrix/whatsapp/blob/v0.2608.0/pkg/connector/login.go#L1647-L1689> and <https://github.com/mautrix/whatsapp/blob/v0.2608.0/pkg/connector/login.go#L1778-L1863>.
- `waid.MakeUserLoginID` accepts only the default WhatsApp user server and
  returns the JID user (phone-number account key); it does not use the LID as
  the login ID: <https://raw.githubusercontent.com/mautrix/whatsapp/e7e5e57/pkg/waid/id.go#L45-L77>.
- `whatsmeow`'s pair-success event carries both JID and LID and persists the
  mapping: <https://raw.githubusercontent.com/tulir/whatsmeow/fb386f152837/pair.go#L104-L150>. Use the returned `user_login_id`/phone JID as the account identity evidence, retain device/LID metadata only as supporting evidence, and run a live sacrificial-account test before promising duplicate/relink semantics.

## Minimal capability experiment before implementation is accepted

In a disposable deployment, enable a random >=16-character shared secret,
keep `allow_matrix_auth: false`, call the routes only from the trusted backend,
and use a sacrificial phone. Verify: `flows -> start/qr -> display_and_wait`
QR rotation/expiry -> cancel; scan success returns a complete
`user_login_id`; `GET /logins` exposes the same ID; repeated same-account relink
keeps that identity; different-account relink returns a different ID; logout
removes the login and blocks a stale process callback. Record only redacted
status/identity, never QR data or session credentials.

