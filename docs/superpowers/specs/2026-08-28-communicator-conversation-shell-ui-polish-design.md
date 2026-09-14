# Communicator Conversation Shell UI Polish Design

**Status:** Approved product feedback; implementation design

**Goal:** Refine the existing Conversations workspace into a dense, full-height messenger shell while preserving every data contract, isolation rule, command behavior, responsive flow, and simulated-data boundary.

## Scope and non-goals

This is a presentation and interaction refinement of the existing conversation shell. It changes layout composition, visual density, provider branding, channel sorting affordances, and viewport scrolling. It does not change API shapes, query keys, pagination semantics, connection ownership, identity or tenant checks, realtime filtering, command routing, send modes, unread aggregation, or Connections lifecycle behavior. No live provider, Matrix, Cloudflare, deployment, or production data path is added.

## Product hierarchy

The route keeps the current application header and primary navigation. At wide desktop sizes, the content area becomes four aligned regions: primary navigation, channels, conversations, and the active thread. At tablet widths the primary navigation remains in its existing menu and the three messenger regions remain visible. At mobile widths one task is visible at a time: conversation list, active thread, or the existing channel sheet.

The workspace uses the available dynamic viewport below the app header. It has no outer rounded card, shadow, or large side inset. Each region uses a one-pixel separator, a compact header outside its scrollable body, and `min-h-0`/`overflow-hidden` constraints so the browser window is not the message scroller.

## Visual and interaction decisions

- The desktop/tablet thread view has no text “Back to conversations” link. Mobile retains a compact icon-only back button in the sticky thread header with an accessible name.
- “All” is a pinned, non-sortable channel row. Connected channels are sortable from a visible handle only; selecting the row still selects the channel. Pointer, touch, and keyboard sorting all call the existing principal-plus-identity `onReorder` callback. Screen-reader instructions and live announcements describe the keyboard path. No visible up/down buttons remain.
- Channel rows are contiguous, compact inbox rows with a provider icon, account label, unread badge, health/status indicator, and drag handle. Provider icons are local Simple Icons package data rendered as inline SVG; they are decorative and paired with accessible text. WhatsApp, Telegram, Messenger, LinkedIn, and an unknown-provider fallback are mapped.
- Conversation rows are contiguous rows targeted at roughly 64–76px where content allows. They keep title, preview, timestamp, unread count, provider icon, account label, current state, and same-name channel distinction without card borders or large vertical gaps.
- The thread has a compact sticky header, a message-only scroll viewport, and a composer footer anchored inside the thread panel. The composer loses its outer card treatment while preserving direct/human-paced controls, idempotency, capability disabling, status/error messaging, and form accessibility. Long previews/errors remain in the footer flow rather than covering messages.
- Loading, empty, retry, disconnected, and unavailable states remain readable inside the relevant region and do not cause global page overflow.

## Component boundaries

- `provider-icon.tsx`: provider label/icon mapping and generic fallback.
- `sortable-channel-list.tsx`: dnd-kit sensors, sortable rows, pinned All, keyboard announcements, and the existing reorder callback.
- `channel-sidebar.tsx`: compact panel header, All row, channel list, connection-health context, and navigation to Connections.
- `conversation-list.tsx`: compact provider-aware inbox rows.
- `conversation-page.tsx`: thread panel layout, mobile back control, sticky header, message viewport, and composer footer.
- `message-timeline.tsx`: compact message bubbles within the supplied viewport.
- `message-composer.tsx`: footer-friendly composer styling only; business logic stays unchanged.
- `conversations-shell.tsx`: full-height three-panel messenger layout and responsive pane visibility.
- `app-shell.tsx`: full-bleed Conversations route handling while non-conversation routes retain their existing centered content treatment.

The current dnd-kit legacy React API is compatible with the requested handle-only behavior: `DndContext`, `SortableContext`, `useSortable`, `arrayMove`, and `CSS.Transform.toString`. The current official docs also document a newer `@dnd-kit/react` API, so dependency versions and imports will be pinned to the compatible legacy packages rather than mixing APIs.

## Responsive and scroll contract

- Desktop (`xl` and above): primary navigation + channels + conversations + thread.
- Tablet (`md` through `xl`): channels + conversations + thread; primary navigation remains menu-only.
- Mobile (below `md`): channel selector sheet + one conversation-list or thread pane; thread back control returns to the list.
- The app content beneath the header has a bounded height based on `100dvh` minus the header. Channel body, conversation body, and message timeline can scroll independently. Panel headers remain visible and composer placement is stable while messages scroll.

## Validation

Unit/component tests cover provider mapping, pinned All, callback-based reorder, keyboard sorting without arrow buttons, compact metadata, mobile/desktop back behavior, disconnected composer state, and composer placement. Playwright covers 1440px, 1024px, 390×844, pointer/keyboard reorder persistence, independent scrolling, sticky headers, composer anchoring, absence of card/arrow regressions, fail-closed simulation behavior, and no external request boundary violations.

The before/after viewport evidence is captured on port 61465 for the baseline and port 61466 for the branch. Clean screenshots stay in `/tmp` unless the repository gains a dedicated visual-artifact convention.
