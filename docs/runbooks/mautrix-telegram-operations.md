# Mautrix Telegram Operations

## Simple explanation

The Telegram bridge is one shared, pinned `mautrix-telegram` process inside the
private Compose network. It translates new Telegram traffic into Matrix rooms
and keeps each Telegram login's portals separate. The pilot connects only
`@human:communicator.0000.gold` to the Human's established personal Telegram
account. It does not create an Agent Telegram identity, expose a Telegram
port, enable Matrix federation, or import Telegram history.

The bridge is an integration boundary, not a place to copy credentials into
chat. API credentials, database passwords, appservice tokens, pickle keys,
session data, QR codes, phone codes, and 2FA passwords remain on the protected
host and are never printed, committed, or sent to an operator through Codex.

## Identity and isolation contract

- The Human is the only pilot Telegram portal member:
  `@human:communicator.0000.gold`.
- `@agent:communicator.0000.gold` must not be able to access Human Telegram
  portals.
- `@platform-admin:communicator.0000.gold` has break-glass administrative
  permission only; it is not an automatic member of Human portal rooms.
- `bridge.split_portals` is `true` before the first login and must never be
  changed afterward.
- Future customers use independent logins in this same bridge process only
  after the customer gate in the final section passes.

## API credential provisioning

Creating or selecting the Telegram application at
`https://my.telegram.org/apps` is a user-only pause.

1. The operator creates or selects the application in the user's Telegram
   account and obtains the API ID and API hash.
2. The user enters the API ID and API hash directly into the protected
   Contabo terminal. Do not paste either value into Codex, Element, a ticket,
   a shell argument, Git, or a command transcript.
3. Store them as the root-owned, mode-`0600` files expected by the runtime
   initialization script under `/srv/communicator/secrets/`. The API ID is
   numeric and the API hash is a 32-character hexadecimal value.
4. Run the normal release procedure. `scripts/init-runtime.sh` creates the
   protected Telegram directories and database password files, but it never
   invents or logs Telegram API credentials.
5. Confirm that the credentials are present only by the bounded validator
   result. Never print their contents or the rendered configuration.

If the application is unavailable, invalid, or belongs to the wrong Telegram
account, stop at this gate. Do not search logs, dump the environment, or
replace the account silently.

## Pre-login deployment checkpoint

Before any login, verify the release archive and the pinned Telegram image,
the provider snapshot evidence, the protected runtime directory, and the
existing WhatsApp and Messenger health evidence. The release must use the
approved Compose project `communicator`, runtime
`COMMUNICATOR_RUNTIME_DIR=/srv/communicator`, and the existing private
network.

Run the release deployment from the verified release directory:

```sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator \
  COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh
```

Require Compose health and all applicable bounded validators:

```sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator \
  COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator \
  COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator \
  COMPOSE_PROJECT_NAME=communicator ./scripts/validate-messenger.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator \
  COMPOSE_PROJECT_NAME=communicator ./scripts/validate-telegram.sh
```

The pre-login gate is complete only when the Telegram validator records
`telegram_prelogin_gate=PASS`, private-port and federation checks pass, and
the WhatsApp/Messenger preservation checks remain green. Do not pair an
account during deployment or while this gate is incomplete.

## QR login

Pair only the Human identity, from the Human's encrypted private room with
`@telegrambot:communicator.0000.gold`:

```text
login qr
```

The user scans the short-lived QR in the official Telegram client at
**Settings -> Devices -> Link Desktop Device**. Scanning the QR is a
user-only pause. The QR is sensitive authentication material: do not take a
screenshot, copy it into a ticket, place it in a log, or ask the user to
paste it into Codex.

After the user completes the scan, validate the exact Human MXID, portal
membership, encrypted room behavior, and cross-account denial. Pairing is
accepted only with the live acceptance markers in the validation runbook.

## Phone-code fallback and 2FA

Use phone login only when the operator explicitly approves the fallback and
the user is ready to complete it:

```text
login phone +<international-number>
```

The six-digit code arrives in an already logged-in official Telegram client,
not by SMS. Entering the phone number, receiving or entering the code, and
entering a 2FA password are user-only pauses. Do not request the number, code,
password, recovery answer, or challenge result in chat. Do not retry blindly;
Telegram rate limits and account challenges are external state.

If Telegram presents account recovery, a challenge, logout, device removal,
or another disruptive choice, stop and give the user the exact official-client
action required. Do not improvise recovery.

## Normal restart and upgrade

For a normal restart, preserve the runtime directory and database, restart
only through the approved Compose project, wait for health, and run the core
and Telegram validators. A restart must not request a new QR scan.

For an upgrade:

1. Build and checksum a clean release archive.
2. Confirm the image digest and deployment evidence.
3. Take a fresh encrypted backup and record only its short snapshot ID.
4. Deploy through `scripts/deploy-core.sh`; it force-recreates services as
   required to load registrations without removing volumes or dropping
   databases.
5. Run all core, WhatsApp, Messenger, and Telegram health and isolation
   checks.
6. Prove existing Telegram session persistence with one inbound and one
   outbound test before accepting the release.

Never modify upstream mautrix, Synapse, or Telegram source code and never
build an unapproved custom bridge image.

## Bad credentials or unhealthy bridge

If pre-login validation rejects an API credential, database secret, image, or
registration, stop before login. Preserve the evidence as bounded pass/fail
output and inspect only protected files with approved root-only procedures.
Never use `docker compose config`, `docker inspect`, environment dumps, or
logs in a way that emits secrets.

Correct an API credential only through the user-only provisioning procedure.
After correction, rerun the complete pre-login deployment and validation
checkpoint. Do not delete Telegram runtime state, log out the account, delete
portals, or reset the database merely to make a health check pass.

## Explicit logout and device removal

`logout`, removing the Telegram device, deleting portals, or changing
`bridge.split_portals` is externally disruptive. These actions are never an
automatic rollback step.

Obtain explicit user approval, take and verify a fresh encrypted backup, and
record the exact intended scope before any such action. The user performs
Telegram account logout or device removal in the official client when that is
the selected action. Matrix retention and privacy rules continue to apply to
already bridged events; logout is not a Matrix-history deletion workflow.

## Break-glass administration

The Platform Admin may use the approved administrative command path to repair
service state or inspect bounded health results. Break-glass access must be
time-limited, recorded, and restricted to the smallest necessary operation.
It does not add `@platform-admin:communicator.0000.gold` to Human portal
rooms, grant access to Human Telegram data, or authorize QR, phone-code,
2FA, logout, or device-removal actions.

## Rollback

Rollback restores the prior verified release and protected Synapse
configuration after the operator records a fresh backup and the exact
failure. Restart the affected services through the approved Compose project,
then run core, WhatsApp, Messenger, and Telegram validators.

Rollback must preserve the Telegram database, runtime directory, session
pickle, appservice registrations, Matrix rooms, users, and secrets. It must
not automatically log the Telegram account out, remove a Telegram device,
change `split_portals`, or delete portal rooms. If the prior release cannot
read the newer session state, stop and use the documented recovery procedure;
do not destroy state to force compatibility.

## Retention, privacy, and licensing

Synapse retention and privacy rules apply to bridged Telegram events. Telegram
logout does not erase Matrix history, and a restore test must not be treated
as a retention exception. Keep runtime state and encrypted backups only for
the approved operational retention period, with access limited to the
protected service and root-only recovery procedures. Do not place acceptance
evidence, dumps, rendered configuration, or secrets in Git.

Use the upstream mautrix-telegram and Telegram APIs under their applicable
licenses and terms. Before a production or customer rollout, record the
license review and any attribution or service restrictions required by those
terms. Do not represent the bridge as an official Telegram client.

## Future customer onboarding

Every customer receives an independent Telegram login inside this same bridge
process. Before enabling one:

1. Add the exact customer MXID as the intended `user`; do not grant a broad
   wildcard.
2. Review the configuration and release commit for symmetric isolation from
   the Human, Agent, and every other customer.
3. Deploy through the same pre-login release and backup gates.
4. Have the customer, not the operator, complete their own QR or phone/2FA
   user-only gate.
5. Demonstrate that the customer can access only their own portals and that
   every pilot identity is denied access to the customer's portals.
6. Take a fresh encrypted backup and prove isolated restore before acceptance.

Do not create a second Telegram container for a customer. Do not enable the
customer until the exact-MXID, symmetric-isolation, backup, restore, and
retention evidence is recorded.
