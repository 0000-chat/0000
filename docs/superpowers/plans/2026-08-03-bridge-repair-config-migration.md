# Bridge Repair Config Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Use TDD for each behavior change.

**Goal:** Make the installer repair stale local bridge API origins and make invalid bridge commands fail clearly.

**Architecture:** The bridge config remains the local source for authenticated API routing. `repair-config --app-url <public-origin>` reads the existing single or multi-registration config, updates only registrations whose `appUrl` matches the requested public origin, and writes them with `bridgeApiUrl` set to that public origin. This repairs the known stale `https://platform-actions.0000.chat` value without changing registrations for another environment. CLI parsing keeps help as a successful command but identifies unsupported commands so the process reports an error and exits nonzero.

**Security:** Never print bridge tokens or full config contents. Use the existing config reader and atomic, owner-only writer. Do not change unrelated registrations. Do not perform network calls during repair.

---

## Task 1: Add failing CLI and migration tests

**Files:**
- Modify: `scripts/acp-bridge.test.ts`
- Inspect: `scripts/acp-bridge.ts`

- [ ] Verify worktree `/home/ubuntu/.config/superpowers/worktrees/0000/codex-bridge-repair-config-migration`, branch `codex/bridge-repair-config-migration`, and base `97306fc1cfe716393a2a235f4f308be531b302c6`.
- [ ] Add a test that runs `repair-config --app-url https://0000.chat` against a temporary legacy or version-2 config and expects a stale `bridgeApiUrl` to become `https://0000.chat`.
- [ ] Add a multi-registration test that preserves a registration whose `appUrl` targets another environment.
- [ ] Add an idempotence assertion for an already-canonical registration.
- [ ] Add a CLI process test that an unsupported command prints an error and exits nonzero, while explicit help still exits zero.
- [ ] Run the focused test and capture the RED failures before implementation.

## Task 2: Implement the minimal repair and command failure

**Files:**
- Modify: `scripts/acp-bridge.ts`
- Modify if needed: `README.md` or `docs/configure.md`

- [ ] Add `repair-config` to the recognized bridge commands and help text.
- [ ] Require `--app-url` or `ZERO_CHAT_APP_URL` for repair.
- [ ] Normalize the public origin consistently with existing URL helpers.
- [ ] Read the selected config path with existing helpers, update only matching registrations, and write it through the existing owner-only config writer.
- [ ] Print only a count and safe path or origin summary. Never print tokens.
- [ ] Distinguish missing or explicit help from unsupported commands. Unsupported commands must set exit code 1.
- [ ] Run the focused tests until GREEN.

## Task 3: Validate and commit

- [ ] Run `bun test scripts/acp-bridge.test.ts`.
- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
- [ ] Run `git diff --check`.
- [ ] Review config scoping, file mode preservation, token redaction, idempotence, and help/unknown exit behavior.
- [ ] Commit as `fix(bridge): repair stale API config origins`.
- [ ] Report exact worktree, branch, base range, commit SHA, RED proof, GREEN tests, and validation results.
- [ ] Do not push, land, deploy, reset, stash, discard, or modify `/home/ubuntu/0000` canonical state.
