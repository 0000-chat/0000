# Communicator Messaging Prototype Design

## Status

Approved design for the first Communicator prototype.

- Date: 2026-08-23
- Audience: Communicator developer and system administrator
- Source architecture: `docs/PROPOSAL.md`
- Deployment host: `ovh-vps`

## Simple explanation

Communicator will first run as a private prototype for one owner. It will connect the owner's personal WhatsApp, Telegram, and Messenger accounts and a second WhatsApp account for a future AI agent.

The owner and agent will have separate identities and conversations. A separate administrator account can manage both, but it can read encrypted conversation content only through a temporary, recorded break-glass action.

The system will be installed in small stages. Matrix must work and restore from backup before Telegram is added. Telegram must be stable before WhatsApp is added, and WhatsApp must be stable before Messenger is added.

The prototype will attempt to import approximately three months of WhatsApp history. It will keep secrets and runtime data outside Git and create encrypted backups on another system.

## Purpose

This prototype validates a unified personal messaging system built with Synapse and mautrix. It connects one human operator's personal WhatsApp, Telegram, and Messenger accounts and a second WhatsApp account that represents a future AI agent.

The prototype validates messaging, encryption, identity isolation, administration, history import, backup, and recovery. It does not implement the Cloudflare reporting data plane.

## Scope

The prototype includes:

- Synapse as the Matrix homeserver.
- PostgreSQL 16 or later.
- Caddy for HTTPS.
- `mautrix-telegram`.
- `mautrix-whatsapp` with two independent WhatsApp logins.
- `mautrix-meta` for Messenger.
- Matrix end-to-end encryption in bridged rooms.
- A human principal, an AI-agent principal, and a separate platform-administrator role.
- A three-month target for initial WhatsApp history import.
- Encrypted off-server backups and a tested restoration procedure.
- Version-controlled deployment definitions and documentation.

The prototype excludes:

- Public Matrix registration.
- Public Matrix federation.
- Production customer onboarding.
- The Matrix event consumer.
- Cloudflare Queues, Durable Objects, Workers, and R2.
- A hosted Matrix web client.
- Unlimited historical backfill.
- Production availability guarantees.

## Environment and naming

The prototype uses a dedicated Matrix identity domain:

- Matrix `server_name`: `communicator.0000.gold`
- Synapse endpoint: `matrix.communicator.0000.gold`
- User IDs: `@<localpart>:communicator.0000.gold`

DNS delegation will allow Matrix identities to use `communicator.0000.gold` while clients connect to `matrix.communicator.0000.gold`.

The prototype identity domain is permanent. Prototype identities are disposable and will not be renamed or migrated into production.

A future production deployment will use:

- Matrix `server_name`: `0000.chat`
- Synapse endpoint: `matrix.0000.chat`

Application tenant and principal identifiers do not depend on the Matrix domain. This permits controlled replay or migration into a separate production environment.

## Host readiness

The prototype runs on the current `ovh-vps` host, which has sufficient CPU and memory but insufficient free disk at design time.

Installation may begin only after all of these checks pass:

- The host runs supported Ubuntu 26.04 LTS. Ubuntu 25.10 reached end of life on 2026-07-09 and must be upgraded before deployment.
- At least 50 GB of disk space is free.
- Swap use has been investigated and current memory pressure is safe.
- Existing services and required ports have been inventoried.
- DNS records resolve correctly.
- Only SSH, HTTP, and HTTPS are exposed for the Communicator stack.
- An encrypted off-server backup destination is available.
- Disk, memory, and service-health monitoring is enabled.

Official lifecycle reference: <https://ubuntu.com/about/release-cycle>

The compromised Contabo VPS is not part of this prototype. It must be rebuilt from a known-clean image before any future use.

## Deployment architecture

Communicator will run as one isolated Docker Compose project.

```text
Internet
   |
   v
Caddy :443
   |
   v
Synapse -------------------------------+
   |                                   |
   | application-service traffic       | Matrix clients
   v                                   |
mautrix-telegram                       |
mautrix-whatsapp                       |
mautrix-meta                           |
   |                                   |
   +--------------+--------------------+
                  |
                  v
             PostgreSQL 16+
```

The stack has these boundaries:

- Caddy is the only public application entry point.
- Synapse, PostgreSQL, and bridge service ports use a private container network.
- The Synapse Admin API is not exposed publicly.
- One PostgreSQL service hosts a separate database and credential set for Synapse and each bridge.
- Each bridge has independent configuration, credentials, session state, health checks, and lifecycle.
- Container image versions are pinned.
- Persistent runtime state is stored outside Git under `/srv/communicator`.
- Deployment definitions and sanitized templates are stored in the repository.
- An existing Matrix client is used instead of hosting Element Web.

## Identities and authorization

Communicator uses an application-level tenant and principal model. Synapse and mautrix do not have a native Communicator `tenant_id`.

The prototype contains one tenant with two messaging principals:

```text
tenant: personal
├── principal: human-primary
│   ├── one native Matrix account
│   ├── personal WhatsApp login
│   ├── personal Telegram login
│   └── personal Messenger login
└── principal: agent-primary
    ├── one native Matrix account
    └── AI-agent WhatsApp login
```

Bridge bots, remote-contact ghosts, puppets, rooms, and Spaces are resources associated with a principal. They are not tenants.

The trusted ownership mapping is:

```text
tenant_id -> principal_id -> network_account_id -> Matrix room IDs
```

Permissions are separated as follows:

- `customer_user`: Can read and operate only resources mapped to `human-primary`.
- `agent_runtime`: Can read and operate only resources mapped to `agent-primary`.
- `platform_admin`: Can manage tenants, principals, bridge logins, room mappings, health, ingestion, backup, and recovery.

The human customer session does not inherit platform-administrator privileges. The future agent service authenticates as its own Matrix user and is invited only to agent-owned rooms.

## Encryption and secret storage

All bridged conversation rooms use Matrix end-to-end encryption from the first live bridge.

Each mautrix bridge will have encryption support and self-signing enabled. A bridge must decrypt Matrix messages to send them to a remote network and must encrypt remote-network messages before sending them into an encrypted Matrix room.

An optional unencrypted operations room may contain health notifications. It must never contain message bodies, attachment contents, credentials, or remote-network payloads.

The following data must never enter Git:

- Matrix device keys.
- Synapse signing keys.
- Application-service tokens.
- Bridge sessions and remote-network credentials.
- PostgreSQL passwords.
- TLS private keys.
- Message data, media, logs, exports, and backups.

Secrets are stored in narrowly permissioned files under `/srv/communicator` and mounted into containers. Required cryptographic material is included in encrypted off-server backups.

The future Matrix event consumer will authenticate as a separate verified Matrix device. It will consume and decrypt events through Matrix APIs and will not read Synapse's PostgreSQL database directly.

## Break-glass administrative access

Platform administrators can normally inspect configuration, metadata, and health. They do not have permanent plaintext message access.

Plaintext access requires an explicit break-glass session with:

- Administrator reauthentication.
- A documented reason.
- Explicit tenant, principal, and room scope.
- A short expiration time.
- Audit events for activation, reads, exports, and termination.
- Automatic permission revocation and administrator notification.

For live encrypted Matrix rooms, break-glass access uses a dedicated administrator Matrix device that joins the selected rooms and receives the required room keys. It cannot silently recover historical messages whose keys were never shared.

There is no permanent universal decryption device or global plaintext administrator feed. Because decrypted content cannot be made unknown again, the dedicated inspection device and its crypto store must be controlled and destroyed after the access window ends.

When the Cloudflare projection is implemented, the Worker API will enforce temporary `content.read` grants for projected data. Direct Matrix access remains a separate audited mechanism.

## Layered rollout

The rollout uses gates. A later layer cannot start until the current layer passes its validation and recovery checks.

### Stage 0: Host preflight

- Meet the host-readiness conditions.
- Establish DNS and HTTPS reachability.
- Establish private container networking and firewall rules.
- Establish the off-server backup destination.

### Stage 1: Matrix core

- Deploy Caddy, Synapse, and PostgreSQL.
- Create the administrator and human Matrix accounts.
- Disable public registration and federation.
- Validate authentication, encrypted private rooms, device verification, media upload, health checks, and restart persistence.
- Create and restore a database, media, configuration, signing-key, and device-key backup.

### Stage 2: Telegram

- Deploy `mautrix-telegram` with an independent database and persistent session state.
- Connect the personal Telegram account.
- Validate bidirectional text, media, replies, edits, reactions, redactions, encryption, reconnection, and restart persistence.
- Complete a 24-hour soak test.

### Stage 3: WhatsApp

- Deploy `mautrix-whatsapp` with an independent database and persistent session state.
- Connect the personal WhatsApp account.
- Connect the AI-agent WhatsApp account as a separate login owned by `agent-primary`.
- Validate identity and room isolation between both WhatsApp accounts.
- Validate the standard bridge behaviors and the initial history import.
- Complete a 24-hour soak test.

### Stage 4: Messenger

- Deploy `mautrix-meta` with an independent database and persistent session state.
- Connect the personal Messenger account.
- Validate the standard bridge behaviors.
- Complete a 24-hour soak test.

### Stage 5: Prototype acceptance

- Run all completed services together.
- Validate backup restoration into a clean isolated stack.
- Record resource use, disk growth, reconnect behavior, and known platform limitations.
- Approve or reject progression to the Cloudflare data-plane design.

## WhatsApp history import

The prototype targets approximately three months of history for both WhatsApp accounts.

The bridge configuration is applied before either QR-code login:

- `history_sync.request_full_sync` remains `false` to request the normal web-client history window, documented as approximately three months.
- `history_sync.max_initial_conversations` is `-1` so all conversations received in the history-sync payload can create portals.
- `backfill.enabled` is `true`.
- `backfill.max_initial_messages` uses a high but bounded per-room count selected after the preflight disk measurement.
- Automatic retrieval of old media starts disabled or tightly limited.

The date range is a target, not a completeness guarantee. WhatsApp controls the history-sync payload, and mautrix limits import by message count rather than an exact timestamp. Initial backfill works only for newly created portal rooms. If the initial payload is missed or processing fails, retrying normally requires unlinking and linking the WhatsApp account again.

Telegram and Messenger retain limited initial history import until a separate design change approves larger backfills.

## Failure handling and recovery

Each bridge can be stopped, rolled back, upgraded, or replaced without rolling back Synapse or another bridge.

Failure handling includes:

- Container health checks and restart policies.
- Pinned image versions and controlled upgrades.
- Redacted structured logs.
- Persistent bridge sessions and crypto stores.
- Independent bridge databases.
- Resource limits and disk-growth alerts.
- Manual approval before retrying destructive login or history-import operations.

Prototype recovery objectives are:

- Recovery point objective: approximately 24 hours.
- Recovery time objective: approximately four hours.

Backups include:

- PostgreSQL backups for Synapse and every bridge database.
- Synapse signing keys and configuration.
- Matrix device and cross-signing material required for recovery.
- Bridge configuration, application-service registrations, encryption state, and remote-network sessions.
- Local Synapse media.

Restoration occurs into a clean isolated stack. Restoring over a running or populated Synapse database is not permitted.

## Retention and storage controls

Synapse is the prototype's operational messaging system of record. R2 is not part of this phase.

Storage controls include:

- At least 50 GB free before installation.
- Alerts near 70%, 80%, and 90% disk use.
- Bounded upload sizes.
- Bounded automatic media retrieval during backfill.
- Short fixed retention for redacted operational logs.
- No unrestricted Telegram or Messenger history import.
- Daily encrypted off-server backups.

Messages and media remain available during the prototype unless the operator explicitly runs a documented deletion procedure.

## Repository and runtime boundary

`/home/ubuntu/communicator` becomes a Git repository with `main` as the default branch.

The first commit contains:

- `docs/PROPOSAL.md`.
- This approved design.
- A defensive `.gitignore`.

Implementation uses a dedicated feature branch or isolated worktree. Git tracks:

- Compose definitions.
- Pinned image versions.
- Health checks.
- Sanitized configuration templates.
- Database initialization definitions.
- Backup and restore scripts.
- Validation tests and operational checklists.

Runtime state lives under `/srv/communicator`. Generated credentials, application-service registrations, databases, volumes, media, exports, and backups remain outside the repository.

The repository is published as the private GitHub repository `0000-chat/communicator`. A secret scan is required before every initial or history-rewriting push.

## Acceptance criteria

The prototype is accepted when all conditions are true:

- HTTPS and Matrix discovery work for `communicator.0000.gold`.
- Public registration and federation are disabled.
- The human and AI-agent Matrix identities are separate.
- The human identity can exchange messages through personal Telegram, WhatsApp, and Messenger accounts.
- The agent identity can exchange messages through its separate WhatsApp account.
- The agent cannot join or read human-owned portal rooms.
- The human customer role cannot join or read agent-owned portal rooms.
- The separate platform-administrator role can manage both principals.
- Plaintext administrator access requires a logged, scoped, expiring break-glass session.
- Bridged rooms use Matrix end-to-end encryption.
- Both WhatsApp logins attempt the approximately three-month initial history import.
- Each bridge survives a controlled restart without losing its remote login.
- Text, media, replies, edits, reactions, and deletions are tested where the remote network supports them.
- Backups restore successfully into a clean isolated stack.
- Disk, memory, database, and bridge health remain acceptable during the combined soak test.
- Known WhatsApp and Messenger unofficial-platform risks are documented before wider use.

## Risks retained from the proposal

The prototype does not remove these risks:

- WhatsApp uses an unofficial linked-device implementation and may break or trigger account enforcement.
- Messenger uses private web behavior and has the highest account-challenge and protocol-fragility risk.
- Telegram automation can still trigger platform controls despite its official client API.
- Bridge, device, and cross-signing keys are required to preserve encrypted-message access.
- Remote deletion, disappearing-message, view-once, retention, export, and erasure semantics require explicit product policy.
- Synapse and mautrix licensing obligations require review before commercial distribution or service operation involving modifications.
- WhatsApp and Meta terms require review before commercial launch.
- A shared prototype host is not an acceptable production isolation boundary.

## Next step

After the user reviews this written specification, create a detailed implementation plan for Stage 0 and Stage 1 only. Do not plan bridge installation until the Matrix core and restoration gate pass.
