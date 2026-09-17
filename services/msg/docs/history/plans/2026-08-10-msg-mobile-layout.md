# msg.0000.chat Mobile Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public temporary conversation UI usable from 320 px through tablet widths.

**Architecture:** Keep one server-rendered page and one browser asset. Add a native mobile details disclosure, responsive CSS, and small runtime updates for duplicate mobile metadata targets.

**Tech Stack:** TypeScript, server-rendered HTML, CSS, browser JavaScript, Bun tests, Playwright.

---

### Task 1: Lock the responsive contract

**Files:**
- Modify: `apps/msg/src/browser.test.ts`

- [ ] Add failing assertions for the mobile details disclosure, sticky composer, safe-area padding, 44 px targets, and 320 px action stacking.
- [ ] Run `bun test apps/msg/src/browser.test.ts` and confirm the new assertions fail.

### Task 2: Implement the mobile structure

**Files:**
- Modify: `apps/msg/src/browser.ts`

- [ ] Add the complete mobile details disclosure with existing room actions.
- [ ] Update expiry and created-time rendering to support desktop and mobile targets.
- [ ] Add responsive styles for the compact header, collapsed details, sticky composer, transcript clearance, dialog sizing, and narrow controls.
- [ ] Run `bun test apps/msg/src/browser.test.ts` and confirm it passes.

### Task 3: Verify responsive behavior

**Files:**
- Modify if needed: `apps/msg/src/browser.ts`
- Modify if needed: `apps/msg/src/browser.test.ts`

- [ ] Run `bun run quality:fast` and `bun run quality:changed`.
- [ ] Check room and home pages in Chromium at 320 px, 390 px, and 760 px.
- [ ] Confirm there is no horizontal overflow, transcript content is visible, details open correctly, and the composer does not cover messages.
- [ ] Commit, finish the controlled worktree, and verify production deployment.
