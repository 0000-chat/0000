# Network Behavior

The bridge communicates with 0000 Chat over HTTPS. It does not import private
app code or generated backend clients.

## Endpoints

| Endpoint | Direction | Purpose | Auth |
| --- | --- | --- | --- |
| `/api/agent-connections/install.sh?code=<code>` | Download from app | Fetch connection-code installer | Short-lived connection code |
| `/api/agent-connections/register` | Bridge to app | Register a pending bridge for approval | Short-lived connection code |
| `/api/agent-bridge/validate` | Bridge to app | Validate bridge token and device id | Bridge bearer token |
| `/api/agent-bridge/claim` | Bridge to app | Claim queued work for this bridge | Bridge bearer token |
| `/api/agent-bridge/events` | Bridge to app | Post normalized agent events and results | Bridge bearer token |
| `/api/agent-bridge/logs` | Bridge to app | Forward sanitized operational logs | Bridge bearer token |

The app URL is provided during pairing. Production installs use
`https://0000.chat`.

## Data Sent

The bridge sends the minimum data needed to run queued agent work:

- Bridge device id and bearer token.
- Runtime profile metadata such as runtime name and command.
- Queue item ids and status updates.
- Agent event payloads returned by the local ACP runtime.
- Sanitized operational logs for bridge health and debugging.

## Data Not Sent Intentionally

The bridge should not send:

- Local environment variables other than explicit bridge configuration.
- API keys, auth headers, cookies, or provider credentials.
- Pairing tokens in logs.
- Arbitrary local files.
- Private app/backend source code.

Agent runtimes may receive prompts that ask them to inspect or edit local files.
Those actions are controlled by the local agent runtime and its approval model,
not by hidden bridge code.

