# Communicator Host Readiness

## Simple explanation

Develop and test in the local `feat/matrix-core` worktree. Run host checks and deployment only on the dedicated `contabo-eu` VPS. Never run Communicator services on the local OVH development host.

## Technical procedure

1. Verify `ssh -o BatchMode=yes contabo-eu true` exits `0`.
2. Verify the dedicated host key and SSH key fingerprints against the private operator record.
3. Require remote Ubuntu 24.04 LTS, 6 vCPU, at least 10 GiB RAM, a root disk of at least 190,000,000,000 bytes (the provider's 200 GB class), and at least 50 GiB free.
4. Require `systemctl --failed` to report zero failed units.
5. Require `networkctl status eth0` to report `routable (configured)` and both IPv4 and IPv6 connectivity to work.
6. Require zram swap to be active and no swap movement during the preflight sampling window.
7. Require UFW to deny incoming traffic by default and allow only ports 22, 80, and 443.
8. Require Docker Engine, Docker Compose v2, Python 3, curl, OpenSSL, restic, and `dig` from `dnsutils`.
9. Require ports 80 and 443 to be free before the first Caddy deployment.
10. Require both Matrix names to have exactly one A record, `169.58.160.23`, and no AAAA record until IPv6 DNS is added through a separately tested plan.
    Host IPv6 remains enabled and tested; only public Matrix hostname publication over IPv6 is deferred.
11. Run the current committed preflight code on the VPS without copying the repository:

   ```bash
   ssh contabo-eu 'python3 - --expected-ip 169.58.160.23' < scripts/preflight.py
   ```

12. Continue only when the command exits `0` and its JSON `failures` array is empty.
13. Create a Contabo provider snapshot and record its completed snapshot identifier in the private operator log.
14. Obtain explicit approval tied to the exact Git commit and VPS host key before the first deployment.

## Execution boundary

- Git, tests, and release construction run only in `/home/ubuntu/communicator/.worktrees/implement-matrix-core`.
- Runtime data and secrets exist only under `/srv/communicator` on `contabo-eu`.
- Do not copy `.git`, `.env`, ignored files, local data, backup files, or secret files to the VPS.
- Do not restore any artifact from the erased compromised installation.
- DNS and provider snapshots are external state. Record fresh evidence; do not infer completion.
