# Personal mautrix-whatsapp Validation

## Simple explanation

Automated checks prove that the private bridge is up and isolated. Only the
operator can observe whether the linked WhatsApp account actually sends and
receives messages, survives restart, and remains isolated from the Agent.

## Automated gate

From the verified release on `contabo-eu`, run:

```bash
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
```

Require these safe markers:

```text
whatsapp_container=running
whatsapp_health=healthy
whatsapp_ready=PASS
whatsapp_ports=NONE
whatsapp_registration=PASS
whatsapp_permissions=PASS
whatsapp_history_sync=DISABLED
whatsapp_provisioning=DISABLED
core_validation=PASS
```

Also require public Matrix and well-known HTTPS checks to pass, federation and
key endpoints to remain HTTP 404, and host listeners to remain limited to the
approved ports. Do not print logs, environment, registrations, tokens, QR
payloads, session data, or message/contact content.

## Human and Agent acceptance

Record only the following markers after pairing the Human account:

1. `pairing=PASS`: the bridge reports authenticated.
2. `inbound_text=PASS`: one harmless text from an operator-approved test
   contact appears in the Human Matrix portal.
3. `outbound_text=PASS`: a harmless reply from the Human Matrix portal reaches
   that same approved contact.
4. `inbound_media=PASS`: one harmless image or small file sent by the approved
   contact appears in the Human Matrix portal.
5. `outbound_media=PASS`: one harmless image or small file sent from the Human
   Matrix portal reaches the approved contact.
6. `e2ee=PASS`: the Human portal remains encrypted and the Human can read it.
7. `identity_isolation=PASS`: the Agent cannot discover, join, or read the
   Human portal.
8. `restart_persistence=PASS`: after the controlled bridge/Synapse restart and
   reopening Element, the Human can still decrypt the pre-restart portal
   message and the WhatsApp session remains authenticated.

Do not infer any marker from server health or a displayed QR code. Do not enable
public media, direct media, federation, public registration, history sync, or
bulk backfill to work around a failed check.

Record these additional operator markers after pairing the Agent account:

```text
human_session_preserved=PASS
agent_pairing=PASS
agent_inbound_text=PASS
agent_outbound_text=PASS
agent_e2ee=PASS
human_cannot_access_agent=PASS
agent_cannot_access_human=PASS
non_admin_commands_rejected=PASS
both_sessions_restart_persistence=PASS
post_pairing_backup=PASS
post_pairing_restore_test=PASS
```

The Agent QR is shown only in its encrypted bot chat. The Human and Agent
isolation check is symmetric: each account must be unable to discover, join, or
read the other account's portal. `!wa set-relay` in either account's portal
must be rejected, and relay must remain disabled.

Do not print QR, session, contact, or message data.

## Recovery observations

After a fresh encrypted backup, a restore test must use a distinct
`communicator-restore-test` Compose project and timestamped runtime. Validate
database tables, protected file modes, appservice registration, and pinned
binary/config parsing without starting a restored live WhatsApp session.
