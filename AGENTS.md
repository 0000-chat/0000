# 0000 Bridge

This repository is the public local ACP bridge for connecting coding agents to
0000 Chat. The main app/backend repository is separate and lives at
`/home/ubuntu/0000-chat`.

## Repository

- Local checkout: `/home/ubuntu/0000`
- GitHub remote: `https://github.com/0000-chat/0000.git`
- Default branch: `main`
- Package name: `@0000-chat/0000`

The main app does not import this repository as a package dependency. During
agent connection setup, 0000 Chat generates an install command that clones this
repo and registers the bridge with the user's account.

## Development

Use this checkout for bridge runtime changes:

```bash
cd /home/ubuntu/0000
bun install
bun test
bun run typecheck
```

Common scripts:

- `bun run bridge`: run the bridge CLI.
- `bun run bridge:enroll`: enroll a Machine; add `--register-agent` to enroll an agent target.
- `bun run bridge:connect`: legacy shortcut for agent enrollment from a 0000 Chat Machine enrollment code.
- `bun run bridge:start`: start the paired bridge.
- `bun test`: run bridge tests.
- `bun run typecheck`: run TypeScript checking.

MCP tool-surface updates:

- The bridge vendors the app's portable MCP manifest snapshot in
  `scripts/agent-tool-manifest-snapshot.ts`.
- After changing `/home/ubuntu/0000-chat/apps/convex/convex/agentToolManifest.ts`,
  first update/check the app snapshot in `/home/ubuntu/0000-chat`, then refresh the
  bridge snapshot with:

```bash
bun scripts/generate-agent-tool-manifest-snapshot.ts /home/ubuntu/0000-chat --write
bun scripts/generate-agent-tool-manifest-snapshot.ts /home/ubuntu/0000-chat --check
```

- `--check` fails when the vendored bridge snapshot drifts from the app's
  `scripts/agent-tool-mcp-manifest.snapshot.json`.

## Change Workflow

For coding-agent work, create a normal feature branch from `main`:

```bash
cd /home/ubuntu/0000
git checkout main
git pull --ff-only origin main
git checkout -b codex/<short-name>
```

Before handing work back or pushing:

```bash
bun test
bun run typecheck
git status --short
```

Push bridge changes to the public bridge repo, not the main app repo:

```bash
git push -u origin codex/<short-name>
```

Use direct pushes to `main` only when the human explicitly asks for that path.

## Boundaries

- Do not copy private app/backend source into this repository.
- Do not commit local pairing files, tokens, logs, or status files.
- Local bridge state belongs under `~/.0000/`, especially:
  - `~/.0000/bridge.json`
  - `~/.0000/bridge-status.json`
- Keep the bridge's app integration over authenticated HTTPS polling and public
  API contracts.
- If a change requires Convex schema, settings UI, connection-code generation,
  or queue/API changes, make the app-side change in `/home/ubuntu/0000-chat`.
