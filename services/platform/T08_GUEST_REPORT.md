# T08 guest lifecycle evidence

T08 adds the registered service guest issuer boundary, persistent orgless guest
control, resource bound grants, renewal and revocation, and the protected
resource fixture's owner or participant proof. The public `/api/guest/bootstrap`
route is removed. Bootstrap credentials remain hashed in D1 and are accepted
only by the guest control routes; resource bearer credentials are separate
hashed `platform_credential` rows with `expires_at = NULL`.

The focused Worker test `worker/test/guest-lifecycle.test.ts` exercises:

- same control resumed through another registered service client and independent
  guest identities, with issuer/verifier and audience mismatch failures;
- owner stored ID mismatch and capability denial categories, participant link
  proof, a real guest-to-organization transfer with participant re-attestation
  and access, and sibling service continuity;
- stable grant and subject on renewal, old bearer denial, a deterministic
  predecessor CAS interleaving with one conflict and one winner, and a targeted
  replacement INSERT trigger whose exact D1 error is asserted while the
  predecessor remains usable; issuer-scoped revocation held across a retired
  issuer lookup, and rotation-disable CAS with no successor left active;
- permanent grant revocation, guest disable, service disable, issuer rotation
  and disable, retired issuer control returning `authority_unavailable`, and
  verifier/authority outage mapping;
- fixture cookie resume with `HttpOnly; Secure; SameSite=Lax`, independent cookie
  identity, invalid or empty-cookie denial without replacement, and outage
  `503`.

Validation run on this branch:

- `bun run check` in `services/platform`: passed 8 Worker files / 11 tests,
  typecheck, format check, and persistent Miniflare restart probe;
- `bun run check` in `packages/contracts`: passed typecheck and 3 tests;
- `bun run check` in `packages/platform-client`: passed typecheck and 5 tests,
  including guest transport/error parsing;
- local Wrangler D1 migration application (schema already current) plus
  `bun run provision:service -- --local` register, register-guest-issuer,
  rotate-guest-issuer, and disable-guest-issuer: all successful with one-time
  secrets emitted only for successful register/rotate; the final active issuer
  count was zero;
- `git diff --check`: passed.

The concurrent renewal route test can serialize two complete HTTP requests as
two valid sequential renewals because retry through bootstrap is intentionally
allowed. The deterministic D1 interleaving in the focused test holds both
current credential reads at one predecessor and proves the actual CAS race
produces one winner and one conflict. Browser adoption remains outside T08;
the fixture endpoint is the only cookie consumer in this slice.
