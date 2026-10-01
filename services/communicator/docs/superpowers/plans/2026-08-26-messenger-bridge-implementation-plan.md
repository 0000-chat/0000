---
repo: 0000-chat/0000
status: archived
---

# Messenger bridge implementation history

> Archived design history from 2026-08-26. This is a technical record, not a
> current execution plan or live deployment acceptance record.

## Design

The proposal added one pinned upstream `mautrix-meta` container to the existing
Synapse, PostgreSQL, Caddy, and shared WhatsApp composition. A separate
`messenger_bridge` PostgreSQL database keeps protocol/session state separate
from Synapse and other bridges. Upstream owns the Messenger protocol; the
project owns configuration, policy, registration, validation, backup, and restore.

The recorded upstream release was `v0.2608.0` / `v26.08`, with image
`dock.mau.dev/mautrix/meta:v26.08`, appservice port 29319, `/data` storage, and
UID/GID 1337. The plan used upstream config generation followed by registration
generation and interactive account login. Recheck upstream release behavior
before using this historical version in a new deployment.

## Configuration and policy

- Exact Matrix identities receive explicit permissions; wildcard permission
  must not provide usable relay or administrative access.
- Independent logins share the bridge process while `split_portals: true`
  isolates their rooms. Administrative commands do not imply portal membership.
- Portal rooms require Matrix E2EE and disabled federation.
- Disable provisioning, public/direct media, analytics, double puppeting,
  relay mode, and initial, catch-up, manual, and thread backfill.
- Protect config, registrations, database credentials, encryption material,
  and session state outside the repository. Preserve existing keys on rerender.
- No bridge port or reverse-proxy route is exposed publicly.

## Implementation sequence

1. Pin the image and add the private Compose service and dedicated database.
2. Add idempotent runtime initialization and deterministic config rendering.
3. Generate missing registration artifacts without replacing existing tokens.
4. Add secret-safe policy validation and registration checks to deployment.
5. Include Messenger in bounded deployment health checks while preserving
   Synapse and other bridge databases, registrations, and sessions.
6. Extend encrypted backup and isolated restore coverage before account pairing.
7. Validate each configured account independently through its own encrypted
   bridge-bot room and account-owner authentication.

## Acceptance contract

Every paired identity requires new inbound/outbound text, E2EE, portal-isolation,
and restart-persistence checks. Test isolation in both directions when two
accounts are configured. An unpaired identity remains `NOT_TESTED`; permission
configuration or another identity's successful test cannot establish its result.
Unsupported upstream capabilities must remain named limitations.

Pairing, QR scans, credentials, account challenges, logout, and unlinking are
account-owner actions. Tests use harmless new content and never publish room
IDs, contacts, messages, credentials, or session artifacts.

The encrypted backup contains the Messenger database, runtime config,
appservice and Synapse registrations, database credentials, encryption material,
persisted sessions, and required media metadata. Restore into a distinct
Compose project and fresh runtime, validate the pinned image with network access
disabled, and start only isolated PostgreSQL and Synapse. Never start a restored
Messenger session or reconnect it to Meta.

Rollback restores a prior verified release and protected configuration while
preserving databases, sessions, registrations, encryption keys, and rooms.
It never automatically logs out or unlinks an account.

## Current technical references

- [Messenger operations](../../runbooks/mautrix-messenger-operations.md)
- [Messenger validation](../../runbooks/mautrix-messenger-validation.md)
- [Core recovery](../../runbooks/matrix-core-recovery.md)
- [Messenger design](../specs/2026-08-26-messenger-bridge-design.md)
