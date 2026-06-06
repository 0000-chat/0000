# Update The Bridge

The bridge is distributed as source. Installed machines update by fetching this
repository and running the updater or normal package install flow.

## Bridge-Managed Update

0000 Chat can ask a running bridge to update itself from the bridge devices
settings. That internal helper is launched by the bridge with the repository
path and restart command; external users do not run `bun run bridge:update`
directly.

The updater is responsible for moving between compatible source releases and
preserving local pairing files under `~/.0000/`.

## Manual Update

For development or recovery:

```bash
cd "$HOME/0000"
git fetch --tags --force origin "v0.1.7"
git checkout --detach "v0.1.7"
bun install
bun test
```

Do not delete `~/.0000/bridge.json` unless you intentionally want to unpair the
machine.

## Compatibility

The bridge reports a contract version and capability flags to the host. Hosts
should use those flags for old/new bridge negotiation instead of relying on
product rollout feature flags. Unknown capabilities must be ignored by older
hosts, and missing capabilities must degrade to explicit unsupported behavior.

## Update Required

When a host requires a newer bridge contract, it should stop assigning new work
to the old bridge, surface a clear update-required diagnostic, and keep existing
local pairing state valid so the user can update in place.
