# Matrix Core Recovery

## Simple explanation

Backups are valid only after a clean restore test. The restore test uses a different Compose project and does not overwrite the running system.

## Technical procedure

1. Before execution, obtain the user's off-server backend choice and connection details. For this non-Cloudflare stage, prefer SFTP unless the user explicitly selects another backend.
2. For SFTP, set `RESTIC_REPOSITORY=sftp:<user>@<host>:/<absolute-path>` and `RESTIC_PASSWORD_FILE=/srv/communicator/secrets/restic.password` in `/srv/communicator/secrets/restic.env`. Create a dedicated root-readable SSH key, pin the verified server host key in `/root/.ssh/known_hosts`, and require `StrictHostKeyChecking=yes`; never accept a host key non-interactively without comparing its fingerprint to operator-provided evidence.
3. If the user instead selects an S3-compatible backend, record its endpoint and required `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` variables in the same root-only environment file. Do not assume R2 or create Cloudflare resources in this stage.
4. Require `restic.env`, the password file, and any backend key to be owned by `root:root` with mode `0600`. Never pass secret values through SSH arguments or write them to Git or operator logs.
5. Load the verified root-only environment and initialize once with `restic snapshots`; run `restic init` only when the repository is confirmed absent, never to replace an unexpected or inaccessible repository.
6. From `/opt/communicator/current`, run `sudo bash -c 'set -a; source /srv/communicator/secrets/restic.env; set +a; COMMUNICATOR_RUNTIME_DIR=/srv/communicator ./scripts/backup-core.sh'`.
7. Require `backup=PASS` and confirm that Synapse returned to healthy status.
8. Run the restore script through the same remote root-only environment pattern and require `restore_test=PASS`.
9. Confirm the restored Synapse health endpoint responds inside the isolated project.
10. Keep the restored files until the operator records the test evidence, then remove that exact timestamped restore-test directory through a separately approved cleanup action. Never restore over the running PostgreSQL data directory.
