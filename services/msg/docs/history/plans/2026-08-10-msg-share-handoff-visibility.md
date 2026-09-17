# msg Share Handoff and Message Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return complete sharing instructions after creation and show conversation messages immediately on first visit.

**Architecture:** Generate a deterministic `share_message` in the room service and document it in agent and OpenAPI discovery. Keep the invitation modal as an explicit action, but remove its automatic first-visit trigger.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, Bun tests, server-rendered HTML and browser JavaScript.

---

### Task 1: Specify the handoff response

- [ ] Add a failing room-service test for the exact copy-and-paste handoff text.
- [ ] Add failing discovery tests requiring agents to return `share_message` verbatim and requiring its OpenAPI response schema.
- [ ] Run focused tests and confirm the new assertions fail.

### Task 2: Implement the handoff response

- [ ] Update `DurableRoomService.create` to return the complete handoff text.
- [ ] Update `/agent.txt` and `/llms.txt` instructions.
- [ ] Add the create response schema and example to OpenAPI.
- [ ] Run focused tests and confirm they pass.

### Task 3: Make the transcript visible first

- [ ] Add a failing browser runtime test that rejects automatic modal opening.
- [ ] Remove the first-visit modal trigger and its obsolete dismissal storage.
- [ ] Keep explicit invite and copy actions unchanged.
- [ ] Run browser tests and confirm they pass.

### Task 4: Validate and deploy

- [ ] Run `bun run quality:fast` and `bun run quality:changed`.
- [ ] Commit the intended changes and merge local `main`.
- [ ] Run `bun run work:finish`.
- [ ] Monitor CI and production deployment.
- [ ] Verify live sharing instructions and the original conversation page.
