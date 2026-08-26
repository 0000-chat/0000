# Dual-Account Messenger Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one pinned `mautrix-meta` service to the existing private Communicator deployment, connect separate Human and Agent Messenger accounts with strict encrypted portal isolation, and prove safe deployment, recovery, and restart persistence without modifying upstream code.

**Architecture:** The existing Synapse, PostgreSQL, Caddy, and shared mautrix-whatsapp deployment remains the operational messaging core. One additional `messenger` container uses a dedicated `messenger_bridge` PostgreSQL database and two independent remote logins. Project code supplies only pinned container topology, generated configuration, exact permissions, appservice registration, validation, backup, restore, and runbooks; upstream `mautrix-meta` owns the Messenger protocol and session implementation.

**Tech Stack:** Docker Compose, Synapse v1.159.0, PostgreSQL 16, Caddy, upstream `dock.mau.dev/mautrix/meta:v26.08`, Bash, Python 3 standard library, `unittest`, restic, Cloudflare R2 backup repository, Ubuntu 24.04 LTS on Contabo.

---

## Simple execution contract

Work only in `/home/ubuntu/communicator/.worktrees/messenger-bridge` on branch
`codex/messenger-bridge`. Do not edit local `main`, the completed
`feat/matrix-core` worktree, or files under `/opt/communicator/current` directly.

The bridge feature already exists upstream. Do not clone, fork, patch, or
rebuild Synapse, Element, or any mautrix repository. This plan changes only the
Communicator deployment repository and the protected Contabo runtime.

Continue autonomously through every local implementation and safe remote
deployment step. Stop only at the two explicit operator login gates, an actual
Meta account challenge, an unexpected remote identity/release mismatch, a
destructive action, or a failure that remains after systematic diagnosis.

Never request or expose Facebook passwords, cookies, copied cURL commands, 2FA
codes, captcha answers, recovery codes, phone numbers, account IDs, contact
names, message bodies, Matrix room IDs, appservice tokens, bridge pickle keys,
database passwords, or restic credentials. Do not use `docker logs`, inspect
container environment variables, print configs, or query message/session rows
as diagnostics.

## Current verified source facts

- Base commit: `c95bf07` (`Merge pull request #1 from 0000-chat/feat/matrix-core`).
- Approved design commit: `d571f06`.
- Current production application commit at plan creation:
  `4c38fe42dfc7135986ddf2ff7859a1fc7039492b`.
- Remote SSH alias: `contabo-eu`.
- Required remote hostname: `vmi3501337`.
- Required remote `eth0` IPv4: `169.58.160.23`.
- Runtime: `/srv/communicator`.
- Releases: `/opt/communicator/releases/$release_commit` with
  `/opt/communicator/current` as the active symlink.
- `mautrix-meta` GitHub release: `v0.2608.0`, published 2026-08-16.
- Docker release tag: `dock.mau.dev/mautrix/meta:v26.08`.
- Pinned manifest-list digest:
  `sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8`.
- Linux/amd64 child digest:
  `sha256:b3b8e9eeb4ca67185b58333801276759a49789cb6199973863adfe5296f7baa1`.
- Image command: `/docker-run.sh`; bridge binary: `/usr/bin/mautrix-meta`;
  working directory and volume: `/data`; service UID/GID: 1337.
- Messenger appservice port: 29319.
- Official setup requires upstream config generation, config editing, a second
  generation pass for registration, Synapse appservice registration, then
  interactive login.

If the registry tag no longer resolves to the pinned digest, stop. Do not
silently choose another release or digest.

## Hard safety boundaries

- No public port except Caddy 80/443.
- No Matrix federation or public registration.
- No Messenger public media, direct media, provisioning API, relay, proxy,
  Tor, analytics, session transfer, or history backfill.
- `bridge.split_portals` is `true` before the first login and is never changed.
- Human and Agent are `user`; Platform Admin is `admin`; no other explicit MXID
  is permitted.
- Platform Admin is not invited to encrypted portals during ordinary work.
- Database creation is additive and idempotent; never drop or recreate a
  production database.
- Registration tokens and the encryption pickle key are generated once and
  preserved.
- Never run `docker compose down`, remove production volumes, reset the bridge
  database, log out an account, or unlink a remote session as rollback.
- A restored Messenger session is never started and never receives network
  access.
- Preserve the existing two WhatsApp sessions and all existing Matrix data.
- Telegram and the Cloudflare data plane are outside this branch.

## File map

Create:

- `scripts/init-messenger-db.sh` — idempotent database/role initialization.
- `scripts/init-messenger-runtime.sh` — one-time upstream generation, safe
  render, registration copy, and image guard.
- `scripts/render-messenger-config.py` — deterministic secret-safe config
  rendering with token and pickle-key preservation.
- `scripts/validate_messenger_policy.py` — fail-closed permission, relay, and
  split-portal validation.
- `scripts/validate-messenger.sh` — secret-free production health and policy
  validator.
- `tests/test_messenger_contract.py` — image, network, dependency, volume, and
  health contracts.
- `tests/test_render_messenger_config.py` — config, secret handling, and
  atomic-file behavior.
- `tests/test_messenger_policy.py` — exact identity and isolation policy.
- `tests/test_validate_messenger.py` — deployment order and safe diagnostics.
- `docs/runbooks/mautrix-messenger-operations.md` — deployment, login,
  challenge, upgrade, and rollback how-to.
- `docs/runbooks/mautrix-messenger-validation.md` — automated and operator
  acceptance gates.

Modify:

- `compose.yaml` — private Messenger service.
- `deploy/images.lock.env` — immutable Meta image.
- `deploy/synapse/homeserver.yaml.template` — second appservice registration.
- `scripts/init-runtime.sh` — protected Messenger directories and DB secret.
- `scripts/render-synapse-config.py` — require both protected registrations.
- `scripts/deploy-core.sh` — initialize and start Messenger in safe order.
- `scripts/validate-core.sh` — require Messenger and reject port 29319.
- `scripts/backup-core.sh` — Messenger DB/runtime backup and bounded restart.
- `scripts/restore-core-test.sh` — isolated Messenger restore and offline parse.
- `tests/test_repository_contract.py` — require the new pinned image and private
  port boundary.
- `tests/test_runtime_init.py` — Messenger secret and generation idempotency.
- `tests/test_render_synapse_config.py` — both registration files.
- `tests/test_backup_core.py` — Messenger recovery coverage.
- `tests/test_restore_core.py` — isolated DB/config validation and no session
  start.
- `docs/runbooks/matrix-core-operations.md` — Messenger-aware release gate.
- `docs/runbooks/matrix-core-recovery.md` — three-database recovery contract.

Do not commit anything under `/srv/communicator`, generated YAML, registrations,
database dumps, restic state, release archives, credentials, screenshots, or
acceptance evidence containing identifiers.

### Task 1: Establish source, host, resource, and rollback gates

**Files:** Read only; no repository modifications.

- [ ] **Step 1: Verify the local branch and approved documents**

Run locally:

```bash
cd /home/ubuntu/communicator/.worktrees/messenger-bridge
test "$(git branch --show-current)" = codex/messenger-bridge
git status --short --branch
git log --oneline --decorate -5
test -f docs/superpowers/specs/2026-08-26-messenger-bridge-design.md
test -f docs/superpowers/plans/2026-08-26-messenger-bridge-implementation-plan.md
```

Expected: the branch is `codex/messenger-bridge`, the worktree has no uncommitted
changes, and both approved documents exist. If the plan document is the only
uncommitted file because this task is being executed before the planning commit,
stop and ask the planning session to commit it.

- [ ] **Step 2: Re-verify the immutable upstream image**

Run locally:

```bash
docker buildx imagetools inspect dock.mau.dev/mautrix/meta:v26.08
```

Expected top-level digest:

```text
sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8
```

Require a `linux/amd64` manifest. If either requirement differs, stop without
editing the image lock.

- [ ] **Step 3: Verify the exact remote before any Docker mutation**

Run:

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
test "$(cat /opt/communicator/current/RELEASE_COMMIT)" = 4c38fe42dfc7135986ddf2ff7859a1fc7039492b
test "$(readlink -f /opt/communicator/current)" = /opt/communicator/releases/4c38fe42dfc7135986ddf2ff7859a1fc7039492b
sudo -n docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'
available_kib=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
test "$available_kib" -ge 2097152
free_kib=$(df --output=avail -k / | tail -1 | tr -d ' ')
test "$free_kib" -ge 41943040
if ss -H -ltn | awk '{print $4}' | grep -Eq ':(5432|8008|8448|29318|29319|2019)$'; then
  exit 1
fi
REMOTE
```

Expected: exact identity/release, at least 2 GiB available memory and 40 GiB
free disk, current services healthy, and no private port published. Any mismatch
is a hard stop.

- [ ] **Step 4: Verify recovery credentials by metadata only**

Run:

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

Expected modes are root-only. Do not source or print either file during this
metadata check.

### Task 2: Add the pinned private Messenger container contract

**Files:**

- Create: `tests/test_messenger_contract.py`
- Modify: `tests/test_repository_contract.py`
- Modify: `deploy/images.lock.env`
- Modify: `compose.yaml`

- [ ] **Step 1: Write the failing Messenger contract tests**

Create `tests/test_messenger_contract.py` with:

```python
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPECTED_IMAGE = (
    "dock.mau.dev/mautrix/meta:v26.08@"
    "sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8"
)


def compose_service(name: str) -> str:
    compose = (ROOT / "compose.yaml").read_text()
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(?P<body>.*?)(?=^  [a-z].*:\n|^networks:\n)",
        compose,
    )
    return match.group("body") if match else ""


class MessengerContractTests(unittest.TestCase):
    def test_image_is_verified_release_digest(self):
        lock = dict(
            line.split("=", 1)
            for line in (ROOT / "deploy/images.lock.env").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertEqual(EXPECTED_IMAGE, lock.get("MESSENGER_IMAGE"))

    def test_service_is_private_and_persistent(self):
        service = compose_service("messenger")
        self.assertTrue(service)
        self.assertNotIn("ports:", service)
        self.assertNotIn("expose:", service)
        self.assertIn("networks: [core]", service)
        self.assertIn("${COMMUNICATOR_RUNTIME_DIR}/messenger:/data", service)

    def test_service_waits_for_postgres_and_synapse(self):
        service = compose_service("messenger")
        self.assertIn("postgres:\n        condition: service_healthy", service)
        self.assertIn("synapse:\n        condition: service_healthy", service)

    def test_healthcheck_is_internal_only(self):
        service = compose_service("messenger")
        self.assertIn("127.0.0.1:29319/_matrix/mau/ready", service)
        self.assertNotIn("0.0.0.0", service)


if __name__ == "__main__":
    unittest.main()
```

Update `test_every_image_is_digest_pinned` in
`tests/test_repository_contract.py` so the expected set includes
`MESSENGER_IMAGE`. Update the port boundary test to reject `29319:29319`.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
python3 -m unittest tests.test_messenger_contract tests.test_repository_contract -v
```

Expected: failures because `MESSENGER_IMAGE` and the `messenger` service do not
exist.

- [ ] **Step 3: Add the image lock and service**

Append exactly this line to `deploy/images.lock.env`:

```dotenv
MESSENGER_IMAGE=dock.mau.dev/mautrix/meta:v26.08@sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8
```

Add this service after `whatsapp` in `compose.yaml`:

```yaml
  messenger:
    image: ${MESSENGER_IMAGE}
    depends_on:
      postgres:
        condition: service_healthy
      synapse:
        condition: service_healthy
    volumes:
      - ${COMMUNICATOR_RUNTIME_DIR}/messenger:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:29319/_matrix/mau/ready >/dev/null"]
      interval: 10s
      timeout: 5s
      retries: 18
    restart: unless-stopped
    networks: [core]
```

Do not add `ports`, `expose`, environment credentials, or a second network.

- [ ] **Step 4: Run focused and repository tests**

```bash
python3 -m unittest tests.test_messenger_contract tests.test_repository_contract -v
python3 -m unittest discover -s tests -p 'test_*.py' -v
git diff --check
```

Expected: all tests pass and the diff check is silent.

- [ ] **Step 5: Commit**

```bash
git add compose.yaml deploy/images.lock.env tests/test_messenger_contract.py tests/test_repository_contract.py
git commit -m "feat: define private Messenger bridge service"
```

### Task 3: Add protected Messenger secrets and database initialization

**Files:**

- Modify: `scripts/init-runtime.sh`
- Create: `scripts/init-messenger-db.sh`
- Modify: `tests/test_runtime_init.py`

- [ ] **Step 1: Extend runtime tests first**

In `test_creates_private_secret_files_without_printing_values`, require:

```python
self.assertTrue((pathlib.Path(directory) / "messenger").is_dir())
messenger_password = pathlib.Path(directory) / "secrets/messenger-db.password"
messenger_env = pathlib.Path(directory) / "secrets/messenger-db.env"
self.assertEqual(0o600, stat.S_IMODE(messenger_password.stat().st_mode))
self.assertEqual(0o600, stat.S_IMODE(messenger_env.stat().st_mode))
self.assertIn("MESSENGER_DB_PASSWORD=", messenger_env.read_text())
self.assertNotIn(messenger_password.read_text().strip(), result.stdout)
```

In `test_second_run_is_idempotent`, capture the Messenger password before the
second call and assert exact equality afterward.

Add a static test:

```python
def test_messenger_database_initializer_is_additive(self):
    script = (ROOT / "scripts/init-messenger-db.sh").read_text()
    self.assertIn('"$project" == communicator || "$project" == communicator-restore-test', script)
    self.assertIn("CREATE ROLE messenger_bridge", script)
    self.assertIn("ALTER ROLE messenger_bridge", script)
    self.assertIn("CREATE DATABASE messenger_bridge OWNER messenger_bridge", script)
    for forbidden in ("DROP DATABASE", "DROP ROLE", "compose down", "rm -rf"):
        self.assertNotIn(forbidden, script)
```

- [ ] **Step 2: Verify RED**

```bash
python3 -m unittest tests.test_runtime_init -v
```

Expected: missing Messenger directory, files, and initializer.

- [ ] **Step 3: Extend `scripts/init-runtime.sh`**

Add `$runtime_dir/messenger` and `$runtime_dir/messenger-backups` to the
mode-0700 directory list. Add the following idempotent block after the WhatsApp
credential block, preserving `umask 077`:

```bash
messenger_password="$runtime_dir/secrets/messenger-db.password"
if [[ ! -e "$messenger_password" ]]; then
  openssl rand -base64 48 | tr -d '\n' > "$messenger_password"
  printf '\n' >> "$messenger_password"
fi
chmod 0600 "$messenger_password"

messenger_env="$runtime_dir/secrets/messenger-db.env"
if [[ ! -e "$messenger_env" ]]; then
  temporary_env=$(mktemp "$runtime_dir/secrets/messenger-db.env.XXXXXX")
  chmod 0600 "$temporary_env"
  {
    printf 'MESSENGER_DB_PASSWORD='
    cat "$messenger_password"
  } > "$temporary_env"
  mv "$temporary_env" "$messenger_env"
fi
chmod 0600 "$messenger_env"
```

- [ ] **Step 4: Create `scripts/init-messenger-db.sh`**

Copy the structure of the existing initializer, but use these exact Messenger
values throughout:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
password_file="${runtime_dir}/secrets/messenger-db.password"
sql_file=$(mktemp "${runtime_dir}/secrets/messenger-db-init.XXXXXX.sql")

cleanup() { rm -f -- "$sql_file"; }
trap cleanup EXIT

[[ "$project" == communicator || "$project" == communicator-restore-test ]]
[[ -f "$password_file" ]]
[[ "$(stat -c '%a' "$password_file")" == 600 ]]
chmod 0600 "$sql_file"

python3 - "$password_file" "$sql_file" <<'PY'
import pathlib
import sys

password = pathlib.Path(sys.argv[1]).read_text().strip()
if not password:
    raise SystemExit("database password is empty")
literal = password.replace("'", "''")
sql = f"""\
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'messenger_bridge') THEN
    CREATE ROLE messenger_bridge LOGIN PASSWORD '{literal}';
  ELSE
    ALTER ROLE messenger_bridge LOGIN PASSWORD '{literal}';
  END IF;
END
$$;
SELECT 'CREATE DATABASE messenger_bridge OWNER messenger_bridge'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'messenger_bridge')\gexec
"""
pathlib.Path(sys.argv[2]).write_text(sql)
PY

cd "$repo_dir"
docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -U synapse -d postgres < "$sql_file" >/dev/null

check=$(docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -At -U synapse -d postgres -c \
  "SELECT (SELECT count(*) FROM pg_roles WHERE rolname='messenger_bridge') || ':' || (SELECT count(*) FROM pg_database WHERE datname='messenger_bridge')")
[[ "$check" == "1:1" ]]
echo "messenger_database=PASS"
```

Make it executable with `chmod 0755 scripts/init-messenger-db.sh`.

- [ ] **Step 5: Verify GREEN and commit**

```bash
python3 -m unittest tests.test_runtime_init -v
bash -n scripts/init-runtime.sh scripts/init-messenger-db.sh
git diff --check
git add scripts/init-runtime.sh scripts/init-messenger-db.sh tests/test_runtime_init.py
git commit -m "feat: initialize protected Messenger database"
```

### Task 4: Render and validate the exact Messenger security policy

**Files:**

- Create: `scripts/render-messenger-config.py`
- Create: `scripts/validate_messenger_policy.py`
- Create: `tests/test_render_messenger_config.py`
- Create: `tests/test_messenger_policy.py`

- [ ] **Step 1: Write renderer tests**

Test a password containing `@:/?#'`, a mode-0600 registration containing
concrete fake tokens, and an existing output containing
`pickle_key: "stable-messenger-pickle"`. Require:

```text
postgres://messenger_bridge:p%40ss%3Aword%2Fwith%3Fhash%23%27quote@postgres/messenger_bridge?sslmode=disable
```

Also require all of these exact rendered values:

```yaml
network:
  send_presence_on_typing: false
  disable_view_once: true
  thread_backfill:
    batch_count: 0
bridge:
  split_portals: true
  personal_filtering_spaces: true
  async_events: false
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin
  relay:
    enabled: false
    admin_only: true
    default_relays: []
matrix:
  delivery_receipts: true
  federate_rooms: false
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
encryption:
  allow: true
  default: true
  require: true
  appservice: false
  msc4190: false
```

Require mode 0600, atomic replacement, preserved fake tokens/pickle key, and no
password/token/key in stdout. Add negative tests for missing or broad-mode
password files and for a registration path that is explicitly supplied but
missing or broad-mode. Add a pre-registration test that omits
`--registration`, starts with no output file, and requires literal JSON strings
`"generate"` for both appservice tokens.

- [ ] **Step 2: Write fail-closed policy tests**

Create fixtures for the exact approved nested policy. Test acceptance of the
exact policy and rejection of:

- missing Agent;
- Agent as admin;
- unexpected explicit identity;
- enabled relay;
- `split_portals: false`;
- missing `split_portals`; and
- a duplicate permissions or relay block.

Import `scripts/validate_messenger_policy.py` by adding `scripts` to `sys.path`,
as `tests/test_whatsapp_policy.py` does, and call `validate(path)` directly.

- [ ] **Step 3: Verify RED**

```bash
python3 -m unittest tests.test_render_messenger_config tests.test_messenger_policy -v
```

Expected: both modules are missing.

- [ ] **Step 4: Implement the renderer**

Use only Python standard-library modules already used by
`render-whatsapp-config.py`: `argparse`, `json`, `os`, `pathlib`, `re`, `stat`,
`tempfile`, and `urllib.parse.quote`.

The CLI is exactly:

```text
--db-password-file PATH [--registration PATH] --output PATH
```

When `--registration` is supplied, apply strict mode/token checks and use the
two registration tokens. When it is omitted for the one pre-registration
render, use literal token values `generate`. Reuse the proven
existing-pickle-key algorithm verbatim. Change the database role/database to
`messenger_bridge`. Render this complete minimal top-level structure with the
exact values tested above. The brace names are actual Python `str.format`
fields in `CONFIG_TEMPLATE`:

```yaml
network:
  proxy: null
  tor: false
  proxy_media: false
  proxy_e2ee: false
  send_presence_on_typing: false
  disable_view_once: true
  log_redacted_bloks_payloads: false
  thread_backfill:
    batch_count: 0
    batch_delay: 2s

bridge:
  command_prefix: "!fb"
  personal_filtering_spaces: true
  private_chat_portal_meta: true
  async_events: false
  split_portals: true
  bridge_status_notices: errors
  bridge_matrix_leave: false
  bridge_notices: false
  cleanup_on_logout:
    enabled: false
  relay:
    enabled: false
    admin_only: true
    prefer_default: true
    allow_bridge: false
    default_relays: []
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin

database:
  type: postgres
  uri: "{database_uri}"
  max_open_conns: 5
  max_idle_conns: 1

homeserver:
  address: http://synapse:8008
  domain: communicator.0000.gold
  software: standard
  websocket: false

appservice:
  address: http://messenger:29319
  public_address: null
  hostname: 0.0.0.0
  port: 29319
  id: messenger
  bot:
    username: messengerbot
    displayname: Facebook Messenger bridge bot
  ephemeral_events: true
  async_transactions: false
  as_token: {as_token}
  hs_token: {hs_token}
  username_template: messenger_{{{{.}}}}

matrix:
  message_status_events: false
  delivery_receipts: true
  message_error_notices: true
  sync_direct_chat_list: true
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
    max_batches: 0

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
  pickle_key: {pickle_key}
```

Use the exact source-template line `username_template: messenger_{{{{.}}}}`.
Python `str.format` then emits the required mautrix value
`username_template: messenger_{{.}}` in the rendered YAML.
All other values are literal. Write to a mode-0600 temporary file in the
destination directory and replace atomically with `os.replace`.

- [ ] **Step 5: Implement the policy validator**

Start from the proven parser structure in `validate_whatsapp_policy.py`, but
name the output marker `messenger_policy=PASS` and the failure
`Messenger policy validation failed`. Accept only nested `bridge.permissions`
and `bridge.relay` blocks. Add this helper, operating on the original indented
lines returned for the top-level `bridge` block:

```python
def exact_scalar(block: list[str], key: str) -> str | None:
    pattern = re.compile(rf"^  {re.escape(key)}:\s+(.+)$")
    values = [match.group(1) for line in block if (match := pattern.fullmatch(line))]
    return values[0] if len(values) == 1 else None
```

Restrict `parse_permissions` to the nested header `  permissions:` with child
indent 4. Restrict `parse_relay` to the nested header `    relay:` with child
indent 8. The completed `validate(path)` must return true only when:

```python
parse_permissions(bridge) == EXPECTED_PERMISSIONS
and parse_relay(bridge) == EXPECTED_RELAY
and exact_scalar(bridge, "split_portals") == "true"
```

The tests, not intuition, decide whether indentation handling is correct.

- [ ] **Step 6: Verify GREEN and commit**

```bash
python3 -m unittest tests.test_render_messenger_config tests.test_messenger_policy -v
python3 -m py_compile scripts/render-messenger-config.py scripts/validate_messenger_policy.py
git diff --check
git add scripts/render-messenger-config.py scripts/validate_messenger_policy.py tests/test_render_messenger_config.py tests/test_messenger_policy.py
git commit -m "feat: render isolated Messenger policy"
```

### Task 5: Generate and register the Messenger appservice safely

**Files:**

- Create: `scripts/init-messenger-runtime.sh`
- Modify: `deploy/synapse/homeserver.yaml.template`
- Modify: `scripts/render-synapse-config.py`
- Modify: `tests/test_runtime_init.py`
- Modify: `tests/test_render_synapse_config.py`

- [ ] **Step 1: Write registration and generation tests**

Add `test_messenger_runtime_guard_matches_locked_image_digest` and
`test_messenger_bootstrap_renders_before_and_after_registration` to
`tests/test_runtime_init.py`. Require the exact `MESSENGER_IMAGE` lock guard,
two upstream `docker compose ... run --rm --no-deps messenger` generation
calls, and two renderer calls. Require this exact order on a fresh runtime:

```text
upstream config generation
pre-registration project render without --registration
upstream registration generation
final project render with --registration
```

Extend `tests/test_render_synapse_config.py` to create separate mode-0600 fake
WhatsApp and Messenger registrations, pass both CLI arguments, and require both:

```yaml
  - /data/whatsapp-registration.yaml
  - /data/messenger-registration.yaml
```

Add negative tests for missing or group/world-readable Messenger registration.

- [ ] **Step 2: Verify RED**

```bash
python3 -m unittest tests.test_runtime_init tests.test_render_synapse_config -v
```

- [ ] **Step 3: Create `scripts/init-messenger-runtime.sh`**

Use these exact paths and guard:

```bash
messenger_dir="${runtime_dir}/messenger"
registration="${messenger_dir}/registration.yaml"
config="${messenger_dir}/config.yaml"
synapse_registration="${runtime_dir}/synapse/messenger-registration.yaml"
[[ "$project" == communicator ]]
[[ "$MESSENGER_IMAGE" == dock.mau.dev/mautrix/meta:v26.08@sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8 ]]
```

Create the mode-0700 runtime. If `config.yaml` is absent, run the pinned Compose
service once with `run --rm --no-deps messenger`, suppressing stdout/stderr.
Before generating a missing registration, render the approved project config
without `--registration` so the registration uses the approved `messenger`
appservice ID, `messengerbot` namespace, container address, and port. Then run
the same upstream service command to generate the registration. Require the
registration, set its owner to `1337:1337` and mode to `0600`, and only then
render a second time with:

```bash
python3 scripts/render-messenger-config.py \
  --db-password-file "$runtime_dir/secrets/messenger-db.password" \
  --registration "$registration" \
  --output "$config" >/dev/null
```

Then apply:

```bash
chown 1337:1337 "$config" "$registration" "$messenger_dir"
chmod 0600 "$config" "$registration"
install -o 991 -g 991 -m 0600 "$registration" "$synapse_registration"
echo "messenger_runtime=PASS"
```

Never overwrite an existing registration before extracting its tokens. On an
already-initialized runtime, skip both upstream generation calls and perform
only the final render. Make the script executable.

- [ ] **Step 4: Register Messenger with Synapse**

Add `/data/messenger-registration.yaml` after WhatsApp in the template. Add a
required `--messenger-registration` CLI path in `render-synapse-config.py` and
apply the same regular-file and mode check as WhatsApp. Do not read or print
registration contents.

- [ ] **Step 5: Verify and commit**

```bash
python3 -m unittest tests.test_runtime_init tests.test_render_synapse_config -v
bash -n scripts/init-messenger-runtime.sh
python3 -m py_compile scripts/render-synapse-config.py
git diff --check
git add scripts/init-messenger-runtime.sh deploy/synapse/homeserver.yaml.template scripts/render-synapse-config.py tests/test_runtime_init.py tests/test_render_synapse_config.py
git commit -m "feat: register Messenger appservice with Synapse"
```

### Task 6: Add safe deployment and fail-closed live validation

**Files:**

- Modify: `scripts/deploy-core.sh`
- Create: `scripts/validate-messenger.sh`
- Modify: `scripts/validate-core.sh`
- Create: `tests/test_validate_messenger.py`

- [ ] **Step 1: Write deployment and validator tests**

Require this exact ordering in `deploy-core.sh`:

```text
pull
init-whatsapp-db.sh
init-messenger-db.sh
init-whatsapp-runtime.sh
init-messenger-runtime.sh
render-synapse-config.py with both registration arguments
Synapse force-recreate/wait
Caddy force-recreate/wait
WhatsApp force-recreate/wait
Messenger force-recreate/wait
```

Require `validate-messenger.sh` to guard exact runtime/project, check mode 600,
call `validate_messenger_policy.py`, inspect only container status/health,
perform internal live/ready requests, reject host port 29319, and emit only:

```text
messenger_container=running
messenger_health=healthy
messenger_live=PASS
messenger_ready=PASS
messenger_ports=NONE
messenger_registration=PASS
messenger_policy=PASS
messenger_backfill=DISABLED
messenger_provisioning=DISABLED
```

Reject `docker logs`, `.Config.Env`, config printing, `compose down`,
`compose stop`, and `rm -rf` in the validator.

Update core-validator tests to require sorted services:

```text
caddy
messenger
postgres
synapse
whatsapp
```

- [ ] **Step 2: Verify RED**

```bash
python3 -m unittest tests.test_validate_messenger -v
```

- [ ] **Step 3: Extend deployment**

After PostgreSQL becomes healthy, call both DB initializers and both runtime
initializers. Pass:

```bash
--messenger-registration "$runtime_dir/synapse/messenger-registration.yaml"
```

to the Synapse renderer. Start Messenger last with:

```bash
docker compose --env-file deploy/images.lock.env up -d --no-deps --force-recreate --wait --wait-timeout 180 messenger
```

- [ ] **Step 4: Implement `validate-messenger.sh`**

Follow this secret-safe sequence:

1. Set and export runtime/project; require exactly `/srv/communicator` and
   `communicator`.
2. Resolve the Messenger container ID with Compose; require one ID.
3. Use `docker inspect --format` only for `.State.Status` and
   `.State.Health.Status`; require running/healthy.
4. Execute `curl -fsS` inside the container against
   `127.0.0.1:29319/_matrix/mau/live` and `/ready`, discarding bodies.
5. Require config and both registration copies to be regular mode-0600 files.
6. Run `python3 scripts/validate_messenger_policy.py "$config"`.
7. Execute the container's `yq` with `-e` and no output to require the approved
   E2EE, federation, provisioning, public/direct media, split portal, and
   backfill booleans.
8. Reject host listeners on 29319.
9. Print only the approved markers.

Do not print yq results or registration/config content.

- [ ] **Step 5: Extend `validate-core.sh`**

Add 29319 to the forbidden private-port expression and Messenger to the exact
running service list. Keep every existing federation, registration, HTTPS,
well-known, Synapse, and WhatsApp check.

- [ ] **Step 6: Verify and commit**

```bash
python3 -m unittest tests.test_validate_messenger tests.test_validate_whatsapp tests.test_repository_contract -v
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
git diff --check
git add scripts/deploy-core.sh scripts/validate-messenger.sh scripts/validate-core.sh tests/test_validate_messenger.py
git commit -m "feat: deploy and validate Messenger bridge"
```

### Task 7: Extend encrypted backup and isolated restore

**Files:**

- Modify: `scripts/backup-core.sh`
- Modify: `scripts/restore-core-test.sh`
- Modify: `tests/test_backup_core.py`
- Modify: `tests/test_restore_core.py`

- [ ] **Step 1: Add failing recovery tests**

Extend backup tests to require:

```text
stop messenger whatsapp synapse
pg_dump -U synapse -d messenger_bridge
$staging/messenger.pgdump
$staging/messenger-data
$runtime_dir/messenger/config.yaml
$runtime_dir/messenger/registration.yaml
$runtime_dir/synapse/messenger-registration.yaml
$runtime_dir/secrets/messenger-db.password
$runtime_dir/secrets/messenger-db.env
up -d --wait --wait-timeout 180 synapse whatsapp messenger
```

Extend restore tests to require the Messenger dump and artifacts, UID/GID 1337,
mode 600, `init-messenger-db.sh`, restore into `messenger_bridge`, a positive
table count marker, and offline config generation with:

```text
docker run --rm --network none
/usr/bin/mautrix-meta
-c /validation/config.yaml --generate-registration
```

Explicitly reject `up -d messenger` and `start messenger` in the restore script.

- [ ] **Step 2: Verify RED**

```bash
python3 -m unittest tests.test_backup_core tests.test_restore_core -v
```

- [ ] **Step 3: Extend the backup script**

Define one `restart_core` helper that runs the exact bounded command
`docker compose --env-file deploy/images.lock.env up -d --wait
--wait-timeout 180 synapse whatsapp messenger`. Both the cleanup trap and the
normal path must call it; the cleanup trap may suppress errors, while the
normal path must fail closed if health is not reached. Stop
`messenger whatsapp synapse` before dumps. Add a custom-format
`messenger_bridge` dump. Add mode-0700 `messenger-data`; copy only protected
config/registration and the Synapse registration copy plus Messenger DB secret
files. Do not copy logs or temporary files.

Keep `restic backup`, `restic check`, bounded service interruption, staging
cleanup, and the single `backup=PASS` marker.

- [ ] **Step 4: Extend the isolated restore**

Require `messenger.pgdump`, create isolated Messenger runtime, copy artifacts,
set UID/GID 1337, and require mode 600. After isolated PostgreSQL is healthy,
run `init-messenger-db.sh`, restore with `--clean --if-exists --no-owner`, and
require at least one public table.

Create a separate validation directory, copy only restored Messenger
`config.yaml`, then run the pinned image with `--network none` and the exact
binary/registration-generation command. Require a nonempty generated
registration, remove only the validation directory, and emit
`messenger_config=PASS`.

Never add Messenger to the isolated Compose `up` or `start` commands.

- [ ] **Step 5: Verify and commit**

```bash
python3 -m unittest tests.test_backup_core tests.test_restore_core -v
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/backup-core.sh scripts/restore-core-test.sh
git diff --check
git add scripts/backup-core.sh scripts/restore-core-test.sh tests/test_backup_core.py tests/test_restore_core.py
git commit -m "feat: recover Messenger bridge state safely"
```

### Task 8: Write Messenger operations and acceptance runbooks

**Files:**

- Create: `docs/runbooks/mautrix-messenger-operations.md`
- Create: `docs/runbooks/mautrix-messenger-validation.md`
- Modify: `docs/runbooks/matrix-core-operations.md`
- Modify: `docs/runbooks/matrix-core-recovery.md`

- [ ] **Step 1: Write the operations runbook**

Include simple explanation first, then exact technical sections for release,
pre-login checkpoint, Human login, Agent login, Meta challenge handling,
restart, upgrade, logout, and rollback.

The primary operator command in each identity's encrypted bridge-bot room is:

```text
login messenger-lite
```

Document `login facebook` cookie authentication only as an operator-approved
fallback following official upstream instructions. Never ask the implementer
to handle the returned credentials. Meta captcha, 2FA, password reset, account
verification, or WebAuthn is a user-only pause.

Document that logout/unlink is external and disruptive, is never automatic
rollback, and requires explicit approval after preserving a fresh backup.

- [ ] **Step 2: Write the validation runbook**

Include all markers from the approved design. Define harmless test contacts and
new test messages only; no history import. Define E2EE verification, symmetric
portal isolation, Platform Admin non-membership, non-admin command rejection,
typing and receipt observations, session restart persistence, WhatsApp
preservation, and post-pairing backup/restore.

State that unsupported media/reply/reaction/typing/receipt behavior is recorded
as an evidence-based upstream limitation, while bidirectional text, E2EE,
isolation, session persistence, WhatsApp preservation, and recovery remain hard
completion gates.

- [ ] **Step 3: Update core runbooks**

Add Messenger to exact release health/validation commands and to the backup
payload/restore expectations. Preserve all existing remote identity,
checksum, secret, and no-destructive-rollback rules.

- [ ] **Step 4: Verify and commit**

```bash
! rg -n '\b(T''BD|T''ODO|FIX''ME|X''XX)\b' docs/runbooks/mautrix-messenger-*.md
git diff --check
git add docs/runbooks/mautrix-messenger-operations.md docs/runbooks/mautrix-messenger-validation.md docs/runbooks/matrix-core-operations.md docs/runbooks/matrix-core-recovery.md
git commit -m "docs: add Messenger bridge operations"
```

### Task 9: Run complete local verification and deploy the pre-login release

**Files:** No new files unless a test-backed correction is required.

- [ ] **Step 1: Run the complete local gate**

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m py_compile scripts/*.py
git diff --check origin/main...HEAD
git status --short --branch
```

Require zero failures, clean syntax/diff, and no uncommitted files.

- [ ] **Step 2: Run the secret and scope scan**

```bash
! rg -n --hidden --glob '!*.pyc' --glob '!.git/**' \
  '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AWS_SECRET_ACCESS_KEY|RESTIC_PASSWORD=[A-Za-z0-9+/]{20,}|MESSENGER_DB_PASSWORD=[A-Za-z0-9+/]{20,}|c_user=[0-9]{6,}|"xs"\s*:\s*"[^<][^"]{20,}"|sessionid=[A-Za-z0-9%_-]{20,}|csrftoken=[A-Za-z0-9]{20,}|as_token:\s+[A-Za-z0-9_-]{24,}|hs_token:\s+[A-Za-z0-9_-]{24,})' .
! git diff --name-only origin/main...HEAD \
  | grep -Ev '^deploy/images\.lock\.env$' \
  | grep -E '(^|/)(config\.yaml|registration\.yaml|.*\.pgdump|.*\.password|.*\.env)$'
```

Expected: both negated commands exit zero. Fake unit-test values must remain
obviously fake and short.

- [ ] **Step 3: Push the traceable branch**

```bash
git push -u origin codex/messenger-bridge
```

Do not create the PR yet.

- [ ] **Step 4: Take a fresh pre-change encrypted backup**

Run on the verified current release using the existing root-only restic env:

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

Require `backup=PASS`, `restic check` success, and a short snapshot ID. Do not
print the restic environment.

- [ ] **Step 5: Package the exact clean commit**

```bash
release_commit=$(git rev-parse HEAD)
release_archive=$(mktemp "/tmp/communicator-${release_commit}.XXXXXX.tar")
git archive --format=tar --output="$release_archive" "$release_commit"
release_sha=$(sha256sum "$release_archive" | awk '{print $1}')
printf 'release_commit=%s\nrelease_sha256=%s\n' "$release_commit" "$release_sha"
```

Keep the explicit archive path in the current shell; do not use a broad glob.

- [ ] **Step 6: Verify remote identity before transfer, then transfer/checksum**

```bash
ssh -o BatchMode=yes contabo-eu 'set -euo pipefail; test "$(hostname)" = vmi3501337; ip -4 -o addr show dev eth0 | grep -q "169.58.160.23/"'
remote_archive="/tmp/communicator-${release_commit}.tar"
scp -o BatchMode=yes "$release_archive" "contabo-eu:${remote_archive}"
ssh -o BatchMode=yes contabo-eu "test \"\$(sha256sum '$remote_archive' | awk '{print \$1}')\" = '$release_sha'"
```

- [ ] **Step 7: Extract and activate only after a second identity check**

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
printf '%s\n' "$release_commit" |
  sudo -n install -o root -g root -m 0644 /dev/stdin "$release_dir/RELEASE_COMMIT"
test "$(cat "$release_dir/RELEASE_COMMIT")" = "$release_commit"
sudo -n ln -sfn "$release_dir" /opt/communicator/current
cd /opt/communicator/current
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh
REMOTE
```

If deploy fails before login, diagnose using only Compose `ps`, container state,
health, listener state, and script error output. If not promptly test-fixable,
reactivate the prior release and run existing core/WhatsApp validators. Do not
delete generated Messenger runtime.

- [ ] **Step 8: Run the mandatory pre-login gate**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
cd /opt/communicator/current
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-messenger.sh
REMOTE
curl -fsS https://matrix.communicator.0000.gold/_matrix/client/versions >/dev/null
curl -fsS https://communicator.0000.gold/.well-known/matrix/client >/dev/null
curl -fsS https://communicator.0000.gold/.well-known/matrix/server >/dev/null
```

Require every marker and public check. Stop here and report
`messenger_prelogin_gate=PASS`. Do not log into Meta without the user.

### Task 10: Operator pairs and validates the Human Messenger account

**Files:** No repository changes.

- [ ] **Step 1: Give the operator the exact private action**

Ask the user to sign into Element as `@human:communicator.0000.gold`, open a
private encrypted room with `@messengerbot:communicator.0000.gold`, verify the
room is encrypted, and send:

```text
login messenger-lite
```

The user, not the implementer, enters any credentials or account challenge.
If Meta requires another action, report `human_messenger_login_challenge=WAIT`
and stop without repeated attempts.

- [ ] **Step 2: After user confirms login, rerun automated validators**

Run core, WhatsApp, and Messenger validators from the exact active release.
Require all pass and no new listener.

- [ ] **Step 3: Ask for Human acceptance evidence only as markers**

Using a harmless approved test contact and new messages, collect the Human
markers from the design/runbook. Then verify from the Agent Element identity
that Human portals cannot be discovered, joined, or decrypted. Do not request
room names, IDs, contact names, or message text.

The hard gate before Agent login is:

```text
human_messenger_pairing=PASS
human_messenger_inbound_text=PASS
human_messenger_outbound_text=PASS
human_messenger_e2ee=PASS
agent_cannot_access_human_messenger=PASS
```

Record other supported feature markers or an explicit upstream limitation.

### Task 11: Operator pairs and validates the Agent Messenger account

**Files:** No repository changes.

- [ ] **Step 1: Confirm Human remains connected**

Require `human_messenger_session_preserved=PASS` from a harmless new Human
round trip immediately before Agent login.

- [ ] **Step 2: Give the Agent operator action**

Ask the user to sign into Element as `@agent:communicator.0000.gold`, open a
separate encrypted private room with the same bridge bot, and send:

```text
login messenger-lite
```

Apply the same credential and Meta challenge boundary. Do not use the Human
room or credentials.

- [ ] **Step 3: Collect Agent and symmetric-isolation markers**

Require bidirectional Agent text and E2EE. Verify Human cannot discover, join,
or decrypt Agent portals and Agent still cannot access Human portals. Require a
non-admin bridge administration/relay command to be rejected. Platform Admin
must not be a portal member.

Collect only the named markers in the validation runbook.

### Task 12: Prove restart persistence and post-pairing recovery

**Files:** No repository changes unless a test-backed correction is required.

- [ ] **Step 1: Perform one controlled restart**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
cd /opt/communicator/current
sudo -n docker compose --env-file deploy/images.lock.env restart synapse whatsapp messenger
for service in synapse whatsapp messenger; do
  container_id=$(sudo -n docker compose --env-file deploy/images.lock.env ps -q "$service")
  for attempt in $(seq 1 36); do
    state=$(sudo -n docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
    [[ "$state" == healthy ]] && break
    [[ "$attempt" -lt 36 ]] || exit 1
    sleep 5
  done
done
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-messenger.sh
REMOTE
```

- [ ] **Step 2: Obtain session-persistence markers**

Ask the user to confirm both Messenger identities can read a pre-restart
encrypted message and complete a harmless new round trip. Also confirm both
WhatsApp sessions remain working. Require:

```text
both_messenger_sessions_restart_persistence=PASS
whatsapp_sessions_preserved=PASS
```

- [ ] **Step 3: Take the post-pairing encrypted backup**

Run `backup-core.sh` through the protected root-only restic environment as in
Task 9. Require `backup=PASS`, `restic check` success, and record only the short
snapshot ID.

- [ ] **Step 4: Run the isolated restore**

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

Require Synapse, WhatsApp, and Messenger database/config markers plus
`restore_test=PASS`. Confirm no `communicator-restore-test-*` container remains
and production validators still pass. Preserve the timestamped evidence
directory; deletion requires separate approval.

Record only these recovery acceptance markers:

```text
post_messenger_pairing_backup=PASS
post_messenger_pairing_restore_test=PASS
```

### Task 13: Final verification, PR, and handoff

**Files:** No new files unless correcting a verified defect.

- [ ] **Step 1: Run final local verification from the pushed branch**

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m py_compile scripts/*.py
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Require zero failures and no uncommitted work.

- [ ] **Step 2: Re-run remote production validators**

Require exact host/IP, active `RELEASE_COMMIT` equal to local HEAD, core,
WhatsApp, Messenger, and public HTTPS checks passing. Do not inspect messages,
sessions, credentials, or logs.

- [ ] **Step 3: Push final commits and create the PR**

```bash
git push origin codex/messenger-bridge
gh pr create --repo 0000-chat/communicator \
  --base main \
  --head codex/messenger-bridge \
  --title "Add isolated Human and Agent Messenger bridge" \
  --body-file - <<'EOF'
## Summary
- add a pinned private mautrix-meta service for separate Human and Agent Messenger logins
- enforce encrypted non-federated split portals, exact permissions, disabled relay/backfill/public APIs, and no public bridge port
- extend guarded deployment, encrypted backup, isolated restore, validation, and operational runbooks

## Verification
- [x] complete repository test suite, Bash syntax, Python compile, diff, and secret scans pass
- [x] Human and Agent bidirectional text, E2EE, and symmetric isolation pass
- [x] both Messenger sessions and both WhatsApp sessions persist across restart
- [x] post-pairing encrypted backup and isolated restore pass

## Boundaries
- no upstream Synapse, Element, or mautrix source was modified
- no Messenger history backfill, public media, relay, federation, Cloudflare data plane, or Telegram work is included
EOF
```

- [ ] **Step 4: Report completion evidence**

Report the PR URL, exact release commit, short restic snapshot ID, preserved
restore evidence path, test count, and only the named acceptance markers. Do
not merge the PR unless the user explicitly requests it.

## Failure and escalation rules

At any failed test or unexpected runtime behavior, use systematic debugging:
reproduce, identify the failing layer, inspect only safe status/health metadata,
write a focused failing test, implement the minimal fix, rerun focused and full
tests, commit, package a new exact release, and redeploy once. Never repeatedly
restart or re-login hoping the problem clears.

The following require the user:

- entering Human or Agent Messenger credentials;
- resolving Meta captcha, 2FA, WebAuthn, password reset, or account verification;
- choosing to use browser-cookie fallback authentication;
- logout or unlink;
- database/session reset;
- deletion of restore evidence;
- break-glass encrypted-room access; and
- accepting a documented upstream feature limitation.

Everything else that is reversible and inside this plan is delegated to the
implementer.

## Plan self-review checklist

- Spec coverage: topology, dual logins, strict split portals, permissions,
  E2EE, federation, media, backfill, login challenges, recovery, rollback, and
  acceptance each map to explicit tasks.
- Source boundary: no task modifies upstream code or runs a restored session.
- Secret boundary: no command prints configs, credentials, tokens, sessions,
  contacts, or messages.
- Recovery: pre-change and post-pairing backups are required; the isolated
  restore has separate DBs/runtime and no Messenger network process.
- Existing system: every remote gate retains core and WhatsApp validation.
- Destructive behavior: logout, unlink, reset, evidence deletion, and
  break-glass access are operator-only.
- Scope: Telegram and Cloudflare code are excluded.
