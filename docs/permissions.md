# Permissions

The bridge connects 0000 Chat to an ACP-compatible local agent runtime. It does
not grant hidden operating-system permissions by itself, but it can ask the
local runtime to do work.

## What The Bridge Can Do

- Poll 0000 Chat for queued work after pairing.
- Start the configured ACP runtime command, such as `hermes acp`.
- Pass prompts, thread context, and tool configuration to that runtime.
- Forward normalized runtime events and results back to 0000 Chat.
- Forward sanitized operational logs for bridge health.
- Expose 0000 Chat MCP tools to the runtime for app data and actions.

## What The Bridge Cannot Do By Itself

- Bypass the local runtime's approval model.
- Read arbitrary local files unless the selected runtime chooses to do so.
- Access provider credentials that are not available to the local runtime.
- Claim work without a valid bridge token.
- Continue after the local process is stopped or the token is revoked.

## What The Local Runtime Controls

The selected runtime controls local file access, shell access, edit approvals,
and model/provider credentials. Review that runtime's own trust and approval
model before connecting it to 0000 Chat.

## What 0000 Chat Controls

0000 Chat controls bridge pairing, queued work, app data access through the MCP
tools, and bridge removal from app settings. Removing a bridge in 0000 Chat
prevents that bridge token from claiming new work.

## User Checks

- Inspect the runtime command before starting the bridge.
- Use a dedicated working directory when connecting a coding agent.
- Keep the bridge token in `$HOME/.0000/bridge.json` private.
- Revoke unused bridges in 0000 Chat.
- Stop the local process when you do not want the agent available.

