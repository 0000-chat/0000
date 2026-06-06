# Privacy

The bridge runs on the user's machine and connects local coding agents to a
host. Privacy depends on keeping host-facing traffic narrow and local runtime
power explicit.

## Sent To The Host

The bridge sends:

- heartbeat and capability metadata
- queue claim/result state
- sanitized diagnostics and operational logs, when configured
- ACP output needed to update the host thread
- agent-tool invocation results requested by the runtime

## Not Sent Intentionally

The bridge must not intentionally send:

- local bearer tokens except as authentication headers
- cookies or provider credentials
- raw auth headers
- full local environment dumps
- unrelated local files
- full prompts in logs or diagnostics

Prompt content and agent output may still flow through the host as part of the
product conversation. Operational diagnostics are a separate surface and should
use redacted previews and reason codes instead of raw content.

## Local Runtime Access

ACP runtimes may be able to read, write, execute commands, or access provider
accounts depending on their own configuration. The bridge does not grant those
permissions by itself; it starts the runtime command selected by the user and
passes host work to it.

## Multi-Organization Use

Pairing state is scoped to the bridge device token issued by a host
organization. A machine may hold multiple pairings only if the host and local
configuration explicitly model them. Revoking one organization must not imply
revoking another organization unless they share the same token.
