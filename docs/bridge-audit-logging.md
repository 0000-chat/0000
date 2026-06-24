# Bridge Audit Logging

The bridge writes a local diagnostic flight recorder to help answer why a bridge
stopped, restarted, or stopped claiming work. The log is local-first so it still
works when Convex, Axiom, or the network is unavailable.

## Local Audit Log

Default path:

```bash
~/.0000/bridge-audit.jsonl
```

Override path:

```bash
ZERO_CHAT_BRIDGE_AUDIT_LOG=/path/to/bridge-audit.jsonl
```

Disable local audit writes:

```bash
ZERO_CHAT_BRIDGE_AUDIT_DISABLED=1
```

The audit directory is written as `0700`, the log file as `0600`, and rotation
starts at 10 MiB with five retained rotated files. Entries are JSONL and redact
tokens, auth headers, prompts, raw command lines, stdout/stderr bodies, full
payloads, and local queue/thread/session identifiers.

## systemd Drop-In

Create `~/.config/systemd/user/0000-chat-bridge.service.d/90-audit.conf`:

```ini
[Service]
Environment=ZERO_CHAT_BRIDGE_AUDIT_LOG=%h/.0000/bridge-audit.jsonl
ExecStopPost=/home/ubuntu/.bun/bin/bun /home/ubuntu/0000-bridge-prod/scripts/bridge-systemd-stop-snapshot.ts --unit 0000-chat-bridge.service
```

## Companion Monitor Service

Create `~/.config/systemd/user/0000-chat-bridge-audit-monitor.service`:

```ini
[Unit]
Description=0000 Chat bridge systemd audit monitor
After=default.target

[Service]
Type=simple
Environment=ZERO_CHAT_BRIDGE_AUDIT_LOG=%h/.0000/bridge-audit.jsonl
ExecStart=/home/ubuntu/.bun/bin/bun /home/ubuntu/0000-bridge-prod/scripts/bridge-systemd-call-monitor.ts --unit 0000-chat-bridge.service
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then install and restart:

```bash
systemctl --user daemon-reload
systemctl --user enable --now 0000-chat-bridge-audit-monitor.service
systemctl --user restart 0000-chat-bridge.service
```

Smoke check:

```bash
tail -n 20 ~/.0000/bridge-audit.jsonl
```

Look for `bridge.systemd.unit_call`, `bridge.signal.received`,
`bridge.supervisor.child_exited`, and `bridge.systemd.stop_snapshot`.
