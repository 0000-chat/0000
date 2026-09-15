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
