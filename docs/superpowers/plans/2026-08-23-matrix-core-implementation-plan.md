# Communicator Matrix Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the dedicated `contabo-eu` VPS and deploy a private, encrypted Synapse core with PostgreSQL, Caddy, validation, backup, and clean-restore evidence.

**Architecture:** Git development and tests run in the local implementation worktree. An exact committed release is transferred to `contabo-eu`, where a pinned Docker Compose project exposes only Caddy on ports 80 and 443. Runtime data and secrets live only under `/srv/communicator` on the VPS, outside Git.

**Tech Stack:** Ubuntu 24.04 LTS, Docker Engine with Compose v2, Caddy 2.11.4, Synapse 1.159.0, PostgreSQL 16.15, Python 3 standard library tests, Bash, restic.

---

## Simple explanation

This plan does not build any Cloudflare data-plane components or install any bridges. It first verifies the freshly reinstalled `contabo-eu` host, then installs the Matrix core. Work stops if the operating system, disk, DNS, ports, secrets, backup target, or restore test is not ready.

The deployment host runs supported Ubuntu 24.04 LTS with 6 vCPU, 12 GB RAM, and a 200 GB SSD. The local OVH machine is development-only.

## Scope boundary

This plan implements only prototype Stage 0 and Stage 1:

- Supported-host gate.
- Disk, memory, swap, port, Docker, and DNS checks.
- Runtime-directory and secret initialization.
- Immutable container image pins.
- Caddy, Synapse, and PostgreSQL deployment.
- Private registration and federation policy.
- Human, agent, and administrator Matrix accounts.
- Encrypted-room and identity-isolation validation.
- Encrypted off-server backup and clean restoration.

This plan does not implement:

- Telegram, WhatsApp, or Messenger bridges.
- Message-history backfill.
- An AI-agent runtime.
- The Matrix event consumer.
- Queues, Durable Objects, Workers, R2, or any other Cloudflare data-plane component.

## Execution contract for GPT-5.6 Luna at xhigh effort

This plan is intentionally executable by an agent that has no prior project context. The executor must follow these rules exactly.

### Required reading and workspace

1. Read `docs/PROPOSAL.md` first.
2. Read `docs/superpowers/specs/2026-08-23-communicator-prototype-design.md` second.
3. Read this section and only the current task before starting that task. Do not load or start subsequent tasks early.
4. Work in an isolated Git worktree on a branch other than `main`. The implementation branch must start from `origin/plan/matrix-core`.
5. Run every command from the worktree root unless the step gives a different directory.
6. Before changing a file, run `git status --short`. Stop and ask the user if it shows changes that the current task did not create.
7. Treat the code blocks in this plan as exact content. Copy them without redesigning, shortening, upgrading, or refactoring them.
8. Do not replace image versions or digests. A version change requires a separate plan update supported by current official documentation.
9. Commands without `ssh contabo-eu` are local repository commands. Never interpret a local `sudo`, Docker daemon, public IP, port, `/srv/communicator`, or service result as evidence about the VPS.
10. Host-affecting commands must start with `ssh contabo-eu` and must verify the remote hostname/IP before using `/srv/communicator` or Docker.
11. Transfer only files from a clean committed release. Never transfer `.git`, `.env`, ignored files, runtime data, backups, or secrets.

Use this one-time setup from `/home/ubuntu/communicator`:

```bash
git fetch origin
if [[ -d .worktrees/implement-matrix-core ]]; then
  cd .worktrees/implement-matrix-core
  test "$(git branch --show-current)" = "feat/matrix-core"
else
  git worktree add .worktrees/implement-matrix-core -b feat/matrix-core origin/plan/matrix-core
  cd .worktrees/implement-matrix-core
fi
git status --short --branch
```

Expected: the branch is `feat/matrix-core`, it is based on `origin/plan/matrix-core`, and the worktree has no uncommitted files. If the branch exists but is not attached to this worktree, stop and ask the primary agent to inspect it; do not delete or recreate it.

### One-task execution loop

For each task, use this exact loop:

1. Put only that task into the active session plan.
2. Confirm that every dependency in the gate table below is complete.
3. Perform one checkbox step at a time and in the listed order.
4. After a file-creation step, confirm that each named file exists and is not empty. Do not claim the step passed because the write command returned successfully.
5. After a test step, run the exact command and compare the result with the stated `Expected:` result.
6. If an expected failure unexpectedly passes, stop. The test is not proving the intended behavior.
7. If an expected pass fails, preserve the non-secret error output and use `superpowers:systematic-debugging`. Do not make speculative edits.
8. After a commit step, run `git status --short` and `git show --stat --oneline --decorate HEAD`. Expected: the worktree is clean and the commit contains only the current task's files.
9. Stop after the task. Report the commit hash, changed files, checks run, exact pass or fail result, and the next gate. Do not begin the next task in the same subagent turn.

The Markdown checkboxes identify steps. Do not edit this plan merely to mark a checkbox. Track completion in the active session plan and in the final task report so implementation commits contain only implementation artifacts.

### Step completion rules

| Step type | Required evidence before it is complete |
|---|---|
| Create or modify a file | The named path exists, is non-empty, and matches the complete code block in this plan. |
| Expected-failure test | The command exits non-zero for the stated reason, not because of an import, syntax, permission, or environment mistake unless that is the stated reason. |
| Expected-pass test | The command exits `0` and its output matches the stated result. |
| Commit | The commit succeeds, the worktree is clean, and the commit contains only the files listed for that task. |
| Manual validation | The user or operator reports the observed result. The agent must not infer a pass. |
| External-state validation | Fresh evidence confirms DNS, TLS, service health, backup, or restore state. Cached or planned state is not evidence. |

### Dependency and authority gates

| Task | May start when | Mandatory stop or approval |
|---|---|---|
| 1 | The isolated implementation worktree is clean. | None; this task is repository-only and read-only host inspection. |
| 2 | Task 1 is committed. | Continue only after the remote preflight reports no failure except the explicitly pending DNS records. Require a completed provider snapshot before first deployment. |
| 3 | Task 2's remote host prerequisites are verified. | This task is repository-only. Do not initialize `/srv/communicator` locally. |
| 4 | Task 3 is committed. | No substitutions for the pinned image references. |
| 5 | Task 4 is committed and its repository-contract tests pass. | Do not expose Synapse or PostgreSQL directly on a host port. |
| 6 | Task 5 is committed and a fresh remote preflight is clean. | Deployment approval is valid only for the shown Git commit, `contabo-eu` host key, release checksum, and DNS evidence. All deployment commands run remotely. |
| 7 | All three remote core services are healthy. | Manual E2EE checks and break-glass checks require the user's observed results. Never print passwords, access tokens, or recovery keys. |
| 8 | Task 7 is complete. | The user must provide or confirm the off-server restic destination and remote password-file path. Backup and restore commands run on `contabo-eu`. |
| 9 | Backup and isolated restoration both pass. | The 24-hour soak uses elapsed real time. Do not simulate it or mark it complete early. |

### Required subagent prompt

When `superpowers:subagent-driven-development` dispatches a fresh Luna worker, use this prompt and replace only `<N>`:

```text
Implement only Task <N> from docs/superpowers/plans/2026-08-23-matrix-core-implementation-plan.md.
Use GPT-5.6 Luna with xhigh effort. First read docs/PROPOSAL.md, the approved prototype design, and the plan's "Execution contract for GPT-5.6 Luna at xhigh effort" section. Then read Task <N> only.
Follow every step in order. Copy specified file content exactly. Run every stated check. Do not start another task. Do not perform a manual or external action without the approval required by the gate table.
Return only: outcome; files changed; verification commands and results; commit hash; blockers or next gate. Never include secret values.
```

## File map

Create these files:

```text
.env.example                                  Safe operator inputs
compose.yaml                                  Core service topology
deploy/images.lock.env                        Immutable image references
deploy/caddy/Caddyfile                        TLS, discovery, and client-only proxy
deploy/synapse/homeserver.yaml.template       Synapse configuration template
deploy/synapse/log.config                     Redacted structured logging
scripts/preflight.py                          Read-only host readiness gate
scripts/init-runtime.sh                       Runtime directories and secret creation
scripts/render-synapse-config.py              Strict template renderer
scripts/deploy-core.sh                        Idempotent core deployment
scripts/create-matrix-user.sh                 Controlled local-user creation
scripts/validate-core.sh                      Automated public-boundary checks
scripts/backup-core.sh                        Consistent restic backup
scripts/restore-core-test.sh                  Restore into an isolated project
tests/test_preflight.py                       Host-check unit tests
tests/test_runtime_init.py                    Runtime-init tests
tests/test_render_synapse_config.py           Renderer tests
tests/test_repository_contract.py             Compose/config/security tests
docs/runbooks/host-readiness.md               Manual OS and host gate
docs/runbooks/matrix-core-operations.md        Deploy and account procedures
docs/runbooks/matrix-core-validation.md        Client and E2EE acceptance checks
docs/runbooks/break-glass.md                   Temporary plaintext-access procedure
docs/runbooks/matrix-core-recovery.md          Backup and clean-restore procedure
```

No implementation file may write secrets into the repository.

### Task 1: Add the supported-host preflight gate

**Status:** Completed in commit `b29037a`. Task 2 replaces its historical DNS implementation with explicit per-domain A and AAAA RRset checks. Do not recreate Task 1 from the historical embedded code block.

**Files:**
- Create: `tests/test_preflight.py`
- Create: `scripts/preflight.py`

- [ ] **Step 1: Write the failing preflight tests**

Create `tests/test_preflight.py`:

```python
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import preflight


class PreflightTests(unittest.TestCase):
    def test_supported_lts_is_accepted(self):
        self.assertTrue(preflight.is_supported_ubuntu("26.04"))
        self.assertTrue(preflight.is_supported_ubuntu("24.04"))

    def test_eol_interim_release_is_rejected(self):
        self.assertFalse(preflight.is_supported_ubuntu("25.10"))

    def test_disk_threshold_is_fifty_gib(self):
        self.assertTrue(preflight.has_required_disk(50 * 1024**3))
        self.assertFalse(preflight.has_required_disk(50 * 1024**3 - 1))

    def test_report_fails_when_required_port_is_bound(self):
        facts = preflight.HostFacts(
            ubuntu_version="26.04",
            free_disk_bytes=80 * 1024**3,
            available_memory_bytes=20 * 1024**3,
            swap_in_delta=0,
            swap_out_delta=0,
            bound_ports=frozenset({443}),
            docker_compose=True,
            dns_addresses=frozenset({"203.0.113.10"}),
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertIn("ports 80 and 443 must be free", report.failures)

    def test_healthy_report_passes(self):
        facts = preflight.HostFacts(
            ubuntu_version="26.04",
            free_disk_bytes=80 * 1024**3,
            available_memory_bytes=20 * 1024**3,
            swap_in_delta=0,
            swap_out_delta=0,
            bound_ports=frozenset(),
            docker_compose=True,
            dns_addresses=frozenset({"203.0.113.10"}),
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertEqual((), report.failures)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
python3 -m unittest tests/test_preflight.py -v
```

Expected: `ERROR` because `scripts/preflight.py` does not exist.

- [ ] **Step 3: Implement the preflight checker**

Create executable `scripts/preflight.py` with:

```python
#!/usr/bin/env python3
import argparse
import dataclasses
import json
import pathlib
import shutil
import socket
import subprocess
import time


GIB = 1024**3
SUPPORTED_UBUNTU = frozenset({"24.04", "26.04"})
DOMAINS = ("communicator.0000.gold", "matrix.communicator.0000.gold")


@dataclasses.dataclass(frozen=True)
class HostFacts:
    ubuntu_version: str
    free_disk_bytes: int
    available_memory_bytes: int
    swap_in_delta: int
    swap_out_delta: int
    bound_ports: frozenset[int]
    docker_compose: bool
    dns_addresses: frozenset[str]


@dataclasses.dataclass(frozen=True)
class Report:
    failures: tuple[str, ...]
    facts: HostFacts


def is_supported_ubuntu(version: str) -> bool:
    return version in SUPPORTED_UBUNTU


def has_required_disk(free_bytes: int) -> bool:
    return free_bytes >= 50 * GIB


def parse_os_release(path: pathlib.Path = pathlib.Path("/etc/os-release")) -> str:
    values = {}
    for line in path.read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip().strip('"')
    if values.get("ID") != "ubuntu":
        return "unsupported"
    return values.get("VERSION_ID", "unknown")


def memory_available() -> int:
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    return 0


def swap_counters() -> tuple[int, int]:
    values = {}
    for line in pathlib.Path("/proc/vmstat").read_text().splitlines():
        key, value = line.split()
        if key in {"pswpin", "pswpout"}:
            values[key] = int(value)
    return values.get("pswpin", 0), values.get("pswpout", 0)


def swap_delta(seconds: float = 2.0) -> tuple[int, int]:
    before = swap_counters()
    time.sleep(seconds)
    after = swap_counters()
    return after[0] - before[0], after[1] - before[1]


def listening_ports() -> frozenset[int]:
    result = subprocess.run(
        ["ss", "-H", "-ltn"], check=True, text=True, capture_output=True
    )
    ports = set()
    for line in result.stdout.splitlines():
        local = line.split()[3]
        try:
            ports.add(int(local.rsplit(":", 1)[1]))
        except ValueError:
            continue
    return frozenset(ports)


def has_docker_compose() -> bool:
    return subprocess.run(
        ["docker", "compose", "version"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def resolve_domains() -> frozenset[str]:
    addresses = set()
    for domain in DOMAINS:
        try:
            for item in socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM):
                addresses.add(item[4][0])
        except socket.gaierror:
            continue
    return frozenset(addresses)


def collect() -> HostFacts:
    swap_in, swap_out = swap_delta()
    return HostFacts(
        ubuntu_version=parse_os_release(),
        free_disk_bytes=shutil.disk_usage("/").free,
        available_memory_bytes=memory_available(),
        swap_in_delta=swap_in,
        swap_out_delta=swap_out,
        bound_ports=listening_ports(),
        docker_compose=has_docker_compose(),
        dns_addresses=resolve_domains(),
    )


def evaluate(facts: HostFacts, expected_ip: str) -> Report:
    failures = []
    if not is_supported_ubuntu(facts.ubuntu_version):
        failures.append("Ubuntu 24.04 or 26.04 LTS is required")
    if not has_required_disk(facts.free_disk_bytes):
        failures.append("at least 50 GiB free disk is required")
    if facts.available_memory_bytes < 8 * GIB:
        failures.append("at least 8 GiB available memory is required")
    if facts.swap_in_delta or facts.swap_out_delta:
        failures.append("active swap movement must be investigated")
    if {80, 443} & facts.bound_ports:
        failures.append("ports 80 and 443 must be free")
    if not facts.docker_compose:
        failures.append("Docker Compose v2 is required")
    if expected_ip not in facts.dns_addresses:
        failures.append("both Matrix DNS names must resolve to the expected IP")
    return Report(tuple(failures), facts)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-ip", required=True)
    args = parser.parse_args()
    report = evaluate(collect(), args.expected_ip)
    facts = dataclasses.asdict(report.facts)
    facts["bound_ports"] = sorted(report.facts.bound_ports)
    facts["dns_addresses"] = sorted(report.facts.dns_addresses)
    print(json.dumps({"failures": report.failures, "facts": facts}, indent=2, sort_keys=True))
    return 1 if report.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the unit tests**

Run:

```bash
chmod +x scripts/preflight.py
python3 -m unittest tests/test_preflight.py -v
```

Expected after Task 2's DNS amendment: all 12 tests pass with `OK`.

- [ ] **Step 5: Demonstrate the remote host gate fails safely before DNS**

```bash
ssh contabo-eu 'python3 - --expected-ip 169.58.160.23' < scripts/preflight.py
```

Expected before DNS creation: non-zero exit with one failure for each missing Matrix DNS name and no other host failure.

- [ ] **Step 6: Commit the preflight gate**

```bash
git add scripts/preflight.py tests/test_preflight.py
git commit -m "test: add Matrix host preflight gate"
```

### Task 2: Verify and bootstrap the dedicated Contabo host

**Files:**
- Create: `docs/runbooks/host-readiness.md`

- [ ] **Step 1: Replace the obsolete OVH remediation runbook**

Modify the existing `docs/runbooks/host-readiness.md` so it identifies `contabo-eu` as the only deployment host, distinguishes local repository commands from remote host commands, and contains every requirement listed below.

Required facts:

```markdown
# Communicator Host Readiness

## Simple explanation

Develop and test in the local `feat/matrix-core` worktree. Run host checks and deployment only on the dedicated `contabo-eu` VPS. Never run Communicator services on the local OVH development host.

## Technical procedure

1. Verify key-only SSH to `contabo-eu`.
2. Require Ubuntu 24.04 LTS, 6 vCPU, at least 10 GiB RAM, a 200 GB disk, and at least 50 GiB free.
3. Require zero failed systemd units and `eth0` to be `routable (configured)`.
4. Require compressed zram swap, UFW, Docker Engine, Compose v2, Python 3, curl, OpenSSL, and restic.
5. Allow only inbound ports 22, 80, and 443.
6. Require ports 80 and 443 to be free before Caddy is deployed.
7. Require both Matrix names to resolve only to `169.58.160.23`; do not publish AAAA yet.
8. Run the committed preflight remotely through standard input.
9. Require an empty JSON `failures` array.
10. Require a completed provider snapshot and deployment approval tied to the exact commit and host key.
```

- [ ] **Step 2: Review the runbook for destructive ambiguity**

Run:

```bash
rg -n "rm -rf|wipe|delete all|T[B]D|TO[D]O" docs/runbooks/host-readiness.md
```

Expected: no output.

- [ ] **Step 3: Verify the bootstrapped VPS without changing DNS**

```bash
ssh contabo-eu 'set -eu
source /etc/os-release
test "$VERSION_ID" = 24.04
test "$(nproc)" -eq 6
test "$(hostname)" = vmi3501337
ip -4 -brief address show eth0 | grep -q "169.58.160.23/"
test "$(awk "/MemTotal:/ {print \$2 * 1024}" /proc/meminfo)" -ge "$((10 * 1024 * 1024 * 1024))"
root_source=$(findmnt -n -o SOURCE /)
root_parent=$(lsblk -ndo PKNAME "$root_source")
test -n "$root_parent"
test "$(sudo blockdev --getsize64 "/dev/$root_parent")" -ge 190000000000
test "$(df --output=avail -B1 / | tail -1)" -ge "$((50 * 1024 * 1024 * 1024))"
test "$(systemctl --failed --plain --no-legend | wc -l)" -eq 0
systemctl is-active docker zramswap
networkctl status eth0 | grep -q "State: routable (configured)"
curl -4 --max-time 10 -fsS https://cloudflare.com/cdn-cgi/trace >/dev/null
curl -6 --max-time 10 -fsS https://cloudflare.com/cdn-cgi/trace >/dev/null
sudo ufw status verbose | grep -q "Status: active"
sudo ufw status verbose | grep -q "Default: deny (incoming)"
inbound=$(sudo ufw status numbered | grep -E "(ALLOW|LIMIT) IN")
test "$(printf "%s\n" "$inbound" | wc -l)" -eq 6
test "$(printf "%s\n" "$inbound" | grep -Ec "22/tcp.*LIMIT IN")" -eq 2
test "$(printf "%s\n" "$inbound" | grep -Ec "80/tcp.*ALLOW IN")" -eq 2
test "$(printf "%s\n" "$inbound" | grep -Ec "443/tcp.*ALLOW IN")" -eq 2
docker compose version
for tool in python3 curl openssl restic dig; do command -v "$tool" >/dev/null; done
'
```

Expected: exit `0`.

- [ ] **Step 4: Run the current preflight code on the remote host**

```bash
ssh contabo-eu 'python3 - --expected-ip 169.58.160.23' < scripts/preflight.py
```

Expected before DNS creation: exit `1` with exactly two failures, one for each missing Matrix DNS name. Any other failure blocks Task 3.

- [ ] **Step 5: Commit the corrected runbook and per-domain DNS gate**

```bash
git add .gitignore scripts/preflight.py tests/test_preflight.py docs/runbooks/host-readiness.md docs/PROPOSAL.md docs/superpowers/specs/2026-08-23-communicator-prototype-design.md docs/superpowers/plans/2026-08-23-matrix-core-implementation-plan.md
git commit -m "docs: retarget Matrix pilot to Contabo"
```

- [ ] **Step 6: Stop for DNS and provider snapshot evidence**

Require both A records to equal `169.58.160.23`, require both AAAA records to be absent, and require a completed Contabo snapshot identifier. Then rerun Step 4 and require exit `0` with `"failures": []` before first deployment.

### Task 3: Create runtime directories and secrets safely

**Files:**
- Create: `tests/test_runtime_init.py`
- Create: `scripts/init-runtime.sh`
- Create: `.env.example`

- [ ] **Step 1: Write the failing runtime-initialization test**

Create `tests/test_runtime_init.py`:

```python
import os
import pathlib
import stat
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RuntimeInitTests(unittest.TestCase):
    def test_creates_private_secret_files_without_printing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ | {"COMMUNICATOR_RUNTIME_DIR": directory}
            result = subprocess.run(
                [ROOT / "scripts/init-runtime.sh"],
                env=env,
                check=True,
                text=True,
                capture_output=True,
            )
            secret = pathlib.Path(directory) / "secrets/postgres.env"
            self.assertTrue(secret.exists())
            self.assertEqual(0o600, stat.S_IMODE(secret.stat().st_mode))
            self.assertIn("POSTGRES_PASSWORD=", secret.read_text())
            self.assertNotIn(secret.read_text().split("=", 1)[1].strip(), result.stdout)

    def test_second_run_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ | {"COMMUNICATOR_RUNTIME_DIR": directory}
            subprocess.run([ROOT / "scripts/init-runtime.sh"], env=env, check=True)
            secret = pathlib.Path(directory) / "secrets/postgres.env"
            before = secret.read_text()
            subprocess.run([ROOT / "scripts/init-runtime.sh"], env=env, check=True)
            self.assertEqual(before, secret.read_text())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
python3 -m unittest tests/test_runtime_init.py -v
```

Expected: `ERROR` because `scripts/init-runtime.sh` does not exist.

- [ ] **Step 3: Implement idempotent runtime initialization**

Create executable `scripts/init-runtime.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-communicator}
umask 077

install -d -m 0700 \
  "$runtime_dir/secrets" \
  "$runtime_dir/postgres" \
  "$runtime_dir/synapse" \
  "$runtime_dir/caddy/data" \
  "$runtime_dir/caddy/config" \
  "$runtime_dir/backups" \
  "$runtime_dir/restore-tests"

postgres_env="$runtime_dir/secrets/postgres.env"
if [[ ! -e "$postgres_env" ]]; then
  password=$(openssl rand -base64 48 | tr -d '\n')
  printf 'POSTGRES_DB=synapse\nPOSTGRES_USER=synapse\nPOSTGRES_PASSWORD=%s\n' "$password" > "$postgres_env"
  chmod 0600 "$postgres_env"
fi

registration_secret="$runtime_dir/secrets/synapse_registration_shared_secret"
if [[ ! -e "$registration_secret" ]]; then
  openssl rand -hex 48 > "$registration_secret"
  chmod 0600 "$registration_secret"
fi

printf 'runtime initialized at %s\n' "$runtime_dir"
```

Create `.env.example`:

```dotenv
COMMUNICATOR_RUNTIME_DIR=/srv/communicator
COMPOSE_PROJECT_NAME=communicator
```

- [ ] **Step 4: Run the runtime tests**

```bash
chmod +x scripts/init-runtime.sh
python3 -m unittest tests/test_runtime_init.py -v
```

Expected: `Ran 2 tests` and `OK`.

- [ ] **Step 5: Verify Git ignores representative secrets**

```bash
git check-ignore -v .env secrets/example.key data/example.db backups/example.tar
```

Expected: every path is matched by `.gitignore`.

- [ ] **Step 6: Commit runtime initialization**

```bash
git add .env.example scripts/init-runtime.sh tests/test_runtime_init.py
git commit -m "feat: initialize private Communicator runtime"
```

### Task 4: Pin core images and define the Compose topology

**Files:**
- Create: `deploy/images.lock.env`
- Create: `compose.yaml`
- Create: `tests/test_repository_contract.py`

- [ ] **Step 1: Write the failing repository-contract tests**

Create `tests/test_repository_contract.py`:

```python
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RepositoryContractTests(unittest.TestCase):
    def test_every_image_is_digest_pinned(self):
        compose = (ROOT / "compose.yaml").read_text()
        lock = (ROOT / "deploy/images.lock.env").read_text()
        image_variables = re.findall(r"^\s*image:\s*\$\{([A-Z_]+)\}", compose, flags=re.MULTILINE)
        locked_images = dict(
            line.split("=", 1) for line in lock.splitlines() if line and not line.startswith("#")
        )
        self.assertEqual({"POSTGRES_IMAGE", "CADDY_IMAGE", "SYNAPSE_IMAGE"}, set(image_variables))
        self.assertTrue(all("@sha256:" in locked_images[name] for name in image_variables))

    def test_only_caddy_publishes_ports(self):
        compose = (ROOT / "compose.yaml").read_text()
        self.assertEqual(1, compose.count("ports:"))
        self.assertIn('"80:80"', compose)
        self.assertIn('"443:443"', compose)
        self.assertNotIn("5432:5432", compose)
        self.assertNotIn("8008:8008", compose)

    def test_cloudflare_products_are_not_services(self):
        compose = (ROOT / "compose.yaml").read_text().lower()
        for forbidden in ("durable", "r2", "queue", "worker"):
            self.assertNotIn(forbidden, compose)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
python3 -m unittest tests/test_repository_contract.py -v
```

Expected: `ERROR` because `compose.yaml` does not exist.

- [ ] **Step 3: Record immutable image references**

Create `deploy/images.lock.env`:

```dotenv
POSTGRES_IMAGE=postgres:16.15-bookworm@sha256:60f4761b9035e0b8d5218f701a8c3382f641bf12b1604822574cf5be3baeb537
CADDY_IMAGE=caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
SYNAPSE_IMAGE=ghcr.io/element-hq/synapse:v1.159.0@sha256:edf259d2b575b669a3e81024918ab8d5cfb7d2fba5a53c9e09695f1abc5645cb
```

- [ ] **Step 4: Create the core Compose file**

Create `compose.yaml`:

```yaml
name: ${COMPOSE_PROJECT_NAME:-communicator}

services:
  postgres:
    image: ${POSTGRES_IMAGE}
    env_file:
      - ${COMMUNICATOR_RUNTIME_DIR}/secrets/postgres.env
    volumes:
      - ${COMMUNICATOR_RUNTIME_DIR}/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U synapse -d synapse"]
      interval: 10s
      timeout: 5s
      retries: 12
    restart: unless-stopped
    networks: [core]

  synapse:
    image: ${SYNAPSE_IMAGE}
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ${COMMUNICATOR_RUNTIME_DIR}/synapse:/data
    healthcheck:
      test: ["CMD-SHELL", "python -c 'import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:8008/health\", timeout=3)'"]
      interval: 10s
      timeout: 5s
      retries: 18
    restart: unless-stopped
    networks: [core]

  caddy:
    image: ${CADDY_IMAGE}
    depends_on:
      synapse:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ${COMMUNICATOR_RUNTIME_DIR}/caddy/data:/data
      - ${COMMUNICATOR_RUNTIME_DIR}/caddy/config:/config
    restart: unless-stopped
    networks: [core]

networks:
  core:
    driver: bridge
```

- [ ] **Step 5: Run the contract tests**

```bash
python3 -m unittest tests/test_repository_contract.py -v
```

Expected: `Ran 3 tests` and `OK`.

- [ ] **Step 6: Verify image digests still resolve**

```bash
set -a
source deploy/images.lock.env
set +a
docker buildx imagetools inspect "$POSTGRES_IMAGE" >/dev/null
docker buildx imagetools inspect "$CADDY_IMAGE" >/dev/null
docker buildx imagetools inspect "$SYNAPSE_IMAGE" >/dev/null
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit the topology**

```bash
git add compose.yaml deploy/images.lock.env tests/test_repository_contract.py
git commit -m "feat: define pinned Matrix core topology"
```

### Task 5: Render secure Synapse and Caddy configuration

**Files:**
- Create: `deploy/caddy/Caddyfile`
- Create: `deploy/synapse/homeserver.yaml.template`
- Create: `deploy/synapse/log.config`
- Create: `scripts/render-synapse-config.py`
- Create: `tests/test_render_synapse_config.py`

- [ ] **Step 1: Write failing renderer tests**

Create `tests/test_render_synapse_config.py`:

```python
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RenderTests(unittest.TestCase):
    def test_renders_required_secret_without_printing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "postgres.env"
            registration = pathlib.Path(directory) / "registration-secret"
            output = pathlib.Path(directory) / "homeserver.yaml"
            source.write_text("POSTGRES_DB=synapse\nPOSTGRES_USER=synapse\nPOSTGRES_PASSWORD=correct-horse-battery-staple\n")
            registration.write_text("registration-secret-value\n")
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", registration,
                    "--output", output,
                ],
                check=True,
                text=True,
                capture_output=True,
            )
            rendered = output.read_text()
            self.assertIn("correct-horse-battery-staple", rendered)
            self.assertNotIn("correct-horse-battery-staple", result.stdout)
            self.assertIn("enable_registration: false", rendered)
            self.assertIn("federation_domain_whitelist: []", rendered)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
python3 -m unittest tests/test_render_synapse_config.py -v
```

Expected: non-zero because the renderer does not exist.

- [ ] **Step 3: Create the Synapse template**

Create `deploy/synapse/homeserver.yaml.template`:

```yaml
server_name: "communicator.0000.gold"
public_baseurl: "https://matrix.communicator.0000.gold/"
pid_file: /data/homeserver.pid
web_client_location: null

listeners:
  - port: 8008
    tls: false
    type: http
    x_forwarded: true
    bind_addresses: ['0.0.0.0']
    resources:
      - names: [client]
        compress: false

database:
  name: psycopg2
  args:
    user: synapse
    password: "${POSTGRES_PASSWORD}"
    database: synapse
    host: postgres
    port: 5432
    cp_min: 5
    cp_max: 10

log_config: /data/log.config
media_store_path: /data/media_store
signing_key_path: /data/communicator.0000.gold.signing.key
registration_shared_secret: "${REGISTRATION_SHARED_SECRET}"
report_stats: false

enable_registration: false
enable_registration_without_verification: false
allow_profile_lookup_over_federation: false
allow_device_name_lookup_over_federation: false
federation_domain_whitelist: []
federation_whitelist_endpoint_enabled: false

user_directory:
  enabled: false
  search_all_users: false
  exclude_remote_users: true

encryption_enabled_by_default_for_room_type: invite
max_upload_size: 50M
url_preview_enabled: false
```

- [ ] **Step 4: Create the strict renderer**

Create executable `scripts/render-synapse-config.py`:

```python
#!/usr/bin/env python3
import argparse
import os
import pathlib
import string


ROOT = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "deploy/synapse/homeserver.yaml.template"


def read_env(path: pathlib.Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--postgres-env", type=pathlib.Path, required=True)
    parser.add_argument("--registration-secret", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()

    values = read_env(args.postgres_env)
    substitutions = {
        "POSTGRES_PASSWORD": values["POSTGRES_PASSWORD"],
        "REGISTRATION_SHARED_SECRET": args.registration_secret.read_text().strip(),
    }
    rendered = string.Template(TEMPLATE.read_text()).substitute(substitutions)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered)
    os.chmod(args.output, 0o600)
    print(f"rendered {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Add redacted Synapse logging**

Create `deploy/synapse/log.config`:

```yaml
version: 1
formatters:
  precise:
    format: '%(asctime)s %(levelname)s %(name)s %(message)s'
filters:
  context:
    (): synapse.logging.context.LoggingContextFilter
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
    filters: [context]
loggers:
  synapse.storage.SQL:
    level: WARNING
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
```

- [ ] **Step 6: Add client-only Caddy routing**

Create `deploy/caddy/Caddyfile`:

```caddyfile
communicator.0000.gold {
  header /.well-known/matrix/* Access-Control-Allow-Origin "*"
  header /.well-known/matrix/* Content-Type "application/json"
  respond /.well-known/matrix/server `{"m.server":"matrix.communicator.0000.gold:443"}` 200
  respond /.well-known/matrix/client `{"m.homeserver":{"base_url":"https://matrix.communicator.0000.gold"}}` 200
  respond 404
}

matrix.communicator.0000.gold {
  @client path /_matrix/client/* /_matrix/media/* /_synapse/client/*
  handle @client {
    reverse_proxy synapse:8008
  }
  respond 404
}
```

This intentionally does not proxy `/_matrix/federation/*` or `/_matrix/key/*`.

- [ ] **Step 7: Run renderer and contract tests**

```bash
chmod +x scripts/render-synapse-config.py
python3 -m unittest tests/test_render_synapse_config.py tests/test_repository_contract.py -v
```

Expected: all tests pass.

- [ ] **Step 8: Commit the configuration**

```bash
git add deploy/caddy deploy/synapse scripts/render-synapse-config.py tests/test_render_synapse_config.py
git commit -m "feat: add private Synapse and Caddy configuration"
```

### Task 6: Deploy the Matrix core idempotently

**Files:**
- Create: `scripts/deploy-core.sh`
- Create: `docs/runbooks/matrix-core-operations.md`

- [ ] **Step 1: Create the deployment script**

Create executable `scripts/deploy-core.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
export COMMUNICATOR_RUNTIME_DIR="$runtime_dir"

./scripts/init-runtime.sh

if [[ ! -f "$runtime_dir/synapse/communicator.0000.gold.signing.key" ]]; then
  docker run --rm \
    -e SYNAPSE_SERVER_NAME=communicator.0000.gold \
    -e SYNAPSE_REPORT_STATS=no \
    -v "$runtime_dir/synapse:/data" \
    "$SYNAPSE_IMAGE" generate
fi

cp deploy/synapse/log.config "$runtime_dir/synapse/log.config"
chmod 0600 "$runtime_dir/synapse/log.config"

python3 scripts/render-synapse-config.py \
  --postgres-env "$runtime_dir/secrets/postgres.env" \
  --registration-secret "$runtime_dir/secrets/synapse_registration_shared_secret" \
  --output "$runtime_dir/synapse/homeserver.yaml"

docker compose --env-file deploy/images.lock.env config --quiet
docker compose --env-file deploy/images.lock.env pull
docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 postgres synapse caddy
docker compose --env-file deploy/images.lock.env ps
```

- [ ] **Step 2: Add the core operations runbook**

Create `docs/runbooks/matrix-core-operations.md` with:

```markdown
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
```

- [ ] **Step 3: Validate shell syntax**

```bash
chmod +x scripts/deploy-core.sh
bash -n scripts/deploy-core.sh scripts/init-runtime.sh
```

Expected: exit `0` and no output.

- [ ] **Step 4: Commit deployment orchestration**

```bash
git add scripts/deploy-core.sh docs/runbooks/matrix-core-operations.md
git commit -m "feat: orchestrate Matrix core deployment"
```

- [ ] **Step 5: Package and transfer the approved commit**

```bash
test -z "$(git status --short)"
release_commit=$(git rev-parse HEAD)
archive=$(mktemp "/tmp/communicator-${release_commit}.XXXXXX.tar.gz")
git archive --format=tar.gz --output="$archive" HEAD
checksum=$(sha256sum "$archive" | awk '{print $1}')
remote_dir=$(ssh contabo-eu 'set -eu; test "$(hostname)" = vmi3501337; ip -4 -brief address show eth0 | grep -q "169.58.160.23/"; umask 077; mktemp -d /tmp/communicator-release.XXXXXX')
case "$remote_dir" in /tmp/communicator-release.*) ;; *) exit 1 ;; esac
cleanup_release() { unlink -- "$archive"; ssh contabo-eu "test \"\$(hostname)\" = vmi3501337 && sudo rm -rf -- '$remote_dir'"; }
trap cleanup_release EXIT
scp "$archive" "contabo-eu:${remote_dir}/release.tar.gz"
ssh contabo-eu "set -eu
test \"\$(hostname)\" = vmi3501337
ip -4 -brief address show eth0 | grep -q '169.58.160.23/'
test \"\$(stat -c '%U:%G:%a' '$remote_dir')\" = admin:admin:700
printf '%s  %s\n' '$checksum' '$remote_dir/release.tar.gz' | sha256sum -c -
sudo install -d -o root -g root -m 0755 /opt/communicator/releases
sudo test ! -e '/opt/communicator/releases/${release_commit}'
sudo install -d -o root -g root -m 0755 '/opt/communicator/releases/${release_commit}'
sudo tar -xzf '$remote_dir/release.tar.gz' -C '/opt/communicator/releases/${release_commit}'
printf '%s\n' '$release_commit' | sudo install -o root -g root -m 0644 /dev/stdin '/opt/communicator/releases/${release_commit}/RELEASE_COMMIT'
"
```

Expected: remote archive checksum passes and `RELEASE_COMMIT` matches the local commit. The inactive release exists under `/opt/communicator/releases/<commit>`; `/opt/communicator/current` is not changed until Step 6's approval gate.

- [ ] **Step 6: Deploy only after the commit-specific approval gate passes**

```bash
release_commit=$(git rev-parse HEAD)
ssh contabo-eu bash -s -- "$release_commit" <<'REMOTE'
set -eu
release_commit=$1
printf '%s\n' "$release_commit" | grep -Eq '^[0-9a-f]{40,64}$'
test "$(hostname)" = vmi3501337
ip -4 -brief address show eth0 | grep -q "169.58.160.23/"
cd "/opt/communicator/releases/$release_commit"
test "$(cat RELEASE_COMMIT)" = "$release_commit"
sudo ln -sfn "/opt/communicator/releases/$release_commit" /opt/communicator/current
cd /opt/communicator/current
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/deploy-core.sh
sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator docker compose --env-file deploy/images.lock.env ps
REMOTE
```

Expected: `postgres`, `synapse`, and `caddy` report healthy. Stop and diagnose any unhealthy service before continuing.

### Task 7: Create isolated Matrix accounts and validate public boundaries

**Files:**
- Create: `scripts/create-matrix-user.sh`
- Create: `scripts/validate-core.sh`
- Create: `docs/runbooks/matrix-core-validation.md`
- Create: `docs/runbooks/break-glass.md`

- [ ] **Step 1: Add controlled account creation**

Create executable `scripts/create-matrix-user.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]] || [[ "$2" != "user" && "$2" != "admin" ]]; then
  echo "usage: $0 <localpart> <user|admin>" >&2
  exit 2
fi

localpart=$1
role=$2
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
admin_flag=--no-admin
[[ "$role" == "admin" ]] && admin_flag=--admin

read -rsp "Password for @${localpart}:communicator.0000.gold: " password
echo

docker compose --env-file deploy/images.lock.env exec -T synapse \
  register_new_matrix_user \
  --user "$localpart" \
  --password "$password" \
  "$admin_flag" \
  --config /data/homeserver.yaml \
  http://localhost:8008
unset password
```

- [ ] **Step 2: Add automated boundary validation**

Create executable `scripts/validate-core.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

matrix=https://matrix.communicator.0000.gold
identity=https://communicator.0000.gold

curl -fsS "$matrix/_matrix/client/versions" | python3 -m json.tool >/dev/null
curl -fsS "$identity/.well-known/matrix/client" | python3 -m json.tool >/dev/null
curl -fsS "$identity/.well-known/matrix/server" | python3 -m json.tool >/dev/null

federation_status=$(curl -sS -o /dev/null -w '%{http_code}' "$matrix/_matrix/federation/v1/version")
key_status=$(curl -sS -o /dev/null -w '%{http_code}' "$matrix/_matrix/key/v2/server")
[[ "$federation_status" == "404" ]]
[[ "$key_status" == "404" ]]

if ss -H -ltn | awk '{print $4}' | grep -Eq ':(5432|8008)$'; then
  echo "PostgreSQL or Synapse is published on the host" >&2
  exit 1
fi

docker compose --env-file deploy/images.lock.env ps --status running --services | sort | diff -u \
  <(printf 'caddy\npostgres\nsynapse\n') -

echo "core_validation=PASS"
```

- [ ] **Step 3: Add the client and encryption validation runbook**

Create `docs/runbooks/matrix-core-validation.md`:

```markdown
# Matrix Core Validation

## Simple explanation

Create separate human, agent, and administrator accounts. Confirm that the human and agent cannot see each other's rooms. Confirm that an encrypted room remains readable after every client and service restart.

## Technical checklist

1. Verify `hostname` is exactly `vmi3501337` and `eth0` owns `169.58.160.23`, then create three accounts from an interactive remote terminal so passwords never enter command arguments: `ssh -t contabo-eu 'set -eu; test "$(hostname)" = vmi3501337; ip -4 -brief address show eth0 | grep -q "169.58.160.23/"; cd /opt/communicator/current; sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/create-matrix-user.sh <localpart> <user|admin>'`.
2. Sign into the human and agent accounts on separate verified Matrix client profiles.
3. Create one private encrypted room as the human. Do not invite the agent.
4. Create one private encrypted room as the agent. Do not invite the human.
5. Send text and media in each room and verify the other principal cannot discover or join it.
6. Confirm room encryption is active before sending sensitive content.
7. Restart Synapse and PostgreSQL in a controlled window.
8. Confirm both clients decrypt messages sent before the restart.
9. Confirm public registration fails.
10. Confirm federation and key endpoints return HTTP 404 through Caddy.
11. Record room IDs and ownership in the private operator registry, not in Git.
12. Treat `platform-admin` as metadata-only. Do not join it to either room outside an approved break-glass test.
13. Enable Matrix Secure Backup separately for the human and agent accounts and store each recovery key in the operator's offline password manager.
```

- [ ] **Step 4: Add the manual break-glass procedure**

Create `docs/runbooks/break-glass.md`:

```markdown
# Break-glass Conversation Access

## Simple explanation

The administrator cannot normally read encrypted conversations. Emergency access must be deliberate, limited, recorded, and temporary.

## Technical procedure

1. Reauthenticate to the `platform-admin` Matrix account on a dedicated temporary client profile.
2. Record the reason, requesting operator, principal, room scope, start time, and expiration time in the private operator audit log.
3. Set the maximum access window to one hour for the prototype.
4. From the owning principal's verified client, invite `platform-admin` only to the approved room and explicitly share the current room keys.
5. Read or export only the approved content. Record each read or export action in the private audit log.
6. Remove `platform-admin` from the room when the access window ends.
7. Sign the temporary administrator device out and delete its local crypto store.
8. Record the termination time and result.
9. Treat any copied or exported plaintext as irreversibly disclosed and apply the same retention and deletion rules as the source conversation.

This process does not recover historical keys that the owning principal cannot share. It does not create a universal decryption account.
```

- [ ] **Step 5: Validate syntax and public behavior**

```bash
chmod +x scripts/create-matrix-user.sh scripts/validate-core.sh
bash -n scripts/create-matrix-user.sh scripts/validate-core.sh
ssh contabo-eu 'set -eu; test "$(hostname)" = vmi3501337; ip -4 -brief address show eth0 | grep -q "169.58.160.23/"; cd /opt/communicator/current; sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh'
curl -fsS https://matrix.communicator.0000.gold/_matrix/client/versions | python3 -m json.tool >/dev/null
curl -fsS https://communicator.0000.gold/.well-known/matrix/client | python3 -m json.tool >/dev/null
```

Expected: local syntax passes, remote validation prints `core_validation=PASS`, and both external HTTPS requests exit `0`. Record the certificate names and expiry in the private operator log.

- [ ] **Step 6: Complete the manual encryption checklist**

Expected: human and agent rooms are mutually invisible; encrypted messages remain decryptable after service and client restarts.

- [ ] **Step 7: Commit validation tooling**

```bash
git add scripts/create-matrix-user.sh scripts/validate-core.sh docs/runbooks/matrix-core-validation.md docs/runbooks/break-glass.md
git commit -m "test: validate Matrix identity and network boundaries"
```

### Task 8: Implement encrypted backup and clean restoration

**Files:**
- Create: `scripts/backup-core.sh`
- Create: `scripts/restore-core-test.sh`
- Create: `docs/runbooks/matrix-core-recovery.md`

- [ ] **Step 1: Add a consistent restic backup script**

Create executable `scripts/backup-core.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
staging=$(mktemp -d "$runtime_dir/backups/core.XXXXXX")

cleanup() {
  rm -rf -- "$staging"
  docker compose --env-file "$repo_dir/deploy/images.lock.env" start synapse >/dev/null 2>&1 || true
}
trap cleanup EXIT

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"

cd "$repo_dir"
docker compose --env-file deploy/images.lock.env stop synapse
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_dump -U synapse -d synapse --format=custom > "$staging/synapse.pgdump"

install -d -m 0700 "$staging/synapse-data" "$staging/secrets"
cp -a "$runtime_dir/synapse/homeserver.yaml" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/log.config" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/communicator.0000.gold.signing.key" "$staging/synapse-data/"
cp -a "$runtime_dir/synapse/media_store" "$staging/synapse-data/"
cp -a "$runtime_dir/secrets/postgres.env" "$staging/secrets/"
cp -a "$runtime_dir/secrets/synapse_registration_shared_secret" "$staging/secrets/"

restic backup "$staging" --tag communicator-core
restic check
docker compose --env-file deploy/images.lock.env start synapse
trap - EXIT
rm -rf -- "$staging"
echo "backup=PASS"
```

- [ ] **Step 2: Add an isolated restore-test script**

Create executable `scripts/restore-core-test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
restore_root="$runtime_dir/restore-tests/$(date -u +%Y%m%dT%H%M%SZ)-$$"
project=communicator-restore-test

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"

if [[ -e "$restore_root" ]]; then
  echo "restore target already exists: $restore_root" >&2
  exit 1
fi

install -d -m 0700 "$restore_root"
restic restore latest --tag communicator-core --target "$restore_root/restic"

payload=$(find "$restore_root/restic" -type f -name synapse.pgdump -printf '%h\n' -quit)
[[ -n "$payload" ]]

install -d -m 0700 "$restore_root/runtime/postgres" "$restore_root/runtime/synapse" "$restore_root/runtime/secrets"
cp -a "$payload/secrets/." "$restore_root/runtime/secrets/"
cp -a "$payload/synapse-data/." "$restore_root/runtime/synapse/"

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
export COMMUNICATOR_RUNTIME_DIR="$restore_root/runtime"
export COMPOSE_PROJECT_NAME="$project"

cleanup() {
  cd "$repo_dir"
  docker compose --env-file deploy/images.lock.env down >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose --env-file deploy/images.lock.env up -d postgres
docker compose --env-file deploy/images.lock.env exec -T postgres \
  pg_restore -U synapse -d synapse --clean --if-exists < "$payload/synapse.pgdump"
docker compose --env-file deploy/images.lock.env up -d synapse
docker compose --env-file deploy/images.lock.env exec -T synapse \
  python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8008/health", timeout=5)'
docker compose --env-file deploy/images.lock.env down
trap - EXIT
echo "restore_test=PASS path=$restore_root"
```

- [ ] **Step 3: Add the recovery runbook**

Create `docs/runbooks/matrix-core-recovery.md`:

```markdown
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
```

- [ ] **Step 4: Validate script syntax**

```bash
chmod +x scripts/backup-core.sh scripts/restore-core-test.sh
bash -n scripts/backup-core.sh scripts/restore-core-test.sh
```

Expected: exit `0` and no output.

- [ ] **Step 5: Commit backup and recovery tooling**

```bash
git add scripts/backup-core.sh scripts/restore-core-test.sh docs/runbooks/matrix-core-recovery.md
git commit -m "feat: add encrypted Matrix core recovery workflow"
```

- [ ] **Step 6: Execute backup and clean restoration remotely**

```bash
ssh contabo-eu "set -eu
test \"\$(hostname)\" = vmi3501337
ip -4 -brief address show eth0 | grep -q '169.58.160.23/'
sudo bash -c 'set -a
test \"\$(stat -c %U:%G:%a /srv/communicator/secrets/restic.env)\" = root:root:600
source /srv/communicator/secrets/restic.env
test \"\$(stat -c %U:%G:%a \"\$RESTIC_PASSWORD_FILE\")\" = root:root:600
set +a
cd /opt/communicator/current
COMMUNICATOR_RUNTIME_DIR=/srv/communicator ./scripts/backup-core.sh
COMMUNICATOR_RUNTIME_DIR=/srv/communicator ./scripts/restore-core-test.sh
'"
```

Expected: `backup=PASS` followed by `restore_test=PASS`.

### Task 9: Run the Stage 1 gate and publish evidence

**Files:**
- Create: `docs/status/matrix-core-stage-gate.md`

- [ ] **Step 1: Run every automated test from a clean checkout**

```bash
python3 -m unittest discover -s tests -v
bash -n scripts/*.sh
ssh contabo-eu 'set -eu; test "$(hostname)" = vmi3501337; ip -4 -brief address show eth0 | grep -q "169.58.160.23/"; cd /opt/communicator/current; sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator docker compose --env-file deploy/images.lock.env config --quiet; sudo env COMMUNICATOR_RUNTIME_DIR=/srv/communicator COMPOSE_PROJECT_NAME=communicator ./scripts/validate-core.sh'
```

Expected: all Python tests pass, Bash syntax exits `0`, Compose validation exits `0`, and core validation prints `core_validation=PASS`.

- [ ] **Step 2: Complete the manual Matrix validation checklist**

Expected: separate human and agent accounts, mutually invisible encrypted rooms, stable decryption after restart, public registration disabled, and no administrator content access without deliberate room-key sharing.

- [ ] **Step 3: Record stage-gate evidence without secrets**

Create `docs/status/matrix-core-stage-gate.md` containing:

```markdown
# Matrix Core Stage Gate

## Simple explanation

This record states whether the Matrix core is safe enough to begin Telegram bridge planning. It contains no credentials, message content, room IDs, IP addresses, or private backup locations.

## Technical evidence

- Supported Ubuntu LTS preflight: pass
- Free disk and swap-movement gate: pass
- DNS and HTTPS discovery: pass
- PostgreSQL, Synapse, and Caddy health: pass
- Registration and federation boundary: pass
- Human and agent room isolation: pass
- Encrypted-message restart test: pass
- Off-server backup: pass
- Clean isolated restoration: pass
- Minimum 24-hour core soak: pass

## Decision

Stage 1 is accepted. Telegram bridge planning may begin. WhatsApp and Messenger remain out of scope until their own gated plans are approved.
```

Do not mark a line `pass` until current evidence exists. If any check fails, record the failure in the private operator log and keep Stage 1 unaccepted.

- [ ] **Step 4: Run a secret scan over all tracked files**

Run:

```bash
git grep -nE 'BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY|gh[pousr]_[A-Za-z0-9_]{20,}|POSTGRES_PASSWORD=.{12,}|registration_shared_secret: .{12,}' -- ':!docs/superpowers/plans/*'
```

Expected: no output.

- [ ] **Step 5: Commit the verified stage gate**

```bash
git add docs/status/matrix-core-stage-gate.md
git commit -m "docs: record verified Matrix core stage gate"
```

- [ ] **Step 6: Push the implementation branch for review**

```bash
git push -u origin HEAD
```

Expected: the remote branch is created successfully. Do not merge until the user reviews the stage-gate evidence.

## Plan completion gate

This plan is complete only when:

- Ubuntu 24.04 LTS is running and supported.
- At least 50 GiB is free.
- No active swap movement is observed during preflight.
- DNS and TLS work for both prototype names.
- Only Caddy publishes host ports.
- Registration and federation remain unavailable publicly.
- Human, agent, and administrator identities are separate.
- Encrypted-room isolation is demonstrated.
- Off-server backup and clean restoration pass.
- The Matrix core completes a 24-hour soak.

Only then create a separate Telegram bridge implementation plan. Do not add Cloudflare components or another bridge to this plan.
