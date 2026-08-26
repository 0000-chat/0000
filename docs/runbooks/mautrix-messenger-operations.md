# Mautrix Messenger Operations

## Simple explanation

Messenger is a private, internal bridge for the existing Human and Agent
Matrix accounts. It uses one pinned upstream `mautrix-meta` service with two
separate account sessions. The operator authenticates each account from that
account's encrypted bridge-bot room. The bridge has no public port, no public
registration, and no history backfill.

The implementer prepares files and verifies health. The user alone enters
Facebook credentials, scans a QR code, answers Meta challenges, or handles
account-security prompts.

## Technical safety rules

- Work from a clean, committed release on `codex/messenger-bridge`.
- Deploy only to `contabo-eu`, after checking hostname `vmi3501337`,
  `eth0=169.58.160.23`, the expected active release, archive checksum, and
  backup prerequisites.
- Use `COMMUNICATOR_RUNTIME_DIR=/srv/communicator` and
  `COMPOSE_PROJECT_NAME=communicator`.
- Keep `messenger_bridge` separate from Synapse and WhatsApp.
- Preserve `split_portals: true`, encrypted non-federated rooms, disabled
  public/direct media, disabled provisioning, and disabled backfill.
- Never print or copy passwords, cookies, tokens, registrations, config,
  room IDs, contacts, messages, session data, or environment values.
- Never use `docker compose down`, remove volumes, reset databases, regenerate
  existing registration tokens, log out, unlink accounts, or delete session
  state as routine operations.

## Release and pre-login checkpoint

Create a release archive from the exact clean commit and record its checksum
privately. Transfer it to a fresh remote temporary path, verify the checksum
on `contabo-eu`, extract under `/opt/communicator/releases/<commit>`, and
activate only that verified directory.

Run the deployment from the activated release:

```bash
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-messenger.sh
```

The pre-login gate requires all five services to be running and healthy,
Messenger live and ready checks to pass, no host listener on port 29319, both
protected appservice registrations to be present, and the exact Messenger
policy to pass. Public Matrix versions and well-known checks must pass;
federation, signing-key, and public registration endpoints remain disabled.

Take or verify a fresh encrypted restic backup before either login. The
backup must contain the Messenger custom-format database dump, protected
config and registrations, Messenger database credentials, and the existing
Synapse and WhatsApp payload.

## Human login

Open the encrypted private room between `@human:communicator.0000.gold` and
the Messenger bridge bot. The primary command for the pinned release is:

```text
login messenger-lite
```

The user completes the displayed Messenger Lite authentication flow in that
room. Do not paste credentials, QR contents, pairing codes, cookies, or Meta
challenge responses into an operator message. Do not send a test message
during pairing. After the user confirms the account is authenticated, record
only the secret-free Human acceptance markers defined in the validation
runbook.

`login facebook` cookie authentication is an operator-approved fallback only
when the pinned release's Messenger Lite flow is unavailable or rejected. It
must follow the current official upstream instructions. The user supplies any
cookie through the approved private interaction; the implementer never asks
for, receives, stores, parses, or handles the returned credential material.

## Agent login

After Human acceptance is complete, open the separate encrypted private room
between `@agent:communicator.0000.gold` and the Messenger bridge bot. Run the
same primary command:

```text
login messenger-lite
```

The user authenticates the Agent Facebook account separately and records the
Agent markers only after the Human session remains intact. Never reuse a
Human QR, cookie, device session, or account challenge for Agent.

## Meta challenge handling

Captcha, 2FA, password reset, WebAuthn, phone verification, suspicious-login
review, account verification, or any other Meta challenge is a user-only
pause. Stop the procedure once, preserve the deployment, and report only the
safe status needed for the user to act. Do not retry repeatedly, add a proxy,
weaken security, change account settings, or invent a workaround.

## Restart and upgrade

For a controlled restart, restart only the required services with bounded
health waits and verify PostgreSQL first, then Synapse, then WhatsApp and
Messenger. Caddy must remain available. Run the core, WhatsApp, and Messenger
validators and public HTTPS checks after recovery. Do not inspect encrypted
content.

For an upgrade, prepare and verify a new immutable release, preserve the
current release and a protected rollback copy, run the remote preflight, and
take a fresh encrypted backup. Deploy in the plan's order and stop on the
first failure. A failed pre-login release may be rolled back to the previous
verified release while preserving Messenger runtime and database files. After
an account has logged in, rollback must preserve the database, registrations,
encryption/session state, rooms, and both account sessions.

## Logout, unlink, and rollback

Logout or unlink changes external Meta account state and can invalidate a
session. It is disruptive and is never an automatic rollback action. Stop
only the Messenger service if continued operation is unsafe, preserve a
fresh encrypted backup and all non-secret evidence, then obtain explicit
approval before logout, unlink, session deletion, database reset, or account
security changes.

Rolling back code does not imply logging out or unlinking either account.
Restore the protected pre-change Synapse configuration only when the release
procedure requires it, and keep Messenger database/runtime data intact.
