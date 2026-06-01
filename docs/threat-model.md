# Threat Model

The 0000 bridge is designed for users who want local control over the coding
agent process while still using 0000 Chat as the coordination surface.

## Assets

- Bridge pairing token in `$HOME/.0000/bridge.json`.
- User prompts and agent responses.
- Local files reachable by the selected agent runtime.
- 0000 Chat account and approved bridge device.

## Trust Boundaries

- The bridge runs on the user's machine.
- 0000 Chat queues work and receives events over authenticated HTTPS.
- The selected ACP runtime, such as Hermes, Codex ACP, or Claude ACP, performs
  local agent work according to its own permissions and approval model.
- The public bridge repo is separate from the private 0000 Chat app/backend.

For a more direct capability breakdown, see [Permissions](permissions.md).

## Main Risks

- A stolen bridge token could let another process impersonate the bridge.
- A malicious or compromised local agent runtime could access local files.
- Prompts or responses could contain sensitive information.
- Logs could accidentally include identifiers, paths, or content useful to an
  attacker.
- Installer changes could surprise users if they are not visible and auditable.

## Mitigations

- Keep bridge tokens local and out of git.
- Use HTTPS for all app communication.
- Keep install behavior documented and reviewable in this public repository.
- Keep dependencies minimal and visible.
- Sanitize bridge logs before forwarding them.
- Require human approval for pending bridge connections.
- Let users delete `$HOME/.0000/bridge.json` to revoke local pairing material.

## User Controls

- Inspect this repository before installing or updating.
- Run the bridge from a dedicated checkout at `$HOME/0000`.
- Stop the bridge process at any time.
- Delete local pairing state under `$HOME/.0000`.
- Use the app's bridge/device settings to approve or remove bridge access.
