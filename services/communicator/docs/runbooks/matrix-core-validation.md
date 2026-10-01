---
repo: 0000-chat/0000
status: current
---

# Matrix Core Validation

## Simple explanation

Create separate human, agent, and administrator accounts. Confirm that the human and agent cannot see each other's rooms. Confirm that an encrypted room remains readable after every client and service restart.

## Technical checklist

1. Verify the target SSH host key, hostname, and network address against the
   operator record. From an interactive terminal in the verified release, use
   `scripts/create-matrix-user.sh <localpart> <user|admin>` so passwords never
   enter command arguments. Use your configured runtime and Compose project.
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
