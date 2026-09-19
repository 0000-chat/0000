# T14 reconnect proof

Reviewed, integrated and independently verified at aggregate `166e54d`.
Worker commits `1b4d5ed` and `c4491b8` map to aggregate `6ae1d24` and `166e54d`.

This report records a focused Worker/D1/shared-client fixture. It is evidence
for the Platform boundary and application-owned queue behavior; it is not a
Database operation, an apps/0000 implementation, or a product offline-sync
implementation.

The regression at `worker/test/reconnect.test.ts` uses the actual Better Auth
GitHub start/callback flow, `/api/auth/get-session`, `/api/me`, credential
issuance and revocation routes, organization invitation/acceptance, and
membership removal. Provider HTTP is simulated in the test. The resource
fixture stores payload and revision state in a D1 table created by
`test_fixture_0003_reconnect.sql`. Its resource handler authenticates through
the shared `@0000/platform-client` against `/internal/v1/authenticate` and
applies organization ACLs and an ownership conditional update at submission.

The test demonstrates these observable assertions:

- A payload queued before browser sign-out is retained locally while a fresh
  social login establishes a new session. The current session endpoint returns
  `200`, a same-organization `resource:write` credential applies the payload
  with `200`, increments the stored revision, and removes only acknowledged
  queue entries.
- A credential revoked through `/api/credentials/revoke` receives `401` on
  reconnect. The stored payload and revision remain unchanged in the fixture
  client and D1 row.
- A valid credential for another organization receives `404` from the fixture
  ACL, with its queued payload and stored row unchanged.
- A simulated authority fetch failure returns `503`; no resource update occurs
  and the local payload remains queued.
- After the organization owner removes the member through the account route,
  the member's old organization credential returns `401` on the next shared
  verification. A fresh social session still returns `200`, while issuing a
  new credential for the removed organization returns `403`. The pending local
  payload is retained.
- A fixture preflight returns `200`, then a controlled ownership change runs
  after the handler's server-side owner read and before its conditional D1
  update. The zero-row conditional update denies the stale submission with
  `403`, leaves the payload unchanged, and preserves the queued item.

Reauthentication is explicitly tested as sign-out followed by a new provider
start/callback and session endpoint check. This is re-establishment, not a
claim that sliding session renewal was tested. The provider is simulated and
the fixture resource is not a production Database or application write path.

Verification completed on the isolated branch:

- `services/platform bun run check` passed: format check, TypeScript check, all
  8 Worker tests including the T14 regression, the D1 restart persistence probe,
  and diff validation.
- Root `bun run check` passed: all 11 workspace manifests passed the workspace
  scaffold check.

Independent Astra medium Standards and Spec reviews completed. The Spec review
found that removed-member issuance was checked before reauthentication; the
fix now uses the fresh session and asserts `403`, and the reviewer confirmed it.
An unused transport hook was removed. A nonblocking duplicated fixture ACL
predicate observation remains; the write's conditional SQL guard is separate.

One bounded authenticated Grok 4.6 high review of the fixture ownership/apply
and queue proof found no in-scope defect. Tools, web and subagents were disabled
and only an isolated nonsecret source package was provided. This does not claim
exactly-once sync under arbitrary post-write acknowledgment loss.

Parent independently passed the reconnect regression before and after the fix.
Aggregate `bun run check` passes formatting/typecheck, six Worker/D1 files
(eight tests), persistent runtime restart and diff checks at `166e54d`; root
manifest checks also pass. No production code changed in this slice.
