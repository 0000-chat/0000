# msg service rules

Keep msg Worker code, CLI code, configuration, and service documentation in
this directory. Root workspace changes should stay limited to the service
manifest, lockfile, and root README when the service needs them.

Run bun run check from this directory before handoff. This check covers the
Worker, Wrangler tooling, and CLI. Run the monorepo root checks after changing
workspace integration.

Do not put secrets, generated caches, node_modules, or deployment output in
Git. Generate Worker types with the service wrangler:types script. Do not edit
worker/worker-configuration.d.ts by hand.

Keep logs metadata-only. Do not log message text, capabilities, tokens,
authorization data, or full request content.

Treat docs/history as reference only. Do not use those plans or runbooks as
current deployment instructions.

This migration does not change the old source repository, deployment workflow,
production route, or production cutover.
