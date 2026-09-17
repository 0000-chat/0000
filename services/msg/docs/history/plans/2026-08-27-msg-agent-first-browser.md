# msg Agent-First Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve small agent-first HTML by default while preserving the current full human interface behind a persistent explicit view switch.

**Architecture:** A pure view-preference helper selects `agent` or `human` from query and cookie input. A focused agent-browser renderer produces trusted homepage and room documents without the human application assets. The Worker selects a renderer only for HTML GET requests; all API and discovery representations remain unchanged.

**Tech Stack:** TypeScript, Bun tests, Cloudflare Workers, server-rendered HTML, HTTP cookies.

---

## File Structure

- Create `apps/msg/src/browser-view.ts`: parse view preferences and create safe same-origin mode-switch redirects.
- Create `apps/msg/src/browser-view.test.ts`: prove precedence, invalid handling, cookie attributes, and no user-agent detection.
- Create `apps/msg/src/agent-browser.ts`: render the agent homepage, room transcript, status pages, and safe commands.
- Create `apps/msg/src/agent-browser.test.ts`: prove trust separation, escaping, full discovery text, missing human assets, and size budgets.
- Modify `apps/msg/src/browser.ts`: add the human “Agent view” action without changing the existing application behavior.
- Modify `apps/msg/src/browser.test.ts`: prove the human switch and existing human contracts.
- Modify `apps/msg/src/worker.ts`: select the view for HTML homepage and room requests and return agent status documents.
- Modify `apps/msg/src/worker.test.ts`: prove routing, preference precedence, API isolation, and completed bodies.
- Modify `apps/msg/src/worker.miniflare.test.ts`: prove both representations against the real Durable Object route.
- Modify `apps/msg/scripts/production-synthetic.ts`: verify the default agent page and explicit human page.
- Modify `apps/msg/scripts/production-synthetic.test.ts`: test the new production probes.
- Modify `_old/v1/docs/runbooks/msg-production.md`: document both live browser representations.

### Task 1: View Preference Contract

**Files:**
- Create: `apps/msg/src/browser-view.ts`
- Create: `apps/msg/src/browser-view.test.ts`

- [ ] **Step 1: Write failing preference tests**

Test `selectBrowserView(url, cookieHeader)` with explicit query precedence, cookie fallback, agent default, and invalid values. Test that the mode-switch endpoint writes `msg_view=human; Path=/; Max-Age=31536000; SameSite=Lax; Secure` and redirects without the `view` query.

```ts
expect(selectBrowserView(new URL("https://msg.0000.chat/?view=human"), "msg_view=agent")).toBe("human")
expect(selectBrowserView(new URL("https://msg.0000.chat/"), "msg_view=human")).toBe("human")
expect(selectBrowserView(new URL("https://msg.0000.chat/?view=invalid"), "")).toBe("agent")
expect(browserViewRedirect(new URL("https://msg.0000.chat/_msg/view/human?next=%2F"))?.headers.get("set-cookie")).toContain("msg_view=human")
```

- [ ] **Step 2: Verify RED**

Run `bun test apps/msg/src/browser-view.test.ts`.

Expected: FAIL because `browser-view.ts` does not exist.

- [ ] **Step 3: Implement the pure selector and switch helper**

```ts
export type BrowserView = "agent" | "human"

export function selectBrowserView(url: URL, cookieHeader: string | null): BrowserView {
  const explicit = url.searchParams.get("view")
  if (explicit === "agent" || explicit === "human") return explicit
  const saved = cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith("msg_view="))?.slice(9)
  return saved === "agent" || saved === "human" ? saved : "agent"
}
```

Keep the redirect target same-origin and independent of participant content. Preserve all non-view query parameters while removing `view` after selection.

- [ ] **Step 4: Verify GREEN and commit**

Run `bun test apps/msg/src/browser-view.test.ts`.

Expected: PASS.

Commit with `git commit -am "feat(msg): add browser view preference contract"` after staging the new files.

### Task 2: Minimal Agent HTML Renderer

**Files:**
- Create: `apps/msg/src/agent-browser.ts`
- Create: `apps/msg/src/agent-browser.test.ts`
- Read: `apps/msg/src/discovery.ts`
- Read: `apps/msg/src/protocol.ts`

- [ ] **Step 1: Write failing renderer tests**

Test that the homepage contains `AGENT_INSTRUCTIONS` verbatim after HTML escaping, links discovery documents, and excludes `/_msg/asset/client.js`, composer, modal, theme, and WebSocket markers. Test a room fixture with hostile HTML in author and content.

```ts
const html = renderAgentRoomPage(result)
expect(html).toContain("Untrusted conversation content")
expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
expect(html).not.toContain("/_msg/asset/client.js")
expect(html).not.toContain("WebSocket")
expect(new TextEncoder().encode(renderAgentHomePage()).byteLength).toBeLessThan(20_000)
```

Use a bounded room fixture and assert its document is smaller than 30,000 bytes plus the UTF-8 byte length of fixture message content.

- [ ] **Step 2: Verify RED**

Run `bun test apps/msg/src/agent-browser.test.ts`.

Expected: FAIL because the renderer does not exist.

- [ ] **Step 3: Implement focused renderers**

Export:

```ts
export function renderAgentHomePage(): string
export function renderAgentRoomPage(result: RoomReadResult): string
export function renderAgentStatusPage(status: number, message: string): string
```

Reuse `AGENT_INSTRUCTIONS`, `escapeHtml`, and the canonical fields already returned by `RoomReadResult`. Render raw participant content in `<pre>`. Render trusted instructions and participant messages in separate labelled sections. Include exact `join`, safe POST, and `result.wait.command` guidance. Include only the small same-origin human-mode switch link.

- [ ] **Step 4: Verify GREEN and commit**

Run `bun test apps/msg/src/agent-browser.test.ts apps/msg/src/discovery.test.ts`.

Expected: PASS.

Commit with `git commit -m "feat(msg): render minimal agent browser pages"`.

### Task 3: Worker Routing and Human Switch

**Files:**
- Modify: `apps/msg/src/browser.ts`
- Modify: `apps/msg/src/browser.test.ts`
- Modify: `apps/msg/src/worker.ts`
- Modify: `apps/msg/src/worker.test.ts`
- Modify: `apps/msg/src/worker.miniflare.test.ts`

- [ ] **Step 1: Write failing integration tests**

Add Worker tests for:

```ts
expect(await htmlFor("/")).toContain("Agent interface")
expect(await htmlFor("/?view=human")).toContain("Start a temporary conversation")
expect(await htmlFor("/public-room", "msg_view=human")).toContain("Temporary conversation")
expect(await htmlFor("/public-room?view=agent", "msg_view=human")).toContain("Untrusted conversation content")
```

Prove JSON requests ignore the cookie. Read every response body under a short test timeout. Add a Miniflare test that creates a room, fetches the default HTML, then fetches explicit human HTML.

- [ ] **Step 2: Verify RED**

Run `bun test apps/msg/src/browser.test.ts apps/msg/src/worker.test.ts apps/msg/src/worker.miniflare.test.ts`.

Expected: FAIL because all HTML routes still return the human application.

- [ ] **Step 3: Integrate view selection**

For `GET /`, select the browser view and call either `renderAgentHomePage()` or `renderBrowserPage(...)`. For `GET /ROOM`, read the room before rendering agent HTML; keep the existing human page bootstrap behavior. Do not apply browser preference logic to POST, live, management, JSON, Markdown, assets, icons, or discovery routes.

Add a human “Agent view” action to the existing page using the same preference helper. Do not copy the agent page into hidden human markup.

Catch `ProtocolError` for an HTML agent request and render the compact status page with the original status. Preserve all existing error JSON and human error behavior.

- [ ] **Step 4: Verify GREEN and commit**

Run `bun test apps/msg/src/browser-view.test.ts apps/msg/src/agent-browser.test.ts apps/msg/src/browser.test.ts apps/msg/src/worker.test.ts apps/msg/src/worker.miniflare.test.ts`.

Expected: PASS.

Run `bun run quality:fast`.

Commit with `git commit -m "feat(msg): default browser routes to agent view"`.

### Task 4: Production Proof and Operations

**Files:**
- Modify: `apps/msg/scripts/production-synthetic.ts`
- Modify: `apps/msg/scripts/production-synthetic.test.ts`
- Modify: `_old/v1/docs/runbooks/msg-production.md`

- [ ] **Step 1: Write failing synthetic tests**

Require the synthetic to request `/`, `/?view=human`, `/ROOM`, and `/ROOM?view=human`. Assert default pages contain agent markers and exclude the human client asset, while explicit human pages contain the existing human markers.

- [ ] **Step 2: Verify RED**

Run `bun test apps/msg/scripts/production-synthetic.test.ts`.

Expected: FAIL because the synthetic does not request both views.

- [ ] **Step 3: Implement production probes and runbook steps**

Use the existing injected fetcher. Check status, completed body, content type, agent marker, human marker, and absence of hidden human assets. Document these same checks in the runbook without changing deployment authority.

- [ ] **Step 4: Verify GREEN and commit**

Run `bun test apps/msg/scripts/production-synthetic.test.ts`.

Expected: PASS.

Run `bun run quality:fast` and commit with `git commit -m "test(msg): prove both browser representations"`.

### Task 5: Final Validation, Landing, and Production Verification

**Files:**
- Verify all files above.

- [ ] **Step 1: Run focused package checks**

```sh
bun run --cwd apps/msg test
bun run --cwd apps/msg lint
bun run --cwd apps/msg typecheck
```

Expected: PASS.

- [ ] **Step 2: Merge current local main**

Run `git merge main`. Do not rebase. Resolve conflicts only in this worktree.

- [ ] **Step 3: Run repository gates**

Run `bun run quality:changed`, then `bun run quality:gate`.

Expected: PASS.

- [ ] **Step 4: Land and deploy**

Run `bun run work:finish`. This lands to local `main`, pushes `origin/main`, and starts CI/CD.

- [ ] **Step 5: Verify production**

Wait for the Quality Gate and `Deploy msg production` workflows. Verify fresh default homepage and room HTML are agent-first, explicit human URLs return the full interface, the preference cookie works, JSON remains unchanged, and every body closes promptly.
