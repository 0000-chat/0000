# Install Details

0000 Chat installs this bridge through a short-lived Machine enrollment code. The
enrollment page shows a command like:

```bash
curl -fsSL "https://0000.chat/api/machine-enrollments/install.sh?code=<code>&registerAgent=true" | bash
```

## What The Installer Does

The generated script is intentionally small and predictable:

1. Installs Bun if `bun` is not already available.
2. Clones or updates this repository at `$HOME/0000` to the release tag chosen
   by the installer.
3. Runs `bun install`.
4. Runs `bun run bridge enroll <code> --app-url https://0000.chat --register-agent`.
5. Writes a local agent skill so the coding agent knows how to reconnect.
6. Registers a pending Machine and agent target for human approval in 0000 Chat.

The repository clone command is currently:

```bash
BRIDGE_REF="v0.1.9"
git clone --branch "$BRIDGE_REF" --depth 1 https://github.com/0000-chat/0000.git "$HOME/0000"
```

If `$HOME/0000` already exists, the installer refuses to overwrite local
checkout changes, then fetches and checks out the same release tag:

```bash
git -C "$HOME/0000" diff --quiet
git -C "$HOME/0000" diff --cached --quiet
git -C "$HOME/0000" fetch --tags --force origin "$BRIDGE_REF"
git -C "$HOME/0000" checkout --detach "$BRIDGE_REF"
```

## Manual Install

If you do not want to run `curl | bash`, inspect this repository first and run
the same steps manually:

```bash
git clone --branch "v0.1.9" --depth 1 https://github.com/0000-chat/0000.git "$HOME/0000"
cd "$HOME/0000"
bun install
bun run bridge enroll "<machine-enrollment-code>" --app-url "https://0000.chat" --register-agent --skill-path "$HOME/.claude/skills/0000/SKILL.md" --install-mode "manual"
```

After 0000 Chat shows the pending Machine and agent target, approve them in the app, then start:

```bash
cd "$HOME/0000"
bun run bridge start
```

Machine enrollment codes are short lived. Generate a fresh code from 0000 Chat when
you are ready to run the manual command.

## Files Written

| Path | Purpose | Contains secret material |
| --- | --- | --- |
| `$HOME/0000` | Public bridge checkout | No |
| `$HOME/.0000/bridge.json` | Pairing config and bridge token | Yes |
| `$HOME/.0000/bridge-status.json` | Local status and heartbeat metadata | No token, but may contain host/runtime details |
| `$HOME/.claude/skills/0000/SKILL.md` | Reconnect instructions for Claude-compatible agents | No token |

`bridge.json` and `bridge-status.json` are written with owner-only `0600`
permissions. The bridge repairs the `bridge.json` mode on startup if the file
already exists.

## Updating

0000 Chat can ask a running bridge to update from the bridge devices settings.
When the bridge receives `updateWhenIdle`, it waits until no ACP work is
running, starts a short-lived updater helper, exits, and lets the helper:

1. Refuse to update if the local checkout has uncommitted changes.
2. Fetch immutable release tags from `origin`.
3. Check out the newest stable tag newer than the running bridge version.
4. Run `bun install`.
5. Restart the same bridge command.

The updater only uses stable tags like `v0.1.2`; prerelease or malformed tags
are ignored. If there is no newer tag, it restarts the bridge without changing
the checkout.

Manual updates use the same tag-based model:

```bash
cd "$HOME/0000"
git fetch --tags --force origin "v0.1.9"
git checkout --detach "v0.1.9"
bun install
```

Restart the bridge after manually updating if it is running as a long-lived
process.

## Safer Runtime Defaults

The built-in Codex and Claude ACP runtime command examples use pinned package
versions instead of `@latest`. ACP runtime sessions ignore remote queue-provided
working directories by default. To opt in for trusted automation, start the
bridge with:

```bash
bun run bridge start --allow-remote-cwd
```

Remote bridge log forwarding is also off by default. To opt in, pass
`--log-url <url>` or set `ZERO_CHAT_BRIDGE_LOG_URL`.

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
