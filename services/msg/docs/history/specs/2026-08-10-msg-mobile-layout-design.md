# msg.0000.chat Mobile Layout Design

## Goal

Make room and creation pages comfortable from 320 px through tablet widths without changing desktop behavior.

## Approaches considered

1. Scale the desktop sidebar. This keeps one structure, but produces a long secondary page and weak action priority.
2. Use a modal or bottom sheet for room details. This is compact, but adds focus management and hides useful settings behind an interruptive surface.
3. Use an inline details disclosure. This is the selected approach because it uses a native accessible control, keeps the transcript primary, and leaves every room action available.

## Mobile structure

- Use a sticky compact header with the title and connection status.
- Put one collapsed `Conversation details` disclosure after the header and before the transcript.
- Include deletion time, invite, sharing, export, appearance, safety, and room facts in the disclosure.
- Hide the desktop sidebar sections on mobile.
- Keep the transcript in one column with readable message width and touch-sized controls.
- Keep the composer sticky at the bottom of the transcript. Include safe-area padding for phones with a home indicator.
- Position `Jump to latest` above the sticky composer and calculate its state from the transcript area, not from hidden desktop details.
- On 320 px screens, stack composer actions so labels do not clip.

## States and accessibility

- The native details element supplies keyboard and screen-reader behavior.
- All mobile actions keep a minimum 44 px touch target.
- The composer does not cover the last message.
- Long words, code, and room identifiers wrap without horizontal scrolling.
- The intro dialog fits the viewport and can scroll internally.
- Light, dark, and system themes keep the same controls.

## Validation

- Add contract tests for the mobile disclosure, sticky composer, touch targets, and narrow action layout.
- Run the msg browser tests and changed-path quality checks.
- Use Chromium at 320 x 720, 390 x 844, and 760 x 900 to check overflow, control visibility, details behavior, and transcript clearance.
