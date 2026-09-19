# T07 runtime acceptance evidence

This checkpoint adds two bounded probes for the production Platform Worker
routes. The probes use Miniflare's D1 persistence directory to recreate the
same local runtime, and use Chromium through a real HTTP bridge for the
account-control flow. They simulate only the external GitHub HTTP calls that
Better Auth makes during the synthetic sign-in; Platform OAuth issuance,
refresh-family state, account APIs, HTML rendering, and shared-client checks
remain production code paths.

## Restart probe

Run from `services/platform`:

```sh
bun scripts/test-oauth-refresh-restart.mjs
```

Observed exit status: `0`.

The probe applies migrations to the first runtime, creates a human session,
trusted client, service, and two offline-consented installations through the
production routes, then disposes and recreates the Worker with the same D1
persistence directory. It installs two temporary D1 triggers for the target
installation: one rejects the provider access-row insert during refresh, and
the other rejects the attempted `quarantined` family update. The resulting
production refresh response is HTTP `503` with
`temporarily_unavailable`/`authority_unavailable`.

The emitted result recorded these assertions:

- The target family and first refresh row start `active`/`issued`, become
  durable `pending`/`pending` after the failed refresh, and remain the same
  family and state after runtime recreation. The temporary failure triggers
  are dropped before the trigger-free pending retry and runtime recreation;
  both retries compare the exact family ID, pending token ID, consumption
  nonce, full installation-scoped provider access/refresh row inventories
  (including row IDs, `revoked`, and access `refreshId`), and refresh lineage.
- Target access authentication is denied and target refresh remains denied
  before and after recreation.
- The independent sibling remains authenticated after the target failure and
  after recreation. After the persisted human session is logged out, its
  healthy refresh succeeds and produces sequence `1`.
- A second sign-in and authorization creates a new active installation and
  family. The original target family remains the same pending record.
- The result reports migrations applied before the first runtime, not replayed
  after recreation, and the persistence directory reused.

## Browser probe

The probe requires the already-installed Playwright module and makes no
dependency or lockfile changes:

```sh
T07_PLAYWRIGHT_MODULE=/home/ubuntu/0000-full/worktrees/platform-mvp/services/communicator/node_modules/.pnpm/@playwright+test@1.62.1/node_modules/@playwright/test/index.mjs \
  bun scripts/test-oauth-installation-browser.mjs
```

Observed exit status: `0`.

Chromium signs in through the real social start and callback routes, retains a
real browser cookie session, creates two OAuth installations through browser
navigation and consent forms, and loads the account page. The probe checks
that the rendered rows expose client name, organization, service, audience,
capability, and active state without exposing access or refresh token values.
The public client is provisioned without a client-secret field, and the probe
checks that no `client_secret` field appears in the account output. It then
clicks the actual
`button[data-revoke-oauth-installation]` control for the target installation.

The emitted result recorded these assertions:

- Two installations are listed. The target becomes `revoked`, its rendered
  revoke control disappears, and the raw account API reports numeric
  `active: 0` plus a `revoked_at` timestamp.
- Shared-client verification returns `invalid_credential` for the revoked
  target and `authenticated` for the sibling. A browser refresh attempt for
  the target returns HTTP `400` with `invalid_grant`.
- After a full account-page reload, the target remains revoked and has no
  revoke control.
- Access and refresh values are absent from the account DOM before and after
  revocation, the public client has no client-secret field, and Chromium
  reports zero page errors. A confidential-client secret is outside this
  bounded browser probe.

## Boundaries

These probes run the bundled Worker and local persisted D1; they do not prove
behavior against a deployed Worker, remote D1, or a live external provider.
The GitHub adapter returns synthetic provider responses only. The restart
failure is deliberately injected with temporary D1 triggers so the probe can
exercise production consume, provider-write, quarantine, and recovery paths
deterministically. Temporary persistence is removed in `finally` cleanup, and
all credentials and provider values are synthetic. Persistence allocation and
Worker bundling are inside the cleanup scope; page evaluation and each runtime,
browser, bridge, and persistence cleanup step has a finite deadline so one
stalled cleanup does not suppress the later cleanup steps.

The owned files are `scripts/test-oauth-refresh-restart.mjs`,
`scripts/test-oauth-installation-browser.mjs`, and this report. The checkpoint
commit is supplied in the handoff accompanying this report.
