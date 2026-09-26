# Room-local name claims

Status: accepted. Every new message has a required nonempty `author`. A post
may also include `display_name` and the optional `name_password` request field.
The supplied author and display name are room-local posting names. A name is
compared after trimming edge whitespace and ignoring case, while the message
retains the spelling supplied by the caller.

## Decision

The first post that uses an unclaimed name can choose any nonempty
`name_password`. If no password is supplied, the service generates an
eight-character password. The generated value is returned once in the private
post receipt as `name_password`, alongside the `name_password_notice`; it is
not stored in the message projection or exposed through public reads. The CLI
writes that warning to standard error and leaves the value in the JSON receipt
so the caller can save it. A caller-chosen password is never echoed by the
service.

One password authorizes every name supplied by the same post, including both
`author` and `display_name` when they differ. Every later post using a claimed
name must provide that name's password. A lost password has no recovery or
reset path; the participant must choose another unclaimed name.

During migration, the service normalizes each `author` and `display_name` value
present in pre-migration messages and records those values in `legacy_names`. A
name in that table remains unclaimed and unprotected forever. The service does
not infer ownership from legacy messages or backfill claims, and no later post
can claim a matching normalized name. Only a name absent from both
`legacy_names` and `name_claims` can be newly claimed.

The browser is a separate Worker client surface. It uses the same HTTP fields
and server rules, but does not share CLI password state or place passwords in
room state.

## Considered options

- Keep names entirely unprotected: this preserves the original account-free
  behavior but lets another participant reuse a name without the caller's
  knowledge.
- Require a password on every first post: this avoids one-time delivery but
  makes a first interaction needlessly difficult and offers no safe default.
- Treat `author` as the only name: this leaves the human-facing
  `display_name` open to impersonation of an already claimed participant.

The selected design keeps the room capability as the authority to participate,
adds a narrow room-local continuity check, and makes the one-time generated
secret visible only to the caller that made the first claim. A name claim is
not an authenticated real-world identity and does not grant management
authority.

## Consequences

Name passwords are secrets. Clients must keep them out of message content,
public URLs, application logs, exports, public browser pages, and screenshots.
The private delegated GET write URL may carry a supplied `name_password` in its
query, so
the full URL is also a password-bearing secret. Browser history, proxy or
server URL logs, referrer data, previews, and screenshots can retain it; use a
JSON POST when those surfaces cannot be controlled. A private first-post
browser receipt may show the generated value to its caller; the private
first-post receipt is the only delivery path for a generated password. A
client that loses an ambiguous first-post response may be unable to recover the
password even if the message was committed; it should inspect the room before
retrying and then use a different name if the secret is unavailable.
