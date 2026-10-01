---
repo: 0000-chat/0000
status: current
---

# Mautrix Messenger validation

This procedure is an acceptance template for an operator-owned deployment.
It records no live account completion. Select test identities and harmless new
test contacts; keep account names, Matrix room IDs, and live results privately.
Do not import history or include message content in acceptance evidence.

## Automated pre-login gate

Run core and Messenger validators from the verified release. Require the
configured core and bridge services to be healthy, the pinned image and protected
registrations to match, and no host listener on port 29319. Expected success
markers include:

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

These are expected outputs, not recorded deployment results. Public Matrix
client and well-known HTTPS checks must pass; federation, signing-key, and
public registration endpoints remain disabled or return the expected 404.

## Acceptance for each paired identity

The account owner verifies its private encrypted portal. For every paired
identity, verify new inbound and outbound text, E2EE, and persistence after a
controlled restart. Check portal isolation in both directions: the other test
identity cannot discover, join, read, or send into this identity's portal.
Platform administrator permission must not imply room membership.

Use only harmless new messages. Test media, replies, reactions, typing, and
receipts when supported by the pinned bridge. Record unsupported behavior as
`UPSTREAM_LIMITATION` with the version and observation; service health never
proves a message or encryption result.

Any identity that has not been paired remains `NOT_TESTED`. Do not claim
symmetric two-account isolation or two-account recovery from a single-account
test. Adding an identity requires separate pairing, E2EE, isolation, restart,
and backup acceptance. Store the actual results in the operator's private log.

## Restart and preservation

After a bounded restart, wait for core and bridge health, reopen each tested
client profile, decrypt a pre-restart message, and perform a new bidirectional
text exchange. Verify existing bridges still work. Record client performance
separately; do not infer client correctness from server health.

## Encrypted backup and isolated restore

Require `backup=PASS` and a clean `restic check`. The payload includes the
Messenger database, protected config and registrations, database secrets,
encryption material, persisted sessions, and required media metadata, together
with existing Synapse and bridge content.

Restore into a distinct Compose project and fresh timestamped runtime. Verify
database table restoration, protected artifacts, and offline registration
validation using the pinned image with `--network none`. Start only isolated
PostgreSQL and Synapse. Never start the restored Messenger service or reconnect
restored sessions to Meta. Require `restore_test=PASS` before recovery acceptance.
Retain only the minimum protected evidence needed for the recovery decision.
