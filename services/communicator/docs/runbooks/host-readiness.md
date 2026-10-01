---
repo: 0000-chat/0000
status: current
---

# Communicator host readiness

Use a dedicated operator-owned host for the Docker Compose runtime. Build and
test releases in a development checkout. Record deployment-specific hostnames,
addresses, host-key fingerprints, capacity, and approval evidence privately.

## Preconditions

1. Select a supported operating system and size CPU, RAM, disk, and swap for
   the selected bridges, retention, and expected traffic. Inspect the current
   `scripts/preflight.py` requirements before choosing a machine.
2. Verify the SSH host key against independently supplied operator evidence.
   Require noninteractive SSH access with strict host-key checking.
3. Confirm the host identity and its network addresses before running runtime
   commands. Resolve the configured Matrix domains to the intended addresses;
   publish IPv6 only after testing the IPv6 path.
4. Require no failed system units, working DNS and outbound connectivity,
   sufficient free space, and no sustained swap pressure.
5. Default-deny incoming traffic; expose only the operator-selected SSH port
   and the required HTTP/HTTPS ports. Keep database and bridge ports private.
6. Install Docker Engine, Compose v2, Python 3, curl, OpenSSL, restic, and dig.
   Check that ports 80 and 443 are available before the first Caddy start.
7. Run `scripts/preflight.py --help`, then run the committed preflight remotely
   with the actual expected address. Require exit zero and an empty `failures`
   array. Example SSH aliases and addresses in archived plans are placeholders.
8. Verify a recoverable snapshot or encrypted backup before changing the host.
   Record the exact release commit and checksum with the deployment evidence.

Transfer only the committed release archive. Keep `.git`, local environment
files, runtime data, backups, and secrets out of the archive. Use an operator
chosen runtime directory outside the checkout; examples use `/srv/communicator`.
Do not restore untrusted artifacts into a clean installation. Fresh DNS,
service-health, and recovery evidence must be observed for each deployment.
