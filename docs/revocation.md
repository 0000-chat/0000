# Revoking Bridge Access

You can revoke a bridge at the app level, the local machine level, or both.

## In 0000 Chat

Open the bridge or agent settings page and remove the bridge device. This stops
that device from claiming new work with its existing token.

## On The Local Machine

Stop the bridge process first. If it runs under systemd:

```bash
systemctl --user stop 0000-chat-bridge.service
systemctl --user disable 0000-chat-bridge.service
```

Then delete local pairing state:

```bash
rm -f "$HOME/.0000/bridge.json"
rm -f "$HOME/.0000/bridge-status.json"
```

Deleting `bridge.json` removes the local bridge token. Reconnecting later
requires a new connection code from 0000 Chat.

The file is expected to be owner-only readable and writable:

```bash
chmod 600 "$HOME/.0000/bridge.json"
```

## Full Local Removal

To remove the public bridge checkout and Claude-compatible reconnect skill too:

```bash
rm -rf "$HOME/0000"
rm -rf "$HOME/.claude/skills/0000"
```

If another service manager starts the bridge, remove or disable that service as
well.
