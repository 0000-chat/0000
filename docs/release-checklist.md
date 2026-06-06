# Release Checklist

Use this checklist for public bridge source releases.

## Before Tagging

- Confirm the working tree is clean.
- Run `bun test`.
- Run `bun run typecheck`.
- Run `bun run sbom`.
- Run `bun run observability:check`.
- Run `bun run bridge:smoke-runtimes` on a real bridge machine.
- Run `bun run bridge:smoke-cloud` against a paired test bridge.
- If updating the updater, smoke update from the previous release to the new
  release.

## Provenance

Release notes must include:

- GitHub release URL.
- Passing CI run URL.
- SBOM artifact link or committed `sbom.cdx.json` reference.
- Source tag and commit SHA.
- Whether install, update, runtime discovery, or host contract behavior changed.
- Source-only note when there are no binary assets or checksums.

## Compatibility

- State the bridge contract version.
- List any new capability flags.
- Describe behavior for old hosts and old bridges.
- Call out update-required behavior if a host will stop assigning work to older
  bridge versions.

## Runtime Evidence

Record runtime smoke status for:

- Hermes ACP
- Zed Codex ACP
- Claude Code ACP
- OpenClaw ACP
- one custom ACP command

If a runtime is blocked by local installation or provider authentication, mark it
as blocked with the exact diagnostic reason. Do not record it as passed until a
live prompt produces assistant output.
