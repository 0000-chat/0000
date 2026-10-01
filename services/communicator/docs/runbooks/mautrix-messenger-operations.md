---
repo: 0000-chat/0000
status: current
---

# Mautrix Messenger operations

Messenger runs inside the private Compose network with a separate
`messenger_bridge` database. It has no public bridge port, public registration,
or history backfill. Select accounts explicitly in the permission configuration.
Examples use `@human:example.com` and `@agent:example.com`; substitute your own
Matrix domain and identities. Configuration permission is not proof of a login.

## Release and pre-login checks

Build a release archive from a clean commit, record its checksum, verify the
target SSH host key and identity, then verify the transferred archive before
activation. Example release and runtime directories are
`/opt/communicator/releases/<commit>` and `/srv/communicator`.

Preserve the previous release and protected Synapse configuration. Run
`deploy-core.sh`, `validate-core.sh`, `validate-whatsapp.sh`, and
`validate-messenger.sh` from the verified release with your configured
`COMMUNICATOR_RUNTIME_DIR` and `COMPOSE_PROJECT_NAME`.

Require PostgreSQL, Synapse, Caddy, and the enabled bridges to be healthy.
Messenger live and ready checks, registration checks, and policy validation
must pass. Port 29319 must not be published. Public Matrix client and well-known
HTTPS checks must pass; federation, signing-key, and public registration
endpoints remain disabled. Keep `split_portals: true`, encrypted non-federated
rooms, disabled public/direct media, disabled provisioning, and disabled backfill.

Take a fresh encrypted backup and prove an isolated restore before pairing.
Keep passwords, cookies, tokens, rendered config, registrations, room IDs,
contacts, messages, and session material out of logs and Git.

## Pairing a selected account

The account owner opens the encrypted private room with the Messenger bridge
bot. For the pinned bridge release, the primary command is `login messenger-lite`.
The owner completes authentication directly in that private interaction.
Credentials, QR contents, cookies, challenge responses, and recovery codes must
never enter operator messages or evidence. Verify current upstream instructions
against the pinned release before using any fallback authentication flow.

Account challenges, 2FA, recovery, suspicious-login review, logout, and device
removal require the account owner's action. Preserve the deployment while the
owner acts; do not repeatedly retry, weaken security, or change account settings.

Each configured identity requires its own pairing, E2EE, bidirectional message,
portal-isolation, restart, and backup acceptance. An account that has not been
onboarded remains `NOT_TESTED`. Do not infer its results from another account.

## Restart, upgrade, and rollback

Restart only required services with bounded health waits; verify PostgreSQL
before Synapse and bridges, and keep Caddy available. Rerun validators and HTTPS
checks. For each paired identity, confirm decryption of a pre-restart message
and a harmless new inbound/outbound round trip in that identity's own client.

Upgrade through a verified immutable release with a fresh encrypted backup.
Preserve database/runtime files, appservice registrations, encryption material,
rooms, sessions, and existing bridge state. Never use `docker compose down`,
remove volumes, regenerate existing tokens, or reset databases as routine repair.

Rollback restores the previous verified release and protected configuration
when needed. It must not log out or unlink accounts. Logout, unlinking, session
deletion, or account-security changes are separate disruptive operations that
require the account owner's explicit decision.
