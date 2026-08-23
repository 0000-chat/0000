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
