# Agent WhatsApp Shared-Bridge Design

**Status:** Approved for implementation planning

**Audience:** Communicator operators and agentic implementers

**Goal:** Connect the self-owned Agent WhatsApp account to the existing
mautrix-whatsapp service without weakening the Human/Agent Matrix isolation
boundary.

## Simple explanation

The Human and Agent use the same bridge service but log into WhatsApp
separately. Each identity receives only its own private WhatsApp rooms. The
Platform Admin can operate the bridge through the agreed break-glass role, but
ordinary Human and Agent accounts do not receive bridge-administrator access.

This milestone connects the Agent's WhatsApp identity. It does not make the
Agent respond automatically.

## Scope

This milestone:

- authorizes `@agent:communicator.0000.gold` as a normal mautrix user;
- preserves `@human:communicator.0000.gold` as a normal mautrix user;
- preserves `@platform-admin:communicator.0000.gold` as the bridge admin;
- pairs the second self-owned WhatsApp account while signed into Matrix as the
  Agent;
- validates bidirectional messaging, encryption, identity isolation, restart
  persistence, backup, and isolated restoration; and
- records only pass/fail acceptance markers, never QR payloads, session data,
  contact data, message contents, access tokens, or encryption keys.

This milestone does not:

- add an AI model, autonomous response loop, tools, typing-delay policy, or
  automated read receipts;
- pair Telegram or Facebook Messenger;
- enable Matrix federation, public registration, relay mode, provisioning
  endpoints, public media, or direct media;
- enable WhatsApp history sync or backfill;
- create a second mautrix container, database, appservice registration, or
  Synapse deployment; or
- grant the Human or Agent bridge-administrator privileges.

## Architecture

The existing Synapse homeserver, mautrix-whatsapp appservice, PostgreSQL server,
and internal Compose network remain unchanged. Mautrix keeps a distinct
WhatsApp linked-device session for each authorized Matrix user inside the
existing `whatsapp_bridge` database. Portal rooms remain private Matrix rooms
whose membership is scoped to the Matrix identity that owns the corresponding
WhatsApp login.

The bridge remains an internal-only service. It has no published host port and
no Caddy route. The bridge and both linked WhatsApp sessions share one process
failure and upgrade boundary for the pilot.

At larger scale, Communicator may shard bounded tenant groups across multiple
multi-user bridge instances. One bridge container per account is explicitly
outside this pilot because it would duplicate process, connection, monitoring,
deployment, and recovery overhead without improving the current user-facing
test.

## Identity and permission model

The rendered bridge permission map must be exactly:

```yaml
permissions:
  "*": relay
  "@human:communicator.0000.gold": user
  "@agent:communicator.0000.gold": user
  "@platform-admin:communicator.0000.gold": admin
```

The wildcard permission does not provide usable relay access because relay mode
remains disabled and admin-only:

```yaml
relay:
  enabled: false
  admin_only: true
  default_relays: []
```

`user` allows an identity to create and control only its own WhatsApp login and
portals. It does not grant bridge administration. `admin` permits bridge
management for the Platform Admin but does not silently add that account to
encrypted portal rooms or provide room decryption keys. Reading encrypted room
content still requires an explicit, auditable break-glass membership and key
sharing action.

The implementation must fail closed if any expected identity is missing, has a
different role, or if any unexpected explicit Matrix identity appears in the
permission map.

## Pairing and message flow

Pairing is an interactive external-account action:

1. The operator signs into Element as
   `@agent:communicator.0000.gold`.
2. The Agent opens an encrypted private management chat with
   `@whatsappbot:communicator.0000.gold`.
3. The Agent sends `login qr`.
4. The operator uses the physical phone for the second self-owned WhatsApp
   account to scan the QR code under **Linked devices**.
5. The bridge confirms authentication without exposing the QR payload or
   session material outside Element.

After pairing, an inbound WhatsApp message for the Agent account is translated
into an encrypted Agent portal room. An outbound Matrix message from that room
is translated through the Agent's linked WhatsApp session. The existing Human
session continues to use its own portals and linked-device session.

The current minor behavior in which a WhatsApp read receipt may not become blue
until a reply is sent is accepted for this milestone. The later AI runtime must
explicitly test the sequence `read receipt -> typing -> response`, using only
supported Matrix and mautrix behavior and without forking mautrix-whatsapp.

## Isolation and break-glass behavior

The mandatory isolation boundary is symmetric:

- the Human cannot discover, join, or read Agent WhatsApp portal rooms;
- the Agent cannot discover, join, or read Human WhatsApp portal rooms;
- neither account can issue bridge-administrator commands; and
- pairing the Agent must not log out, replace, or mutate the Human's linked
  WhatsApp session.

The Platform Admin remains the only bridge administrator. Break-glass access to
encrypted room content is not automatic. It requires a deliberate operator
action, must be limited to the named room and incident, and must be recorded in
the operator evidence without recording message content or encryption keys.

## Failure and recovery behavior

The shared bridge means either a bridge crash or a bridge deployment can affect
both WhatsApp sessions at the same time. PostgreSQL, Synapse, and Caddy remain
separate services, so a bridge failure must not expose a new public listener or
cause Matrix federation or registration to become available.

The existing deployment process must preserve:

- the bridge `encryption.pickle_key`;
- appservice `as_token` and `hs_token` values;
- both linked-device session records in the `whatsapp_bridge` database;
- the Human and Agent portal mappings; and
- the Human/Agent permission map.

The encrypted R2/restic backup after Agent pairing must include the Synapse and
WhatsApp PostgreSQL dumps, bridge config and registration, the Synapse copy of
the appservice registration, protected database credentials, Synapse signing
key, and Matrix media store.

The isolated restore test must restore and validate both databases and parse
the restored bridge configuration with networking disabled. It must never
start the restored WhatsApp service or connect the restored linked-device
sessions to WhatsApp production.

## Acceptance tests

Automated acceptance requires:

1. Repository tests prove the exact Human, Agent, and Platform Admin role map.
2. Repository tests prove relay, history sync, backfill, provisioning, public
   media, and direct media remain disabled.
3. The exact committed release is checksum-verified before activation.
4. PostgreSQL, Synapse, Caddy, and mautrix-whatsapp become healthy.
5. Core and WhatsApp validators pass.
6. The bridge still has no published port or public Caddy route.

Operator acceptance requires these pass/fail markers:

1. `human_session_preserved=PASS`
2. `agent_pairing=PASS`
3. `agent_inbound_text=PASS`
4. `agent_outbound_text=PASS`
5. `agent_e2ee=PASS`
6. `human_cannot_access_agent=PASS`
7. `agent_cannot_access_human=PASS`
8. `non_admin_commands_rejected=PASS`
9. `both_sessions_restart_persistence=PASS`
10. `post_pairing_backup=PASS`
11. `post_pairing_restore_test=PASS`

No marker may be inferred from container health alone. The operator must observe
the user-facing pairing, message, encryption, and isolation outcomes.

## Rollback

Before deployment, preserve the current verified release and root-only Synapse
configuration rollback copy. If the permission deployment fails before Agent
pairing, reactivate the previous verified release and run the core and WhatsApp
validators.

If the Agent has already paired, do not delete the bridge database, runtime,
portal rooms, or protected files. Stop only the WhatsApp service if continued
operation is unsafe, preserve evidence and a fresh encrypted backup, and obtain
explicit approval before logging out or unlinking either WhatsApp account.

Unlinking is an external and potentially disruptive account action. It is never
part of an automatic rollback.
