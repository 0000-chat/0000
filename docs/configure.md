# Configure The Bridge

The bridge is host-agnostic ACP infrastructure with a 0000 Chat host adapter.
Configuration is split between local runtime settings and host-provided queue
settings.

## Local Pairing

`bun run bridge connect <code> --app-url <url>` writes local pairing state to
`~/.0000/bridge.json`. That file stores the host URL, bridge device identity,
and bearer token needed for realtime ticket issuance and authenticated durable
operations. Do not commit it.

The default production host is:

```bash
bun run bridge connect "$CODE" --app-url "https://0000.chat"
```

## Runtime Commands

The bridge can expose one or more ACP-compatible runtime commands as profiles.
If no runtime command is provided, it uses the default Hermes ACP command.

```bash
bun run bridge start --runtime-command "hermes acp"
bun run bridge start --runtime-command "bunx @zed-industries/codex-acp@0.16.0"
bun run bridge start --runtime-command "npx -y @agentclientprotocol/claude-agent-acp@0.39.0"
```

Multiple commands can be supplied so the host can import them as separate agent
profiles. Runtime capabilities are reported when the bridge obtains its Device
Room ticket and may include close, resume, command catalogs, model options, and
input support depending on the ACP implementation.

## Working Directory Policy

Queue-provided working directories are ignored by default. Enable them only when
the host and user explicitly trust remote cwd selection:

```bash
bun run bridge start --allow-remote-cwd
ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD=1 bun run bridge start
```

## Log Forwarding

Bridge logs are local by default. If a host provides an authenticated log
endpoint, configure forwarding with the host URL/token produced during pairing.
Forwarded logs must remain operational diagnostics only; prompts, secrets,
tokens, cookies, and full user content must not be logged.

## Local Files

The bridge writes:

| Path | Purpose |
| --- | --- |
| `~/.0000/bridge.json` | Pairing token and host URL |
| `~/.0000/bridge-status.json` | Local bridge status projection |
| `~/.0000/restart-handoff.json` | Short-lived restart/update handoff hints |
| `~/.0000/bridge.sqlite` | Durable supervisor state and journal, when enabled |

These files are user-local state and must stay out of source control.
