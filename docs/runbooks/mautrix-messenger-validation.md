# Mautrix Messenger Validation

## Simple explanation

This pilot validates one connected Human Messenger account through the
existing Matrix identity. Agent Messenger onboarding is deferred by user and
is not part of this acceptance. The existing Agent Matrix identity was
verified not to access Human Messenger portals, but symmetric two-account
Messenger isolation is not tested in this phase.

Validation uses new, harmless test messages only. It does not import history,
inspect encrypted content, or start a restored Messenger session.

Human text delivery, Human E2EE, Human portal isolation, Human restart
persistence, WhatsApp preservation, and encrypted backup/restore are hard
completion gates. Future Agent onboarding requires its own pairing, isolation,
restart, and backup acceptance. A feature that the pinned upstream bridge does
not support is recorded as a named limitation with evidence; it is not marked
as passed and is not fixed by changing upstream code.

## Automated pre-login markers

Run the validators from the activated release on `contabo-eu`. The Messenger
validator may emit only these success markers:

```text
messenger_container=running
messenger_health=healthy
messenger_live=PASS
messenger_ready=PASS
messenger_ports=NONE
messenger_registration=PASS
messenger_policy=PASS
messenger_backfill=DISABLED
messenger_provisioning=DISABLED
```

The core validator must report `core_validation=PASS` and require the sorted
running service set:

```text
caddy
messenger
postgres
synapse
whatsapp
```

The public Matrix client and well-known HTTPS checks must pass. Federation,
key, and public registration checks remain disabled or return the expected
404. No host port 29319 is allowed.

## Test data rules

Use only harmless new messages with contacts explicitly selected by the
operator. Do not use an existing private conversation, import history, or
paste real message content into evidence. Record only marker names below.

The Human test uses one approved test contact and must receive a new inbound
text and send a new outbound text. If media, reply, reaction, typing, or
receipt behavior is tested, use harmless content and record only the named
success/failure or upstream limitation. Do not enable initial, catch-up,
manual, or thread backfill.

## Human acceptance — completed

From the Human Element client, verify the private encrypted portal with the
approved test contact. Confirm the message is encrypted and decryptable by
Human, and that Agent cannot discover, join, or decrypt that portal. The
completed hard-gate markers are:

```text
human_messenger_pairing=PASS
human_messenger_inbound_text=PASS
human_messenger_outbound_text=PASS
human_messenger_e2ee=PASS
agent_cannot_access_human_messenger=PASS
```

Optional Human feature markers are recorded only when actually observed:

```text
human_messenger_inbound_media=PASS
human_messenger_outbound_media=PASS
human_messenger_reply=PASS
human_messenger_reaction=PASS
human_messenger_typing=PASS
human_messenger_receipt=PASS
```

Unsupported features remain unpassed and must be described as evidence-based
upstream limitations accepted by the operator. Do not infer a feature result
from bridge health.

## Agent scope — deferred by user

Do not pair, authenticate, log in, log out, unlink, or create an Agent
Messenger session in this phase. Preserve the existing configuration that
permits a future Agent login. The following are the honest scope markers:

```text
agent_messenger_pairing=DEFERRED_BY_USER
agent_messenger_inbound_text=NOT_TESTED
agent_messenger_outbound_text=NOT_TESTED
agent_messenger_e2ee=NOT_TESTED
human_cannot_access_agent_messenger=NOT_TESTED
```
The already-tested one-way isolation result remains:

```text
agent_cannot_access_human_messenger=PASS
```

Do not claim Human-to-Agent portal isolation, Agent messaging, Agent E2EE,
Agent session persistence, or two-account Messenger recovery from this pilot.

## Human restart persistence

After Human acceptance, perform the controlled service restart from the
operations procedure. Wait for PostgreSQL, Synapse, Caddy, WhatsApp, and
Messenger health. Reopen the persistent Human Element profile and confirm it
can decrypt its own pre-restart encrypted message and complete a harmless new
inbound and outbound round trip. Confirm both WhatsApp sessions remain
working. Record:

```text
human_messenger_session_preserved=PASS
whatsapp_sessions_preserved=PASS
```

Do not infer a client result from server health. If the client is slow, record
that as a performance observation and measure it separately; do not infer a
cause without diagnostics.

## Backup and isolated restore

Run the encrypted restic backup after the Human account is paired and require
`backup=PASS` and a clean `restic check`. The payload must cover the Messenger
database, protected config, upstream registration, Synapse registration copy,
database secrets, encryption material, persisted Human session state, and
required media metadata, while retaining all existing Synapse and WhatsApp
content. Record:

```text
post_messenger_pairing_backup=PASS
```

Run the isolated restore with a distinct Compose project and timestamped
runtime. Require the Synapse, WhatsApp, and Messenger database table checks,
protected artifacts, and offline pinned-image Messenger registration
generation. Start only isolated PostgreSQL and Synapse; never start the
restored Messenger service or reconnect restored session data to Meta.
Preserve the timestamped restore evidence for separately approved cleanup,
then record:

```text
post_messenger_pairing_restore_test=PASS
```

## Complete marker set for this Human-only pilot

The final acceptance record may contain only these secret-free markers, plus
explicit named upstream limitations:

```text
human_messenger_pairing=PASS
human_messenger_inbound_text=PASS
human_messenger_outbound_text=PASS
human_messenger_e2ee=PASS
agent_cannot_access_human_messenger=PASS
human_messenger_session_preserved=PASS
whatsapp_sessions_preserved=PASS
post_messenger_pairing_backup=PASS
post_messenger_pairing_restore_test=PASS
agent_messenger_pairing=DEFERRED_BY_USER
agent_messenger_inbound_text=NOT_TESTED
agent_messenger_outbound_text=NOT_TESTED
agent_messenger_e2ee=NOT_TESTED
human_cannot_access_agent_messenger=NOT_TESTED
```
