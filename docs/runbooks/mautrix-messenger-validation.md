# Mautrix Messenger Validation

## Simple explanation

Validation proves that both private Messenger sessions work through the
existing Matrix identities without exposing either account to the other. It
uses new, harmless test messages only. It does not import history, inspect
encrypted content, or start a restored Messenger session.

Text delivery, E2EE, symmetric isolation, restart persistence, WhatsApp
preservation, and encrypted backup/restore are hard completion gates. A
feature that the pinned upstream bridge does not support is recorded as a
named limitation with evidence; it is not marked as passed and is not fixed
by changing upstream code.

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
paste real message content into evidence. Record only the marker names below.

The Human and Agent tests use separate approved test contacts. Each account
must receive a new inbound text and send a new outbound text. If media is
tested, use one harmless small image or file and record only success/failure.
Do not enable initial, catch-up, manual, or thread backfill.

## Human acceptance

From the Human Element client, verify the private encrypted portal with the
approved test contact. Confirm the message is encrypted and decryptable by
Human, and that Agent cannot discover, join, or decrypt that portal. Record:

```text
human_messenger_pairing=PASS
human_messenger_inbound_text=PASS
human_messenger_outbound_text=PASS
human_messenger_inbound_media=PASS
human_messenger_outbound_media=PASS
human_messenger_reply=PASS
human_messenger_reaction=PASS
human_messenger_typing=PASS
human_messenger_receipt=PASS
human_messenger_e2ee=PASS
agent_cannot_access_human_messenger=PASS
```

Typing, receipts, replies, reactions, and media are observed only if exposed
by the pinned upstream bridge. If one is unsupported, record its upstream
limitation and leave the corresponding marker unpassed until the operator
accepts that limitation under the plan.

## Agent acceptance and symmetric isolation

After Human acceptance, repeat the new-message tests from the Agent Element
client with a separate approved contact. Confirm Human cannot discover, join,
or decrypt Agent's portal. Confirm the Platform Admin identity is not a
member of either private portal and that a non-admin account cannot perform
admin-only bridge commands. Record:

```text
human_messenger_session_preserved=PASS
agent_messenger_pairing=PASS
agent_messenger_inbound_text=PASS
agent_messenger_outbound_text=PASS
agent_messenger_inbound_media=PASS
agent_messenger_outbound_media=PASS
agent_messenger_reply=PASS
agent_messenger_reaction=PASS
agent_messenger_typing=PASS
agent_messenger_receipt=PASS
agent_messenger_e2ee=PASS
human_cannot_access_agent_messenger=PASS
non_admin_messenger_commands_rejected=PASS
```

Do not include account IDs, contact identifiers, room IDs, message text,
cookies, credentials, or session data in the evidence.

## Restart persistence

After both sessions are accepted, perform the controlled service restart from
the operations procedure. Wait for PostgreSQL, Synapse, Caddy, WhatsApp, and
Messenger health. Reopen both persistent Element profiles and confirm each
account can still decrypt its own pre-restart encrypted message. Record:

```text
both_messenger_sessions_restart_persistence=PASS
whatsapp_sessions_preserved=PASS
```

Do not infer a client result from server health. If the client is slow, record
that as a performance observation and measure it separately; do not infer a
cause without diagnostics.

## Backup and isolated restore

Run the encrypted restic backup after pairing and require `backup=PASS` and a
clean `restic check`. The payload must cover the Messenger database, protected
config, upstream registration, Synapse registration copy, database secrets,
encryption material, persisted session state, and required media metadata,
while retaining all existing Synapse and WhatsApp content. Record:

```text
post_messenger_pairing_backup=PASS
```

Run the isolated restore with a distinct Compose project and timestamped
runtime. Require the Synapse, WhatsApp, and Messenger database table checks,
protected artifacts, and offline pinned-image Messenger registration
generation. Start only isolated PostgreSQL and Synapse; never start the
restored Messenger service or reconnect restored sessions to Meta. Preserve
the timestamped restore evidence for separately approved cleanup, then record:

```text
post_messenger_pairing_restore_test=PASS
```

## Complete marker set

The final acceptance record may contain only the following secret-free
markers, plus explicit named upstream limitations:

```text
human_messenger_pairing=PASS
human_messenger_inbound_text=PASS
human_messenger_outbound_text=PASS
human_messenger_inbound_media=PASS
human_messenger_outbound_media=PASS
human_messenger_reply=PASS
human_messenger_reaction=PASS
human_messenger_typing=PASS
human_messenger_receipt=PASS
human_messenger_e2ee=PASS
agent_cannot_access_human_messenger=PASS
human_messenger_session_preserved=PASS
agent_messenger_pairing=PASS
agent_messenger_inbound_text=PASS
agent_messenger_outbound_text=PASS
agent_messenger_inbound_media=PASS
agent_messenger_outbound_media=PASS
agent_messenger_reply=PASS
agent_messenger_reaction=PASS
agent_messenger_typing=PASS
agent_messenger_receipt=PASS
agent_messenger_e2ee=PASS
human_cannot_access_agent_messenger=PASS
non_admin_messenger_commands_rejected=PASS
both_messenger_sessions_restart_persistence=PASS
whatsapp_sessions_preserved=PASS
post_messenger_pairing_backup=PASS
post_messenger_pairing_restore_test=PASS
```
