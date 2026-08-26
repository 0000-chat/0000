# Matrix Core Operations

## Simple explanation

Run preflight, initialize the runtime, deploy the core, and validate it. Do not add a bridge until backup restoration passes.

## Technical procedure

1. Build a release only from a clean local commit with `git archive`.
2. Record the commit and archive SHA-256 in the private operator log.
3. Transfer the archive to `contabo-eu` and verify its checksum before extraction under `/opt/communicator/releases/<commit>`.
4. Run the supported-host preflight remotely and stop on any failure.
5. Obtain deployment approval tied to the exact commit, checksum, host key, DNS evidence, and completed provider snapshot.
6. Run `deploy-core.sh` only inside the verified remote release with `COMMUNICATOR_RUNTIME_DIR=/srv/communicator` and `COMPOSE_PROJECT_NAME=communicator`.
7. Require Compose `--wait` to report every service healthy.
8. Run `validate-core.sh` on the VPS and public HTTP/TLS checks from the local development host.
9. Create accounts only with `scripts/create-matrix-user.sh`.
10. Never print, copy into Git, or send the contents of `/srv/communicator/secrets`.
11. Perform backup and clean restoration before bridge planning begins.

## Personal WhatsApp bridge release

1. Verify `feat/matrix-core` is clean and record the exact release commit and archive SHA-256.
2. Verify `contabo-eu` resolves to hostname `vmi3501337`, `eth0` owns `169.58.160.23`, and the provider snapshot evidence is current.
3. Transfer only the `git archive` tarball to a fresh remote temporary path. Compare the remote checksum before extraction under `/opt/communicator/releases/<commit>`.
4. Preserve the current Synapse configuration and checksum in a root-only timestamped rollback file. Never copy its contents into operator output.
5. Activate the verified release and run `sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh`.
6. Require PostgreSQL, Synapse, Caddy, and WhatsApp to be healthy. The bridge uses only the existing internal Compose network; it has no published port and no Caddy route.
   The deployment waits for PostgreSQL, initializes the separate bridge database/runtime, installs the appservice registration, and force-recreates Synapse, Caddy, and WhatsApp so registration changes are loaded. It does not recreate volumes or drop databases.
7. Run `validate-core.sh`, `validate-whatsapp.sh`, and the public Matrix/well-known HTTPS checks. Public registration and federation/key endpoints must remain disabled/404.
8. For rollback, stop only the WhatsApp service if needed, activate the previous release, restore the protected pre-change Synapse configuration, restart Synapse with health checks, and leave the bridge database/runtime intact. Never delete PostgreSQL volumes, Matrix data, bridge session state, users, rooms, or secrets as part of rollback.
9. Do not pair a WhatsApp account during release deployment. Pairing is a separate user checkpoint requiring interactive QR or pairing-code entry.
