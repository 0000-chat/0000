# Ordinary R2 Event Archive — Local Runbook

## Deployment prohibition

The bucket names in Wrangler are configuration targets only; they do not provision Cloudflare resources. This phase authorizes no `wrangler deploy`, `r2 bucket create`, or Cloudflare API mutation. Do not use Wrangler remote commands, create or inspect live buckets, or deploy this Worker as part of local archive verification.

The event archive is an ordinary R2 bucket family separate from the encrypted VPS/restic backup bucket. It must never share the restic bucket, backup objects, credentials, retention policy, or recovery workflow. The names below are reserved targets and are not evidence that any bucket exists:

- local: `communicator-event-archive-local`
- staging: `communicator-event-archive-staging`
- production: `communicator-event-archive-production`

## Current scope

This milestone only declares an isolated `EVENT_ARCHIVE` binding for later archive-library work. It does not add archive writes, replay reads, HTTP routes, Durable Objects, Queues, Matrix or provider behavior, media/export handling, deletion workflows, Data Catalog or Pipelines integration, Brain integration, or live-resource provisioning.

## Local verification

Run the generated-type and Worker checks from the repository root:

```bash
pnpm --filter @communicator/control-plane types:worker
pnpm --filter @communicator/control-plane check
pnpm --filter @communicator/control-plane test:worker
```

The local Worker test runtime should expose an empty isolated `EVENT_ARCHIVE` binding. No application code is expected to read or write it yet; later archive tests will exercise the binding. Inspect only checked-in configuration and generated types locally, for example:

```bash
rg -n 'EVENT_ARCHIVE|communicator-event-archive-' apps/control-plane/wrangler.jsonc apps/control-plane/worker-configuration.d.ts
```

Do not replace these local checks with a remote bucket listing or mutation.
