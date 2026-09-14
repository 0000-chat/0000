# Communicator Conversation Shell UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Conversations route into a dense, full-height, responsive messenger workspace without changing any authoritative data or command behavior.

**Architecture:** Keep `ConversationsShell` as the data boundary and introduce focused presentational components for provider icons and sortable channels. Use dnd-kit’s compatible legacy React packages for pointer/touch/keyboard sorting, with a handle-only activator and the existing `onReorder` callback. Use CSS grid/flex viewport constraints to isolate panel scroll regions; keep all existing React Query, routing, identity checks, realtime updates, and composer mutation logic intact.

**Tech Stack:** React 19, TypeScript, TanStack Router/Query, Tailwind CSS v4, lucide-react, dnd-kit legacy React packages, Simple Icons package data, Vitest + Testing Library, Playwright.

---

## Files and responsibilities

Create:

- `apps/control-plane/src/features/conversations/provider-icon.tsx` — local provider branding and accessible fallback.
- `apps/control-plane/src/features/conversations/provider-icon.test.tsx` — provider mapping and accessibility tests.
- `apps/control-plane/src/features/conversations/sortable-channel-list.tsx` — sortable connected channels with pinned All support.
- `apps/control-plane/src/features/conversations/sortable-channel-list.test.tsx` — reorder callback, pinned All, keyboard affordance, and no-arrow tests.

Modify:

- `apps/control-plane/package.json` and `pnpm-lock.yaml` — add compatible dnd-kit and Simple Icons dependencies.
- `apps/control-plane/src/features/conversations/channel-sidebar.tsx` — compact channels panel and integration with sortable list.
- `apps/control-plane/src/features/conversations/conversation-list.tsx` — contiguous compact rows with provider icon/account identity.
- `apps/control-plane/src/features/conversations/conversations-shell.tsx` — full-height grid and independent column scroll containers.
- `apps/control-plane/src/features/conversations/conversation-page.tsx` — thread panel header/back control/timeline viewport/composer footer.
- `apps/control-plane/src/features/conversations/message-timeline.tsx` — compact messages and stable viewport content.
- `apps/control-plane/src/features/conversations/message-composer.tsx` — remove card/shadow treatment and keep footer content usable.
- `apps/control-plane/src/components/layout/app-shell.tsx` — full-bleed Conversations route content; preserve centered layouts elsewhere.
- `apps/control-plane/src/features/conversations/*.test.tsx` — focused regressions for the new presentation contract.
- `apps/control-plane/e2e/channel-conversations.spec.ts`, `responsive.spec.ts`, and `send-command.spec.ts` — viewport, sorting, scrolling, and safety journeys.

## Task 1: Install and pin local visual dependencies

**Files:** `apps/control-plane/package.json`, `pnpm-lock.yaml`

- [ ] Verify the documented compatible imports before editing: `@dnd-kit/core` for sensors/context, `@dnd-kit/sortable` for `SortableContext`/`useSortable`/`verticalListSortingStrategy`, `@dnd-kit/utilities` for `CSS.Transform.toString`; use `simple-icons` package exports for local SVG path data.
- [ ] Add runtime dependencies using the workspace package manager:

```bash
pnpm --filter @communicator/control-plane add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities simple-icons
```

- [ ] Confirm the lockfile contains the new packages and that no remote icon URL is introduced.
- [ ] Commit:

```bash
git add apps/control-plane/package.json pnpm-lock.yaml
git commit -m "build: add local conversation shell visual dependencies"
```

## Task 2: Add provider icon mapping

**Files:** create `provider-icon.tsx`, `provider-icon.test.tsx`

- [ ] Write the failing tests for WhatsApp, Telegram, Messenger, LinkedIn, and unknown values. Assert that known providers render an inline `svg` with `aria-hidden="true"`, accessible provider text remains in the surrounding row, and unknown values render the generic fallback without throwing.
- [ ] Run:

```bash
pnpm --filter @communicator/control-plane exec vitest run src/features/conversations/provider-icon.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] Implement a typed provider mapping using imported Simple Icons data (`siWhatsapp`, `siTelegram`, `siMessenger`, `siLinkedin`) and a generic `CircleHelp` fallback. Render the path data in a fixed 18px inline SVG with `focusable="false"` and `aria-hidden="true"`; do not use remote URLs.
- [ ] Re-run the focused test; expected PASS.
- [ ] Commit:

```bash
git add apps/control-plane/src/features/conversations/provider-icon.tsx apps/control-plane/src/features/conversations/provider-icon.test.tsx
git commit -m "feat: add local provider branding to conversations"
```

## Task 3: Build the sortable channel list

**Files:** create `sortable-channel-list.tsx`, `sortable-channel-list.test.tsx`

- [ ] Write failing tests for:
  - All renders first and has no drag handle or sortable attributes.
  - Connected channels render visible handle buttons with labels such as `Reorder Telegram`.
  - No `Move … up`/`Move … down` text or arrow controls render.
  - `onReorder` receives the new connected-channel order with All excluded from the persisted ids.
  - Keyboard activation on a handle exposes instructions/live status and moves an item through the same callback.

- [ ] Run the focused test and confirm the new component fails before implementation.
- [ ] Implement the list with:

```tsx
<DndContext
  sensors={useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))}
  collisionDetection={closestCenter}
  onDragEnd={({ active, over }) => { /* derive arrayMove and call onReorder */ }}
>
  <SortableContext items={connectedIds} strategy={verticalListSortingStrategy}>
    {/* All is rendered outside SortableContext, connected rows use useSortable */}
  </SortableContext>
</DndContext>
```

  Each sortable row attaches `setNodeRef`, `transform`, and `transition` to its row, but spreads `listeners` and `attributes` only on the dedicated handle button. Stop propagation from the handle so channel selection does not start when dragging. Add keyboard announcements for picked-up, moved, dropped, and cancelled states, plus a visually hidden instruction that explains Space/Arrow/Enter/Escape. Use `arrayMove` with stable channel ids and pass only connected channel ids to the persistence callback.
- [ ] Re-run the focused tests; expected PASS.
- [ ] Commit:

```bash
git add apps/control-plane/src/features/conversations/sortable-channel-list.tsx apps/control-plane/src/features/conversations/sortable-channel-list.test.tsx
git commit -m "feat: replace channel arrows with accessible sorting"
```

## Task 4: Compact the channel panel and conversation list

**Files:** `channel-sidebar.tsx`, `conversation-list.tsx`, their tests

- [ ] Add failing assertions for compact headers, provider icon/account identity, unread/status visibility, selected state, and distinct same-name channel labels.
- [ ] Replace the per-channel bordered card and arrow footer with a contiguous list. Keep All pinned above the sortable connected list. Preserve the manage-connection link for attention/disconnected channels.
- [ ] Render channel status using a small semantic status dot plus readable text; do not encode status with color alone. Use provider icon + provider label + display label; keep unread badges aligned.
- [ ] Change conversation rows to `min-h`-bounded, separator-driven links with provider icon, title, preview, time, unread badge, and provider/account label. Keep `data-testid`, `data-conversation-id`, `data-channel-id`, `aria-current`, and route search unchanged.
- [ ] Update component tests and run:

```bash
pnpm --filter @communicator/control-plane exec vitest run src/features/conversations/channel-sidebar.test.tsx src/features/conversations/conversation-list.test.tsx
```

- [ ] Commit:

```bash
git add apps/control-plane/src/features/conversations/channel-sidebar.tsx apps/control-plane/src/features/conversations/conversation-list.tsx apps/control-plane/src/features/conversations/channel-sidebar.test.tsx apps/control-plane/src/features/conversations/conversation-list.test.tsx
git commit -m "refactor: densify channel and conversation navigation"
```

## Task 5: Recompose the shell into full-height messenger regions

**Files:** `conversations-shell.tsx`, `app-shell.tsx`, shell tests

- [ ] Write failing layout assertions for no rounded outer workspace card, no large inset, panel header/body separation, desktop/tablet pane visibility, mobile list/thread pane visibility, and region overflow classes.
- [ ] In `AppShell`, add a route-aware class to the content wrapper by reading the current pathname (or use a small route-aware wrapper already present in the app) so `/conversations` gets `min-h-0 p-0` while other routes keep existing spacing. Keep the sticky app header and primary navigation breakpoints unchanged.
- [ ] In `ConversationsShell`, make the outer section `h-[calc(100dvh-4rem)] min-h-0 overflow-hidden`, use `grid` columns `[minmax(12rem,15rem)_minmax(17rem,22rem)_minmax(0,1fr)]`, and render each panel as `min-h-0 overflow-hidden border-r`. Put channel and conversation list bodies in `min-h-0 overflow-y-auto`; place compact headers outside them. Keep `ChannelSelector` only below `md`.
- [ ] Preserve all query enablement, URL navigation, channel order state, realtime scope checks, and unavailable/loading/error branches. Only move them into the correct panel body.
- [ ] Run focused shell tests and `pnpm check`; expected PASS.
- [ ] Commit:

```bash
git add apps/control-plane/src/features/conversations/conversations-shell.tsx apps/control-plane/src/components/layout/app-shell.tsx apps/control-plane/src/features/conversations/conversations-shell.test.tsx apps/control-plane/src/components/layout/app-shell.test.tsx
git commit -m "refactor: make conversations workspace full height"
```

## Task 6: Anchor the thread header, timeline, and composer

**Files:** `conversation-page.tsx`, `message-timeline.tsx`, `message-composer.tsx`, tests

- [ ] Add failing tests for desktop absence of the Back text link, mobile accessible back button, message viewport scrolling, composer-disabled disconnected state, and composer being outside the message list.
- [ ] Make the thread a `flex min-h-0 h-full flex-col` panel. Its header is `sticky top-0 z-[1]` within the panel, contains provider icon/account label, conversation title, unread badge, and a mobile-only icon button that navigates to `/conversations` with the existing identity/channel search.
- [ ] Put `MessageTimeline` in a `min-h-0 flex-1 overflow-y-auto` body with compact gap/padding and keep message articles in normal flow. The timeline must not own the composer or use browser-fixed positioning.
- [ ] Put `MessageComposer` in a non-scrolling footer with `shrink-0 border-t` and remove `rounded-xl bg-card shadow-sm`. Preserve all mutation and form code; only adjust layout classes so paced previews and status errors expand within the footer without covering messages.
- [ ] Run:

```bash
pnpm --filter @communicator/control-plane exec vitest run src/features/conversations/conversation-page.test.tsx src/features/conversations/message-composer.test.tsx
```

- [ ] Commit:

```bash
git add apps/control-plane/src/features/conversations/conversation-page.tsx apps/control-plane/src/features/conversations/message-timeline.tsx apps/control-plane/src/features/conversations/message-composer.tsx apps/control-plane/src/features/conversations/conversation-page.test.tsx apps/control-plane/src/features/conversations/message-composer.test.tsx
git commit -m "refactor: anchor conversation thread composer"
```

## Task 7: Extend browser journeys and capture branch evidence

**Files:** `apps/control-plane/e2e/channel-conversations.spec.ts`, `responsive.spec.ts`, `send-command.spec.ts`

- [ ] Add Playwright coverage at 1440×900 for four regions, no arrows, no rounded outer workspace, panel headers, and independent panel scrolling.
- [ ] Add 1024×768 coverage for the three messenger panels and hidden primary navigation.
- [ ] Add 390×844 coverage for mobile channel selector, one-pane list/thread flow, accessible back control, and the absence of the desktop text link.
- [ ] Add pointer and keyboard sorting journeys that navigate away and back, asserting order persists through the existing persistence callback; keep All first and undraggable.
- [ ] Assert no request leaves the local/simulated boundary and production/simulated fail-closed behavior remains unchanged.
- [ ] Run the branch preview on port 61466 only, capture clean screenshots to `/tmp/communicator-after-1087x789.png`, `/tmp/communicator-after-1440x900.png`, `/tmp/communicator-after-1024x768.png`, and `/tmp/communicator-after-390x844.png`, then inspect each image.
- [ ] Commit:

```bash
git add apps/control-plane/e2e/channel-conversations.spec.ts apps/control-plane/e2e/responsive.spec.ts apps/control-plane/e2e/send-command.spec.ts
git commit -m "test: cover responsive conversation shell polish"
```

## Task 8: Full verification and diff review

- [ ] Run exactly:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm --filter @communicator/control-plane test:e2e -- --retries=0
python3 -m unittest discover -s tests -v
git diff --check
git status --short
```

- [ ] Record the known pre-existing Python failure `tests/test_runtime_init.py::test_telegram_runtime_initializer_is_executable` if it remains with mode `0775` versus expected `0755`; do not change that file in this UI branch.
- [ ] Review `git diff main...HEAD` to confirm changes are limited to visual composition, accessibility affordances, dependency metadata, tests, and the focused design/plan docs. Confirm no production API, provider session, runtime permission, deployment, or credential changes.
