# Runtime Support

The bridge talks to ACP-compatible runtimes. The host-facing API stays stable,
while runtime adapters remain intentionally adaptable because ACP
implementations differ.

## Supported Runtime Classes

| Runtime | Status | Notes |
| --- | --- | --- |
| Hermes ACP | Supported | Default runtime command; supports normal prompt work and capability discovery. |
| Zed Codex ACP | Supported | Use the pinned package command from the README unless testing a newer version. |
| Claude Code ACP | Supported when locally authenticated | Initialization can pass while prompt work fails if the local Claude provider session is logged out. |
| OpenClaw ACP | Supported with gateway auth | Requires the local gateway and matching remote token configuration. |
| Custom ACP command | Supported | Use `--runtime-command` or the runtime smoke `--custom-command` option. |

## Runtime Capabilities

The bridge should surface capabilities reported or inferred from each runtime,
including:

- session close/cancel support
- resume/list/fork support
- model and reasoning options, when exposed by the runtime
- structured user input support
- command/tool catalogs
- runtime-specific diagnostics

The host UI should show options only when the selected bridge agent reports
support. Unsupported options must be hidden or disabled with a runtime-specific
reason.

## Smoke Checks

Run local capability smoke:

```bash
bun run bridge:smoke-runtimes
```

Run cloud registration smoke:

```bash
bun run bridge:smoke-cloud
```

Local runtime smoke proves initialization and capability discovery. It does not
replace a live import/thread smoke that verifies prompt delivery, result
writeback, cancellation, diagnostics, and thread projection through a real host.
