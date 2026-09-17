# msg.0000.chat Theme Switcher Design

## Outcome

Add a visible Light, Dark, and System theme switcher to the temporary conversation prototype. The control must work on desktop and mobile. It must not add clutter to the conversation header.

## Placement

Add an **Appearance** section in the conversation room rail. Place it after **Share and export** and before **Trust and safety**.

The section contains one segmented control with three equal text choices:

- Light
- Dark
- System

The room rail moves above the conversation on a narrow viewport. The Appearance section stays in this mobile room panel.

## Behavior

- System is the default when no saved choice exists.
- Light always uses the light token set.
- Dark always uses the dark token set.
- System follows the operating-system color preference.
- If the operating-system preference changes while System is active, the page updates at once.
- Save the selected choice in browser local storage.
- If local storage is not available, keep the selected choice for the current page session.
- The switcher changes only presentation. It does not change conversation data or message behavior.

## Visual Design

Use the selected option 2 layout and the existing 0000 design system.

- Keep the light theme unchanged.
- Use a calm blue-gray dark theme.
- Use the same working-blue primary accent in both themes.
- Do not use pure black, neon colors, gradients, or hacker-console styling.
- Keep borders and tonal layers as the main separation method.
- Keep shadows limited to floating controls and the composer.
- Keep Markdown, code blocks, modal content, controls, the room rail, and toast messages readable in both themes.

The selected theme uses a clear filled or tinted state. Unselected choices use the normal rail surface.

## Accessibility

- Use a labeled radiogroup for the three choices.
- Each choice must expose its checked state.
- Keyboard users can focus and select each choice.
- The selected state must not depend on color alone.
- Focus rings must remain visible in both themes.
- Both themes must keep readable text and control contrast.
- System changes must not add animation.

## Implementation Structure

Add small theme helpers to the existing prototype module:

- Validate a stored theme choice.
- Resolve System to Light or Dark.
- Apply the resolved theme to the document root.
- Update the three controls and their accessibility state.
- Listen for operating-system changes only while System is active.

Use CSS custom properties for both theme token sets. Do not add a new dependency or a backend.

## Testing

Add tests before implementation for:

- Invalid stored values fall back to System.
- System resolves from the operating-system preference.
- Light and Dark ignore the operating-system preference.
- The HTML contains the labeled theme radiogroup and all three choices.
- The CSS contains explicit light and dark token sets.
- The mobile room panel keeps the Appearance section available.

After implementation:

- Run the prototype and development-server tests.
- Run the app lint and repository changed-path checks.
- Verify Light, Dark, and System in the browser.
- Verify the desktop rail and the narrow mobile layout.
- Verify there are no browser console errors.

## Non-goals

- No account-level preference sync.
- No server persistence.
- No additional themes.
- No automatic theme based on conversation content.
- No changes to message data, Markdown behavior, invitation behavior, or retention rules.
