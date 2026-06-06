# ACP Runtime Smoke Checks

Use the runtime smoke check when you need to verify which local ACP-compatible
agent runtimes this bridge can initialize on the current machine.

```bash
bun run bridge:smoke-runtimes
```

The command prints a redacted markdown table with one row for:

- Hermes ACP
- Codex ACP
- Claude Code ACP
- OpenClaw ACP
- any custom ACP command passed with `--custom-command`

Rows are classified as:

- `pass`: the runtime binary/profile was discovered and ACP `initialize`
  returned successfully.
- `fail`: the runtime/profile was discovered, but ACP initialization failed.
- `blocked`: the expected runtime binary or custom profile was not discovered on
  this machine.

## OpenClaw Gateway Auth

OpenClaw ACP connects through the local OpenClaw gateway. When gateway auth is
enabled, `openclaw acp` must have a client token that matches the gateway auth
token. If the smoke matrix reports `openclaw_gateway_token_missing`, configure
OpenClaw so `gateway.remote.token` matches `gateway.auth.token`, or register a
custom runtime command that passes `--token` or `--token-file`.

To repair a local OpenClaw install, prefer OpenClaw's own configuration helpers
instead of copying tokens into bridge config. For example, use
`openclaw config get gateway.auth.token` and
`openclaw config set gateway.remote.token ...` locally, without pasting the
token into logs, shell history, issue trackers, or chat threads.

By default the command probes only ACP initialization and runtime capabilities.
This keeps the smoke check bounded and avoids long-lived handles in package
adapter runtimes. To also attempt ACP available-command discovery, run:

```bash
bun run bridge:smoke-runtimes -- --include-commands
```

To include a custom ACP runtime:

```bash
bun run bridge:smoke-runtimes -- --custom-command "my-acp-agent --stdio"
```

For machine-readable output:

```bash
bun run bridge:smoke-runtimes -- --json
```

## Cloud Registration Smoke

Use the cloud smoke check when you need to verify that the bridge registrations
in `~/.0000/bridge.json` can authenticate, heartbeat, and poll the 0000 bridge
queue endpoint:

```bash
bun run bridge:smoke-cloud
```

The default cloud smoke is intentionally non-claiming. It does not take queued
work. When you are deliberately running a live bridge smoke window and want to
prove the claim endpoint too, pass:

```bash
bun run bridge:smoke-cloud -- --include-claim
```

Rows that fail with `bridge_credentials_invalid` or
`bridge_device_not_paired` usually mean the local config contains a stale
registration from an older pairing. Reconnect that organization or remove the
stale registration from the local bridge config before running long-lived
bridge workers.

## Evidence Boundaries

This smoke check proves local ACP runtime initialization. It does not by itself
prove that a paired 0000 organization can import the profile, claim queued work,
deliver a thread message, stop a running turn, steer a session, or complete
mailbox delegation. Use the 0000 app's bridge diagnostics and the runtime smoke
check together when debugging an end-to-end bridge issue.

On the OVH bridge machine on 2026-06-05, the local smoke matrix initially showed:

- Hermes ACP: `pass`
- Codex ACP: `pass`
- Claude Code ACP: `pass`
- OpenClaw ACP: `fail` before gateway setup, then
  `openclaw_gateway_token_missing` after the gateway was running but the ACP
  client token was not configured.

After configuring `gateway.remote.token`, the same machine reported:

- Hermes ACP: `pass`
- Codex ACP: `pass`
- Claude Code ACP: `pass`
- OpenClaw ACP: `pass`

Treat OpenClaw as unproven until its local gateway is running, gateway client
auth is configured, and ACP initialize returns successfully.
