# Controlled-copy retention boundary

The control-plane Worker cannot open the host PostgreSQL volumes, Synapse
media directory, or restic repository. It invokes the private
`controlled-copy-v1` boundary through the configured
`COMMUNICATOR_RETENTION_*_URL` and `COMMUNICATOR_RETENTION_*_TOKEN` pairs.
The repository-owned implementation is
[`scripts/controlled-copy-retention.py`](../../scripts/controlled-copy-retention.py).
Run it on the core host with `COMMUNICATOR_RETENTION_SERVICE_TOKEN` and a
private listener; do not publish it through Caddy.

The service reads the non-secret manifest at
`$COMMUNICATOR_RUNTIME_DIR/retention/controlled-copy-manifest.json` (or
`COMMUNICATOR_RETENTION_MANIFEST`). File-backed stores use a store-specific
`COMMUNICATOR_RETENTION_<STORE>_ROOT` and remove only an exact manifest path
under that root. The manifest must match the removal resource and generation;
an unscoped directory is incomplete and cannot be deleted by guesswork.

Synapse inventory entries may carry an exact `room_id` and Matrix `event_id`.
Configure the actual homeserver separately as
`COMMUNICATOR_RETENTION_SYNAPSE_HOMESERVER_URL` and provide its access token in
`COMMUNICATOR_RETENTION_SYNAPSE_ACCESS_TOKEN`; the Worker-facing
`COMMUNICATOR_RETENTION_SYNAPSE_URL` remains the controlled-copy service URL.
With those host credentials, cleanup uses Synapse's supported Matrix redaction
endpoint to redact that exact event. The pinned `v1.159.0` homeserver template
sets `redaction_retention_period: 7d`. Configure the host-side database
connection separately with `COMMUNICATOR_RETENTION_SYNAPSE_DATABASE_URL` and,
for tests or a root-owned wrapper, `COMMUNICATOR_RETENTION_SYNAPSE_PSQL_BIN`.
The adapter joins the exact room and event rows, checks the expected message or
encrypted event type, and requires the stored `event_json.content` object to be
exactly empty before recording `expired`. `redactions.have_censored` is
supporting evidence only: Synapse can set it when a redaction was not allowed,
so an intact stored body remains `quarantined`. Synapse checks this job every
five minutes, so the seven-day period plus the Worker's 24-hour cleanup margin
stays below the 30-day ceiling. If the database boundary is absent, the
adapter records only `quarantined` or `unknown` evidence and cannot complete
the controlled-copy gate. The public event endpoint is not used as
physical-deletion evidence.
Synapse WAL and restic backups are separate controlled stores and must also
complete their own evidence.

For the pinned `v26.08` Mautrix bridge-v2 images, bridge inventory entries must
carry `bridge_id`, `message_id`, and `part_id`. Configure the bridge database
connection in `COMMUNICATOR_RETENTION_BRIDGE_DATABASE_URL` (and optionally a
test or wrapper binary in `COMMUNICATOR_RETENTION_BRIDGE_PSQL_BIN`). The host
service checks the common bridge-v2 `message` table, then deletes that exact
message part and matching `reaction` rows in one transaction. It never deletes
a portal, account, session, or key row. An absent exact mapping or database
connection remains incomplete.

The configured Cloudflare Queue uses the real API when
`COMMUNICATOR_RETENTION_QUEUE_ACCOUNT_ID`, `COMMUNICATOR_RETENTION_QUEUE_ID`,
and `COMMUNICATOR_RETENTION_QUEUE_API_TOKEN` are present. Inventory calls the
Queue `messages/peek` endpoint with `{ "batch_size": N }` and accepts an item
only when its body carries the same resource id and content generation;
cleanup calls `messages/purge` with `{ "refs": [{ "ref": "..." }] }`, using
the opaque peek reference exactly as returned by Cloudflare. The service
refuses to infer a resource from the Communicator ingestion pointer, and a
full/ambiguous peek page remains incomplete. `COMMUNICATOR_RETENTION_QUEUE_API_URL`
is only a test/private API base override. The generic command hook remains an
explicit provider escape hatch for other configured stores, but it cannot turn
an unscoped mapping into completion.

The core backup contains PostgreSQL custom-format images for Synapse and each
bridge. `backup-core.sh` writes
`retention/controlled-copy-layout.json`, which declares those four database
contracts and exhaustively lists every regular file in the staged tree. A
core mixed-copy migration restores each target dump in a throwaway local
PostgreSQL cluster, rewrites only the exact Synapse event or bridge message
part (including matching reaction rows), re-dumps it, restores the replacement
dump into a second database, and verifies the target is absent while unrelated
rows remain. It removes only explicitly mapped Synapse media files. Unknown
schemas, missing row mappings, incomplete media mappings, or unexpected files
are rejected before the old snapshot can be forgotten. Session credentials,
account keys, unrelated database rows, and other bridge state remain in the
replacement snapshot.

Restic is handled directly for an exclusive message-only snapshot. The cleanup
invokes `restic forget <snapshot> --prune` after checking the manifest class and
`exclusive_resource_id`. The existing [`backup-core.sh`](../../scripts/backup-core.sh)
records its mixed database/media/session/key snapshot explicitly and merges a
sidecar entry using the exact `snapshot_id` from that backup's JSON summary;
historical entries and other store inventories are retained.
When restic credentials are configured, inventory calls `restic snapshots
--json` and reconciles every controlled tag with the sidecar before returning a
complete result. A missing or extra tagged snapshot leaves the inventory
incomplete even when a matching manifest entry happens to exist.

An operator can migrate a legacy mixed snapshot by setting
`COMMUNICATOR_RETENTION_RESTIC_MIGRATION_MANIFEST` to a root-only JSON manifest
that exhaustively maps every restored regular file to one exact message
lineage, `session_credential`, or `account_key`. The host adapter restores the
snapshot into a temporary directory, rejects omissions, symlinks, wildcard
message lineages, unexpected files outside the declared prefix, and mixed file
classes, then creates one replacement
message-only snapshot per retained lineage and separate protected snapshots
for session credentials and account keys. It forgets the old snapshot only
after every replacement returns an exact snapshot id, and atomically records
the new references. The removed lineage is deliberately absent from the
replacement set. A pre-layout `backup-core.sh` snapshot may use
`format: "communicator-core-pgdump-v0"` in the migration manifest. The host
adapter recognizes and validates the original fixed runtime tree, enumerates
its media subtree, synthesizes the v1 layout on the replacement, and then uses
the same exact database rewrite and second-restore proof. It still requires
explicit target row and exhaustive media mappings. Unknown shapes, arbitrary
custom dumps, and unsupported database schemas remain visible as an
administrator alert and never become a false completion claim.

The Worker always persists unavailable or unsupported stores as incomplete
operations. Configure all required private endpoints before relying on a
completion status; credentials and session-key adapters use `preserved` and
are reported separately from the six required message-copy stores.

The HTTP removal handler and removal MCP tool pass
`retentionAdapters: createConfiguredControlledCopyAdapters(context.env as
Record<string, unknown>)` into `recordRemovalWithArchivePurge`. The scheduled
Worker entry point constructs and passes the same adapters before running the
expiry and retention sweep. Status reads use the durable controlled-copy rows
and therefore do not need a second provider call.
