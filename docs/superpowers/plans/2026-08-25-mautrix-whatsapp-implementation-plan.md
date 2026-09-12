# Personal mautrix-whatsapp Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deploy one private mautrix-whatsapp bridge on `contabo-eu`, link only the Human Matrix account to one personal WhatsApp account, and prove safe text/media synchronization, restart persistence, identity isolation, and recovery coverage without adding public ports or Cloudflare data-plane components.

**Architecture:** Add one pinned `mautrix-whatsapp` service to the existing Compose project on the existing internal `core` network. Synapse reaches `http://whatsapp:29318` and the bridge reaches `http://synapse:8008`; neither is published on the host. The bridge uses separate `whatsapp_bridge` PostgreSQL database/login and runtime. Existing Matrix data, users, rooms, Caddy routes, registration policy, federation policy, and Agent identity are unchanged.

**Tech Stack:** Docker Compose, PostgreSQL 16, Synapse 1.159, mautrix-whatsapp `v0.2608.0`/`v26.08`, Python 3, Bash, restic, and the existing Contabo archive/checksum release procedure.

---

## Current official source basis

- Selected release: `v26.08`, Git tag `v0.2608.0`, release commit `e7e5e57`: [release page](https://github.com/mautrix/whatsapp/releases/tag/v0.2608.0).
- Selected image: `dock.mau.dev/mautrix/whatsapp:v26.08@sha256:86237c4d0d33a1e08910b1f820e6c561f9b8e21dc26943caf266e01021087002`, verified 2026-08-25 with `docker buildx imagetools inspect`. The official Docker docs state that `latest` follows the latest commit rather than latest release: [Docker setup](https://docs.mau.fi/bridges/general/docker-setup.html).
- Config fields come from [v26.08 config](https://docs.mau.fi/configs/mautrix-whatsapp/v26.08.html), container behavior from [official docker-run.sh](https://raw.githubusercontent.com/mautrix/whatsapp/main/docker-run.sh).
- Requirements are an appservice-capable Matrix homeserver, PostgreSQL 16+, and a phone WhatsApp client with separate databases: [Go bridge setup](https://docs.mau.fi/bridges/go/setup.html?bridge=whatsapp).
- Login uses a private bot chat, `login qr` or `login phone`, then Linked devices QR/pairing-code approval. Official docs cover passkeys, linked-device expiry, `logout`, and suspicious-activity ban risk: [authentication](https://docs.mau.fi/bridges/go/whatsapp/authentication.html).
- Initial history transfer is one-time and cannot be re-requested without logout/login: [backfill](https://docs.mau.fi/bridges/general/backfill.html).

## Hard boundaries

1. Work only in `/home/ubuntu/communicator/.worktrees/implement-matrix-core` on `feat/matrix-core`; deploy only to `contabo-eu` after checking `vmi3501337` and `169.58.160.23`.
2. Do not deploy to local OVH, upgrade the host, alter UFW, publish DNS, or open an inbound port.
3. Keep public registration/federation disabled, federation/key endpoints at 404, and existing Caddy routes unchanged.
4. Provision only Human; do not link Agent WhatsApp.
5. No full sync, three-month/backfill import, Telegram, Messenger, Cloudflare data-plane, public provisioning, public admin, or custom UI.
6. Never put passwords, DB URIs with passwords, Matrix/appservice tokens, QR/pairing data, session data, recovery keys, or message/contact content in Git, arguments, messages, logs, or reports.
7. Never start a restored live WhatsApp session in an isolated restore test.

## File map

Modify `compose.yaml`, `deploy/images.lock.env`, `deploy/synapse/homeserver.yaml.template`, `scripts/render-synapse-config.py`, `scripts/init-runtime.sh`, `scripts/deploy-core.sh`, `scripts/backup-core.sh`, and `scripts/restore-core-test.sh`. Create `scripts/init-whatsapp-db.sh`, `scripts/render-whatsapp-config.py`, `scripts/init-whatsapp-runtime.sh`, `scripts/validate-whatsapp.sh`, tests `test_whatsapp_contract.py`, `test_render_whatsapp_config.py`, `test_validate_whatsapp.py`, `test_restore_whatsapp.py`, and runbooks `mautrix-whatsapp-operations.md` and `mautrix-whatsapp-validation.md`. Never add generated runtime files, dumps, registrations, sessions, secrets, backups, or private registry data.

---

### Task 1: Source, host, and rollback gate

**Files:** current proposal/design/Matrix plan/host-readiness/Matrix operations/Matrix recovery; no modifications.

- [ ] Verify clean local state and matching remote:

`bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/feat/matrix-core
`

Expected: `## feat/matrix-core...origin/feat/matrix-core`, identical commits, no changes.

- [ ] Verify Contabo before Docker:

`bash
ssh -o BatchMode=yes contabo-e 'set -eu; test "$(hostname)" = vmi3501337; test "$(ip -4 -o addr show dev eth0 | awk "{print \$4}" | cut -d/ -f1)" = 169.58.160.23; sudo -n docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"; ss -H -ltn'
`

Expected: exact host/IP, production PostgreSQL/Synapse healthy, Caddy up, only approved listeners.

- [ ] Record resolved previous release and only file metadata:

`bash
ssh -o BatchMode=yes contabo-e 'set -eu; test "$(hostname)" = vmi3501337; readlink -f /opt/communicator/current; stat -c "%U:%G:%a %n" /srv/communicator/synapse/homeserver.yaml /srv/communicator/synapse/log.config'
`

Expected previous release: `74a8ced7c020cda5fa8fa2b9311e68a3d62bfdcb`.

- [ ] Review failure recovery and identity isolation. Confirm no task deletes production data, restore uses a distinct project, and only Human receives `user` permission.

- [ ] Commit only this plan:

`bash
git add docs/superpowers/plans/2026-08-25-mautrix-whatsapp-implementation-plan.md
git commit -m "docs: plan personal WhatsApp bridge rollout"
git push origin feat/matrix-core
git status --short --branch
`

---

### Task 2: Internal service and contract tests

**Files:** `compose.yaml`, `deploy/images.lock.env`, `tests/test_whatsapp_contract.py`, `tests/test_repository_contract.py`.

- [ ] Add this exact image lock:

`dotenv
WHATSAPP_IMAGE=dock.mau.dev/mautrix/whatsapp:v26.08@sha256:86237c4d0d33a1e08910b1f820e6c561f9b8e21dc26943caf266e01087002
`

The actual line must be `dock.mau.dev/mautrix/whatsapp:v26.08@...`; this plan avoids embedding the dollar-brace syntax in its own source.

- [ ] Add this service under `services`, with no host port:

`yaml
  whatsapp:
    image: ${WHATSAPP_IMAGE}
    depends_on:
      postgres:
        condition: service_healthy
      synapse:
        condition: service_healthy
    volumes:
      - ${COMMUNICATOR_RUNTIME_DIR}/whatsapp:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:29318/_matrix/mau/ready >/dev/null"]
      interval: 10s
      timeout: 5s
      retries: 18
    restart: unless-stopped
    networks: [core]
`

Do not add `ports`, `expose`, host networking, public address, or a Caddy route.

- [ ] Tests must assert the exact image/digest, no service `ports`/`expose`, only `core` networking, healthy PostgreSQL/Synapse dependencies, and loopback-only ready URL. Use existing structural tests if PyYAML is unavailable.
- [ ] Verify and commit:

`bash
python3 -m unittest tests/test_whatsapp_contract.py tests/test_repository_contract.py -v
docker compose --env-file deploy/images.lock.env config --quiet
git add compose.yaml deploy/images.lock.env tests/test_whatsapp_contract.py tests/test_repository_contract.py
git commit -m "feat: add internal WhatsApp bridge service contract"
`

---

### Task 3: Separate DB, runtime, config, and registration

**Files:** `scripts/init-runtime.sh`, `scripts/init-whatsapp-db.sh`, `scripts/render-whatsapp-config.py`, `scripts/init-whatsapp-runtime.sh`, `scripts/render-synapse-config.py`, `deploy/synapse/homeserver.yaml.template`, `tests/test_render_whatsapp_config.py`, `tests/test_runtime_init.py`.

- [ ] Create `/srv/communicator/whatsapp` and `whatsapp-backups` as 0700. Create absent `whatsapp-db.password` and `whatsapp-db.env` atomically as `root:root 0600`; preserve existing files. Never print/use a password argument.
- [ ] `init-whatsapp-db.sh` reads the protected password, writes a mode-0600 temporary SQL file with Python, feeds it to `docker compose exec -T postgres psql`, idempotently creates role/database `whatsapp_bridge`, verifies existence without values, removes the exact temp file in a trap, and prints only `whatsapp_database=PASS`. It never drops/truncates/changes `synapse`.
- [ ] `render-whatsapp-config.py` uses `urllib.parse.quote(password, safe="")`, writes atomically mode 0600, and prints only the output path. The pinned v26.08 values must be:

`yaml
network:
  os_name: Mautrix-WhatsApp bridge
  browser_name: unknown
appservice:
  address: http://whatsapp:29318
  public_address: null
  hostname: 0.0.0.0
  port: 29318
  id: whatsapp
  bot:
    username: whatsappbot
database:
  type: postgres
  uri: construct at runtime as `postgres://whatsapp_bridge:` + `urllib.parse.quote(password, safe="")` + `@postgres/whatsapp_bridge?sslmode=disable` from the protected password file
homeserver:
  address: http://synapse:8008
  domain: communicator.0000.gold
  software: standard
bridge:
  split_portals: false
  personal_filtering_spaces: true
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin
relay:
  enabled: false
  admin_only: true
  default_relays: []
provisioning:
  shared_secret: disable
  allow_matrix_auth: false
  debug_endpoints: false
  enable_session_transfers: false
public_media:
  enabled: false
direct_media:
  enabled: false
history_sync:
  max_initial_conversations: 0
  request_full_sync: false
backfill:
  enabled: false
  max_initial_messages: 0
  max_catchup_messages: 0
  queue:
    enabled: false
    manual: false
encryption:
  allow: true
  default: true
  require: true
  appservice: false
  msc4190: false
`

Preserve other fields from the pinned official example; do not invent deprecated keys. Prove encrypted management-room commands before accepting `require`; diagnose instead of lowering it silently.
- [ ] Add to the Synapse template:

`yaml
app_service_config_files:
  - /data/whatsapp-registration.yaml
`

Make the renderer require the registration path and fail before writing if absent/non-regular/overly permissive. Preserve all existing registration/federation/user-directory policy.
- [ ] `init-whatsapp-runtime.sh` verifies the image, invokes the official entrypoint only when files are absent, renders config, generates registration, and copies it to `/srv/communicator/synapse/whatsapp-registration.yaml`. Bridge config/session: `1337:1337`/0600. Synapse registration: `991:991`/0600. Never regenerate existing tokens/session. Print only `whatsapp_runtime=PASS`.
- [ ] Test URL encoding with reserved characters and a single quote, exact permissions/history/provisioning settings, no password in stdout, and private modes. Then run:

`bash
python3 -m unittest tests/test_render_whatsapp_config.py tests/test_runtime_init.py -v
bash -n scripts/init-runtime.sh scripts/init-whatsapp-db.sh scripts/init-whatsapp-runtime.sh
python3 -m py_compile scripts/render-whatsapp-config.py scripts/render-synapse-config.py
git add scripts/init-runtime.sh scripts/init-whatsapp-db.sh scripts/init-whatsapp-runtime.sh scripts/render-whatsapp-config.py scripts/render-synapse-config.py deploy/synapse/homeserver.yaml.template tests/test_render_whatsapp_config.py tests/test_runtime_init.py
git commit -m "feat: isolate WhatsApp bridge runtime and database"
`

---

### Task 4: Deployment ordering and health validation

**Files:** `scripts/deploy-core.sh`, `scripts/validate-core.sh`, `scripts/validate-whatsapp.sh`, `tests/test_validate_whatsapp.py`, `tests/test_repository_contract.py`.

- [ ] Change deployment order to: init runtime; source image lock; Compose config; pull; start/wait PostgreSQL; initialize bridge DB; initialize bridge runtime/registration; render Synapse; start/wait PostgreSQL/Synapse/Caddy/WhatsApp. Stop on errors. Never run down, remove volumes, recreate production PostgreSQL, or regenerate registration/session.
- [ ] `validate-whatsapp.sh` requires production runtime/project and uses only safe Compose status, inspect status/health, internal live/ready curl, registration metadata, and listener checks. It prints only:

`text
whatsapp_container=running
whatsapp_health=healthy
whatsapp_ready=PASS
whatsapp_ports=NONE
whatsapp_registration=PASS
whatsapp_permissions=PASS
whatsapp_history_sync=DISABLED
whatsapp_provisioning=DISABLED
`

No logs, env/config output, message/contact data, or destructive commands.
- [ ] Keep `validate-core.sh` hard: registration failure, federation/key 404, Matrix HTTPS, and well-known checks remain required.
- [ ] Add tests for exact guards, internal URLs, no logs/env inspection, no public ports, and no destructive commands. Reject host publication of 8008, 8448, 29318, and 2019.
- [ ] Run and commit:

`bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m py_compile scripts/*.py
git diff --check
rg -n --hidden --glob '!*.pyc' '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AWS_SECRET_ACCESS_KEY|RESTIC_PASSWORD=|WHATSAPP_DB_PASSWORD=|as_token:|hs_token:|pairing|access_token)' .
git add scripts/deploy-core.sh scripts/validate-core.sh scripts/validate-whatsapp.sh tests/test_repository_contract.py tests/test_validate_whatsapp.py
git commit -m "feat: validate internal WhatsApp bridge health"
`

---

### Task 5: Package, checksum, activate, and verify Contabo

**Files:** `docs/runbooks/matrix-core-operations.md`; no host mutation before archive verification.

- [ ] Build a clean archive from `release_commit=$(git rev-parse HEAD)`, record its SHA-256 privately, transfer to a fresh remote `/tmp` path, verify exact host/IP/checksum, extract only under `/opt/communicator/releases/$release_commit`, preserve previous release, and atomically update `current`.
- [ ] Preserve a root-only timestamped pre-change Synapse config/checksum without printing content.
- [ ] From the verified release run:

`bash
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh
`

Require PostgreSQL, Synapse, Caddy, and WhatsApp healthy. Failure requires systematic diagnosis or rollback; never blind retry.
- [ ] Run:

`bash
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh
curl -fsS https://matrix.communicator.0000.gold/_matrix/client/versions >/dev/null
curl -fsS https://communicator.0000.gold/.well-known/matrix/client >/dev/null
curl -fsS https://communicator.0000.gold/.well-known/matrix/server >/dev/null
`

Expected core/bridge/public HTTPS pass and no bridge port on `169.58.160.23`.
- [ ] Commit only operations documentation with `docs: record WhatsApp bridge release procedure`.

---

### Task 6: Mandatory checkpoint before pairing

**Files:** `docs/runbooks/mautrix-whatsapp-operations.md` and `docs/runbooks/mautrix-whatsapp-validation.md`. No automated authentication.

- [ ] Run `validate-whatsapp.sh` and record only health markers.
- [ ] Send the coordinator this exact procedure: Element as `@human:communicator.0000.gold` → encrypted private chat with `@whatsappbot:communicator.0000.gold` → `login qr`, or `login phone` with phone number entered only interactively in Element → physical WhatsApp Settings/Menu → Linked devices → Link a device → scan QR or enter eight-letter code → complete any passkey prompt → wait for bot success.
- [ ] State risk exactly: the bridge uses WhatsApp's web API; normal use is not documented as an automatic ban, but Android emulators, VoIP/new accounts, and initiating DMs to non-contacts increase risk. Physical phone is preferred. Pairing adds this server as a linked device; phone offline over two weeks can disconnect it. No real-contact message is sent during pairing.
- [ ] State rollback: send `logout`, verify/remedy device removal in Linked devices, stop only `whatsapp` if needed, preserve encrypted backup/runtime/DB, and if necessary activate the previous release and restore pre-change Synapse config. Never remove Matrix data or bridge state without separate approval.
- [ ] Pause for the user's interactive approval and pairing. Never infer success from a displayed QR. Ask coordinator to confirm no message is sent during pairing.

---

### Task 7: Human text/media/E2EE/restart validation

**Files:** validation/operations runbooks only until evidence is recorded. No automated messages.

- [ ] After the user's bot-success observation, run safe bridge health checks.
- [ ] User obtains one harmless inbound text from an approved contact; record only `inbound_text=PASS`.
- [ ] User sends one harmless outbound reply from Human portal and confirms receipt; record only `outbound_text=PASS`.
- [ ] User exchanges one non-sensitive image/small file each direction; record only `inbound_media=PASS`/`outbound_media=PASS`. Do not enable public/direct media to work around limits.
- [ ] User confirms Human portal E2EE and Agent cannot discover/join/read it; record only `e2ee=PASS`/`identity_isolation=PASS`.
- [ ] After a fresh backup, restart bridge/Synapse in dependency order without recreating DBs/volumes; wait all health and rerun core/public checks.
- [ ] User reopens Element and confirms Human decrypts the pre-restart portal message and device remains authenticated; record only `restart_persistence=PASS`.
- [ ] Commit only status-marker runbook evidence with `docs: record personal WhatsApp bridge validation`.

---

### Task 8: Encrypted backup and isolated restore

**Files:** `scripts/backup-core.sh`, `scripts/restore-core-test.sh`, recovery runbook, `tests/test_restore_core.py`, `tests/test_restore_whatsapp.py`.

- [ ] Stop only `whatsapp` and `synapse`; dump `synapse` and `whatsapp_bridge` into protected staging; copy Synapse config/signing/media and Matrix secrets; copy bridge config/registration/session/device state and protected DB password; run encrypted restic backup/check; wait PostgreSQL/Synapse/WhatsApp healthy; remove only staging; print `backup=PASS`. Exclude transient logs/temp files.
- [ ] Restore with `COMPOSE_PROJECT_NAME=communicator-restore-test` and a fresh timestamped runtime. Resolve isolated IDs and bounded health. Restore only isolated bridge DB/artifacts. Validate modes/table existence and a non-networking pinned-binary help/version/config parse. Never start the restored live session, attach it to production, display config/rows, or run production-project Compose commands. Preserve evidence and clean only isolated resources.
- [ ] Tests assert isolated project, bridge dump/registration/session artifacts, bounded waits, safe diagnostics, isolated cleanup, and no production bridge start/exec.
- [ ] Run fresh backup and restore using the root-only restic environment and require `backup=PASS`, clean restic check, isolated `restore_test=PASS`, production health after cleanup, and no secret/message output.
- [ ] Commit recovery coverage with `feat: cover WhatsApp bridge in encrypted recovery`.

---

### Task 9: Upgrade, unlink, and final acceptance

**Files:** `docs/runbooks/mautrix-whatsapp-operations.md` and `docs/runbooks/mautrix-whatsapp-validation.md`.

- [ ] Document upgrades as release tag plus fresh manifest digest, local tests, clean archive/checksum, host/checksum verification, and `docker compose up -d --wait`; never use `docker compose restart` for an upgrade.
- [ ] Document break-glass: stop only `whatsapp`, preserve DB/runtime, activate previous release, restore pre-change Synapse config, validate Matrix core, and never copy secrets/session data into messages/commands.
- [ ] Document unlink/re-pair: user issues `logout`, removes linked device if needed, confirms unauthenticated state, and takes a fresh encrypted backup before login.
- [ ] Run local tests, Bash/Python syntax, diff/secret checks, clean/pushed Git state, host identity/listeners, core/bridge validators, and public Matrix/well-known HTTPS checks. Record only status markers. A slow Element experience is a performance observation, not a diagnosed failure.
- [ ] Commit/push final docs with `docs: finish WhatsApp bridge operations runbook`.

The milestone is complete only after user-supplied inbound/outbound text, media, E2EE/isolation, and restart-persistence observations plus fresh automated/recovery evidence. Until then, keep the goal active.

## Self-review

- Coverage: Tasks 2–4 cover internal service, existing core, E2EE, no public registration/federation, and Human/Agent permissions; Tasks 6–7 cover login/text/media/restart/isolation; Task 8 covers encrypted recovery; Task 9 covers rollback/upgrade/unlink. Agent WhatsApp and three-month import are intentionally excluded.
- Recovery: identity/checksum gates precede mutations; prior release/config are retained; DB initialization is additive/idempotent; restore uses a distinct project/runtime and bounded waits; restored session is never started.
- Isolation: only Human has `user`, only platform-admin has `admin`, relay is disabled, Agent is not provisioned/invited, and the existing Matrix validator remains hard.
- Secret review: no runtime values, tokens, phone numbers, QR payloads, access tokens, passwords, or message contents are present.
