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

## Messenger recovery additions

The encrypted restic payload must retain all existing Matrix and WhatsApp
content and also include:

- a custom-format `messenger_bridge` PostgreSQL dump;
- protected `messenger/config.yaml` and `messenger/registration.yaml`;
- protected `synapse/messenger-registration.yaml`;
- `messenger-db.password` and `messenger-db.env`;
- bridge encryption material, persisted connection/session state, and required
  Messenger media metadata.

The production backup stops only the private bridge/core services
telegram messenger whatsapp synapse for the bounded dump window, runs restic
backup and check, and returns all six Compose services to healthy operation
with a bounded up --wait command. It must not expose
registration/config contents or account/session data.

The isolated restore uses COMPOSE_PROJECT_NAME=communicator-restore-test and a
fresh timestamped runtime. It initializes and restores the isolated Synapse,
WhatsApp, Messenger, and messenger_bridge databases, checks a positive public
table count, and validates the restored Messenger config with the pinned
image on --network none. It starts isolated PostgreSQL and Synapse only; the
restored Messenger and Telegram services are never started and cannot
reconnect a restored Human session to an external service. Agent onboarding
is deferred by user and no Agent session is created. Preserve the successful
restore evidence directory until separately approved cleanup.
## Telegram bridge recovery

The Telegram recovery payload is part of the same encrypted backup and is
restored into the disposable restore-test project only:

- the telegram_bridge database dump;
- the Telegram runtime configuration, session pickle, and appservice
  registration;
- the Synapse-side Telegram registration;
- the protected API ID, API hash, database password, and environment files.

Require the backup and restore scripts to stop and restart all bridges through
the approved Compose project, while preserving the existing WhatsApp and
Messenger payloads and health checks. Require both the Telegram table marker
and telegram_config=PASS. The restored configuration must be validated with
the pinned image and network none; never start a Telegram client or contact
Telegram during an isolated restore.

The restore test must use a separate Compose project, a disposable runtime
directory, and a restore-test PostgreSQL database. It must prove positive
Telegram public-table restoration without dropping or overwriting the
production database, and it must leave production Telegram session state and
Matrix history untouched.

For rollback or recovery of a bad release, restore the prior verified release
and protected Synapse configuration, then rerun core, WhatsApp, Messenger,
and Telegram validators. Preserve Telegram session state, registrations,
portal rooms, users, secrets, and retention behavior. Recovery must not
automatically log the Telegram account out, remove its Telegram device,
change split_portals, or delete portal rooms.
