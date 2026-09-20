# Actual Platform/Communicator browser composition

`runner.mjs` starts a fresh Miniflare Platform runtime and a fresh local Wrangler
Communicator runtime. It allocates ports at runtime, builds Communicator assets
from the checked out source, writes secrets only to mode `0600` temporary files,
and removes its owned process groups and state directories on exit. It never
uses the long running T11 fixture processes or their persisted state.

Run the incremental OAuth/session proof from the repository root with:

```sh
COMPOSITION_PHASE=oauth bun run services/platform/scripts/platform-browser-composition/runner.mjs
```

That phase uses the simulated GitHub provider callback, then drives the real
Platform selection/consent/code flow and real Communicator callback. It checks a
pre-login `401`, the resulting Platform binding/tenant/membership/identity, the
protected session `200`, and the `__Host-0000-access` cookie attributes. The
provider is simulated outbound GitHub only; no live provider or public write is
used.

Without `COMPOSITION_PHASE`, the runner continues through the browser draft,
revocation, outage, changed-context, logout, and actual Platform-backed
realtime checks. Realtime frames are summarized as safe counts/statuses; the
runner never records credentials, cookies, OAuth state/code URLs, SQL values, or
message bodies. `fixture.mjs` is kept beside Platform because it uses the
Platform runner's temporary bootstrap boundary while supplying only the
Communicator-owned local directory and projection fixture data.

Run the focused lifecycle probes with:

```sh
node --test services/platform/scripts/platform-browser-composition/fault-probes.test.mjs
```
