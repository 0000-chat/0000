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

## Evidence Boundaries

This smoke check proves local ACP runtime initialization. It does not by itself
prove that a paired 0000 organization can import the profile, claim queued work,
deliver a thread message, stop a running turn, steer a session, or complete
mailbox delegation. Use the 0000 app's bridge diagnostics and the runtime smoke
check together when debugging an end-to-end bridge issue.

On the OVH bridge machine on 2026-06-05, the local smoke matrix showed:

- Hermes ACP: `pass`
- Codex ACP: `pass`
- Claude Code ACP: `pass`
- OpenClaw ACP: `fail`, with ACP initialize timing out or returning
  `ECONNREFUSED 127.0.0.1:18789`

Treat OpenClaw as unproven until its local gateway is running and ACP initialize
returns successfully.
