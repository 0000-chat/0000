# 0000 Bridge

Connect local ACP-compatible coding agents to 0000 Chat.

This repo contains the public bridge runtime only. It does not include the
private 0000 Chat app, Convex schema, generated Convex client, or production
secrets.

Useful trust and operations docs:

- [Install details](INSTALL.md)
- [Configure the bridge](docs/configure.md)
- [Update the bridge](docs/update.md)
- [Runtime support](docs/runtime-support.md)
- [Lifecycle contract](docs/lifecycle.md)
- [Diagnostics](docs/diagnostics.md)
- [Privacy](docs/privacy.md)
- [Host adapter contract](docs/host-adapter.md)
- [Network behavior](docs/network.md)
- [Permissions](docs/permissions.md)
- [ACP runtime smoke checks](docs/runtime-smoke.md)
- [Threat model](docs/threat-model.md)
- [Dependencies](docs/dependencies.md)
- [Release process](docs/release-process.md)
- [Release checklist](docs/release-checklist.md)
- [Revoking bridge access](docs/revocation.md)
- [Security policy](SECURITY.md)
- [Agent contributor guide](AGENTS.md)

## Install From A Connection Code

In 0000 Chat, generate an agent connection code from Agents settings. Then
paste the generated prompt into your local agent. It will fetch instructions
from:

```text
https://0000.chat/connect/<code>
```

The setup command installed by 0000 Chat clones this repo into `~/0000` and
registers the bridge against your 0000 Chat account:

```bash
git clone https://github.com/0000-chat/0000.git "$HOME/0000"
cd "$HOME/0000"
bun install
bun run bridge connect "$CODE" --app-url "https://0000.chat"
```

After the human approves the pending agent in 0000 Chat, start the bridge:

```bash
cd "$HOME/0000"
bun run bridge start
```

For local bridge development, run the dev supervisor instead:

```bash
bun run bridge:dev -- --agent-command "/home/ubuntu/.local/bin/hermes acp"
```

The supervisor watches `scripts/acp-bridge.ts` and `scripts/acp-bridge/**`.
When those files change, it waits until `~/.0000/bridge-status.json` reports no
in-flight commands or running session queues, then restarts the bridge. Idle ACP
sessions do not block a restart. This is a developer-only workflow; customer
installs should use `bun run bridge start`.

## Runtime Commands

By default the bridge starts `hermes acp`. You can connect other ACP runtimes:

```bash
bun run bridge start --runtime-command "npx --yes @agentclientprotocol/codex-acp@1.1.4"
bun run bridge start --runtime-command "npx -y @agentclientprotocol/claude-agent-acp@0.39.0"
```

You can provide multiple runtime commands. 0000 Chat will surface them as
available bridge profiles.

By default, package-backed runtime commands use pinned package versions. ACP
runtime sessions ignore remote queue-provided working directories unless you
start with `--allow-remote-cwd` or `ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD=1`.

## Files Written Locally

The bridge keeps its local pairing state under:

```text
~/.0000/bridge.json
~/.0000/bridge-status.json
```

`bridge.json` and `bridge-status.json` are written with owner-only `0600`
permissions. The bridge repairs the `bridge.json` mode when it starts.

The default Claude skill install path used by connection-code setup is:

```text
~/.claude/skills/0000/SKILL.md
```

## Development

```bash
bun install
bun test
bun run typecheck
```

The public bridge currently uses authenticated HTTPS polling to receive work
from 0000 Chat. It intentionally avoids importing private app code or generated
Convex APIs.
