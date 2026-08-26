# Communicator: Unified Messaging Data Platform

## Proposal status

- Status: Draft
- Purpose: Technical and commercial feasibility proposal
- Intended audience: Product, engineering, security, and operations
- Proposed pilot host: `contabo-eu` (`169.58.160.23`)

## Executive summary

Communicator will provide a unified, programmatic interface to WhatsApp, Telegram, and Facebook Messenger. It will use Matrix as the common messaging protocol, Synapse as the Matrix homeserver, and mautrix bridges to translate between Matrix and each external network.

Messages received after an account is connected will enter Matrix rooms and be retained by Synapse unless a retention policy removes them. A separate Cloudflare data plane will consume those Matrix events and create tenant-specific, report-friendly projections. Each tenant will initially have a SQLite-backed Durable Object, while R2 will hold immutable raw-event batches, exports, and optionally archived media.

The proposed architecture is technically viable and inexpensive at pilot and early-production scale. The principal risks are not infrastructure cost; they are the unofficial nature of WhatsApp and Messenger connectivity, incomplete historical backfill, encryption-key management, privacy obligations, and operational dependence on changing third-party protocols.

The recommended pilot is:

- Synapse and PostgreSQL on a Contabo VPS.
- `mautrix-whatsapp`, `mautrix-telegram`, and `mautrix-meta` on the same VPS.
- A Matrix event consumer forwarding normalized batches to Cloudflare Queues.
- One SQLite-backed Durable Object per tenant.
- R2 as a replayable archive and media/export store.
- Cloudflare Workers as the authenticated application and reporting API.

## Goals

- Provide one API and event stream for WhatsApp, Telegram, and Messenger.
- Retain the messages delivered to the system for later browsing and processing.
- Support tenant-isolated search, reports, dashboards, exports, and automation.
- Keep the reporting model independent of Matrix's internal database schema.
- Make Cloudflare projections rebuildable from an immutable archive.
- Start on inexpensive infrastructure while leaving a clear scaling path.

## Non-goals

- Guarantee import of every message sent before an account is connected.
- Replace official business APIs for regulated or high-volume outbound messaging.
- Treat Synapse's PostgreSQL schema as an application-facing reporting API.
- Store large attachments directly in Durable Object SQLite.
- Provide a fully self-hosted build of the proprietary Beeper product.
- Include email in the initial mautrix deployment.

## Platform findings

### Mautrix and Beeper

Mautrix is an open-source Matrix bridge framework and collection of bridges. It began as independent Matrix tooling and is now core infrastructure for Beeper. Beeper employs and sponsors substantial mautrix development, and recent bridge architecture has been shaped by Beeper's commercial requirements while retaining standard Matrix application-service support.

This provides meaningful commercial validation, but it does not make every upstream connection official:

| Network | Bridge | Connection model | Operational risk |
| --- | --- | --- | --- |
| Telegram | `mautrix-telegram` | Official Telegram client API/MTProto | Lowest of the three; suspicious automation can still be flagged |
| WhatsApp | `mautrix-whatsapp` | Linked-device, reverse-engineered multi-device protocol | Protocol changes and account enforcement |
| Facebook Messenger | `mautrix-meta` | Browser session and private web APIs | Highest fragility and account-challenge risk |

Mautrix bridges primarily support **puppeting**: the user logs in with a real remote-network account and its conversations are represented as Matrix rooms. Some bridges also provide relay modes through a bot or dedicated relay account.

### Beeper self-hosting boundary

Beeper currently supports self-hosting its bridges using Beeper Bridge Manager (`bbctl`), but those bridges connect to a Beeper account and Beeper's Matrix infrastructure. The complete modern Beeper account, synchronization, server, and official-client stack is not offered as a supported standalone self-hosted product.

A fully independent installation therefore uses:

- Synapse or another Matrix homeserver.
- Mautrix bridges.
- PostgreSQL.
- An open Matrix client such as Element.
- The standard Matrix Client-Server API for automation.

### Why Synapse

Synapse is the recommended homeserver for this pilot because it has mature Matrix Application Service support, broad mautrix compatibility, PostgreSQL support, administration APIs, monitoring, and a well-understood scaling path. It is not the lightest homeserver, but it minimizes integration risk.

For a small installation, Synapse should run as a single process. Redis and Synapse workers are unnecessary until measurements show that horizontal scaling is required.

Production requirements include:

- PostgreSQL rather than SQLite.
- HTTPS behind Caddy, nginx, or another reverse proxy.
- Disabled public registration.
- A private Synapse Admin API.
- Federation disabled initially unless it is explicitly required.
- Backups of PostgreSQL, signing keys, media, bridge databases, and bridge configuration.
- TURN only if Matrix voice or video calling is required.

## Message storage and history

Once a bridge is connected, the normal flow is:

```text
Remote network
    -> mautrix bridge
    -> Matrix room event
    -> Synapse PostgreSQL and media store
```

Synapse stores Matrix events, including messages, timestamps, senders, reactions, edits, receipts, and room state. Attachments and thumbnails normally live in Synapse's media store rather than as PostgreSQL blobs. Each mautrix bridge also has a database for remote-to-Matrix mappings, login sessions, portals, synchronization checkpoints, and bridge-specific metadata. The bridge database is operational state, not the primary message archive.

By default, Synapse does not automatically purge messages when no retention policy exists. Historical messages should be accessed through Matrix APIs such as `/sync` and `/rooms/{roomId}/messages`, not by depending on Synapse's private database schema.

### History limitations

The system can reliably preserve what it receives after connection, subject to outages and correct backups. It cannot promise a complete lifetime archive from before connection:

- Telegram generally offers strong history backfill.
- WhatsApp provides linked-device history synchronization with service-controlled limits and one-time behavior.
- Messenger backfill depends on Meta's private APIs and current bridge support.
- Edits, deletions, disappearing messages, and view-once media require explicit product and compliance decisions.

### Encryption implications

With Matrix room encryption enabled, Synapse stores encrypted event contents. Authorized Matrix clients and bridges can decrypt them, but direct PostgreSQL queries will generally see ciphertext. Any event consumer must therefore operate as a verified Matrix device and persist its encryption keys securely.

Unencrypted private rooms simplify server-side processing but allow server and database administrators to read message contents. Encryption should be the default for sensitive customer communications unless a documented threat model supports another decision.

## Proposed architecture

```text
WhatsApp        Telegram        Messenger
    \              |               /
     \         mautrix bridges    /
      +------------+-------------+
                   |
             Synapse / Matrix
                   |
          Matrix event consumer
                   |
            Cloudflare Queue
              /           \
             /             \
 Tenant Durable Object     R2 archive
      SQLite               raw events/media
             \             /
              Cloudflare Worker
               API and reports
```

### Responsibility boundaries

| Component | Responsibility |
| --- | --- |
| External networks | Original messaging systems |
| Mautrix | Network translation and account sessions |
| Synapse | Operational Matrix history and messaging system of record |
| Matrix event consumer | Incremental ingestion, decryption, normalization, and checkpointing |
| Cloudflare Queue | Failure isolation, retries, and asynchronous delivery |
| Tenant Durable Object | Hot, tenant-isolated query model and aggregates |
| R2 | Replayable raw archive, exports, and optional archived attachments |
| Worker | Authentication, tenant routing, APIs, dashboards, and reports |

### Durable Object storage clarification

Durable Object SQLite is Cloudflare-managed storage attached to the object; R2 does not back the SQLite file. The two stores are separate:

- Durable Object SQLite holds normalized, indexed, interactive data.
- R2 holds immutable event batches, large binary objects, and exports.

### One Durable Object per tenant

A tenant workspace is a good initial Durable Object boundary because it provides:

- Strong per-tenant coordination and serialized writes.
- Simple authorization and deletion boundaries.
- Private storage per object.
- Natural placement of tenant reports and aggregates.
- Reduced risk of accidentally omitting a `tenant_id` predicate.

Constraints include:

- A current 10 GB SQLite limit per Durable Object.
- Single-threaded synchronous execution within each object.
- A large tenant can become a hotspot.
- Fleet-wide reports cannot efficiently scan thousands of tenant objects.

If an individual tenant approaches the limit or becomes throughput-bound, shard that tenant by stable units such as year, conversation group, or account. Do not introduce sharding before measurements justify it.

### Suggested tenant schema

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  matrix_event_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  remote_message_id TEXT,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT,
  sent_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  raw_r2_key TEXT
);
```

Additional tables should represent conversations, participants, attachment metadata, reactions, daily aggregates, and ingestion checkpoints. Store only attachment metadata and an R2 key in SQLite.

Every ingestion write must be idempotent. Use `matrix_event_id` or a canonical network/message identifier as a unique key because queue retries, reconnects, and recovery replays can deliver the same event more than once.

### R2 layout

Avoid one R2 object per message. Instead, write compressed hourly or size-based batches:

```text
events/{tenant}/{year}/{month}/{day}/{hour}/{batch-id}.jsonl.gz
media/{tenant}/{content-hash}
exports/{tenant}/{timestamp}.jsonl.gz
```

At larger scale, emit Parquet into R2 Data Catalog/Iceberg for cross-tenant analytical queries through R2 SQL or another Iceberg-compatible engine.

### Is the mirror redundant?

The mirror is justified when the product needs cross-channel search, business reports, response-time metrics, classifications, exports, AI processing, or a stable domain model independent of Matrix.

It would be redundant if the only requirement were chronological room browsing through Matrix clients. In that case, retaining only aggregates and selected metadata would be sufficient.

The intended ownership model is:

```text
Synapse = operational messaging truth
R2 = immutable ingestion archive
Durable Object SQLite = disposable, rebuildable query projection
```

## Cost model

### Cloudflare

At current published prices, the Workers Paid minimum is approximately USD $5 per month. Important included monthly allowances and overages include:

| Component | Included | Overage |
| --- | ---: | ---: |
| Workers | 10M requests; 30M CPU-ms | $0.30/M requests; $0.02/M CPU-ms |
| Durable Object requests | 1M | $0.15/M |
| Durable Object duration | 400K GB-s | $12.50/M GB-s |
| DO SQLite row reads | 25B | $0.001/M rows |
| DO SQLite row writes | 50M | $1/M rows |
| DO SQLite storage | 5 GB | $0.20/GB-month |
| Queues | 1M operations | $0.40/M operations |
| R2 standard storage | 10 GB | $0.015/GB-month |
| R2 Class A writes | 1M | $4.50/M |
| R2 Class B reads | 10M | $0.36/M |

A typical Queue delivery consumes three operations: write, read, and delete.

Directional Cloudflare estimates, assuming batching and modest report use:

| Messages per month | Estimated Cloudflare cost |
| ---: | ---: |
| 100,000 | About $5 |
| 1 million | About $5-$10 |
| 10 million | About $15-$40 |
| 100 million | Potentially several hundred dollars |

The main cost mistakes would be:

- Writing one R2 object per message.
- Updating many SQLite tables and indexes for every message.
- Keeping Durable Objects awake instead of allowing hibernation.
- Storing attachments in both Synapse and R2 without a deliberate retention reason.
- Repeated full-history scans for reports instead of maintaining periodic aggregates.

Efficient ingestion should batch 50-500 messages per tenant invocation, commit them in a transaction, aggregate counters periodically, and write compressed R2 batches.

### VPS

The Cloudflare plane is likely to cost less than the VPS during the pilot. A likely early-stage monthly total is:

| Item | Estimate |
| --- | ---: |
| Cloudflare | $5-$20 |
| Synapse VPS | $20-$50 |
| VPS backups/storage | $5-$20 |
| Domain and monitoring | $2-$10 |
| Total | Approximately $32-$100 |

Provider location surcharges, VAT, media volume, and backup retention can change this estimate.

## VPS sizing and Contabo recommendation

### Resource profile

Approximate memory planning for a small deployment:

```text
Synapse                    1-3 GB
PostgreSQL                 1-4 GB
mautrix-whatsapp         200-800 MB
mautrix-telegram         200-800 MB
mautrix-meta             200-800 MB
Proxy, containers, monitoring 0.5-1 GB
OS filesystem cache       remaining RAM
```

Backfills, media conversions, PostgreSQL maintenance, large rooms, and many simultaneously connected accounts create temporary spikes.

### Capacity guidance

| Connected remote accounts | Suggested minimum |
| ---: | --- |
| 1-20 | 4 vCPU, 8 GB RAM |
| 20-100 | 6 vCPU, 12 GB RAM |
| 100-500 | 8 vCPU, 24 GB RAM |
| 500+ | Benchmark and split services based on observed bottlenecks |

These are planning estimates rather than hard platform limits. Active message rate matters more than the number of dormant tenants.

### Contabo

Contabo is suitable for the pilot. The provisioned 2026 Cloud VPS has 6 vCPU, 12 GB RAM, and a 200 GB SSD, which is sufficient for the personal prototype. Earlier advertised examples were:

| Plan | Resources | Use |
| --- | --- | --- |
| Cloud VPS 10 | 3 vCPU, 8 GB, 75 GB NVMe | Development or a small personal instance |
| Cloud VPS 20 | 6 vCPU, 12 GB, 100 GB NVMe | Minimum comfortable early production |
| Cloud VPS 30 | 8 vCPU, 24 GB, 200 GB NVMe | Recommended pilot with production headroom |
| Cloud VDS S | Dedicated CPU, 24 GB, 180 GB NVMe | Upgrade for established production traffic |

The pilot uses the provisioned 6 vCPU, 12 GB, 200 GB SSD VPS with Ubuntu 24.04 LTS, PostgreSQL 16 or newer, compressed zram swap, and no public Matrix federation initially. Resize only when measurements show sustained CPU, memory, or I/O pressure.

Prefer NVMe over a capacity-oriented storage VPS for PostgreSQL latency. Use R2 for scalable archive capacity. Set alerts at approximately 70% disk utilization and define explicit Synapse media and log retention.

Contabo's low-cost VPS uses shared CPU and can experience noisy-neighbor variability. This is acceptable for a pilot. A revenue-critical deployment should move to dedicated CPU or another provider with stronger performance consistency and operational guarantees.

### Deployment topology

The initial VPS can run:

```text
Caddy
Synapse
PostgreSQL 16+
mautrix-whatsapp
mautrix-telegram
mautrix-meta
Matrix event forwarder
Monitoring agent
```

Each bridge should have a separate PostgreSQL database within the same PostgreSQL server. PostgreSQL and bridge administration ports must not be exposed publicly.

### Backups

Contabo's optional automatic backups are daily and retained for a limited period. They are useful but are not a complete recovery plan.

Required backup material includes:

- Nightly PostgreSQL backups stored off-server in R2.
- Synapse signing keys.
- Appservice registration files.
- Encrypted bridge configuration and bridge databases.
- Required Synapse media not already archived in R2.
- Periodic volume snapshots.
- A documented and tested restoration procedure.

Use bucket versioning, retention protection, or another control that prevents a compromised VPS from immediately deleting all backups.

## Email

Mautrix does not currently provide a maintained first-party email bridge equivalent to its WhatsApp, Telegram, and Meta bridges.

The wider Matrix ecosystem includes:

- Postmoogle, an SMTP server that maps mailboxes to Matrix rooms.
- Experimental or less mature IMAP/SMTP bridges for existing personal mailboxes.

For Gmail or Microsoft 365, direct Gmail API or Microsoft Graph integrations are preferable. They preserve native threading, labels, drafts, search, authentication, and provider-specific semantics. Email should enter the same tenant reporting model through a separate connector rather than being forced through mautrix.

## Security, privacy, and compliance

The system centralizes highly sensitive communications. Before production, it requires:

- Explicit customer consent and a documented lawful basis for retention and analysis.
- Tenant-specific retention and deletion policies.
- A clear policy for remote deletions, disappearing messages, and view-once content.
- Encryption in transit and at rest.
- Restricted administrative access and comprehensive audit logging.
- Secure storage and rotation of Matrix device keys, bridge sessions, API tokens, and backups.
- A tested tenant export and erasure workflow spanning Synapse, bridge databases, Durable Objects, R2, logs, and backups.
- Review of Synapse and mautrix AGPL obligations, especially if distributing modified versions or providing a network service using modifications.
- Review of WhatsApp and Meta platform terms before commercial launch.

The platform should distinguish between operational retention, customer-visible history, compliance archive, and derived analytics. These must not silently share an indefinite retention policy.

## Key risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| WhatsApp or Meta protocol changes | Bridge outages | Monitoring, staged upgrades, incident runbooks, customer communication |
| Account challenges or bans | Customer disruption | Conservative automation, established accounts, 2FA, official APIs where required |
| Incomplete historical backfill | Missing older messages | State limitation clearly; preserve all newly received events; import separately where possible |
| Encryption-key loss | Unreadable archived Matrix events | Secure persistent device-key backups and restoration testing |
| Duplicate ingestion | Incorrect reports | Idempotent unique event keys and transactional writes |
| R2/DO divergence | Missing or inconsistent projections | Archive-first or atomic checkpoint workflow; reconciliation jobs |
| Tenant DO reaches 10 GB | Failed writes | Usage alerts, retention, cold archive, planned tenant sharding |
| Shared VPS contention | Latency and outages | Metrics, capacity thresholds, dedicated-CPU upgrade path |
| Single VPS failure | Service outage | Offsite backups first; later warm standby or service separation |
| Excessive media growth | Disk exhaustion | R2 archive, lifecycle rules, local retention, disk alerts |

## Pilot plan

### Phase 1: Infrastructure

1. Provision the Contabo VPS.
2. Harden SSH and the host firewall.
3. Install Docker, PostgreSQL, Caddy, and monitoring.
4. Deploy Synapse with registration and federation disabled.
5. Configure encrypted offsite backups.

### Phase 2: Bridges

1. Deploy each bridge with a separate PostgreSQL database.
2. Register the appservices in Synapse.
3. Connect controlled test accounts.
4. Validate text, media, replies, reactions, edits, deletions, receipts, reconnects, and backfill.

### Phase 3: Cloudflare projection

1. Implement a verified Matrix event-consumer device.
2. Publish idempotent message batches to Cloudflare Queues.
3. Create a SQLite-backed Durable Object per tenant.
4. Write compressed raw-event batches to R2.
5. Add reconciliation and replay tooling.

### Phase 4: Reports and product validation

1. Implement conversation browsing and search.
2. Add response-time and message-volume reports.
3. Validate tenant isolation, export, retention, and deletion.
4. Measure cost per message and per active account.
5. Establish thresholds for a larger VPS, dedicated CPU, and tenant sharding.

## Success criteria

- Test accounts remain connected reliably through normal restarts.
- New messages reach the tenant projection without loss.
- Duplicate delivery does not duplicate records or aggregates.
- A deleted tenant can be erased across live stores according to policy.
- A tenant Durable Object can be rebuilt from the R2 archive.
- PostgreSQL and bridge state can be restored to a clean VPS.
- Resource use and monthly cost remain within documented pilot budgets.
- Platform-specific limitations are visible to customers and support staff.

## Current server-access status

The proposed server is identified as:

```text
Alias: contabo-eu
Host: 169.58.160.23
```

Current verified access and host state:

- SSH uses the dedicated `admin` account and a dedicated Ed25519 key.
- SSH password authentication and root login are disabled.
- Ubuntu 24.04 LTS, 6 vCPU, 12 GB RAM, and approximately 200 GB disk are present.
- Docker Engine and Compose are installed from Docker's official Ubuntu repository.
- The firewall permits only SSH, HTTP, and HTTPS inbound.
- Static IPv4 and IPv6 connectivity are operational.
- Host IPv6 remains enabled and tested, but Matrix hostname AAAA publication is intentionally deferred until a separate IPv6 ingress test is approved.

Repository development remains local. Host-affecting commands run explicitly through the verified `contabo-eu` SSH alias, and releases are transferred without Git history, local environment files, runtime data, or secrets.

## Open decisions

1. How many connected remote accounts are expected during the pilot and first year?
2. Is this a personal inbox product, internal company tool, or customer-facing commercial service?
3. Must Matrix rooms be end-to-end encrypted?
4. What are the retention rules for text, attachments, deletions, and disappearing messages?
5. Is R2 the compliance archive or only a rebuild source?
6. Should attachments be archived immediately or fetched only when required?
7. Is cross-tenant analytics permitted, and if so, at what level of aggregation?
8. What uptime objective triggers migration from shared VPS to dedicated CPU or redundant hosts?
9. Which email providers, if any, enter the first release through direct APIs?
10. What licensing and platform-terms review is required before launch?

## References

- Mautrix documentation: https://docs.mau.fi/bridges/
- Mautrix bridge usage: https://docs.mau.fi/bridges/general/using-bridges.html
- Mautrix bridge setup: https://docs.mau.fi/bridges/go/setup.html
- Synapse installation: https://element-hq.github.io/synapse/latest/setup/installation.html
- Synapse retention: https://element-hq.github.io/synapse/latest/message_retention_policies.html
- Synapse media repository: https://element-hq.github.io/synapse/latest/media_repository.html
- Matrix Client-Server API: https://spec.matrix.org/latest/client-server-api/
- Beeper bridge self-hosting: https://developers.beeper.com/bridges/self-hosting
- Durable Object design guidance: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Durable Object pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- R2 SQL: https://developers.cloudflare.com/r2-sql/
- Contabo pricing: https://contabo.com/en/pricing/
- Contabo automatic backups: https://help.contabo.com/en/support/solutions/articles/103000331729-what-is-the-auto-backup-add-on-
