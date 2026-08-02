# Network Behavior

The bridge communicates with 0000 Chat over HTTPS. It does not import private
app code or generated backend clients.

## Endpoints

| Endpoint | Direction | Purpose | Auth |
| --- | --- | --- | --- |
| `/api/machine-enrollments/install.sh?code=<code>` | Download from app | Fetch Machine enrollment installer | Short-lived Machine enrollment code |
| `/api/machine-enrollments/register` | Bridge to app | Register a pending Machine and optional agent target for approval | Short-lived Machine enrollment code |
| `/api/agent-bridge/validate` | Bridge to app | Validate bridge token and device id | Bridge bearer token |
| `/api/agent-bridge/claim` | Bridge to app | Claim queued work for this bridge | Bridge bearer token |
| `/api/agent-bridge/events` | Bridge to app | Post normalized agent events and results | Bridge bearer token |
| `/api/agent-bridge/logs` | Bridge to app | Forward sanitized operational logs when log forwarding is explicitly configured | Bridge bearer token |

The app URL is provided during pairing. Production installs use
`https://0000.chat`.

Older bridge versions can use the legacy agent-connection endpoints. New
installations use the Machine enrollment endpoints above.

## Data Sent

The bridge sends the minimum data needed to run queued agent work:

- Bridge device id and bearer token.
- Runtime profile metadata such as runtime name and command.
- Queue item ids and status updates.
- Agent event payloads returned by the local ACP runtime, including agent
  transcript events, tool calls, and tool results that the runtime emits.
- Sanitized operational logs for bridge health and debugging, only when
  `--log-url` or `ZERO_CHAT_BRIDGE_LOG_URL` is configured.

The bridge token is also passed to the selected ACP runtime when configuring
0000 MCP helper tools, so the runtime can call bridge-authenticated app tools.
Only run runtimes you trust with that local bearer token.

## Data Not Sent Intentionally

The bridge does not independently scan and upload:

- Local environment variables other than explicit bridge configuration.
- API keys, auth headers, cookies, or provider credentials.
- Pairing tokens in logs.
- Arbitrary local files.
- Private app/backend source code.

Agent runtimes may receive prompts that ask them to inspect or edit local files.
Those actions are controlled by the local agent runtime and its approval model,
not by hidden bridge code. If the selected runtime includes secrets, local file
contents, or credentials in its normal transcript or tool-result events, those
events can be sent back to 0000 Chat as part of agent execution.
