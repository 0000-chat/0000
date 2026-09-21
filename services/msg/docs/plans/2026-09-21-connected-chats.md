# Connected chats

Implement the user's request for parallel discussions, grouping, backlinks, and
focused discussions originating from a high-level chat. A source relationship is
one optional relationship, not a mandatory chat hierarchy.

## Model and boundaries

- Chats retain independent messages, membership-by-link, and seven-day message
  inactivity expiry. Optional titles make several chats distinguishable.
- A named group is a shared collection with its own capability URL. Adding a chat
  shares its URL with everyone holding that group link. Chats do not reveal group
  membership; a room link alone must not reveal sibling rooms.
- Related links are reciprocal. Source-message links identify a branch and its
  origin. Link writes are idempotent; a failed two-room write reports failure and
  a retry repairs any partial backlink. Cross-object writes are not atomic.
- Branch creation uses the existing idempotent room creation API followed by a
  link request. The browser retains the created URL on link failure so retrying
  does not create another room. Only explicitly selected context is copied.
- Returning findings is a user-written summary posted explicitly to the source,
  through the existing message API and its idempotency key.
- Groups expire 30 days after their last edit, display that deadline, and contain
  at most 50 chats. Links are capped at 50 per room. Group edits/linking do not
  extend the lifetime of any chat. No production deployment or secrets required.

## Work

1. Add focused SQLite/service tests for groups, independent room messages, URL
   validation, duplicate links, partial-write retry, source validation and expiry.
2. Add room schema migration for titles and links; a SQLite ChatGroup Durable
   Object; a small organization service and HTTP routes. Preserve existing APIs,
   rate limits, kill switches, content negotiation and security headers.
3. Extend the existing browser interface with recent chats/groups, named chat
   creation, a group page, related-chat navigation, link-existing and branch
   dialogs, per-message branching and explicit summary return. Keep local recents
   browser-local, clearly labeled, removable, and bounded.
4. Describe APIs and sharing semantics for humans and agents. Generate Worker
   binding types through the service script. Add the local preview binding.
5. Run focused checks, then the required service `bun run check`. Exercise real
   browser group/create/link/branch/summary/reload flows and review mobile layout.

Acceptance: grouping and linking work for ordinary parallel chats as well as
detail branches; messages stay isolated; reciprocal navigation survives reload;
summary posting is explicit; a chat does not expose its private group context;
existing localhost HTTP and agent workflows keep working.

## Validation completed

- Service `bun run check`: 279 Worker tests, 18 tooling tests, 57 CLI tests,
  and 3 packaging tests passed, along with lint and type checks. One existing
  constant-condition lint warning remains in `production-synthetic.ts`.
- Final canonical-copy and browser polish: 39 focused browser/discovery tests
  and the Worker type check passed after the full suite.
- Real workerd integration: groups and source links survived runtime restart;
  explicit summary replay produced one message; cross-origin changes failed.
- Local browser: created a group, created two independent group chats, branched
  from a message into a third chat, edited the selected context, returned a
  summary, linked existing peers, added the branch to the group and reloaded.
  Verified independent transcripts and reciprocal navigation. Inspected layouts
  at 390 px and 1440 px and restored the browser's default viewport.
- The local HTTP preview remains running. No production deployment performed.
