# Personal mautrix-whatsapp Operations

## Simple explanation

The bridge is private: it runs only inside the existing Compose network and is
reachable through Matrix, not through a new public port. Keep its database,
configuration, registration, and linked-device state protected and backed up.

## Release procedure

1. Work from a clean `feat/matrix-core` checkout and build an archive from the
   exact commit being released. Never transfer Git history, local environment
   files, runtime data, backups, or secrets.
2. Verify the Contabo SSH alias, hostname `vmi3501337`, and `eth0` address
   `169.58.160.23` before any Docker command.
3. Compare the local and remote archive SHA-256 values before extracting under
   `/opt/communicator/releases/<commit>`.
4. Preserve a root-only, timestamped copy of the current Synapse configuration
   before activation. Do not print its contents.
5. Activate the verified release and run:

   ```bash
   sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh
   ```

   The deployment waits for PostgreSQL, initializes the separate bridge
   database/runtime, installs the appservice registration, and force-recreates
   Synapse, Caddy, and WhatsApp so registration changes are loaded. It never
   recreates volumes or drops databases.
6. Require `validate-core.sh` and `validate-whatsapp.sh` to pass. Public
   listeners remain limited to ports 22, 80, and 443; the bridge has no
   published port or Caddy route.
7. The renderer preserves the existing `encryption.pickle_key`. Never replace
   it during an ordinary release. Losing it makes the bridge database
   unrecoverable without a separately approved reset.

## Pairing and unlinking

Pairing is an interactive user action, never an automated deployment action.

1. Sign into Element as `@human:communicator.0000.gold`.
2. Open an encrypted private chat with `@whatsappbot:communicator.0000.gold`.
3. Send `login qr`, or send `login phone` and enter the phone number only in
   Element's interactive prompt.
4. On the physical WhatsApp phone, open Settings/Menu → Linked devices → Link
   a device, then scan the displayed QR code or enter the displayed eight-letter
   pairing code. Complete any passkey prompt.
5. Wait for the bridge's success response. Do not send a message to a real
   contact during pairing.

The bridge uses an unofficial WhatsApp web client. A physical phone is
preferred; WhatsApp may disconnect linked devices when the phone is offline for
an extended period, and account restrictions are possible. Pairing adds this
server as a linked device and creates bridge session state and Matrix portal
state.

To unlink, issue `logout` in the bridge management chat, confirm the account is
unauthenticated, and remove the linked device from the phone's Linked devices
screen if it remains. Take a fresh encrypted backup before pairing again.

## Break-glass rollback

1. Stop only the `whatsapp` service if it is unsafe or unhealthy.
2. Preserve the bridge runtime, database, registration, and encrypted backup.
3. Activate the previous verified release and restore the protected pre-change
   Synapse configuration when required.
4. Restart Synapse with health checks, then run the core validator.

Never delete Matrix data, users, rooms, PostgreSQL volumes, bridge session
state, or secrets as part of rollback.

If the pickle key is lost, first preserve a protected database dump and config
backup. A reset may target only the separate `whatsapp_bridge` database and
requires explicit destructive approval. Never reset `synapse` or production
Matrix data.

## Backup coverage

The encrypted backup must include the separate bridge database, bridge config,
appservice registration, linked-device/session state, bridge media metadata,
the protected bridge database password, and the Synapse configuration needed
to load the registration. Isolated restore tests must never start a restored
live WhatsApp session or connect it to production.
