# Mautrix Telegram Validation

## Simple explanation

This runbook proves that the Telegram bridge is private, healthy, reversible,
and isolated before the feature is accepted. Automated checks prove the
container, image, files, registrations, database, network boundary, and
policy. A user performs the live Telegram checks because only the user may
scan a QR code, enter a phone code or 2FA password, and confirm the behavior
of their personal account.

The pilot tests new traffic only. Use harmless test contacts and newly sent
messages; do not import or inspect Telegram history.

## Preconditions

Record the exact release commit, image digest, backup snapshot ID, and
operator timestamp in the protected acceptance record. Do not put rendered
configuration, session state, QR material, phone codes, access tokens,
database passwords, or API credentials in that record.

Before login, confirm:

- only @human:communicator.0000.gold is configured as the pilot Telegram
  user;
- @agent:communicator.0000.gold is not a Telegram portal member;
- @platform-admin:communicator.0000.gold is not an automatic portal
  member;
- bridge.split_portals=true is set before login and will not be changed;
- the Telegram service has no published port or public Caddy route;
- Matrix federation, public provisioning, public media, analytics, double
  puppeting, and history backfill remain disabled;
- WhatsApp and Messenger have current healthy preservation evidence.

## Automated pre-login gate

From the verified release directory on the protected host, run:

```sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator \
  COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator \
  COMPOSE_PROJECT_NAME=communicator ./scripts/validate-telegram.sh
```

The checks must prove the exact project and pinned image, healthy Telegram
container, protected mode-0600 and mode-0700 paths, valid registrations,
separate Telegram database, private-only network, no host listener, no Caddy
route, and the offline policy validator. The restore validator must also
prove that an isolated restore can parse the restored configuration without
starting Telegram.

Record:

```text
telegram_prelogin_gate=PASS
```

If this marker is absent, do not pair the account.

## Human pairing and live traffic

Pair only from the Human's encrypted private room with
@telegrambot:communicator.0000.gold. The primary command is:

```text
login qr
```

The user scans the short-lived QR in the official Telegram client at
**Settings -> Devices -> Link Desktop Device**. The QR must not be
screenshotted, logged, copied into a ticket, or pasted into Codex.

Only if the operator explicitly approves the fallback, the user may use:

```text
login phone +<international-number>
```

The six-digit code comes through an already logged-in official Telegram
client, not SMS. The user enters the phone number, code, and any 2FA password
without sharing them with Codex. Stop for account recovery, challenge,
logout, or device-removal decisions.

Using harmless new test contacts and newly sent messages, record each result
only as the marker shown below:

1. Complete the Human QR or approved phone pairing:
   human_telegram_pairing=PASS.
2. Send a new inbound text from the test contact to Telegram and confirm it
   arrives in the Human's Matrix portal:
   human_telegram_inbound_text=PASS.
3. Send a new outbound text from the Human's Matrix portal and confirm it
   arrives at the Telegram test contact:
   human_telegram_outbound_text=PASS.
4. Send a supported small media item in both directions and confirm the
   expected portal rendering:
   human_telegram_media=PASS.
5. Reply to a new message in both directions and verify reply context:
   human_telegram_reply=PASS.
6. Add and observe a reaction in both directions:
   human_telegram_reaction=PASS.
7. Observe typing notifications. If the upstream bridge does not expose the
   behavior, record the evidence-based alternative:
   human_telegram_typing_observed=PASS or
   human_telegram_typing_observed=UPSTREAM_LIMITATION.
8. Observe delivery/read receipts. If the upstream bridge does not expose
   the behavior, record:
   human_telegram_receipt_observed=PASS or
   human_telegram_receipt_observed=UPSTREAM_LIMITATION.

Do not turn unsupported behavior into a pass. Record the upstream limitation
and the exact observed version in the protected evidence.

## E2EE and portal isolation

Verify the Human portal is an encrypted private Matrix room and that the
expected encryption state is visible to the Human. Record:

```text
human_telegram_e2ee=PASS
```

Test symmetric denial, not only the positive Human path:

- The Agent cannot list, join, read, or send to the Human's Telegram portals.
- The Platform Admin's administrative command permission does not make the
  admin a room member or grant Human Telegram data access.
- No Telegram portal is reachable through a public service port or a Caddy
  route.
- A future customer test, when applicable, can access only that customer's
  exact-MXID portals and cannot access Human, Agent, or other customer
  portals.

Record:

```text
agent_cannot_access_human_telegram=PASS
platform_admin_not_automatic_member=PASS
non_admin_commands_rejected=PASS
```

non_admin_commands_rejected=PASS means an unauthorized Matrix user cannot
run administrative bridge commands; it does not mean ordinary portal
messaging is disabled for the Human.

## Existing bridge preservation

Repeat a harmless health and message-preservation check for the existing
bridges after Telegram pairing. Do not accept a Telegram release that
silently removes or broadens another bridge registration.

```text
whatsapp_preserved=PASS
messenger_preserved=PASS
```

The checks include healthy services, unchanged private-network exposure,
existing registration loading, and one new-message smoke test for each
bridge where an approved test identity is available.

## Restart and recovery acceptance

Restart the Telegram container through the approved Compose project, wait for
health, and verify that the existing session remains logged in. Send one new
inbound and one new outbound text without pairing again:

```text
telegram_restart_persistence=PASS
```

Take a fresh encrypted backup after pairing. Run the isolated restore test
with the documented restore script. It must restore the Telegram database,
runtime configuration, appservice registrations, API credential files, and
session state; validate the restored configuration with
--network none; and never start the Telegram service in the restore project.
Record:

```text
telegram_backup_restore=PASS
```

The restore test is not complete if it logs the account in, contacts
Telegram, exposes a host port, restores over the production PostgreSQL data,
or prints any secret.

## Acceptance record

The release is accepted only when all applicable markers below are present in
the protected evidence, with no secret values:

```text
telegram_prelogin_gate=PASS
human_telegram_pairing=PASS
human_telegram_inbound_text=PASS
human_telegram_outbound_text=PASS
human_telegram_media=PASS
human_telegram_reply=PASS
human_telegram_reaction=PASS
human_telegram_typing_observed=PASS|UPSTREAM_LIMITATION
human_telegram_receipt_observed=PASS|UPSTREAM_LIMITATION
human_telegram_e2ee=PASS
agent_cannot_access_human_telegram=PASS
platform_admin_not_automatic_member=PASS
non_admin_commands_rejected=PASS
whatsapp_preserved=PASS
messenger_preserved=PASS
telegram_restart_persistence=PASS
telegram_backup_restore=PASS
```

Any failed, missing, or unexplained marker blocks release and PR creation.
Retain only the minimum evidence required by the approved retention policy.
