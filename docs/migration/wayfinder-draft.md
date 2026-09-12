# Wayfinder draft: WhatsApp pilot continuation

Status: **PROPOSED**. This is a migration working note, not the canonical
wayfinder map and not a record of closed tickets. The destination and outbound
route are still open.

## Proposed destination

Start with a working WhatsApp pilot whose inbound messages are visible through
the UI. Leave the outbound route open until the pilot acceptance decision is
made. Preserve the wider-provider scope as a deferred proposed boundary for
Telegram, Messenger, and later adapters; this draft does not discard it.

The user has authorized the migration and continued work. The remaining input
is the pilot destination and outbound route. The intended wayfinder path is:

1. settle the pilot boundary and outbound route with the human;
2. research the existing foundations and deployed prerequisites;
3. record an explicit execution-in-map override if the human wants the selected
   work to continue after charting;
4. complete the selected implementation and validation slice;
5. record live evidence before treating the pilot as working.

## Notes

The migration report will record the imported and preserved Matrix gateway
work. This draft does not mark that migration complete. The latest service-loop
plan defines a receive-only, crash-safe Matrix-to-Cloudflare courier. Exact
`/sync` bytes are
journaled, events are normalized under explicit room bindings, tenant batches
are delivered idempotently, and the source checkpoint advances only after
acceptance. Its current phase excludes outbound user/provider mutations.

- [Matrix gateway design](../superpowers/specs/2026-09-09-communicator-matrix-gateway-design.md)
- [Matrix service-loop plan](../superpowers/plans/2026-09-11-communicator-matrix-service-loop.md)
- [WhatsApp validation contract](../runbooks/mautrix-whatsapp-validation.md)
- [Agent shared-bridge design](../superpowers/specs/2026-08-26-agent-whatsapp-shared-bridge-design.md)

Task 6 remains a candidate continuation item. The missing-session failure is
concrete: the current health observer hard-codes `healthy` and `present`, while
its focused test expects an empty store to report `blocked`/`missing`.

The bridge runbooks already describe interactive WhatsApp pairing, inbound and
outbound portal checks, identity isolation, restart persistence, and protected
backup/restore. A gateway outbound command path is a separate design question.

## Candidate tickets

These are proposed tickets only. They have no GitHub numbers, assignees, or
closed state.

### Candidate: decide pilot acceptance and outbound route (`grilling`)

Resolve whether outbound means a human-sent Matrix portal message traversing
the existing WhatsApp bridge, or a new product/gateway command route. Fix the
pilot identity, rooms, approved test contact, text/media scope, isolation
checks, evidence markers, and whether first boot starts at "now". Do not infer
an API, authorization, retry, receipt, or delivery-status contract from the
receive-only gateway plan.

### Candidate: reconcile historical foundations (`research`)

Inventory the preserved divergent Matrix branches/worktrees and identify the
smallest useful continuation for the chosen pilot. Compare the service-loop,
health, binary, deployment, and provider work without merging or cherry-picking
until the destination decision is recorded. Link findings back to the local
historical plans and specs above.

### Candidate: establish deployed prerequisite facts (`research`)

Read-only research on the Contabo core stack, Matrix service identity and room
bindings, WhatsApp linked-device state, Cloudflare ingestion/OAuth bindings,
R2/Queue/Durable Object/API availability, and backup evidence. Verify presence,
permissions, health, and non-secret metadata only; never read or print
credential values, pair a device, send a pilot message, deploy, or mutate
remote state.

### Candidate: finish Task 6 health inspection (`task`)

Implement the plan's read-only health contract, beginning with the missing
session case and then pressure, maintenance, quarantine, corruption, busy
database, and no-network/secret-file coverage. Keep the fixed JSON shape and
key order. This is prerequisite work for the production binary health command.

### Candidate: wire and document the gateway continuation (`task`)

If the pilot decision selects this work, evaluate the planned CLI/admin and
deployment-documentation tasks against the final scope. Derive commands from
the implementation, then prepare a reversible local validation and live-proof
sequence. This candidate does not select the destination or authorize
execution.

## Decision gate

Migration remains ongoing. The default wayfinder session stops after it charts
the open destination and outbound question. Once the human answers it, the
canonical map should record the chosen destination and an explicit
`execution: continue` override when the selected work should proceed in the
same session. Until then, keep these tickets proposed and preserve the
wider-provider boundary.
