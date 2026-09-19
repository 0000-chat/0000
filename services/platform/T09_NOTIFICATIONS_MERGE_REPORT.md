# Shared auth and msg notification merge

This merge combines upstream notification commit `90b0333` with Platform auth.
Source merge `9b9868f` and correction `b49f780` are combined with accepted
Platform/browser/binding runtime `9ef2d0f` in candidate `ebb1593`.

Webhook and push routes use the same shared verifier, participant permissions
and operation budgets as other msg routes. Reads require read permission;
mutations require write permission. Existing room-link participation remains
available. An explicit invalid credential cannot fall back to cookies, and an
authority outage cannot mutate notification state. Browser identifiers remain
notification metadata, not authentication.

Review corrected two regressions: a new forward schema version reconciles
actual upstream-v7 rooms without dropping notification history or assigning an
owner, and recovery preserves a normal participant's existing read/write grant.
The read-only test proves reads and mutation denial with an existing credential;
it does not prove renewal under divergent local and Platform grant state.

Independent verification:

- Full msg check on `b49f780`: 270 Worker tests, 13 tooling tests, 67 CLI tests
  and 3 packaging tests pass, with lint/typecheck and build included.
- Combined actual Platform/D1-to-msg/DO T09/T10/T13 boundary: 3 tests and
  183 assertions pass. This includes recovery followed by posting, explicit
  bearer denial on push status, and unchanged webhook state after an outage.
- Independent schema follow-up: 7 tests pass against upstream-v7 and
  Platform-v6 fixtures, preserving both histories and current access behavior.
- Native review findings are closed. Authenticated Grok 4.6 high review of the
  bounded shared-auth/notification route interaction found no material defect.
- The worker reports a passing notification Chromium smoke. This is separate
  from the actual shared-auth Worker/D1 boundary above.
- Parent actual shared-auth msg Chromium smoke passes on the combined runtime,
  covering guest/control recovery, revocation and outage behavior.

Earlier worker runs encountered intermittent Miniflare startup failures and
T10 timeouts. Parent runs of the ordered pair, the exact reported command and
the full check all pass without a source change; the combined boundary also
passes. The earlier runtime failure was not reproduced and its cause is not
established. No timeout increase or speculative lifecycle change was made.

This report does not establish live providers, deployment, full Communicator
adoption or the final MVP release gates.
