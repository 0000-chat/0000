---
repo: 0000-chat/0000
status: current
---

# Matrix Core Operations

Examples use the SSH alias `matrix-host` and runtime `/srv/communicator`.
Substitute the verified host and runtime configured for your deployment.

## Simple explanation

Run preflight, initialize the runtime, deploy the core, and validate it. Do not add a bridge until backup restoration passes.

## Technical procedure

1. Build a release only from a clean local commit with `git archive`.
2. Record the commit and archive SHA-256 in the private operator log.
3. Transfer the archive to `matrix-host` and verify its checksum before extraction under `/opt/communicator/releases/<commit>`.
4. Run the supported-host preflight remotely and stop on any failure.
5. Record the deployment decision against the exact release and verified host.
6. Run `deploy-core.sh` only inside the verified remote release with `COMMUNICATOR_RUNTIME_DIR=/srv/communicator` and `COMPOSE_PROJECT_NAME=communicator`.
7. Require Compose `--wait` to report every service healthy.
8. Run `validate-core.sh` on the VPS and public HTTP/TLS checks from the local development host.
9. Create accounts only with `scripts/create-matrix-user.sh`.
10. Never print, copy into Git, or send the contents of `/srv/communicator/secrets`.
11. Perform backup and clean restoration before bridge planning begins.

## Messenger bridge release

1. Verify the release checkout is clean and record its commit and archive SHA-256. The pinned Messenger image digest must match the approved
   plan.
2. Verify the intended SSH host identity, network address, active release,
   recovery snapshot, and encrypted backup prerequisites.
3. Transfer only the verified archive to a fresh remote temporary path and
   compare its checksum before extraction under
   `/opt/communicator/releases/<commit>`.
4. Preserve a protected timestamped rollback record without printing its
   contents. Run `deploy-core.sh` only with
   `COMMUNICATOR_RUNTIME_DIR=/srv/communicator` and
   `COMPOSE_PROJECT_NAME=communicator`.
5. Require the deployment order: PostgreSQL health, additive WhatsApp and
   Messenger database initialization, preserved/generated bridge config and
   registrations, Synapse render with both registrations, Synapse and Caddy,
   WhatsApp, then Messenger. No volumes or databases are recreated.
6. Run `validate-core.sh`, `validate-whatsapp.sh`, and
   `validate-messenger.sh`, then public Matrix and well-known HTTPS checks.
   Require no host listener on 29319 and keep public registration and
   federation/key endpoints disabled/404.
7. Before the Human Messenger login, require a fresh encrypted backup and a
   clean isolated restore. Each selected account is paired only from its private encrypted bridge-bot
   room by its account owner. Unconfigured accounts remain untested; onboarding
   another identity requires separate acceptance.
8. For pre-login rollback, activate the previous verified release and restore
   only the protected pre-change Synapse configuration. After Human login,
   preserve Messenger database/runtime, registrations, encryption/session
   state, rooms, and the Human session. Never log out or unlink as rollback.

## Personal WhatsApp bridge release

1. Verify the selected release checkout is clean and record the exact release commit and archive SHA-256.
2. Verify the target SSH host key, hostname, network address, and recovery snapshot against the operator record.
3. Transfer only the `git archive` tarball to a fresh remote temporary path. Compare the remote checksum before extraction under `/opt/communicator/releases/<commit>`.
4. Preserve the current Synapse configuration and checksum in a root-only timestamped rollback file. Never copy its contents into operator output.
5. Activate the verified release and run `sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh`.
6. Require PostgreSQL, Synapse, Caddy, and WhatsApp to be healthy. The bridge uses only the existing internal Compose network; it has no published port and no Caddy route.
   The deployment waits for PostgreSQL, initializes the separate bridge database/runtime, installs the appservice registration, and force-recreates Synapse, Caddy, and WhatsApp so registration changes are loaded. It does not recreate volumes or drop databases.
7. Run `validate-core.sh`, `validate-whatsapp.sh`, and the public Matrix/well-known HTTPS checks. Public registration and federation/key endpoints must remain disabled/404.
8. For rollback, stop only the WhatsApp service if needed, activate the previous release, restore the protected pre-change Synapse configuration, restart Synapse with health checks, and leave the bridge database/runtime intact. Never delete PostgreSQL volumes, Matrix data, bridge session state, users, rooms, or secrets as part of rollback.
9. Do not pair a WhatsApp account during release deployment. Pairing is a separate user checkpoint requiring interactive QR or pairing-code entry.

## Telegram bridge release

1. Confirm the existing bridge validators pass. Record the release commit, archive checksum,
   pinned Telegram image digest, provider snapshot evidence, and a fresh
   encrypted backup.
2. Activate the verified release with
   COMMUNICATOR_RUNTIME_DIR=/srv/communicator and
   COMPOSE_PROJECT_NAME=communicator. Run deploy-core.sh and require Compose
   health plus validate-core.sh, validate-whatsapp.sh,
   validate-messenger.sh, and validate-telegram.sh.
3. Require the Telegram pre-login gate before any QR or phone login. The
   service remains on the private Compose network with no published port, no
   Caddy route, no Matrix federation, and no public bridge endpoint.
4. Pair only an explicitly permitted Matrix identity from its encrypted private
   room. Example identities such as `@human:example.com` must be configured for
   your homeserver. The QR scan, phone number, six-digit code, 2FA, account recovery,
   logout, and device removal are user-only actions.
5. After pairing, prove Human E2EE, symmetric portal isolation, Platform Admin
   non-membership, non-admin command rejection, Telegram message behavior,
   restart persistence, encrypted backup, and isolated restore. Keep the
   WhatsApp and Messenger preservation markers green.
6. For a release upgrade, restart through the approved Compose project and
   preserve the Telegram database, runtime directory, session state,
   registrations, Matrix rooms, users, and secrets. A rollback restores the
   prior release and protected Synapse configuration; it must not log the
   Telegram account out, remove its device, change split_portals, or delete
   portal rooms automatically.
