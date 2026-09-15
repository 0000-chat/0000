# Human and Agent Messenger Bridge Design

**Date:** 2026-08-26

**Status:** Approved in conversation; awaiting written-spec review

**Target:** Existing private Synapse deployment on the Contabo VPS

**Implementation:** Upstream `mautrix-meta`; no upstream source modifications

## Simple explanation

Communicator will add the existing mautrix Facebook Messenger bridge to the
same protected Docker Compose deployment that already runs Synapse and
WhatsApp. One Messenger bridge container will hold two independent logins: the
Human Facebook account and the Agent Facebook account. Each login will get its
own encrypted Matrix rooms, and neither Matrix identity will be able to enter
or read the other identity's rooms.

This project does not implement the Facebook Messenger protocol. The upstream
bridge already provides login, synchronization, message translation, media,
replies, reactions, typing notifications, receipts, encryption support, and
session persistence. Communicator adds the installation-specific
configuration, strict permissions, container isolation, deployment ordering,
validation, backup, restore, rollback, and operator procedures needed to run
that upstream bridge safely in this system.

## Source basis

The implementation must use the current stable Messenger-only
`mautrix-meta` release available when implementation begins. As of this design,
the current documented release is v26.08. The implementer must verify the
release and immutable amd64 image digest from upstream before writing the image
lock. `latest` is not acceptable because upstream documents that it points to
the latest commit rather than the latest release.

The applicable upstream documentation is:

- Docker setup: <https://docs.mau.fi/bridges/general/docker-setup.html>
- Messenger authentication: <https://docs.mau.fi/bridges/go/meta/authentication.html>
- v26.08 configuration reference: <https://docs.mau.fi/configs/mautrix-meta/v26.08.html>
- End-to-bridge encryption: <https://docs.mau.fi/bridges/general/end-to-bridge-encryption.html>
- Upstream source and release history: <https://github.com/mautrix/meta>

If the current release or generated configuration differs when implementation
starts, the generated config and current official documentation take
precedence. The implementer must stop for design review rather than guessing
when an approved field was removed or changed incompatibly.

## Scope

The first Messenger pilot includes:

- one pinned `mautrix-meta` container in the existing Compose project;
- one dedicated `messenger_bridge` PostgreSQL database;
- one protected bridge runtime directory;
- one appservice registration in Synapse;
- one Human Messenger login controlled by
  `@human:communicator.0000.gold`;
- one Agent Messenger login controlled by
  `@agent:communicator.0000.gold`;
- encrypted, non-federated, per-login Matrix portal rooms;
- bidirectional text, small media, replies, reactions, typing, and receipts
  where the remote protocol supports them;
- restart persistence for both Messenger sessions;
- encrypted backup and isolated restore coverage; and
- safe deployment, validation, challenge-response, upgrade, rollback, and
  logout runbooks.

The first Messenger pilot excludes:

- Instagram DMs;
- historical or bulk backfill;
- public bridge ports or public media endpoints;
- relay operation;
- proxies, Tor, or automated proxy rotation;
- automated login, captcha, 2FA, password-reset, or account-challenge handling;
- automatic logout, unlink, room deletion, or database reset;
- modification or forking of `mautrix-meta`, Synapse, or Element;
- the Matrix event consumer, Cloudflare Queues, event R2 archive, Durable
  Objects, reporting API, and AI runtime; and
- deployment portability or multi-VPS orchestration refactors.

## Architecture

The approved topology is:

```text
Human Messenger account ─┐
                         ├─ mautrix-meta ── Synapse ── Element / Matrix clients
Agent Messenger account ─┘       │
                                 └─ messenger_bridge database
```

`mautrix-meta` runs as a service named `messenger` in the existing
`communicator` Compose project. It shares only the private Compose network with
PostgreSQL and Synapse. Synapse reaches it at an internal appservice address;
the expected default port for the selected release is 29319. The bridge reaches
Synapse at `http://synapse:8008`. No bridge port is published on the host.

The upstream image, rather than project code, owns the Messenger protocol,
database migrations, remote sessions, portal mapping, and Matrix event
translation. Project code owns only the deployment and policy boundary around
the image.

The runtime state is stored under `/srv/communicator/messenger`. It is separate
from the Git release under `/opt/communicator/releases/<commit>` and survives
container and release replacement. The bridge config, generated registration,
crypto material, session state, and database credentials are never committed
to Git.

## Identity, portal, and permission model

One bridge container supports both Messenger logins. A container is an
operational boundary, not a tenant or identity boundary. The bridge database
associates each remote login with the Matrix identity that created it.

Strict per-login portal separation is mandatory from the first start:

```yaml
bridge:
  split_portals: true
```

This is the primary Messenger-specific divergence from the WhatsApp policy.
Upstream warns that changing `split_portals` after portals exist is irreversible
and potentially destructive. The design therefore fixes it before either login
and requires tests to reject `false` or a missing setting.

Even when Human and Agent participate in the same remote Messenger thread,
each Matrix identity receives a separate Matrix portal representation. Human
cannot discover, join, or decrypt Agent's portal, and Agent cannot discover,
join, or decrypt Human's portal.

The exact permission map matches the approved WhatsApp model:

```yaml
permissions:
  "*": relay
  "@human:communicator.0000.gold": user
  "@agent:communicator.0000.gold": user
  "@platform-admin:communicator.0000.gold": admin
```

Wildcard `relay` grants no usable relay path because relay remains disabled,
admin-only, and has no default relays. Human and Agent may create and control
only their own Messenger login and portals. Platform Admin may administer the
bridge but is not automatically joined to portal rooms and receives no room
decryption keys.

Platform Admin may read encrypted content only through the existing explicit,
auditable break-glass process: deliberate room membership plus key sharing.
Ordinary deployment and validation must not exercise break-glass access.

The rendered policy must fail closed if an expected identity is absent, an
identity has the wrong role, relay becomes usable, or any unexpected explicit
Matrix identity is added.

## Encryption and Matrix behavior

Messenger portal rooms are encrypted by default and require encryption. The
bridge must use the selected upstream release's supported end-to-bridge
encryption configuration, following the existing WhatsApp policy unless the
generated Meta config requires a documented difference.

Portal rooms must be non-federated. Public Matrix federation and public
registration remain disabled. Direct/public media and public bridge endpoints
remain disabled. Async events and async appservice transactions remain disabled
to preserve ordering during the pilot.

The encryption pickle key, appservice `as_token`, and appservice `hs_token`
must be generated once, stored with root-only or service-only permissions, and
preserved across every render, deployment, restart, backup, and restore.
Regenerating any of them during a routine deployment is a release failure.

## Database and runtime ownership

Messenger uses a separate PostgreSQL database named `messenger_bridge`. It may
share the existing PostgreSQL server and protected database role, but it must
not share a database with Synapse or WhatsApp. Database initialization is
additive and idempotent. It must never drop or recreate an existing database.

The protected runtime will contain, at minimum:

- the upstream-generated bridge config;
- the upstream-generated appservice registration;
- a Synapse-readable protected copy of that registration;
- the Messenger database credential;
- bridge encryption material and connection state written by upstream; and
- only those additional files generated by the pinned upstream image.

Project render code must preserve upstream-generated registration tokens and
the existing encryption key. It must write through a temporary file, set exact
permissions, and replace atomically. It must not print the config or any secret
value.

## Login and Meta account challenges

Human and Agent authenticate separately from their own encrypted private chat
with the Messenger bridge bot. The primary login procedure will use the
current upstream-supported Messenger Lite login flow documented for the pinned
release. A browser-cookie login may be used only as the documented fallback if
the primary flow is unavailable or rejected. The implementation plan must
spell out the command for the pinned release after verifying it from the
generated help and official authentication documentation.

Each login is an operator checkpoint. The implementer may prepare the bridge
and tell the user exactly when to authenticate, but may not request, paste,
inspect, store, or echo Facebook passwords, cookies, 2FA codes, captcha
answers, copied cURL commands, recovery codes, phone numbers, or challenge
contents.

Meta may flag an unofficial client login as suspicious and require captcha,
2FA, phone verification, password reset, or another account action. Those are
external account actions and belong to the user. The implementer must stop,
preserve production state, and provide a secret-free status marker. It must not
loop login attempts, weaken 2FA, add a proxy, change account security settings,
or invent a workaround.

## Backfill and remote-side effects

Historical and bulk backfill are disabled for the initial pilot. Both the
generic bridge backfill settings and the Meta thread-backfill settings must be
configured so that login does not paginate through historical threads or
insert historical messages into Matrix.

The acceptance cycle uses new harmless test messages. Enabling any initial,
catch-up, manual, or thread backfill requires a separate design because it may
increase Meta request volume, produce unexpected room history, and change the
privacy and retention surface.

Typing and receipts are enabled only through supported upstream bridge
behavior. `send_presence_on_typing` remains disabled so a typing event does not
add an unnecessary online-presence side effect. A future AI runtime may send
Matrix typing notifications before a reply; that is not part of this bridge
implementation.

## Deployment and failure behavior

Deployment extends the current guarded release procedure. Before any host
mutation, the implementer verifies the exact SSH host alias, hostname, eth0
IPv4 address, active release, clean repository commit, archive checksum,
running services, resource headroom, and rollback target.

The required deployment order is:

1. initialize protected runtime and secrets;
2. validate the pinned Compose configuration;
3. pull pinned images;
4. start and wait for PostgreSQL;
5. idempotently initialize the WhatsApp and Messenger databases;
6. initialize or preserve each bridge's config and registration;
7. render Synapse with both appservice registrations;
8. start and wait for Synapse and Caddy;
9. start and wait for WhatsApp;
10. start and wait for Messenger; and
11. run core, WhatsApp, and Messenger validators.

The Messenger addition must not disturb the two working WhatsApp sessions.
Any validation or deployment failure stops the procedure. Blind retries,
`docker compose down`, volume removal, database reset, logout, token
regeneration, and session deletion are prohibited.

Before either Messenger login, rollback may reactivate the prior verified
release and restore the protected pre-change Synapse config if necessary. After
a Messenger account logs in, rollback preserves the Messenger database,
runtime, registration, crypto material, portal rooms, and sessions. If continued
operation is unsafe, stop only the Messenger service, take a fresh encrypted
backup, preserve evidence, and obtain explicit approval before logout or any
destructive reset.

## Backup and isolated restore

The encrypted restic/R2 core backup must be extended to include:

- a PostgreSQL custom-format dump of `messenger_bridge`;
- the protected Messenger config and registration;
- the Synapse copy of the Messenger registration;
- Messenger database credentials;
- bridge encryption material and persisted connection/session state; and
- all existing Synapse and WhatsApp backup content.

A consistent backup stops message-producing services only for the bounded
snapshot window, dumps the databases, archives protected runtime artifacts,
runs restic backup and check, removes only the staging directory, and returns
Synapse, WhatsApp, and Messenger to healthy operation.

The isolated restore uses a distinct Compose project, timestamped runtime,
isolated database containers, and bounded health waits. It restores and checks
the Synapse, WhatsApp, and Messenger databases. It validates the restored Meta
configuration with the pinned upstream image and networking disabled.

The restore test must never start the restored Messenger service or reconnect
restored Human or Agent sessions to Meta. It must not print configuration,
database rows, account identifiers, contacts, messages, credentials, or session
material. Production containers and data are never restore targets.

## Validation and acceptance

Local automated checks must cover:

- immutable image pinning;
- private networking and no published Messenger port;
- PostgreSQL and Synapse health dependencies;
- exact service name, internal address, port, database, and runtime mount;
- one-time registration/token/key preservation;
- exact permission and relay policy;
- mandatory `split_portals: true`;
- encrypted and non-federated portals;
- disabled public/direct media and backfill;
- idempotent database/runtime initialization;
- deployment ordering;
- safe, secret-free validators;
- complete encrypted backup coverage; and
- isolated restore without a live restored Messenger process.

The pre-login remote gate requires PostgreSQL, Synapse, Caddy, WhatsApp, and
Messenger healthy; existing Matrix/WhatsApp checks passing; no new public
listener; the exact approved registration and policy; and a valid pre-login
encrypted backup.

After Human login, record only these markers:

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

After Agent login, record only these additional markers:

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
both_messenger_sessions_restart_persistence=PASS
whatsapp_sessions_preserved=PASS
post_messenger_pairing_backup=PASS
post_messenger_pairing_restore_test=PASS
```

Unsupported remote behavior must be recorded as a named, evidence-based
upstream limitation rather than falsely marked `PASS`. The core completion gate
is bidirectional text, E2EE, symmetric isolation, session persistence, existing
WhatsApp preservation, and tested backup/restore. Media, reply, reaction,
typing, or receipt limitations may be accepted only after the operator sees a
clear upstream capability explanation; the implementer must not fork upstream
code to manufacture support.

No acceptance evidence contains real account IDs, names, contacts, messages,
cookies, credentials, room IDs, or session data.

## Operational and legal risks

Messenger connectivity uses private Meta interfaces and is the highest-risk
bridge in the current proposal. Protocol changes, forced logouts, security
challenges, and account enforcement may interrupt service without a project
code change. Conservative automation, established accounts, enabled 2FA,
staged upgrades, pinned images, and explicit operator actions reduce but do not
remove that risk.

The implementation retains the proposal's privacy, retention, encryption-key,
licensing, and Meta terms risks. It does not claim that an unofficial bridge is
equivalent to an official Meta business API. Productization requires a fresh
legal and platform-terms review.

## Completion boundary

Messenger implementation is complete when the committed deployment and
recovery code passes all local checks, the exact release is safely active on
Contabo, both operator-approved accounts pass the core acceptance markers,
existing WhatsApp sessions remain operational, and a post-pairing encrypted
backup passes the isolated restore test.

Completion does not mean Meta connectivity can never break. It means the
current pinned upstream bridge is configured, isolated, recoverable, tested,
and documented for this pilot without modifying upstream source.
