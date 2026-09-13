# Matrix gateway operations

The Matrix gateway is a receive-only daemon. It restores an already
bootstrapped Matrix SDK session, journals each `/sync` response in the
encrypted gateway store, and delivers accepted batches through the ingestion
endpoint. Account bootstrap is an explicit maintenance operation and is not
performed by daemon startup.

## Install and configure

1. Build and review the `communicator-matrix-gateway` binary, then install it
   at `/usr/local/bin/communicator-matrix-gateway`.
2. Copy `deploy/matrix-gateway/config.example.json` to
   `/etc/communicator/matrix-gateway/config.json`. Set the deployment's
   endpoint and identity values while retaining the fixed private Synapse
   origin shape (`http://synapse:8008`). All paths must be absolute and must
   remain within the protected runtime layout.
3. Provision the four protected files named by the configuration separately:
   the Matrix password (for explicit bootstrap tooling), Matrix SDK
   passphrase, state key, and OAuth client secret. Keep them outside Git,
   images, environment interpolation, logs, and process arguments. The daemon
   reads the passphrase, state key, and OAuth secret; it does not read the
   password during normal receive-only operation.
4. Create the configured Matrix-store and state directories owned by the
   service account. Preserve the encrypted state database and SDK store across
   upgrades and restarts.
5. Install
   `deploy/matrix-gateway/communicator-matrix-gateway.service` as a systemd
   unit. Inspect its paths, user, restart policy, and protected mounts before
   enabling it.

Do not enable the unit until the local review, fixture run, and proof gates
have passed. This package does not activate production or send live messages.

## Local review and health

Run the repository checks from the repository root, including the focused
gateway tests and the complete repository check. Review the exact binary and
unit diff before installation. A local state database can be observed without
the state key:

```text
communicator-matrix-gateway healthcheck --state-db /srv/communicator/matrix-gateway/state/gateway.sqlite3
```

The command prints one bounded JSON line. Exit `0` means the session, pressure,
maintenance, and quarantine checks are healthy. Exit `1` is a valid blocked
health result that needs operator review. Database or observer failures use
the operational failure class. Health never calls Matrix, OAuth, or ingestion
and never reads a secret file.

With the state key, inspect bounded operational counts while the daemon is
excluded by the store lock:

```text
communicator-matrix-gateway quarantine status \
  --state-db /srv/communicator/matrix-gateway/state/gateway.sqlite3 \
  --state-key-file /etc/communicator/matrix-gateway/secrets/state-key

communicator-matrix-gateway crypto status \
  --state-db /srv/communicator/matrix-gateway/state/gateway.sqlite3 \
  --state-key-file /etc/communicator/matrix-gateway/secrets/state-key
```

These commands report bounded counts and allowlisted reason codes only. They
do not print decrypted Matrix data, event bodies, access tokens, OAuth values,
or protected identifiers.

## Quarantine recovery

When the health or quarantine status reports a quarantined live window, first
record the exact opaque `window_<64 lowercase hex>` identifier from an approved
local evidence source. Retry only that identifier:

```text
communicator-matrix-gateway quarantine retry \
  --window-id window_<64 lowercase hex> \
  --state-db /srv/communicator/matrix-gateway/state/gateway.sqlite3 \
  --state-key-file /etc/communicator/matrix-gateway/secrets/state-key
```

The store reopens the quarantined window atomically and preserves accepted
sibling batches. It does not skip, delete, acknowledge, or force-accept any
other row. Recheck health and status, then let the daemon resume the bounded
retry path. A malformed, guessed, or unverified identifier is rejected.

Recovery exhaustion remains visible as a blocked state. Do not repeatedly
retry an unresolved crypto or projection failure; preserve the state database,
capture the stable code and bounded status, and escalate for human review.

## Crypto maintenance recovery

The gateway stops before sending a forbidden Matrix crypto request. A
maintenance clear is an offline, verified operation and requires exclusive
store ownership:

```text
communicator-matrix-gateway crypto verify-clear-maintenance \
  --config /etc/communicator/matrix-gateway/config.json
```

The command restores the SDK store without network access, enumerates current
outgoing requests, and clears the authenticated maintenance marker only when
there is no pending `KeysUpload`, forbidden request, unresolved crypto row, or
quarantined crypto row. It never sends, retries, skips, acknowledges, or
deletes a request. If any proof fails, retain the marker and escalate using
the stable error code.

## Start, stop, and rollback

Start and inspect the unit only after the review gate:

```text
systemctl daemon-reload
systemctl start communicator-matrix-gateway.service
systemctl status communicator-matrix-gateway.service
```

`SIGTERM` is the normal stop path. The daemon stops before starting a new
action, retains all durable rows, and resumes from authenticated SQLite state
after restart. A crash or restart must not cause the next Matrix position to
come from an SDK token or rebuild an outbox request from current state.

For rollback, stop the unit, install the previously reviewed binary and unit,
and start it with the same configuration, encrypted database, Matrix store,
and protected files. Do not delete the state database, lock file while the
service is running, SDK store, session, or encrypted recovery evidence. Run
the healthcheck and focused proof again before resuming normal operation.
