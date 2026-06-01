# 0000 Bridge

Connect local ACP-compatible coding agents to 0000 Chat.

This repo contains the public bridge runtime only. It does not include the
private 0000 Chat app, Convex schema, generated Convex client, or production
secrets.

Useful trust and operations docs:

- [Install details](INSTALL.md)
- [Network behavior](docs/network.md)
- [Permissions](docs/permissions.md)
- [Threat model](docs/threat-model.md)
- [Dependencies](docs/dependencies.md)
- [Release process](docs/release-process.md)
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

## Runtime Commands

By default the bridge starts `hermes acp`. You can connect other ACP runtimes:

```bash
bun run bridge start --runtime-command "npx --yes @zed-industries/codex-acp@latest"
bun run bridge start --runtime-command "npx -y @agentclientprotocol/claude-agent-acp"
```

You can provide multiple runtime commands. 0000 Chat will surface them as
available bridge profiles.

## Files Written Locally

The bridge keeps its local pairing state under:

```text
~/.0000/bridge.json
~/.0000/bridge-status.json
```

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
