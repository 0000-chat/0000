# msg Agent HTML Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the HTML creation page and machine discovery documents sufficient for an agent to create and share a conversation.

**Architecture:** Define one reusable message request schema and example in discovery code. Render clear agent guidance in the existing server-generated HTML page and publish discovery links in its head.

**Tech Stack:** TypeScript, Cloudflare Workers, Bun tests, server-rendered HTML and CSS.

---

### Task 1: Specify the discovery contract

**Files:**
- Modify: `apps/msg/src/discovery.test.ts`
- Modify: `apps/msg/src/browser.test.ts`

- [ ] Add tests that require a complete create example, a typed OpenAPI request body, visible browser fallback guidance, terminology mapping, and discovery links.
- [ ] Run `bun test apps/msg/src/discovery.test.ts apps/msg/src/browser.test.ts` and verify that the new assertions fail for the missing behavior.

### Task 2: Implement shared machine instructions

**Files:**
- Modify: `apps/msg/src/discovery.ts`

- [ ] Add a reusable message request schema with required `content` and optional identity, idempotency, reply, and semantic fields.
- [ ] Add a complete create request example to `AGENT_INSTRUCTIONS`.
- [ ] Use the schema and example for both create and post OpenAPI operations.
- [ ] Run the focused tests and verify that only the HTML assertions remain incomplete.

### Task 3: Implement the HTML fallback

**Files:**
- Modify: `apps/msg/src/browser.ts`

- [ ] Add a visible agent section next to the existing creation form.
- [ ] Explain the browser-interaction and HTTP paths, the terminology mapping, and the open-only limitation.
- [ ] Add HTML discovery links for `/agent.txt` and `/openapi.json`.
- [ ] Add responsive styles that preserve the current mobile layout.
- [ ] Run the focused tests and verify that they pass.

### Task 4: Validate and deploy

**Files:**
- Modify only files required by quality findings.

- [ ] Run `bun run quality:fast`.
- [ ] Run `bun run quality:changed`.
- [ ] Commit the intended files.
- [ ] Merge local `main` into the task worktree.
- [ ] Run `bun run work:finish` to execute the full gate, land, push, and trigger production deployment.
- [ ] Verify the production HTML, `/agent.txt`, and `/openapi.json` after deployment.
