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
