# Retention, deletion, backup, and restore research

**Date:** 2026-09-13  
**Scope:** Area 5: prompt active removal, with a 30-day maximum for backup and other controlled recoverable copies  
**Status:** Research and proposed options; no product decision is recorded here

This assessment compares [`docs/product-alignment.md`](../product-alignment.md) with current archive, projection, Matrix/Synapse, bridge, queue, media, and backup boundaries. Cloudflare findings came through the configured Executor docs integration; Matrix/Synapse/Mautrix findings use official documentation or source. The key distinction is between removing content from an active view, one store, or every recoverable copy. No purge operation was performed.

## Assessment

The desired behavior promptly removes expired or deleted content from active storage, search, and downloadable attachments; retains a removal record; ages backups out within 30 days; prevents restore resurrection; and cancels queued webhooks. The current system implements only part of this and has no deletion authority that survives archive replay and backup restore.

The R2 archive is append-only at the object-key level. The writer conditionally creates canonical gzip JSONL plus a manifest, records SHA-256, ETag, sizes, event range, and producer/checkpoint metadata, and reuses an exact pair on retry. The reader validates the manifest, metadata, bytes, hash, and event range before replay. See [`r2-archive-local.md`](../runbooks/r2-archive-local.md) and [`writer.ts`](../../apps/control-plane/worker/archive/writer.ts). This preserves original payloads; the runbook leaves retention, object locking, and erasure undecided.

The projection behaves differently. A deletion creates a permanent resource tombstone and `redactMessage` clears message bodies, identity data, reactions, receipts, failures, and attachment metadata; later ordinary events are gated in the live projection. A rebuild clears derived tables, including tombstones, then replays R2. The tombstone is not an anti-resurrection authority unless stored and reapplied outside the projection. R2 remains a rebuild source, and media retention/erasure is out of scope today.

| Surface | Current behavior | Retention consequence |
| --- | --- | --- |
| R2 archive | Immutable matching data/manifest commit; replay verifies bytes and hashes | Original content remains recoverable until the object and copies expire or are purged |
| DO SQLite projection | Tombstones redact active state; rebuild clears derived rows | A restore/replay can resurrect content without an external removal ledger |
| Synapse | No retention policy is rendered in the current homeserver template | Synapse may retain events and database rows indefinitely by default |
| Synapse media | Backup includes `media_store`; projection stores only an R2 reference | Clearing metadata does not remove media or backup copies |
| Mautrix databases | Bridge PostgreSQL databases are included in restic backups; retention is provider/version-specific | There is no generic 30-day bridge purge contract |
| Queues | Current queue and DLQ retention is 14 days | Expiry bounds delivery retry state, not R2, database, media, or webhook copies |
| Restic restore | Restores a raw snapshot into an isolated runtime and validates it | No age gate, removal filter, or tombstone reapplication |

## Matrix, media, and bridge limits

Synapse’s retention policy is disabled by default. When enabled, `max_lifetime` hides expired events from clients and a later purge removes database rows; the purge can lag, does not remove state events, and will not delete the last room message. See [Synapse message retention policies](https://element-hq.github.io/synapse/latest/message_retention_policies). Separate [`redaction_retention_period`](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html?highlight=retention) controls how long unredacted redacted content remains in the database (documented default: seven days). Neither setting covers federated, backed-up, or external copies.

Synapse’s purge-history API has separate local-event behavior and may need vacuuming to reclaim disk ([purge history API](https://github.com/element-hq/synapse/blob/develop/docs/admin_api/purge_history_api.md)). Its media API distinguishes quarantine from deletion: quarantine blocks access but retains files/thumbnails; local deletion removes local files and cached thumbnails. Remote media can return, and external repositories are unaffected ([media admin API](https://element-hq.github.io/synapse/latest/admin_api/media_admin_api.html)). “Redacted,” “not served,” “row removed,” and “bytes unavailable” are separate criteria.

Matrix redaction removes non-required content from an event representation, while the redaction event remains in the event DAG ([Matrix room specification](https://spec.matrix.org/latest/rooms/v11/)). It does not wipe homeservers, backups, exports, caches, or remote repositories. Local renderers disable public/direct bridge media and history/backfill, reducing new exposure but not expiring existing backups.

Official Mautrix documentation describes provider-specific behavior, not a common bridge retention guarantee. The WhatsApp bridge temporarily stores history-sync messages, deletes them after backfill or when the room already has messages, and may not request a lost blob again ([Mautrix backfill](https://docs.mau.fi/bridges/general/backfill.html)). Restic still captures bridge databases, configs, registrations, sessions, and credentials. Deletion must inventory the installed version/schema and remove message metadata and media mappings; session/key copies that could restore access are a separate recoverability constraint and account/session lifecycle must not be conflated with message cleanup.

## Platform constraints and restore risk

Cloudflare Durable Objects SQLite point-in-time recovery can restore SQL and key-value contents to any point in the prior 30 days ([DO storage access](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)). It is therefore a pre-deletion copy: restoring an old bookmark can recreate deleted state unless the removal authority is loaded and reapplied first.

R2 lifecycle deletion is asynchronous: objects are typically removed within about 24 hours after expiry, with timing depending on workload ([R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)). Direct deletion is strongly consistent, but custom-domain caches can serve an old object until expiry or purge ([R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)). Bucket locks protect objects from deletion/overwrite for a fixed duration, date, or indefinitely ([R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)); a lock beyond 30 days conflicts with prompt erasure. A hard 30-day bound therefore needs early expiry and explicit completion checks; if provider behavior cannot prove that bound, status must remain unknown rather than be claimed.

The Workers API exposes a random per-upload `version` identifier ([R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)). The docs located here do not establish that it is recoverable version history or that lifecycle deletion removes hidden generations. Treat the object, restic snapshots, exports, caches, and provider copies as separate retention surfaces until verified.

Cloudflare Queues supports 60 seconds through 14 days, and purge is irreversible ([custom queue retention](https://developers.cloudflare.com/changelog/post/2025-02-14-customize-queue-retention-period/); [queue purge](https://developers.cloudflare.com/changelog/product/queues/)). The repository configures 14 days. This bounds queue state, not an accepted webhook, provider copy, or source R2 event; dispatch needs a final removal-epoch check before sending.

[`backup-core.sh`](../../scripts/backup-core.sh) dumps Synapse and three bridge databases, copies Synapse media and runtime/configuration, and runs restic; it defines no age policy or deletion ledger. [`restore-core-test.sh`](../../scripts/restore-core-test.sh) restores a snapshot into an isolated runtime and validates it, but does not filter removed records, replay removal markers, or start from a deletion authority. The recovery runbook forbids restoring over production but lacks anti-resurrection ordering.

## Proposed options and tradeoffs

**Option A — external removal ledger plus purge executor (recommended control).** Create a durable removal record outside the rebuildable DO projection with tenant/resource identifiers, event/object keys, deletion time, content generation, and completion state. Write it before redaction or cancellation. Archive replay, DO PITR, backup restore, and webhook send must consult it; restore loads it first, rejects pre-removal events, then exposes the projection. An executor purges projection, Synapse, media, bridge mappings, R2, and aged backups. This preserves archive integrity but adds a source-of-truth boundary and partial-failure handling. It cannot safely delete an R2 batch that mixes a removed event with retained events; it needs archive rewrite or a storage layout that segments purge units.

**Option B — redact/rewrite or segment the archive (complements A).** For mixed batches, publish a sanitized replacement batch/manifest, then delete originals after a safety window. This changes the immutable-byte/hash contract, needs new lineage semantics, and is blocked by bucket locks. Future per-message or otherwise purgeable segments reduce collateral deletion. Older restic snapshots still need the ledger or their own purge.

**Option C — per-message encryption with key erasure.** Delete a separately tracked key while retaining metadata/tombstones. This works only if every copy lacks the key, key backups share the retention policy, and objects have envelope-key boundaries. Current archive, Synapse media, bridge databases, and Matrix session keys do not demonstrate that property; crypto-erasure is a future design, not an assumption about E2EE.

R2 lifecycle alone is least disruptive but does not meet the physical-removal and anti-resurrection requirement: it does not solve DO PITR, restic, Synapse/bridge data, cached media, or replay. Reserve bucket locks for an object class intentionally retained beyond 30 days; they conflict with the stated ceiling for message archives.

## Proposed recommendation

Use Option A as the immediate control, paired with Option B or a purgeable archive segmentation scheme, lifecycle deletion, and a restore gate. The ledger outlives protected content and is restored before projection or bridge service startup. Record removal, advance a deletion epoch, cancel queued deliveries, recheck the epoch before webhook send, redact projections, purge Synapse/bridge data where supported, remove R2 objects/manifests, and age restic copies within 30 days. Restore must reapply removals before startup and prevent stale outbox/webhook pointers crossing the epoch.

The stated scope requires active removal to take effect on deletion or expiry, while controlled backups have a 30-day maximum and a cleanup/completion policy must prove that bound; logical filtering alone does not satisfy it. If archive bytes must be removed, choose archive rewrite/segmentation or a new per-message-key scheme and accept the change to immutable replay. Delivered third-party messages, client caches, remote homeservers, and external media repositories remain outside direct deletion control; the contract can cancel pending work and request provider deletion without claiming recall.
