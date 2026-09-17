# msg.0000.chat Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the independent anonymous `msg.0000.chat` relay through the repository production workflow.

**Architecture:** A dedicated Cloudflare Worker routes representation-aware HTTP requests to one SQLite Durable Object per room. A small D1 database owns encrypted operations records, while static assets provide the approved responsive browser client.

**Tech Stack:** Bun, TypeScript, Cloudflare Workers, Durable Objects, SQLite, D1, WebSocket Hibernation, Miniflare, HTML, CSS, and browser JavaScript.

---

### Task 1: Worker foundation and protocol contracts

- [x] Add the `apps/msg` workspace, typed protocol contracts, request parsing, content negotiation, stable errors, security headers, discovery documents, and focused failing-first tests.
- [x] Add the root and health routes with an injectable room service boundary.
- [x] Verify targeted tests, run `quality:fast`, self-review, and commit.

### Task 2: Durable room storage and realtime

- [x] Add the SQLite-backed `ConversationRoom`, schema initialization, ordered immutable messages, idempotent writes, cursor reads, quotas, expiry alarms, tombstones, and hibernating WebSockets.
- [x] Add Miniflare integration coverage for concurrency, retries, restarts, quotas, sockets, deletion, and alarms.
- [x] Verify targeted tests, run `quality:fast`, self-review, and commit.

### Task 3: Production browser experience

- [x] Port the approved prototype into `apps/msg` without changing the approved visual language.
- [x] Replace fixtures with HTTP and WebSocket state while preserving safe Markdown, long-message expansion, jump-to-latest, first-visit guidance, prompt copy, themes, mobile behavior, accessibility, and transcript exports.
- [x] Add UI tests for live, pending, retry, offline, limited, deleted, and expired states.
- [x] Verify targeted tests, run `quality:fast`, self-review, and commit.

### Task 4: Abuse, operations, and privacy

- [x] Add D1 migrations and encrypted creation-idempotency and abuse-report storage.
- [x] Add authenticated operator routes and a safe repository operator command for health, reports, forced deletion, kill switches, and diagnostics.
- [x] Add truthful privacy, terms, and abuse pages plus privacy-classified observability events.
- [x] Test encryption, D1 failure isolation, operator authentication, capability redaction, origin checks, and security headers.
- [x] Verify targeted tests, observability checks, `quality:fast`, self-review, and commit.

### Task 5: Deployment, rollback, and production proof

- [x] Add the app Wrangler configuration, Durable Object migration, D1 binding, assets, custom domain, typed environment, and dry-run checks.
- [x] Add an independent post-quality deployment workflow with previous-version capture, production synthetic room verification, and automatic rollback on failure.
- [x] Add the operator runbook and extend changed-path quality classification for `apps/msg` and its deployment files.
- [x] Run targeted tests, `quality:changed`, and a Wrangler dry run; self-review and commit.

### Task 6: Final review, landing, and release verification

- [x] Review the complete diff against the approved design and fix all critical or important findings.
- [x] Confirm the public contact and policy prerequisites without printing secrets. V1 uses the encrypted abuse-report endpoint and does not publish unconfigured email addresses.
- [ ] Merge local `main` into the task worktree, run `quality:gate`, and use `work:finish` to land and push.
- [ ] Watch the independent deployment workflow and verify the live health, discovery, create/read/post/delete flow, and rollback status at `https://msg.0000.chat`.
