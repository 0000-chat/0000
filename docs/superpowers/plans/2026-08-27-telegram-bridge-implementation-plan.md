# Personal-First Multi-Tenant Telegram Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one pinned `mautrix-telegram` service to Communicator, connect the Human's established personal Telegram account, preserve the existing WhatsApp and Messenger services, and establish a secure shared-process design that can later onboard separate customer Telegram accounts without adding one bridge container per customer.

**Architecture:** Synapse remains the operational Matrix system of record. One private `telegram` container connects to Synapse and a dedicated `telegram_bridge` PostgreSQL database; each authorized Matrix user receives an independent Telegram login inside that shared process, and `bridge.split_portals: true` prevents different logins from sharing Matrix portal rooms. This repository owns only deployment topology, pinned versions, generated configuration, permissions, validation, backup/restore, and runbooks; the upstream mautrix project owns all Telegram protocol and session code.

**Tech Stack:** Docker Compose, Synapse, PostgreSQL 16, Caddy, upstream `dock.mau.dev/mautrix/telegram:v26.08`, Bash, Python 3 standard library, `unittest`, restic with Cloudflare R2 as the encrypted backup repository, Ubuntu 24.04 LTS on the Contabo VPS.

---

## Simple execution contract

This is primarily configuration and operations work. Do not fork or patch
`mautrix-telegram`, Synapse, Telegram clients, or any upstream dependency.

The pilot connects only the Human's existing Telegram account. It does not
create a second Telegram identity for the Agent. A future Communicator agent
will act as the Human through Communicator's authorization layer; that later
delegation is not implemented here.

Use one Telegram bridge container for all future customers. Each customer gets
an independent remote login and independent Matrix portals inside the shared
process. Adding a customer requires an explicit permission/onboarding change
and isolation test, not a new container.

Implement locally in the Telegram worktree. Do not touch the Messenger
worktree. Do not mutate Contabo until the Messenger PR is merged, deployed,
accepted, and the resource gate in Task 1 passes.

Every user-facing explanation and runbook section must give a short simple
explanation first, followed by the technical procedure.

## Current verified source facts

These facts were verified from official upstream sources on 2026-08-27. Task 1
must re-check the image before implementation because tags and registries are
external state.

- Upstream release: [`v0.2608.0` / `v26.08`](https://github.com/mautrix/telegram/releases/tag/v0.2608.0), commit `3df4c4a`.
- Image tag: `dock.mau.dev/mautrix/telegram:v26.08`.
- Manifest-list digest: `sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8`.
- Linux/amd64 child digest: `sha256:a4f94f8e47fb946f64f6145c08f797d28700a6bea6fa64b8111c8a454d966229`.
- The image uses UID/GID `1337`, `/data`, `/docker-run.sh`, and `/usr/bin/mautrix-telegram`.
- The upstream entrypoint first exports a missing config, then generates a
  missing registration, and only starts the bridge when both exist.
- Default appservice identity: ID `telegram`, bot `telegrambot`, port `29317`,
  ghost template `telegram_{{.}}`.
- The operator must obtain installation-wide `api_id` and `api_hash` values at
  [`my.telegram.org/apps`](https://my.telegram.org/apps). They are protected
  runtime inputs and must never be committed or printed.
- Official configuration reference:
  [`mautrix-telegram v26.08`](https://docs.mau.fi/configs/mautrix-telegram/v26.08.html).
- Official authentication flow:
  [`mautrix-telegram authentication`](https://docs.mau.fi/bridges/go/telegram/authentication.html).
- Official feature matrix:
  [`ROADMAP.md`](https://github.com/mautrix/telegram/blob/main/ROADMAP.md).
- Upstream source is AGPL-3.0 with a separate exceptions file. This plan uses
  the published image unmodified; any future source modification or commercial
  redistribution requires a fresh licensing review.
- Typing works in both directions. Matrix-to-Telegram read receipts are
  supported; Telegram-to-Matrix receipts are supported for DMs only.
- Telegram cloud chats are not end-to-end encrypted, and Telegram secret chats
  are unsupported. Matrix portal rooms are still required to use Matrix E2EE.
- `split_portals` must be set before the first login. Upstream calls changing it
  later irreversible and potentially destructive.

## Hard safety boundaries

1. No upstream source edits or custom bridge image builds.
2. No public port for PostgreSQL, Synapse, WhatsApp, Messenger, or Telegram.
3. No Matrix federation and no public bridge provisioning/media endpoint.
4. No Telegram login, QR scan, phone code, 2FA password, logout, device removal,
   or API-credential creation without the user at the explicit operator gate.
5. No Telegram history import in this pilot. Start with new traffic only.
6. Never change `split_portals` after the first Telegram login.
7. Never print API credentials, database passwords, appservice tokens, pickle
   keys, Telegram session data, Matrix access tokens, or restic credentials.
8. Never put generated runtime data, registrations, dumps, acceptance evidence,
   or secrets in Git.
9. Never start the Telegram service during an isolated restore test. Validate
   restored configuration using `--network none`.
10. Rollback may restore the prior release, but it must not automatically log
    the Telegram account out or delete portal rooms.
11. Platform Admin access is break-glass. Admin command permission does not
    automatically make the admin a member of the Human's portal rooms.
12. Any future customer is denied until their exact MXID is added and symmetric
    cross-account isolation is demonstrated.
13. Synapse retention and privacy rules apply to bridged Telegram events even
    after Telegram logout. Logout is not a Matrix-history deletion workflow.

## Locked identity and policy decisions

- Human Matrix identity: `@human:communicator.0000.gold` with `user` permission.
- Platform Admin: `@platform-admin:communicator.0000.gold` with `admin`
  permission, but no automatic portal membership.
- Agent: no Telegram login and no Telegram `user` permission in this phase.
- Everyone else: `relay`, while relay mode is disabled; this grants no usable
  bridge access.
- One shared Telegram bridge process and one `telegram_bridge` database.
- Separate portals for every login: `split_portals: true` from first boot.
- Personal filtering space enabled for each login.
- Contact-specific names and avatars disabled to reduce cross-login leakage.
- Backfill, takeout sync, login dialog creation, and catch-up import disabled.
- Provisioning, direct media, public media, analytics, relay mode, and
  double-puppeting disabled.
- Portal rooms are non-federated and encrypted by default and requirement.
- Delivery receipts enabled. Typing and receipt behavior are tested and
  recorded, but upstream limitations do not justify local source patches.
- Synapse retains operational portal history under the existing Communicator
  retention policy. This phase neither broadens retention nor implements
  tenant deletion/export workflows.

## File map

Create:

- `scripts/init-telegram-db.sh` — additive role/database initialization.
- `scripts/init-telegram-runtime.sh` — safe upstream bootstrap, rendering,
  registration copy, and image guard.
- `scripts/render-telegram-config.py` — deterministic secret-safe configuration.
- `scripts/validate_telegram_policy.py` — fail-closed policy validation.
- `scripts/validate-telegram.sh` — secret-free production health validation.
- `tests/test_telegram_contract.py` — image, network, service, volume, and port
  contracts.
- `tests/test_render_telegram_config.py` — secrets, exact policy, token/key
  preservation, atomicity, and mode tests.
- `tests/test_telegram_policy.py` — exact identity and multi-login isolation
  rules.
- `tests/test_validate_telegram.py` — deploy order and safe diagnostic tests.
- `docs/runbooks/mautrix-telegram-operations.md` — operator how-to.
- `docs/runbooks/mautrix-telegram-validation.md` — automated and manual gates.

Modify after rebasing onto merged Messenger `origin/main`:

- `compose.yaml` — add private Telegram service.
- `deploy/images.lock.env` — add immutable Telegram image.
- `deploy/synapse/homeserver.yaml.template` — add Telegram registration.
- `scripts/init-runtime.sh` — add protected Telegram directories and DB secret.
- `scripts/render-synapse-config.py` — require three appservice registrations.
- `scripts/deploy-core.sh` — initialize/start Telegram in safe order.
- `scripts/validate-core.sh` — require Telegram and reject host port `29317`.
- `scripts/backup-core.sh` — add Telegram DB/runtime/secrets to encrypted backup.
- `scripts/restore-core-test.sh` — add isolated Telegram restore and offline parse.
- `tests/test_repository_contract.py` — image and private-port contract.
- `tests/test_runtime_init.py` — Telegram secret/idempotency contract.
- `tests/test_render_synapse_config.py` — require all three registrations.
- `tests/test_backup_core.py` — require Telegram recovery payload.
- `tests/test_restore_core.py` — require isolated Telegram recovery without login.
- `docs/runbooks/matrix-core-operations.md` — Telegram-aware release procedure.
- `docs/runbooks/matrix-core-recovery.md` — four-database recovery contract.

Do not commit `/srv/communicator`, generated YAML, registrations, database
dumps, API credentials, restic state, release archives, screenshots, QR codes,
phone numbers, or acceptance evidence containing contact identifiers.

### Task 1: Establish integration, source, host, resource, and rollback gates

**Files:** Read only; no repository modifications.

- [ ] **Step 1: Verify the isolated worktree and wait for Messenger integration**

```bash
cd /home/ubuntu/communicator/.worktrees/telegram-bridge
test "$(git branch --show-current)" = codex/telegram-bridge
git status --short --branch
git fetch origin
test -f docs/superpowers/plans/2026-08-27-telegram-bridge-implementation-plan.md
git cat-file -e origin/main:scripts/init-messenger-runtime.sh
git cat-file -e origin/main:scripts/validate-messenger.sh
git cat-file -e origin/main:docs/runbooks/mautrix-messenger-validation.md
```

Expected: clean worktree and all three Messenger artifacts on `origin/main`.
If any artifact is missing, stop. Planning may continue, but implementation and
all Contabo mutations remain blocked until Messenger is merged and accepted.

- [ ] **Step 2: Rebase only after Step 1 passes**

```bash
git rebase origin/main
git status --short --branch
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m py_compile scripts/*.py
```

Expected: clean rebase and the full merged baseline green. If a conflict affects
shared implementation files, abort the rebase and ask the coordinating session;
do not guess. A conflict limited to planning-document ancestry may be resolved by
preserving this complete Telegram plan.

- [ ] **Step 3: Re-verify the immutable upstream image**

```bash
docker buildx imagetools inspect dock.mau.dev/mautrix/telegram:v26.08
```

Require top-level digest:

```text
sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8
```

Require a linux/amd64 manifest with digest:

```text
sha256:a4f94f8e47fb946f64f6145c08f797d28700a6bea6fa64b8111c8a454d966229
```

If either digest differs, stop without changing the lock file.

- [ ] **Step 4: Verify the exact remote and accepted Messenger release**

```bash
starting_release=$(ssh -o BatchMode=yes contabo-eu 'cat /opt/communicator/current/RELEASE_COMMIT')
[[ "$starting_release" =~ ^[0-9a-f]{40,64}$ ]]
ssh -o BatchMode=yes contabo-eu bash -s -- "$starting_release" <<'REMOTE'
set -euo pipefail
starting_release=$1
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
test "$(cat /opt/communicator/current/RELEASE_COMMIT)" = "$starting_release"
test "$(readlink -f /opt/communicator/current)" = "/opt/communicator/releases/$starting_release"
test -x /opt/communicator/current/scripts/validate-messenger.sh
cd /opt/communicator/current
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-messenger.sh
sudo -n docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'
REMOTE
```

The active release may be the feature commit that was accepted before the PR
merge, so it need not equal the merge commit on `origin/main`. It must contain
the accepted Messenger implementation and pass all three validators. Record
`starting_release` as the only automatic rollback target. If any validator
fails, stop and let the Messenger implementer finish.

- [ ] **Step 5: Enforce the post-Messenger resource and port gate**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
available_kib=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
free_kib=$(df --output=avail -k / | tail -1 | tr -d ' ')
test "$available_kib" -ge 2097152
test "$free_kib" -ge 41943040
sudo -n docker inspect --format '{{.Name}} {{.State.Health.Status}}' \
  communicator-synapse-1 communicator-whatsapp-1 communicator-messenger-1
sudo -n docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' \
  communicator-postgres-1 communicator-synapse-1 communicator-whatsapp-1 communicator-messenger-1
if ss -H -ltn | awk '{print $4}' | grep -Eq ':(5432|8008|8448|29317|29318|29319|2019)$'; then
  exit 1
fi
REMOTE
```

Require at least 2 GiB available RAM, 40 GiB free disk, healthy existing
services, and no private port on the host. Save only aggregate resource values;
do not save logs or identifiers. Any failure is a hard stop.

- [ ] **Step 6: Verify recovery prerequisites by metadata only**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
sudo -n test -f /srv/communicator/secrets/restic.env
sudo -n test -f /srv/communicator/secrets/restic.password
sudo -n stat -c '%a %n' /srv/communicator/secrets/restic.env /srv/communicator/secrets/restic.password
REMOTE
```

Require root-only modes. Do not source or print the files in this metadata gate.

### Task 2: Add the pinned private Telegram container contract

**Files:**

- Modify: `deploy/images.lock.env`
- Modify: `compose.yaml`
- Create: `tests/test_telegram_contract.py`
- Modify: `tests/test_repository_contract.py`

- [ ] **Step 1: Write the failing service contract tests**

Require this exact lock entry:

```text
TELEGRAM_IMAGE=dock.mau.dev/mautrix/telegram:v26.08@sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8
```

In `tests/test_telegram_contract.py`, parse the rendered Compose model and
assert all of these properties:

```python
self.assertEqual("${TELEGRAM_IMAGE}", service["image"])
self.assertEqual(["${COMMUNICATOR_RUNTIME_DIR}/telegram:/data"], service["volumes"])
self.assertEqual(["core"], service["networks"])
self.assertNotIn("ports", service)
self.assertEqual("service_healthy", service["depends_on"]["postgres"]["condition"])
self.assertEqual("service_healthy", service["depends_on"]["synapse"]["condition"])
self.assertIn("127.0.0.1:29317/_matrix/mau/ready", " ".join(service["healthcheck"]["test"]))
self.assertEqual("unless-stopped", service["restart"])
```

Also require only Caddy to publish host ports and reject `29317:29317` in every
Compose form.

- [ ] **Step 2: Run tests to verify RED**

```bash
python3 -m unittest tests.test_telegram_contract tests.test_repository_contract -v
```

Expected: failures for missing image and service.

- [ ] **Step 3: Add the immutable image and exact service**

Append the lock entry above to `deploy/images.lock.env`. Add this service next
to the other bridges in `compose.yaml`:

```yaml
  telegram:
    image: ${TELEGRAM_IMAGE}
    depends_on:
      postgres:
        condition: service_healthy
      synapse:
        condition: service_healthy
    volumes:
      - ${COMMUNICATOR_RUNTIME_DIR}/telegram:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:29317/_matrix/mau/ready >/dev/null"]
      interval: 10s
      timeout: 5s
      retries: 18
    restart: unless-stopped
    networks: [core]
```

Do not add `ports`, Caddy routing, public media, privileged mode, host networking,
or a second Telegram service.

- [ ] **Step 4: Verify GREEN and commit**

```bash
python3 -m unittest tests.test_telegram_contract tests.test_repository_contract -v
runtime_test_dir=$(mktemp -d /tmp/communicator-telegram-compose.XXXXXX)
trap 'rm -rf -- "$runtime_test_dir"' EXIT
install -d -m 0700 "$runtime_test_dir/secrets"
: > "$runtime_test_dir/secrets/postgres.env"
chmod 0600 "$runtime_test_dir/secrets/postgres.env"
COMMUNICATOR_RUNTIME_DIR="$runtime_test_dir" docker compose --env-file deploy/images.lock.env config --quiet
git diff --check
git add compose.yaml deploy/images.lock.env tests/test_telegram_contract.py tests/test_repository_contract.py
git commit -m "feat: add pinned Telegram bridge service"
```

### Task 3: Add protected Telegram runtime inputs and database initialization

**Files:**

- Modify: `scripts/init-runtime.sh`
- Create: `scripts/init-telegram-db.sh`
- Modify: `tests/test_runtime_init.py`

- [ ] **Step 1: Extend runtime tests first**

Require mode-0700 `telegram` and `telegram-backups` directories. Require a
mode-0600 `secrets/telegram-db.password` and `secrets/telegram-db.env`, verify
the password is unchanged on the second run, and verify no secret value appears
in stdout.

Explicitly assert that `init-runtime.sh` does not generate or replace either:

```text
secrets/telegram-api-id
secrets/telegram-api-hash
```

Add an additive initializer test requiring `CREATE ROLE telegram_bridge`,
`ALTER ROLE telegram_bridge`, and `CREATE DATABASE telegram_bridge OWNER
telegram_bridge`, while rejecting `DROP DATABASE`, `DROP ROLE`, `compose down`,
and `rm -rf`.

- [ ] **Step 2: Verify RED**

```bash
python3 -m unittest tests.test_runtime_init -v
```

- [ ] **Step 3: Extend `scripts/init-runtime.sh`**

Add `$runtime_dir/telegram` and `$runtime_dir/telegram-backups` to the protected
directory list. Under the existing `umask 077`, use this idempotent block:

```bash
telegram_password="$runtime_dir/secrets/telegram-db.password"
if [[ ! -e "$telegram_password" ]]; then
  openssl rand -base64 48 | tr -d '\n' > "$telegram_password"
  printf '\n' >> "$telegram_password"
fi
chmod 0600 "$telegram_password"

telegram_env="$runtime_dir/secrets/telegram-db.env"
if [[ ! -e "$telegram_env" ]]; then
  temporary_env=$(mktemp "$runtime_dir/secrets/telegram-db.env.XXXXXX")
  chmod 0600 "$temporary_env"
  {
    printf 'TELEGRAM_DB_PASSWORD='
    cat "$telegram_password"
  } > "$temporary_env"
  mv "$temporary_env" "$telegram_env"
fi
chmod 0600 "$telegram_env"
```

Do not create API credential files here.

- [ ] **Step 4: Create `scripts/init-telegram-db.sh`**

Follow the repository's existing fail-closed shell conventions and use these
exact inputs:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
password_file="${runtime_dir}/secrets/telegram-db.password"
[[ "$project" == communicator || "$project" == communicator-restore-test-* ]]
[[ -f "$password_file" ]]
[[ "$(stat -c '%a' "$password_file")" == 600 ]]
password=$(<"$password_file")
[[ -n "$password" ]]
escaped_password=${password//\'/\'\'}
sql_file=$(mktemp)
trap 'rm -f -- "$sql_file"' EXIT
chmod 0600 "$sql_file"
cat > "$sql_file" <<SQL
SELECT 'CREATE ROLE telegram_bridge LOGIN PASSWORD ''${escaped_password}'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telegram_bridge')\gexec
ALTER ROLE telegram_bridge LOGIN PASSWORD '${escaped_password}';
SELECT 'CREATE DATABASE telegram_bridge OWNER telegram_bridge'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'telegram_bridge')\gexec
SQL
cd "$repo_dir"
docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -U synapse -d postgres < "$sql_file" >/dev/null
check=$(docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -At -U synapse -d postgres -c \
  "SELECT (SELECT count(*) FROM pg_roles WHERE rolname='telegram_bridge') || ':' || (SELECT count(*) FROM pg_database WHERE datname='telegram_bridge')")
[[ "$check" == "1:1" ]]
echo "telegram_database=PASS"
```

Use the exact restore-project pattern already accepted by the merged Messenger
initializer if its spelling differs; update the test to that single bounded
pattern. Make the script executable.

- [ ] **Step 5: Verify and commit**

```bash
python3 -m unittest tests.test_runtime_init -v
bash -n scripts/init-runtime.sh scripts/init-telegram-db.sh
git diff --check
git add scripts/init-runtime.sh scripts/init-telegram-db.sh tests/test_runtime_init.py
git commit -m "feat: initialize protected Telegram database"
```

### Task 4: Render and validate the exact Telegram security policy

**Files:**

- Create: `scripts/render-telegram-config.py`
- Create: `scripts/validate_telegram_policy.py`
- Create: `tests/test_render_telegram_config.py`
- Create: `tests/test_telegram_policy.py`

- [ ] **Step 1: Write renderer tests**

Use fake mode-0600 inputs:

```text
telegram-db.password: p@ss:word/with?hash#'quote
telegram-api-id: 12345
telegram-api-hash: 00000000000000000000000000000000
registration.yaml: fake short as_token and hs_token values
```

Require URL encoding in the database URI:

```text
postgres://telegram_bridge:p%40ss%3Aword%2Fwith%3Fhash%23%27quote@postgres/telegram_bridge?sslmode=disable
```

Require API ID to render as an integer, API hash as a quoted string, atomic
mode-0600 output, and no password/hash/token/key in stdout. Require a second
render to preserve existing concrete appservice tokens and `encryption.pickle_key`.

Require pre-registration mode to use literal `generate` token values and final
mode to use registration tokens. Reject missing, empty, symlinked, non-regular,
group-readable, or world-readable secret/registration files. Reject non-numeric
API IDs and API hashes that do not match `^[0-9a-fA-F]{32}$`.

- [ ] **Step 2: Write fail-closed policy tests**

Require these exact security-critical values in the rendered config:

```yaml
network:
  api_id: 12345
  api_hash: "00000000000000000000000000000000"
  member_list:
    max_initial_sync: 0
    sync_broadcast_channels: false
    skip_deleted: true
  sync:
    update_limit: 0
    create_limit: 0
    login_sync_limit: 0
    direct_chats: true
  takeout:
    dialog_sync: false
    forward_backfill: false
    backward_backfill: false
  contact_avatars: false
  contact_names: false
  disable_view_once: true
  bridge_communities: false
bridge:
  command_prefix: "!tg"
  personal_filtering_spaces: true
  private_chat_portal_meta: true
  async_events: false
  split_portals: true
  deduplicate_matrix_messages: true
  kick_matrix_users: true
  enable_send_state_requests: false
  phone_numbers_in_profile: false
  cleanup_on_logout:
    enabled: false
  relay:
    enabled: false
    admin_only: true
    default_relays: []
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin
database:
  type: postgres
  max_open_conns: 5
  max_idle_conns: 1
homeserver:
  address: http://synapse:8008
  domain: communicator.0000.gold
  software: standard
appservice:
  address: http://telegram:29317
  hostname: 0.0.0.0
  port: 29317
  id: telegram
  bot:
    username: telegrambot
  ephemeral_events: true
  async_transactions: false
  username_template: "telegram_{{.}}"
matrix:
  delivery_receipts: true
  federate_rooms: false
analytics:
  token: null
provisioning:
  shared_secret: disable
  allow_matrix_auth: false
  debug_endpoints: false
  enable_session_transfers: false
public_media:
  enabled: false
direct_media:
  enabled: false
backfill:
  enabled: false
  max_initial_messages: 0
  max_catchup_messages: 0
  threads:
    max_initial_messages: 0
  queue:
    enabled: false
    manual: false
double_puppet:
  servers: {}
  allow_discovery: false
  secrets: {}
encryption:
  allow: true
  default: true
  require: true
  appservice: false
  msc4190: false
  msc4392: false
  self_sign: false
  allow_key_sharing: true
  plaintext_mentions: false
env_config_prefix: null
logging:
  min_level: info
  writers:
    - type: stdout
      format: pretty-colored
```

Also reject the Agent MXID, a homeserver-domain wildcard, any second `user`,
relay enablement, federation, any positive sync/backfill limit, public address,
proxy, analytics token, provisioning secret, and double-puppet secret.

- [ ] **Step 3: Verify RED**

```bash
python3 -m unittest tests.test_render_telegram_config tests.test_telegram_policy -v
```

- [ ] **Step 4: Implement `scripts/render-telegram-config.py`**

Use only the Python standard library. Match the merged Messenger renderer's
safe-file checks, atomic `os.replace`, URL encoding with
`urllib.parse.quote(password, safe="")`, YAML-safe JSON scalar encoding, and
token/pickle-key extraction. Required CLI:

```text
--db-password-file PATH
--api-id-file PATH
--api-hash-file PATH
[--registration PATH]
--output PATH
```

The renderer must build one deterministic approved config template, not perform
textual search and replace on upstream YAML. Include every section and value in
Step 2 plus only the ordinary connector values required for the upstream binary
to parse the document. Unlisted optional features stay absent/disabled. Log only:

```text
telegram_config=PASS
```

- [ ] **Step 5: Implement `scripts/validate_telegram_policy.py`**

Use the same strict YAML subset parser strategy accepted for Messenger. Accept
one config path, validate every value in Step 2, require exact permissions, and
print only:

```text
telegram_policy=PASS
```

It must return non-zero for unknown/broadened permissions or any violated
boundary. Never print parsed secret values or the input document.

- [ ] **Step 6: Verify and commit**

```bash
python3 -m unittest tests.test_render_telegram_config tests.test_telegram_policy -v
python3 -m py_compile scripts/render-telegram-config.py scripts/validate_telegram_policy.py
git diff --check
git add scripts/render-telegram-config.py scripts/validate_telegram_policy.py tests/test_render_telegram_config.py tests/test_telegram_policy.py
git commit -m "feat: render isolated Telegram policy"
```

### Task 5: Bootstrap and register the Telegram appservice safely

**Files:**

- Create: `scripts/init-telegram-runtime.sh`
- Modify: `deploy/synapse/homeserver.yaml.template`
- Modify: `scripts/render-synapse-config.py`
- Modify: `tests/test_runtime_init.py`
- Modify: `tests/test_render_synapse_config.py`

- [ ] **Step 1: Write registration/bootstrap tests first**

Require the exact `TELEGRAM_IMAGE` digest guard and this fresh-runtime order:

```text
upstream default config export
project pre-registration render
upstream registration generation
project final render
protected Synapse registration copy
```

Require all three registrations in Synapse:

```yaml
app_service_config_files:
  - /data/whatsapp-registration.yaml
  - /data/messenger-registration.yaml
  - /data/telegram-registration.yaml
```

Add negative tests for missing or broad-mode Telegram registration and API
credential files.

- [ ] **Step 2: Verify RED**

```bash
python3 -m unittest tests.test_runtime_init tests.test_render_synapse_config -v
```

- [ ] **Step 3: Create `scripts/init-telegram-runtime.sh`**

Use these paths and exact image guard:

```bash
telegram_dir="${runtime_dir}/telegram"
registration="${telegram_dir}/registration.yaml"
config="${telegram_dir}/config.yaml"
synapse_registration="${runtime_dir}/synapse/telegram-registration.yaml"
api_id_file="${runtime_dir}/secrets/telegram-api-id"
api_hash_file="${runtime_dir}/secrets/telegram-api-hash"
[[ "$project" == communicator ]]
[[ "$TELEGRAM_IMAGE" == dock.mau.dev/mautrix/telegram:v26.08@sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8 ]]
```

Before any Compose run, require mode 0600, regular non-symlink files for API ID,
API hash, and database password. On a fresh runtime:

```bash
docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps telegram >/dev/null 2>&1
python3 scripts/render-telegram-config.py \
  --db-password-file "$runtime_dir/secrets/telegram-db.password" \
  --api-id-file "$api_id_file" \
  --api-hash-file "$api_hash_file" \
  --output "$config" >/dev/null
docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps telegram >/dev/null 2>&1
python3 scripts/render-telegram-config.py \
  --db-password-file "$runtime_dir/secrets/telegram-db.password" \
  --api-id-file "$api_id_file" \
  --api-hash-file "$api_hash_file" \
  --registration "$registration" \
  --output "$config" >/dev/null
```

Skip both upstream runs when config and registration already exist. Never
overwrite an existing registration before extracting its tokens. Finish with:

```bash
chown 1337:1337 "$config" "$registration" "$telegram_dir"
chmod 0700 "$telegram_dir"
chmod 0600 "$config" "$registration"
install -o 991 -g 991 -m 0600 "$registration" "$synapse_registration"
echo "telegram_runtime=PASS"
```

Make the script executable. Do not print upstream generation output because it
may contain paths or future sensitive values.

- [ ] **Step 4: Extend Synapse rendering**

Add required `--telegram-registration`. Apply the merged renderer's exact
regular-file, owner-compatible, mode-0600 checks. Render the three registration
paths in WhatsApp, Messenger, Telegram order. No registration contents enter the
generated `homeserver.yaml`; only file paths do.

- [ ] **Step 5: Verify and commit**

```bash
python3 -m unittest tests.test_runtime_init tests.test_render_synapse_config -v
bash -n scripts/init-telegram-runtime.sh
python3 -m py_compile scripts/render-synapse-config.py
git diff --check
git add scripts/init-telegram-runtime.sh deploy/synapse/homeserver.yaml.template scripts/render-synapse-config.py tests/test_runtime_init.py tests/test_render_synapse_config.py
git commit -m "feat: register Telegram appservice"
```

### Task 6: Add safe deployment and fail-closed production validation

**Files:**

- Modify: `scripts/deploy-core.sh`
- Create: `scripts/validate-telegram.sh`
- Modify: `scripts/validate-core.sh`
- Create: `tests/test_validate_telegram.py`

- [ ] **Step 1: Write deployment and validator tests**

Require this deployment order:

```text
docker compose pull
init-whatsapp-db.sh
init-messenger-db.sh
init-telegram-db.sh
init-whatsapp-runtime.sh
init-messenger-runtime.sh
init-telegram-runtime.sh
render Synapse with all three registration arguments
force-recreate and wait for Synapse
force-recreate and wait for Caddy
force-recreate and wait for WhatsApp
force-recreate and wait for Messenger
force-recreate and wait for Telegram
validate-core.sh
validate-whatsapp.sh
validate-messenger.sh
validate-telegram.sh
```

Require `validate-telegram.sh` to check container health, exact pinned image,
runtime file modes, offline policy validation, appservice reachability from the
Synapse network, Telegram DB table existence, no host `29317` listener, and no
public route. Reject commands that print config, inspect environment variables,
dump logs, or display secret files.

- [ ] **Step 2: Verify RED**

```bash
python3 -m unittest tests.test_validate_telegram -v
```

- [ ] **Step 3: Extend `scripts/deploy-core.sh`**

Keep the established exact-host/release guards. Source only
`deploy/images.lock.env`; do not source Telegram secrets. Invoke the scripts in
Step 1 and render Synapse with:

```bash
python3 scripts/render-synapse-config.py \
  --whatsapp-registration "$runtime_dir/whatsapp/registration.yaml" \
  --messenger-registration "$runtime_dir/messenger/registration.yaml" \
  --telegram-registration "$runtime_dir/telegram/registration.yaml" \
  --output "$runtime_dir/synapse/homeserver.yaml"
```

Use Compose `up -d --force-recreate --wait --wait-timeout 180` in dependency
order. Failure must leave runtime/session files intact.

- [ ] **Step 4: Create `scripts/validate-telegram.sh`**

Require exact project `communicator`, runtime `/srv/communicator`, exact image
lock, healthy `communicator-telegram-1`, and no published ports. Validate file
modes without content output, then run:

```bash
python3 scripts/validate_telegram_policy.py "$runtime_dir/telegram/config.yaml" >/dev/null
docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -At -U synapse -d telegram_bridge -c \
  "SELECT CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END FROM information_schema.tables WHERE table_schema='public'" \
  | grep -qx PASS
docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T synapse \
  python -c 'import urllib.request; urllib.request.urlopen("http://telegram:29317/_matrix/mau/ready", timeout=3)'
```

Reject a host listener on 29317 and print only bounded markers ending in:

```text
telegram_validation=PASS
```

- [ ] **Step 5: Extend core validation, verify, and commit**

Add Telegram to expected healthy services and add 29317 to the rejected private
listener set.

```bash
python3 -m unittest tests.test_validate_telegram tests.test_repository_contract -v
bash -n scripts/deploy-core.sh scripts/validate-telegram.sh scripts/validate-core.sh
git diff --check
git add scripts/deploy-core.sh scripts/validate-telegram.sh scripts/validate-core.sh tests/test_validate_telegram.py
git commit -m "feat: deploy and validate Telegram safely"
```

### Task 7: Extend encrypted backup and isolated restore

**Files:**

- Modify: `scripts/backup-core.sh`
- Modify: `scripts/restore-core-test.sh`
- Modify: `tests/test_backup_core.py`
- Modify: `tests/test_restore_core.py`

- [ ] **Step 1: Add failing recovery tests**

Require backup of:

```text
telegram.pgdump
telegram-data/config.yaml
telegram-data/registration.yaml
telegram-data/synapse-registration.yaml
telegram-secrets/telegram-db.password
telegram-secrets/telegram-db.env
telegram-secrets/telegram-api-id
telegram-secrets/telegram-api-hash
```

Require mode-0700 staging directories, mode-0600 files, bounded service restart,
and restart of `synapse whatsapp messenger telegram` on both success and cleanup.

Require isolated restore to create the Telegram database, restore the dump,
require a positive public-table count, and validate config with:

```text
docker run --rm --network none
/usr/bin/mautrix-telegram -c /validation/config.yaml -g -r /validation/registration.yaml
```

Explicitly reject `up -d telegram`, `start telegram`, host networking, and any
network-enabled one-off Telegram container.

- [ ] **Step 2: Verify RED**

```bash
python3 -m unittest tests.test_backup_core tests.test_restore_core -v
```

- [ ] **Step 3: Extend `scripts/backup-core.sh`**

Stop `telegram messenger whatsapp synapse` before consistent dumps. Add a custom
format dump of `telegram_bridge`. Copy only the files listed in Step 1 into the
root-only staging tree. The existing encrypted restic repository is the only
archive destination; no unencrypted R2 objects are created by this task.

The cleanup trap and normal path must use:

```bash
docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 synapse whatsapp messenger telegram
```

Preserve existing `restic backup`, `restic check`, staging cleanup, and the
single final `backup=PASS` marker.

- [ ] **Step 4: Extend `scripts/restore-core-test.sh`**

Restore Telegram files into the isolated timestamped root, set ownership
1337:1337 for runtime files and root:root for secrets, and require 0600 modes.
After isolated PostgreSQL is healthy, run `init-telegram-db.sh`, restore with
`pg_restore --clean --if-exists --no-owner`, and require at least one public
table.

Copy only restored `config.yaml` to a disposable validation directory and run
the pinned image with `--network none`, mounting the directory at `/validation`,
and overriding the entrypoint to `/usr/bin/mautrix-telegram`. Require a nonempty
generated registration and emit `telegram_config=PASS`. Do not start a restored
Telegram client or contact Telegram.

- [ ] **Step 5: Verify and commit**

```bash
python3 -m unittest tests.test_backup_core tests.test_restore_core -v
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/backup-core.sh scripts/restore-core-test.sh
git diff --check
git add scripts/backup-core.sh scripts/restore-core-test.sh tests/test_backup_core.py tests/test_restore_core.py
git commit -m "feat: recover Telegram bridge state"
```

### Task 8: Write Telegram operations and acceptance runbooks

**Files:**

- Create: `docs/runbooks/mautrix-telegram-operations.md`
- Create: `docs/runbooks/mautrix-telegram-validation.md`
- Modify: `docs/runbooks/matrix-core-operations.md`
- Modify: `docs/runbooks/matrix-core-recovery.md`

- [ ] **Step 1: Write the operations runbook**

Start with a simple explanation, then exact technical sections for API
credential provisioning, pre-login deployment, QR login, phone-code fallback,
2FA handling, normal restart, upgrade, bad credentials, explicit logout,
break-glass access, rollback, retention/privacy behavior, licensing, and future
customer onboarding.

Primary login in the Human's encrypted private room with
`@telegrambot:communicator.0000.gold`:

```text
login qr
```

The user scans it in Telegram: Settings -> Devices -> Link Desktop Device. The
QR is short-lived sensitive authentication material and must not be captured in
screenshots or logs.

Document this only as an operator-approved fallback:

```text
login phone +<international-number>
```

The six-digit code arrives in an already logged-in official Telegram client,
not by SMS. A 2FA prompt is a user-only pause. Do not ask the implementer to
handle the number, code, password, QR, or Telegram account recovery.

Document that explicit `logout`, removing the Telegram device, changing
`split_portals`, or deleting portals is disruptive and never an automatic
rollback action.

For future customer onboarding, require: exact customer MXID added as `user`,
reviewed config commit, deployment through the release process, customer-owned
QR/2FA gate, symmetric isolation test against every pilot identity, and a fresh
backup. State explicitly that no second container is added.

- [ ] **Step 2: Write the validation runbook**

Define harmless new-message tests only. Include:

```text
telegram_prelogin_gate=PASS
human_telegram_pairing=PASS
human_telegram_inbound_text=PASS
human_telegram_outbound_text=PASS
human_telegram_media=PASS
human_telegram_reply=PASS
human_telegram_reaction=PASS
human_telegram_typing_observed=PASS|UPSTREAM_LIMITATION
human_telegram_receipt_observed=PASS|UPSTREAM_LIMITATION
human_telegram_e2ee=PASS
agent_cannot_access_human_telegram=PASS
platform_admin_not_automatic_member=PASS
non_admin_commands_rejected=PASS
whatsapp_preserved=PASS
messenger_preserved=PASS
telegram_restart_persistence=PASS
telegram_backup_restore=PASS
```

Bidirectional text, Matrix E2EE, Agent isolation, preservation of existing
bridges, restart persistence, and recovery are hard gates. Media, reply, and
reaction are expected and should be investigated if broken. Typing/receipt
variations that match the official feature matrix may be recorded as upstream
limitations; do not patch upstream code.

Require the runbook to state that Matrix E2EE protects the Matrix side only;
Telegram cloud chats and Telegram's server-side copy are not end-to-end
encrypted, and secret chats are unsupported.

- [ ] **Step 3: Update shared runbooks and commit**

Add Telegram to release health checks, backup payload, restore expectations,
and rollback-preservation rules. Keep all existing WhatsApp/Messenger gates.

```bash
! rg -n '\b(T''BD|T''ODO|FIX''ME|X''XX)\b' docs/runbooks/mautrix-telegram-*.md
git diff --check
git add docs/runbooks/mautrix-telegram-operations.md docs/runbooks/mautrix-telegram-validation.md docs/runbooks/matrix-core-operations.md docs/runbooks/matrix-core-recovery.md
git commit -m "docs: add Telegram bridge operations"
```

### Task 9: Run complete local verification and prepare the traceable branch

**Files:** No new files unless a test-backed correction is required.

- [ ] **Step 1: Run the complete local gate**

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m py_compile scripts/*.py
git diff --check origin/main...HEAD
git status --short --branch
```

Require zero failures and a clean worktree.

- [ ] **Step 2: Run the secret and scope scan**

```bash
! rg --pcre2 -n --hidden --glob '!*.pyc' --glob '!.git/**' \
  --glob '!docs/superpowers/plans/**' \
  '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AWS_SECRET_ACCESS_KEY=[A-Za-z0-9+/._~=-]{20,}|RESTIC_PASSWORD=[A-Za-z0-9+/]{20,}|TELEGRAM_DB_PASSWORD=[A-Za-z0-9+/]{20,}|api_hash:[[:space:]]+"?(?!0{32}"?\b)[0-9a-fA-F]{32}"?|as_token:[[:space:]]+[A-Za-z0-9_-]{24,}|hs_token:[[:space:]]+[A-Za-z0-9_-]{24,})' .
! git diff --name-only origin/main...HEAD \
  | grep -Ev '^deploy/images\.lock\.env$' \
  | grep -E '(^|/)(config\.yaml|registration\.yaml|.*\.pgdump|.*\.password|.*\.env)$'
```

Fake unit-test values must remain visibly fake and must not match the production
secret patterns.

- [ ] **Step 3: Push without creating the PR yet**

```bash
git push -u origin codex/telegram-bridge
```

Do not open the PR until live acceptance and recovery pass.

### Task 10: Operator provisions Telegram API credentials and deploys pre-login

**Files:** No repository changes unless a test-backed defect is found.

- [ ] **Step 1: Pause for the user-only Telegram API action**

Ask the user to create or select an application at `https://my.telegram.org/apps`
and obtain its numeric API ID and 32-character API hash. Do not request either
value in chat.

The user enters them directly into the verified Contabo terminal:

```bash
ssh -t contabo-eu
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
sudo install -d -o root -g root -m 0700 /srv/communicator/secrets
sudo bash -c '
set -euo pipefail
umask 077
read -rp "Telegram API ID: " telegram_api_id
read -rsp "Telegram API hash: " telegram_api_hash
printf "\n"
[[ "$telegram_api_id" =~ ^[0-9]+$ ]]
[[ "$telegram_api_hash" =~ ^[0-9a-fA-F]{32}$ ]]
printf "%s\n" "$telegram_api_id" > /srv/communicator/secrets/telegram-api-id
printf "%s\n" "$telegram_api_hash" > /srv/communicator/secrets/telegram-api-hash
chmod 0600 /srv/communicator/secrets/telegram-api-id /srv/communicator/secrets/telegram-api-hash
unset telegram_api_id telegram_api_hash
echo telegram_api_credentials=READY
'
exit
```

The implementer verifies only paths, types, and modes, never content.

- [ ] **Step 2: Take a fresh encrypted pre-change backup**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
cd /opt/communicator/current
sudo -n bash -c '
  set -euo pipefail
  set -a
  source /srv/communicator/secrets/restic.env
  set +a
  export COMMUNICATOR_RUNTIME_DIR=/srv/communicator
  export COMPOSE_PROJECT_NAME=communicator
  ./scripts/backup-core.sh
  restic snapshots --latest 1 --tag communicator-core --json |
    python3 -c '\''import json,sys; rows=json.load(sys.stdin); print("snapshot=" + rows[-1]["short_id"])'\''
'
REMOTE
```

Require `backup=PASS`, `restic check` success, and a short snapshot ID.

- [ ] **Step 3: Package and checksum the exact clean commit**

```bash
release_commit=$(git rev-parse HEAD)
release_archive=$(mktemp "/tmp/communicator-${release_commit}.XXXXXX.tar")
git archive --format=tar --output="$release_archive" "$release_commit"
release_sha=$(sha256sum "$release_archive" | awk '{print $1}')
printf 'release_commit=%s\nrelease_sha256=%s\n' "$release_commit" "$release_sha"
```

- [ ] **Step 4: Verify identity before transfer and verify checksum after**

```bash
ssh -o BatchMode=yes contabo-eu 'set -euo pipefail; test "$(hostname)" = vmi3501337; ip -4 -o addr show dev eth0 | grep -q "169.58.160.23/"'
remote_archive="/tmp/communicator-${release_commit}.tar"
scp -o BatchMode=yes "$release_archive" "contabo-eu:${remote_archive}"
ssh -o BatchMode=yes contabo-eu bash -s -- "$remote_archive" "$release_sha" <<'REMOTE'
set -euo pipefail
remote_archive=$1
expected_sha=$2
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
test "$(sha256sum "$remote_archive" | awk '{print $1}')" = "$expected_sha"
REMOTE
```

- [ ] **Step 5: Extract, deploy, and activate only after a second identity check**

```bash
ssh -o BatchMode=yes contabo-eu bash -s -- "$release_commit" "$remote_archive" <<'REMOTE'
set -euo pipefail
release_commit=$1
remote_archive=$2
[[ "$release_commit" =~ ^[0-9a-f]{40,64}$ ]]
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
release_dir="/opt/communicator/releases/$release_commit"
sudo -n test ! -e "$release_dir"
sudo -n install -d -o root -g root -m 0755 "$release_dir"
sudo -n tar -xf "$remote_archive" -C "$release_dir"
printf '%s\n' "$release_commit" | sudo -n install -o root -g root -m 0644 /dev/stdin "$release_dir/RELEASE_COMMIT"
test "$(cat "$release_dir/RELEASE_COMMIT")" = "$release_commit"
cd "$release_dir"
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh
sudo -n ln -sfn "$release_dir" /opt/communicator/current
REMOTE
```

Deploy before switching `current`; only activate after deploy succeeds. If the
existing deploy script requires `current`, preserve the accepted atomic-release
order from the merged core runbook and record the prior symlink before changing
it. On failure, reactivate the exact prior release and validate Synapse,
WhatsApp, and Messenger. Never delete Telegram runtime or log out the account.

- [ ] **Step 6: Run the mandatory pre-login gate**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
cd /opt/communicator/current
for validator in validate-core.sh validate-whatsapp.sh validate-messenger.sh validate-telegram.sh; do
  sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator "./scripts/$validator"
done
REMOTE
curl -fsS https://matrix.communicator.0000.gold/_matrix/client/versions >/dev/null
curl -fsS https://communicator.0000.gold/.well-known/matrix/client >/dev/null
curl -fsS https://communicator.0000.gold/.well-known/matrix/server >/dev/null
```

Report `telegram_prelogin_gate=PASS` and stop for user pairing.

### Task 11: Operator pairs and validates the Human Telegram account

**Files:** No repository changes.

- [ ] **Step 1: User performs QR login**

The Human opens an encrypted private room with
`@telegrambot:communicator.0000.gold`, sends `login qr`, and scans the QR from
the official Telegram app. Any 2FA prompt is handled only by the user. The
implementer waits for `human_telegram_pairing=PASS` and never asks for
credentials or screenshots.

- [ ] **Step 2: Validate new-message behavior**

Using a harmless contact and messages created after pairing, the user verifies
inbound/outbound text, one small media item, reply, reaction, typing, and read
receipt observations. Confirm the portal room is encrypted in Element.

Do not enable sync/backfill to make old chats appear. A portal may be created
when a new Telegram message arrives.

- [ ] **Step 3: Validate isolation**

Require:

```text
agent_cannot_access_human_telegram=PASS
platform_admin_not_automatic_member=PASS
non_admin_commands_rejected=PASS
```

Check room membership, not merely search visibility. Do not invite Platform
Admin as part of normal validation.

- [ ] **Step 4: Preserve existing bridges**

Run one new bidirectional text test through each existing Human WhatsApp and
Messenger account. Require:

```text
whatsapp_preserved=PASS
messenger_preserved=PASS
```

### Task 12: Prove restart persistence and post-pairing recovery

**Files:** No repository changes unless a test-backed defect is found.

- [ ] **Step 1: Restart the Telegram container and validate the existing login**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
cd /opt/communicator/current
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator \
  docker compose --env-file deploy/images.lock.env restart telegram
for attempt in $(seq 1 36); do
  state=$(sudo -n docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' communicator-telegram-1)
  [[ "$state" == healthy ]] && break
  [[ "$attempt" -eq 36 ]] && exit 1
  sleep 5
done
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-telegram.sh
REMOTE
```

Send one inbound and one outbound text without re-pairing. Require
`telegram_restart_persistence=PASS`.

- [ ] **Step 2: Take the post-pairing encrypted backup**

Run `scripts/backup-core.sh` through the root-only restic environment exactly as
in Task 10. Record only the short snapshot ID and `backup=PASS`.

- [ ] **Step 3: Run the isolated restore**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
cd /opt/communicator/current
sudo -n bash -c '
  set -euo pipefail
  set -a
  source /srv/communicator/secrets/restic.env
  set +a
  export COMMUNICATOR_RUNTIME_DIR=/srv/communicator
  ./scripts/restore-core-test.sh
'
REMOTE
```

Require all existing recovery markers plus `telegram_config=PASS` and a restored
Telegram table marker. Verify production Telegram remains healthy and logged in
afterward. Require `telegram_backup_restore=PASS`.

### Task 13: Final verification, PR, and handoff

**Files:** No new files unless correcting a verified defect.

- [ ] **Step 1: Run final local and production gates**

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m py_compile scripts/*.py
git diff --check origin/main...HEAD
git status --short --branch
ssh -o BatchMode=yes contabo-eu 'cd /opt/communicator/current && sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh && sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh && sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-messenger.sh && sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-telegram.sh'
```

Require clean Git state and all validators green.

- [ ] **Step 2: Push and create the PR**

```bash
git push
gh pr create \
  --base main \
  --head codex/telegram-bridge \
  --title "feat: add isolated multi-user Telegram bridge" \
  --body $'## Summary\n- add one pinned shared-process Telegram bridge\n- connect the Human account with split encrypted portals\n- preserve WhatsApp and Messenger\n- add encrypted backup and offline restore validation\n\n## Verification\n- full local test suite passes\n- pre-login and post-login production validators pass\n- pairing, E2EE, isolation, restart, backup, and restore gates pass\n\n## Safety\n- no upstream source modifications\n- no public bridge port or federation\n- no secrets committed\n- plan: docs/superpowers/plans/2026-08-27-telegram-bridge-implementation-plan.md'
```

Add the exact acceptance markers and snapshot/release IDs to a PR comment only
when they contain no personal identifiers or secrets.

- [ ] **Step 3: Handoff exact evidence**

Report:

- branch, HEAD commit, PR URL, and production `RELEASE_COMMIT`;
- pinned image tag and digest;
- local test count and zero failures;
- pre-login, pairing, new-message, E2EE, isolation, preservation, restart, backup,
  and restore markers;
- resource measurements from before and after Telegram;
- any typing/receipt upstream limitation;
- confirmation that no upstream source was changed and no secret was committed;
- confirmation that only one personal Telegram account was connected;
- the future customer onboarding procedure and its required isolation gate.

## Completion boundary

This plan is complete only when one upstream Telegram container is deployed on
Contabo, the Human's personal Telegram account works bidirectionally in encrypted
Matrix portals, the Agent cannot access those portals, WhatsApp and Messenger
remain healthy, restart persistence and encrypted backup/isolated restore pass,
and a reviewable PR exists.

It does not implement Cloudflare Queues, Durable Objects, the Matrix event
consumer, application APIs, agent delegation, a separate Agent Telegram
identity, Telegram secret chats, history import, public federation, or customer
self-service onboarding.

## Failure and escalation rules

- A changed image digest, missing Messenger merge/deployment, resource-gate
  failure, wrong remote identity/release, or exposed private port is a hard stop.
- A Telegram login ban/challenge, API-app issue, phone code, 2FA request, QR scan,
  explicit logout, device removal, or account recovery is a user-only pause.
- A proposed change to `split_portals` after login is rejected as destructive.
- A request to inspect or print secrets is rejected; verify metadata instead.
- A bridge protocol limitation is documented and escalated upstream; do not
  patch code that Communicator does not own.
- A deployment failure rolls back the release symlink and revalidates existing
  services; it does not delete Telegram runtime or remote sessions.
- A restore test must never contact Telegram or start a restored bridge client.

## Plan self-review checklist

- [x] Scope is Telegram-only and excludes Cloudflare/data-plane work.
- [x] The plan is structurally derived from Messenger but is self-contained.
- [x] Personal-only pilot and future shared-process multi-user model are explicit.
- [x] Agent has no Telegram remote identity or direct portal access.
- [x] `split_portals: true` is locked before first login.
- [x] API credential creation and account login are user-only gates.
- [x] Exact source tag, image digest, UID/GID, port, and binary are recorded.
- [x] No upstream source modifications or custom image build is permitted.
- [x] File paths, commands, tests, expected markers, commits, and failure rules
  are explicit enough for GPT-5.6 Luna on extra-high effort.
- [x] Encryption, privacy, unofficial-client, retention/backfill, and recovery
  risks are preserved.
- [x] AGPL licensing risk and the no-upstream-modification boundary are explicit.
- [x] WhatsApp and Messenger preservation is a hard acceptance gate.
- [x] Backup includes API/session prerequisites and restore stays offline.
- [x] No cross-task shorthand or missing implementation decisions remain.
