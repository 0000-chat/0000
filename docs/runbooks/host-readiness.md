# Communicator Host Readiness

## Simple explanation

Do not install Communicator on an unsupported or full host. Take a provider snapshot, upgrade Ubuntu, restart the host, free disk space, and run the automated preflight check.

## Technical procedure

1. Record `systemctl --failed`, `docker ps`, `ss -lntup`, `df -hT`, `free -h`, and `swapon --show` in the private operator log.
2. Create a provider snapshot and verify that its status is complete.
3. Confirm that the current release is Ubuntu 25.10 with `source /etc/os-release && echo "$VERSION_ID"`.
4. Follow Canonical's server upgrade procedure: <https://ubuntu.com/server/docs/how-to/software/upgrade-your-release/>.
5. Upgrade through the supported path from Ubuntu 25.10 to Ubuntu 26.04 LTS.
6. Reboot and confirm `VERSION_ID=26.04` and that no systemd units failed.
7. Reclaim disk space without deleting unknown data. Stop if fewer than 50 GiB are free.
8. Confirm that ports 80 and 443 are not already assigned to another required service.
9. Set DNS A/AAAA records for `communicator.0000.gold` and `matrix.communicator.0000.gold` to this host.
10. Install or verify Docker Engine, Docker Compose v2, Python 3, curl, openssl, and restic.
11. Run `./scripts/preflight.py --expected-ip <host-public-ip>`.
12. Continue only when the JSON `failures` array is empty.

Ubuntu 25.10 reached end of life on 2026-07-09. Official reference: <https://ubuntu.com/about/release-cycle>.
