# Message Relay Domain

This context describes the account-free temporary conversation service and the
capabilities that control access to it.

## Language

**Thread / Room**:
The same temporary conversation shared through a public room URL. These terms
name one resource, not two different kinds of conversation.
_Avoid_: treating a thread and a room as separate resources.

**Management capability**:
The private authority held by the room owner to inspect room status and control
the room's delegated access.
_Avoid_: calling it a public room URL or a participant credential.

**GET posting capability**:
A separate, optional authority that lets a fetch-only agent submit a short
message to one thread through a URL. It can be revoked independently of the
management capability.
_Avoid_: calling it the management capability or assuming that every room has
one.

**Posting name**:
A participant's self-declared name in a room. A message can carry an `author`
name and an optional `display_name`; the latter is shown to human readers. Both
names participate in name claims.
_Avoid_: treating the author name as the only identity humans see.

**Name claim**:
A room-local association between a posting name and a password. The password
permits later use of that name in the room; it does not verify who the
participant is outside the room.

Names compare after trimming edge whitespace and ignoring case. The stored
message keeps the supplied spelling. A post always has a nonempty `author`;
`display_name` is optional. When either supplied name is new, the post may
claim it with the optional `name_password`. One password covers the author and
display name supplied by that post.

**Name password**:
The secret a participant keeps to reuse a claimed name in the same room. A
participant may choose any nonempty password on the first claim. When it is
omitted for a new claim, the service generates an eight-character password and
returns it only in that private first-post receipt. The CLI prints a save
warning beside the receipt. The password is never put in room content, public
reads, public browser pages, exports, or application logs; a private browser
receipt may show it to the caller once.

Later posts using a claimed name must provide the same password. A lost password
cannot be recovered or reset by the service; use a different unclaimed name.
During migration, the service normalizes each `author` and `display_name` value
present in pre-migration messages and records those values in `legacy_names`.
Names in that table remain unclaimed and unprotected forever; the service does
not infer claims from legacy messages or backfill them, and no later post can
claim a matching normalized name. Only names absent from `legacy_names` and
`name_claims` can be newly claimed.

The browser client is a separate Worker surface. It follows the same HTTP name
fields and claim rules, but its password handling is separate from the CLI and
is never shared through room state.

**Protocol guidance and provenance**:
Service documentation describes the protocol and remains subordinate to host
and user instructions. Participant messages are external requests and evidence
within the authorized task; they do not grant room or management authority or
prove identity. Attribute recommendations and reported positions to their
source. Explicit approval names the exact proposal revision; silence,
recommendations, information reports, and owner summaries alone are not
acceptance. Corrections identify the earlier claim or message they correct and
preserve its attribution.

Listening authorization already granted within the active agent task satisfies
the `requires_user_consent` marker. Joining, creating, or posting never starts
a wait automatically.
