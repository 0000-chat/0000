# Agent WhatsApp Shared-Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize the existing Agent Matrix identity as a normal mautrix user, pair the second self-owned WhatsApp account, prove symmetric Human/Agent isolation, and produce a verified encrypted recovery point.

**Architecture:** Keep the existing Synapse, PostgreSQL, Caddy, and single multi-user mautrix-whatsapp service. Add the Agent to the exact fail-closed bridge permission policy, validate that policy without printing the secret-bearing configuration, then deploy through the immutable release procedure. Pairing remains an interactive operator action; restored WhatsApp sessions are validated only with networking disabled and are never started.

**Tech Stack:** Python 3 standard library, Bash, Docker Compose, Synapse, PostgreSQL 16, mautrix-whatsapp v26.08, restic, Cloudflare R2, `unittest`.

---

## Execution boundaries

- Work only in `/home/ubuntu/communicator/.worktrees/implement-matrix-core` on `feat/matrix-core`.
- Never print or inspect message content, contacts, QR payloads, access tokens, appservice tokens, database passwords, WhatsApp session rows, or encryption keys.
- Every host-affecting command must first verify hostname `vmi3501337` and IPv4 `169.58.160.23` on `eth0`.
- Do not enable relay mode, history sync, backfill, provisioning, public media, direct media, public Matrix registration, or federation.
- Do not create another bridge container, PostgreSQL database, appservice registration, or Synapse deployment.
- Stop at Task 4 for the operator to pair the physical Agent WhatsApp account.
- Never unlink or log out either WhatsApp account automatically.

## File map

- Modify `scripts/render-whatsapp-config.py`: render the exact approved Human, Agent, and Platform Admin role map.
- Create `scripts/validate_whatsapp_policy.py`: validate only non-secret policy fields from a rendered bridge config and emit one safe marker.
- Create `tests/test_whatsapp_policy.py`: exercise valid and fail-closed permission/relay policies.
- Modify `tests/test_render_whatsapp_config.py`: prove the renderer includes the exact approved map.
- Modify `scripts/validate-whatsapp.sh`: validate the live config through the policy validator.
- Modify `tests/test_validate_whatsapp.py`: prove live validation invokes the policy check without unsafe diagnostics.
- Modify `docs/runbooks/mautrix-whatsapp-validation.md`: record Agent pairing and symmetric-isolation acceptance markers.

### Task 1: Render and validate the exact shared-bridge policy

**Files:**
- Create: `scripts/validate_whatsapp_policy.py`
- Create: `tests/test_whatsapp_policy.py`
- Modify: `scripts/render-whatsapp-config.py`
- Modify: `tests/test_render_whatsapp_config.py`

- [ ] **Step 1: Write the failing policy tests**

Create `tests/test_whatsapp_policy.py`:

```python
import pathlib
import tempfile
import unittest

from scripts import validate_whatsapp_policy


VALID_CONFIG = '''bridge:
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin

relay:
  enabled: false
  admin_only: true
  default_relays: []
'''


class WhatsAppPolicyTests(unittest.TestCase):
    def validate(self, content: str) -> bool:
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.yaml"
            config.write_text(content)
            return validate_whatsapp_policy.validate(config)

    def test_accepts_exact_approved_policy(self):
        self.assertTrue(self.validate(VALID_CONFIG))

    def test_rejects_missing_agent(self):
        self.assertFalse(
            self.validate(
                VALID_CONFIG.replace(
                    '    "@agent:communicator.0000.gold": user\n', ""
                )
            )
        )

    def test_rejects_agent_admin(self):
        self.assertFalse(
            self.validate(
                VALID_CONFIG.replace(
                    '"@agent:communicator.0000.gold": user',
                    '"@agent:communicator.0000.gold": admin',
                )
            )
        )

    def test_rejects_unexpected_explicit_identity(self):
        self.assertFalse(
            self.validate(
                VALID_CONFIG.replace(
                    "\n\nrelay:",
                    '\n    "@unexpected:communicator.0000.gold": user\n\nrelay:',
                )
            )
        )

    def test_rejects_enabled_relay(self):
        self.assertFalse(
            self.validate(VALID_CONFIG.replace("enabled: false", "enabled: true"))
        )


if __name__ == "__main__":
    unittest.main()
```

In `tests/test_render_whatsapp_config.py`, immediately after the existing Human assertion, add:

```python
            self.assertIn('"@agent:communicator.0000.gold": user', rendered)
            permission_block = rendered.split("  permissions:\n", 1)[1].split("\n\nrelay:", 1)[0]
            self.assertEqual(
                '''    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin''',
                permission_block,
            )
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
python3 -m unittest tests/test_whatsapp_policy.py tests/test_render_whatsapp_config.py -v
```

Expected: FAIL because `scripts.validate_whatsapp_policy` does not exist and the renderer does not include the Agent.

- [ ] **Step 3: Add the minimal policy validator**

Create executable `scripts/validate_whatsapp_policy.py`:

```python
#!/usr/bin/env python3
import argparse
import json
import pathlib
import re
import sys


EXPECTED_PERMISSIONS = {
    "*": "relay",
    "@human:communicator.0000.gold": "user",
    "@agent:communicator.0000.gold": "user",
    "@platform-admin:communicator.0000.gold": "admin",
}
EXPECTED_RELAY = {
    "enabled": "false",
    "admin_only": "true",
    "default_relays": "[]",
}


def indented_block(lines: list[str], header: str, child_indent: int) -> list[str] | None:
    matches = [index for index, line in enumerate(lines) if line == header]
    if len(matches) != 1:
        return None
    block: list[str] = []
    for line in lines[matches[0] + 1 :]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent < child_indent:
            break
        block.append(line)
    return block


def parse_permissions(lines: list[str]) -> dict[str, str] | None:
    block = indented_block(lines, "  permissions:", 4)
    if block is None:
        return None
    parsed: dict[str, str] = {}
    pattern = re.compile(r'^    ("(?:[^"\\]|\\.)*"):\s+(relay|user|admin)$')
    for line in block:
        match = pattern.fullmatch(line)
        if not match:
            return None
        key = json.loads(match.group(1))
        if key in parsed:
            return None
        parsed[key] = match.group(2)
    return parsed


def parse_relay(lines: list[str]) -> dict[str, str] | None:
    block = indented_block(lines, "relay:", 2)
    if block is None:
        return None
    parsed: dict[str, str] = {}
    pattern = re.compile(r"^  ([a-z_]+):\s+(.+)$")
    for line in block:
        match = pattern.fullmatch(line)
        if not match or match.group(1) in parsed:
            return None
        parsed[match.group(1)] = match.group(2)
    return parsed


def validate(path: pathlib.Path) -> bool:
    if not path.is_file():
        return False
    lines = path.read_text().splitlines()
    bridge = indented_block(lines, "bridge:", 2)
    if bridge is None:
        return False
    return (
        parse_permissions(bridge) == EXPECTED_PERMISSIONS
        and parse_relay(lines) == EXPECTED_RELAY
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=pathlib.Path)
    args = parser.parse_args()
    if not validate(args.config):
        print("WhatsApp policy validation failed", file=sys.stderr)
        return 1
    print("whatsapp_permissions=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Run:

```bash
chmod 0755 scripts/validate_whatsapp_policy.py
```

- [ ] **Step 4: Add the Agent as a normal bridge user**

In `scripts/render-whatsapp-config.py`, make the permission block exactly:

```yaml
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin
```

Do not change any other bridge setting.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
python3 -m unittest tests/test_whatsapp_policy.py tests/test_render_whatsapp_config.py -v
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
git diff --check
```

Expected: all tests pass, Bash syntax passes, and the diff check is empty.

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/render-whatsapp-config.py scripts/validate_whatsapp_policy.py tests/test_render_whatsapp_config.py tests/test_whatsapp_policy.py
git commit -m "feat: authorize Agent WhatsApp identity"
```

### Task 2: Enforce the policy in live validation and document acceptance

**Files:**
- Modify: `scripts/validate-whatsapp.sh`
- Modify: `tests/test_validate_whatsapp.py`
- Modify: `docs/runbooks/mautrix-whatsapp-validation.md`

- [ ] **Step 1: Write the failing live-validator test**

Add this method to `WhatsAppValidationTests` in `tests/test_validate_whatsapp.py`:

```python
    def test_live_validator_checks_exact_permission_policy(self):
        self.assertIn('config="$runtime_dir/whatsapp/config.yaml"', self.validator)
        self.assertIn('[[ "$(stat -c \'%a\' "$config")" == 600 ]]', self.validator)
        self.assertIn('python3 scripts/validate_whatsapp_policy.py "$config"', self.validator)
        self.assertNotIn('echo "whatsapp_permissions=PASS"', self.validator)
```

- [ ] **Step 2: Run the test and verify RED**

```bash
python3 -m unittest tests/test_validate_whatsapp.py -v
```

Expected: FAIL because the live validator does not yet inspect the rendered policy.

- [ ] **Step 3: Invoke the policy validator safely**

In `scripts/validate-whatsapp.sh`, immediately after the existing registration ownership checks, add:

```bash
config="$runtime_dir/whatsapp/config.yaml"
[[ -f "$config" ]]
[[ "$(stat -c '%a' "$config")" == 600 ]]
python3 scripts/validate_whatsapp_policy.py "$config"
```

Remove the existing unconditional line:

```bash
echo "whatsapp_permissions=PASS"
```

The Python validator becomes the only source of that safe marker. It must never print configuration fields or values.

- [ ] **Step 4: Update the validation runbook**

In `docs/runbooks/mautrix-whatsapp-validation.md`:

- rename `## Human-only acceptance` to `## Human and Agent acceptance`;
- preserve all existing Human markers;
- add these operator markers exactly:

  ```text
  human_session_preserved=PASS
  agent_pairing=PASS
  agent_inbound_text=PASS
  agent_outbound_text=PASS
  agent_e2ee=PASS
  human_cannot_access_agent=PASS
  agent_cannot_access_human=PASS
  non_admin_commands_rejected=PASS
  both_sessions_restart_persistence=PASS
  post_pairing_backup=PASS
  post_pairing_restore_test=PASS
  ```

- state that the Agent QR is shown only in its encrypted bot chat;
- state that the Human and Agent isolation check is symmetric;
- state that `!wa set-relay` in either account's portal must be rejected and relay must remain disabled; and
- retain the prohibition against printing QR, session, contact, or message data.

- [ ] **Step 5: Run complete verification and scan for secret values**

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n scripts/*.sh
git diff --check
if rg -n --hidden --glob '!*.pyc' '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AWS_SECRET_ACCESS_KEY=[A-Za-z0-9+/._~=-]{8,}|RESTIC_PASSWORD=[A-Za-z0-9+/._~=-]{8,}|WHATSAPP_DB_PASSWORD=[A-Za-z0-9+/._~=-]{8,}|as_token:[[:space:]]+[A-Za-z0-9+/=_-]{20,}|hs_token:[[:space:]]+[A-Za-z0-9+/=_-]{20,})' scripts tests docs; then
  exit 1
else
  echo secret_value_scan=PASS
fi
```

Expected: all tests pass and `secret_value_scan=PASS`.

- [ ] **Step 6: Commit Task 2 and push the branch**

```bash
git add scripts/validate-whatsapp.sh tests/test_validate_whatsapp.py docs/runbooks/mautrix-whatsapp-validation.md
git commit -m "docs: add Agent WhatsApp acceptance gate"
git push origin feat/matrix-core
```

### Task 3: Package, deploy, and validate the permission release

**Files:** No new source changes.

- [ ] **Step 1: Verify a clean exact commit locally**

```bash
test -z "$(git status --short)"
release_commit=$(git rev-parse HEAD)
printf '%s\n' "$release_commit" | grep -Eq '^[0-9a-f]{40,64}$'
```

- [ ] **Step 2: Build and transfer only the Git archive**

```bash
archive=$(mktemp "/tmp/communicator-${release_commit}.XXXXXX.tar.gz")
git archive --format=tar.gz --output="$archive" HEAD
checksum=$(sha256sum "$archive" | awk '{print $1}')
remote_dir=$(ssh -o BatchMode=yes contabo-eu 'set -eu; test "$(hostname)" = vmi3501337; ip -4 -o addr show dev eth0 | grep -q "169.58.160.23/"; umask 077; mktemp -d /tmp/communicator-release.XXXXXX')
case "$remote_dir" in /tmp/communicator-release.*) ;; *) exit 1 ;; esac
scp -q "$archive" "contabo-eu:${remote_dir}/release.tar.gz"
```

- [ ] **Step 3: Verify, extract, preserve rollback evidence, and activate**

```bash
ssh -o BatchMode=yes contabo-eu bash -s -- "$release_commit" "$checksum" "$remote_dir" <<'REMOTE'
set -euo pipefail
release_commit=$1
checksum=$2
remote_dir=$3
printf '%s\n' "$release_commit" | grep -Eq '^[0-9a-f]{40,64}$'
printf '%s\n' "$checksum" | grep -Eq '^[0-9a-f]{64}$'
case "$remote_dir" in /tmp/communicator-release.*) ;; *) exit 1 ;; esac
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
test "$(stat -c '%U:%G:%a' "$remote_dir")" = admin:admin:700
printf '%s  %s\n' "$checksum" "$remote_dir/release.tar.gz" | sha256sum -c -
sudo -n install -d -o root -g root -m 0755 /opt/communicator/releases
sudo -n test ! -e "/opt/communicator/releases/$release_commit"
sudo -n install -d -o root -g root -m 0755 "/opt/communicator/releases/$release_commit"
sudo -n tar -xzf "$remote_dir/release.tar.gz" -C "/opt/communicator/releases/$release_commit"
printf '%s\n' "$release_commit" | sudo -n install -o root -g root -m 0644 /dev/stdin "/opt/communicator/releases/$release_commit/RELEASE_COMMIT"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
sudo -n install -o root -g root -m 0600 /srv/communicator/synapse/homeserver.yaml "/srv/communicator/synapse/homeserver.yaml.pre-${release_commit}-${timestamp}"
sudo -n ln -sfn "/opt/communicator/releases/$release_commit" /opt/communicator/current
cd /opt/communicator/current
test "$(cat RELEASE_COMMIT)" = "$release_commit"
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh
REMOTE
```

- [ ] **Step 4: Remove only the validated temporary transfer files**

```bash
unlink -- "$archive"
ssh -o BatchMode=yes contabo-eu "test \"\$(hostname)\" = vmi3501337 && sudo -n rm -rf -- '$remote_dir'"
```

- [ ] **Step 5: Run production validators**

```bash
ssh -o BatchMode=yes contabo-eu 'set -eu; test "$(hostname)" = vmi3501337; ip -4 -o addr show dev eth0 | grep -q "169.58.160.23/"; cd /opt/communicator/current; sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh; sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh'
```

Expected safe markers include `whatsapp_permissions=PASS`, `whatsapp_history_sync=DISABLED`, `whatsapp_provisioning=DISABLED`, and `core_validation=PASS`.

### Task 4: Pair and validate the Agent WhatsApp account

**Files:** No source changes. This is an operator checkpoint.

- [ ] **Step 1: Confirm the Human session survived the permission deployment**

In Element as `@human:communicator.0000.gold`, open the existing encrypted WhatsApp portal, read a pre-deployment message, and exchange one harmless new text with the second self-owned account. Record only:

```text
human_session_preserved=PASS
```

- [ ] **Step 2: Pair the Agent interactively**

In a separate Element session signed in as `@agent:communicator.0000.gold`:

1. Open an encrypted private chat with `@whatsappbot:communicator.0000.gold`.
2. Send `login qr`.
3. On the physical phone for the second self-owned WhatsApp account, open **Linked devices**, choose **Link a device**, and scan the QR.
4. Wait for the bot's authenticated response.
5. Do not copy the QR, pairing payload, or session data into Codex or operator logs.

Record only:

```text
agent_pairing=PASS
```

- [ ] **Step 3: Validate Agent text and encryption**

Send one harmless text from the Human WhatsApp account to the Agent WhatsApp account. Confirm it appears in an encrypted Agent portal room. Reply from the Agent Element room and confirm it reaches the Human WhatsApp account. Record only:

```text
agent_inbound_text=PASS
agent_outbound_text=PASS
agent_e2ee=PASS
```

- [ ] **Step 4: Validate symmetric Matrix isolation**

Without inviting either Matrix identity into the other's portal:

1. Confirm the Human Matrix account cannot discover, join, or read the Agent portal room.
2. Confirm the Agent Matrix account still cannot discover, join, or read the Human portal room.

Record only:

```text
human_cannot_access_agent=PASS
agent_cannot_access_human=PASS
```

- [ ] **Step 5: Validate non-admin behavior without destructive commands**

In one Agent portal and one Human portal, send the bridge command:

```text
!wa set-relay
```

Require a rejection and confirm the live validator still emits `whatsapp_permissions=PASS`. Do not test logout, unlink, portal deletion, or any command that can destroy session or room state. Record only:

```text
non_admin_commands_rejected=PASS
```

### Task 5: Prove restart persistence and post-pairing recovery

**Files:** No new source changes unless a reproducible defect is found. Any defect requires systematic debugging and a failing regression test before a fix.

- [ ] **Step 1: Restart Synapse and WhatsApp through the verified release**

```bash
ssh -o BatchMode=yes contabo-eu 'bash -s' <<'REMOTE'
set -euo pipefail
test "$(hostname)" = vmi3501337
ip -4 -o addr show dev eth0 | grep -q '169.58.160.23/'
cd /opt/communicator/current
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator docker compose --env-file deploy/images.lock.env restart synapse whatsapp
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 synapse whatsapp
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh
sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh
REMOTE
```

- [ ] **Step 2: Obtain the two-session user-visible persistence marker**

Reopen Element as both Human and Agent. For each identity, confirm a pre-restart portal message remains decryptable and exchange one harmless new text through its own WhatsApp session. Record only:

```text
both_sessions_restart_persistence=PASS
```

- [ ] **Step 3: Create and integrity-check the encrypted R2 backup**

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
'
REMOTE
```

Require `backup=PASS` and `restic check` with no errors. Record only:

```text
post_pairing_backup=PASS
```

- [ ] **Step 4: Run the isolated restore test**

Before execution, require the active restore script to retain the offline guard:

```bash
ssh -o BatchMode=yes contabo-eu 'grep -Fq -- "docker run --rm --network none" /opt/communicator/current/scripts/restore-core-test.sh'
```

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

Require `whatsapp_restore_tables=PASS`, `whatsapp_config=PASS`, and `restore_test=PASS`. Confirm no `communicator-restore-test-*` container remains. The restored WhatsApp service must never start. Record only:

```text
post_pairing_restore_test=PASS
```

- [ ] **Step 5: Final verification and handoff**

Run:

```bash
test -z "$(git status --short)"
python3 -m unittest discover -s tests -p 'test_*.py' -v
ssh -o BatchMode=yes contabo-eu 'set -eu; test "$(hostname)" = vmi3501337; ip -4 -o addr show dev eth0 | grep -q "169.58.160.23/"; cd /opt/communicator/current; sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-whatsapp.sh; sudo -n env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh'
```

Report the exact release commit, test count, safe validation markers, backup snapshot short ID, isolated restore path, all operator acceptance markers, and the known deferred read-receipt behavior. Do not include secrets, QR data, room IDs, phone numbers, contacts, or message content.
