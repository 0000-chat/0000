# T11 Communicator binding prerequisite

This slice adds Communicator-owned immutable mappings from verified Platform
principals to current local tenant, principal and membership records. It does
not wire public routes, browser UI, provisioning, realtime or issuer retirement.

Migration `0031_platform_bindings.sql` reserves the exact Platform authority,
kind, subject, organization and original membership or grant tuple. It preserves
the organization-to-tenant association across pending, active and revoked rows.
Targets cannot be retargeted; revocation is terminal. A BEFORE INSERT guard also
prevents SQLite replacement from deleting reserved history. Real D1 tests
reproduced that replacement gap before the guard and reject it afterward.

`resolvePlatformBinding` consumes the shared verified Principal contract and
reads current directory state from the primary. It checks exact tuple and tenant
hint, active local records, kind coherence, and optional identity/installation/
client relationships. Missing mappings and unavailable storage fail closed.
A resolved mapping does not itself grant access to a service resource.

Source commits are `781064b` and `389105a`; integrated source is `faac584`.
Verification:

- Worker reports 83 files / 889 tests, typecheck/build and formatting passed.
- Parent and independent Spec reviewer each passed all 29 focused Worker/D1
  tests on final source. The combined browser/binding candidate also passes
  these 29 tests, frozen nested pnpm installation and control-plane check.
- Cases include all supported principal kinds, inactive local state, tuple
  mismatch, replacement attempts, terminal history, cross-tenant association,
  valid independent tuples, new memberships and stable credential rotation.
- Native Standards/Spec findings are closed. Authenticated Grok 4.6 at high
  effort found no remaining issue in a bounded schema/resolver review using
  an isolated nonsecret package with tools disabled.

These tests use shared-contract principals and actual D1. They do not prove a
registered Platform-to-Communicator request boundary. Full consumer acceptance
still requires route authentication, resource ACL intersections, provisioning,
browser reauthentication, realtime current authority and actual Matrix callers.
