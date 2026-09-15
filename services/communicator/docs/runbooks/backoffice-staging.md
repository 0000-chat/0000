# Communicator backoffice staging gate

This runbook describes a protected, simulated-only staging preview for the
Communicator backoffice. It is documentation for a later, explicitly approved
deployment. It does not authorize or perform a Cloudflare mutation.

## Safety boundary

Staging must use the `communicator-control-plane-staging` Worker and
`COMMUNICATOR_DATA_MODE=simulated`. The persistent simulated-data banner must
remain visible throughout the preview. No live Matrix or bridge traffic,
Durable Objects, Queues, R2, PostgreSQL, or provider credentials may be
connected to this phase. Account pairing, QR flows, and real message sending
are out of scope.

The production environment is defined separately as
`communicator-control-plane-production` with `COMMUNICATOR_DATA_MODE=live` for
future work. It has no route or custom hostname in this phase and must not be
deployed as part of this runbook.

## Required order

Perform these checks in order. Stop immediately if a check fails.

1. Verify the intended Cloudflare account and the Worker name
   `communicator-control-plane-staging`. Do not infer account ownership from a
   local login or reuse an unverified target.
2. Verify that a Cloudflare Access application protects the entire staging
   hostname, including every path and API path. The hostname must be supplied
   and approved by the operator; this phase does not create a custom hostname,
   certificate, DNS record, or Access application.
3. Verify that the Access allowed-identity list contains only the pilot
   operator. Do not place identity identifiers, provider identifiers, or
   credentials in this repository, command output, fixtures, screenshots, or
   logs.
4. Run the complete local gate from the UI-foundation plan:

   ```bash
   pnpm install --frozen-lockfile
   pnpm check
   pnpm test
   pnpm --filter @communicator/control-plane test:e2e
   pnpm test:python
   git diff --check
   ```

5. Build the simulated staging bundle:

   ```bash
   VITE_DEPLOYMENT_ENV=staging VITE_DATA_MODE=simulated pnpm --filter @communicator/control-plane build
   ```

   Only after the operator has approved the deployment and confirmed Access
   protection is ready may the staging Worker be deployed with:

   ```bash
   pnpm --filter @communicator/control-plane exec wrangler deploy --env staging
   ```

6. Open the approved staging hostname in a signed-out browser and require
   Cloudflare Access denial for the root, every backoffice screen, and every
   API path.
7. Sign in as the pilot operator, verify the persistent simulated-data banner,
   and run these four Playwright-equivalent manual journeys:

   - navigate all five screens at desktop and mobile widths;
   - switch Human to Agent and back, confirming symmetric connection,
     conversation, and message isolation;
   - preview paced delivery and submit a direct command twice, confirming one
     accepted simulated command and no confirmed message invented by the UI;
   - show the attention-required connection, inspect Activity and System, and
     reset the simulated scenario.

8. Inspect Worker logs for secret-free errors and confirm that no provider,
   bridge, Matrix, database, or infrastructure identifiers are exposed.
9. If Access denial or the persistent simulated-data banner fails, stop using
   the preview and delete the staging deployment only under the same explicit
   operator approval:

   ```bash
   pnpm --filter @communicator/control-plane exec wrangler delete --env staging
   ```

## Deployment-approval gate

This implementation session intentionally stops before `wrangler deploy`.
Before a later staging deployment, the operator must approve all of the
following in writing:

- the target Cloudflare account and Worker name;
- the exact staging hostname and a verified Access application covering the
  whole hostname;
- the Access policy containing only the pilot operator;
- the simulated-only data mode and absence of live provider credentials,
  Matrix or bridge sessions, Durable Objects, Queues, R2, PostgreSQL, and DNS
  changes; and
- the post-deployment signed-out denial check and the four manual journeys.

No custom hostname, DNS record, Cloudflare Access application, provider
account, or external service is created or changed by this phase.
