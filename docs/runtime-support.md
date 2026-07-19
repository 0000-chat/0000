# Runtime Support

The bridge talks to ACP-compatible runtimes. The host-facing API stays stable,
while runtime adapters remain intentionally adaptable because ACP
implementations differ.

## Supported Runtime Classes

| Runtime | Status | Notes |
| --- | --- | --- |
| Hermes ACP | Supported | Default runtime command; supports normal prompt work and capability discovery. |
| Codex ACP | Supported | Uses the pinned `@agentclientprotocol/codex-acp@1.1.4` adapter, which includes a compatible `@openai/codex` dependency. |
| Claude Code ACP | Supported when locally authenticated | Initialization can pass while prompt work fails if the local Claude provider session is logged out. |
| OpenClaw ACP | Supported with gateway auth | Requires the local gateway and matching remote token configuration. |
| Custom ACP command | Supported | Use `--runtime-command` or the runtime smoke `--custom-command` option. |

The Codex ACP adapter normally runs the compatible Codex executable bundled by
its package dependency. Set `CODEX_PATH` only when intentionally overriding
that executable. Runtime diagnostics report the launched adapter package
version; they do not treat an unrelated `codex` executable on `PATH` as the
adapter-effective Codex version.

## Runtime Capabilities

The bridge should surface capabilities reported or inferred from each runtime,
including:

- session close/cancel support
- resume/list/fork support
- model and reasoning options, when exposed by the runtime
- structured user input support
- command/tool catalogs
- runtime-specific diagnostics

For user attachments from 0000 Chat, the bridge sends image attachments as ACP
`image` content blocks with temporary HTTPS URIs, and sends other files as ACP
`resource_link` content blocks. This keeps image pixels on the normal prompt
image path for runtimes such as Hermes, while avoiding embedded attachment
bytes in prompt payloads. If a runtime explicitly opts out with
`_meta["0000.chat/promptResourceLinks"] === false`, the bridge degrades to text
attachment references that include only metadata and temporary access URLs.

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
