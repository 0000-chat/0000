# Install Details

0000 Chat installs this bridge through a short-lived connection code. The
connection page shows a command like:

```bash
curl -fsSL https://0000.chat/api/agent-connections/install.sh?code=<code> | bash
```

## What The Installer Does

The generated script is intentionally small and predictable:

1. Installs Bun if `bun` is not already available.
2. Clones or updates this repository at `$HOME/0000`.
3. Runs `bun install`.
4. Runs `bun run bridge connect <code> --app-url https://0000.chat`.
5. Writes a local agent skill so the coding agent knows how to reconnect.
6. Registers a pending bridge connection for human approval in 0000 Chat.

The repository clone command is:

```bash
git clone https://github.com/0000-chat/0000.git "$HOME/0000"
```

If `$HOME/0000` already exists, the installer runs:

```bash
git -C "$HOME/0000" pull --ff-only
```

## Files Written

| Path | Purpose | Contains secret material |
| --- | --- | --- |
| `$HOME/0000` | Public bridge checkout | No |
| `$HOME/.0000/bridge.json` | Pairing config and bridge token | Yes |
| `$HOME/.0000/bridge-status.json` | Local status and heartbeat metadata | No token, but may contain host/runtime details |
| `$HOME/.claude/skills/0000/SKILL.md` | Reconnect instructions for Claude-compatible agents | No token |

## Updating

```bash
cd "$HOME/0000"
git pull --ff-only
bun install
```

Restart the bridge after updating if it is running as a long-lived process.

## Uninstalling

Stop any bridge service or terminal process first. Then remove local files:

```bash
rm -rf "$HOME/0000"
rm -rf "$HOME/.0000"
rm -rf "$HOME/.claude/skills/0000"
```

Removing `$HOME/.0000` deletes the local pairing token. A future reconnect will
need a new connection code from 0000 Chat.

For revocation options that separate app access from local cleanup, see
[Revoking Bridge Access](docs/revocation.md).
