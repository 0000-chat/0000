# msg.0000.chat Theme Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Light, Dark, and System appearance control to the responsive msg.0000.chat prototype and publish the complete option 2 redesign.

**Architecture:** Keep the prototype self-contained. Add pure theme-choice helpers and a small DOM initializer to `prototype.js`, add a labeled segmented radiogroup and dark token set to `index.html`, and keep the existing room-rail responsive behavior. Browser storage holds the choice, while `matchMedia` resolves and updates System mode.

**Tech Stack:** Static HTML and CSS, browser JavaScript modules, Bun tests, Playwright browser checks, the existing Bun development-artifact server.

---

### Task 1: Theme choice model

**Files:**
- Modify: `apps/dev/msg-prototype.test.js`
- Modify: `apps/dev/public/msg-0000-chat/prototype.js`

- [ ] **Step 1: Write failing theme-choice tests**

Add these assertions inside the existing prototype test suite:

```js
test("normalizes stored theme choices", () => {
  expect(prototypeModule?.normalizeThemeChoice("light")).toBe("light")
  expect(prototypeModule?.normalizeThemeChoice("dark")).toBe("dark")
  expect(prototypeModule?.normalizeThemeChoice("system")).toBe("system")
  expect(prototypeModule?.normalizeThemeChoice("unknown")).toBe("system")
  expect(prototypeModule?.normalizeThemeChoice(null)).toBe("system")
})

test("resolves the visible theme from the choice and system preference", () => {
  expect(prototypeModule?.resolveThemeChoice("light", true)).toBe("light")
  expect(prototypeModule?.resolveThemeChoice("dark", false)).toBe("dark")
  expect(prototypeModule?.resolveThemeChoice("system", false)).toBe("light")
  expect(prototypeModule?.resolveThemeChoice("system", true)).toBe("dark")
})
```

- [ ] **Step 2: Run the tests and confirm the expected failure**

Run:

```bash
bun test apps/dev/msg-prototype.test.js
```

Expected: the two new tests fail because `normalizeThemeChoice` and `resolveThemeChoice` are not exported.

- [ ] **Step 3: Add the pure theme-choice helpers**

Add this near the existing constants in `prototype.js`:

```js
const THEME_CHOICES = new Set(["light", "dark", "system"])
const THEME_STORAGE_KEY = "0000:theme-choice:v1"

export function normalizeThemeChoice(value) {
  return THEME_CHOICES.has(value) ? value : "system"
}

export function resolveThemeChoice(choice, prefersDark) {
  const normalized = normalizeThemeChoice(choice)
  if (normalized === "system") {
    return prefersDark ? "dark" : "light"
  }
  return normalized
}
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
bun test apps/dev/msg-prototype.test.js
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit the theme-choice model**

```bash
git add apps/dev/msg-prototype.test.js apps/dev/public/msg-0000-chat/prototype.js
git commit -m "feat(dev): add prototype theme choice model"
```

### Task 2: Responsive appearance control and dark tokens

**Files:**
- Modify: `apps/dev/msg-prototype.test.js`
- Modify: `apps/dev/public/msg-0000-chat/index.html`
- Modify: `apps/dev/public/msg-0000-chat/prototype.js`

- [ ] **Step 1: Write failing markup and behavior contract tests**

Add this test:

```js
test("contains a responsive light dark and system appearance control", async () => {
  const html = await readFile(artifactPath, "utf8")
  const prototypeSource = await readFile(moduleUrl, "utf8")

  expect(html).toContain('role="radiogroup"')
  expect(html).toContain('aria-label="Appearance"')
  expect(html.match(/data-theme-option=/g)?.length).toBe(3)
  expect(html).toContain('data-theme-option="light"')
  expect(html).toContain('data-theme-option="dark"')
  expect(html).toContain('data-theme-option="system"')
  expect(html).toContain(':root[data-theme="dark"]')
  expect(html).toContain('.theme-switcher')
  expect(prototypeSource).toContain('querySelectorAll("[data-theme-option]")')
  expect(prototypeSource).toContain('prefers-color-scheme: dark')
})
```

- [ ] **Step 2: Run the test and confirm the expected failure**

Run:

```bash
bun test apps/dev/msg-prototype.test.js
```

Expected: the new test fails because the switcher markup, dark tokens, and initializer do not exist.

- [ ] **Step 3: Add the Appearance section**

In `index.html`, add this room-rail section after **Share and export** and before **Trust and safety**:

```html
<section class="rail-section appearance-section">
  <h2 class="rail-title">Appearance</h2>
  <div class="theme-switcher" role="radiogroup" aria-label="Appearance">
    <button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="light">Light</button>
    <button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="dark">Dark</button>
    <button class="theme-option" type="button" role="radio" aria-checked="false" data-theme-option="system">System</button>
  </div>
</section>
```

Add segmented-control styles:

```css
.theme-switcher {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-soft);
}

.theme-option {
  min-height: 36px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  color: var(--muted-strong);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}

.theme-option[aria-checked="true"] {
  color: var(--accent);
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(15 23 42 / 8%);
}
```

- [ ] **Step 4: Add the explicit dark token set**

Add a `:root[data-theme="dark"]` block after the light root variables. Use these tokens:

```css
:root[data-theme="dark"] {
  --canvas: #101828;
  --surface: #182230;
  --surface-soft: #202b3c;
  --surface-blue: #17345f;
  --ink: #f2f4f7;
  --muted: #98a2b3;
  --muted-strong: #cbd5e1;
  --line: #344054;
  --line-strong: #475467;
  --accent: #84adff;
  --accent-hover: #a4c2ff;
  --accent-soft: #244f8f;
  --focus: rgb(132 173 255 / 35%);
  --danger: #fda29b;
  --shadow-float: 0 12px 32px rgb(0 0 0 / 28%);
}
```

Replace fixed light-only surface colors in the room rail, sticky header, composer fade, code treatment, and dialog with token-based colors. Add a dark icon filter for non-primary Tabler icon assets. Keep the primary Invite icon white.

- [ ] **Step 5: Initialize and persist the selected theme**

Add this initializer to `prototype.js` after `canUseLocalStorage`:

```js
function initializeThemeSwitcher(documentObject, windowObject) {
  const controls = [...documentObject.querySelectorAll("[data-theme-option]")]
  const systemPreference = windowObject.matchMedia("(prefers-color-scheme: dark)")
  const storageAvailable = canUseLocalStorage(windowObject)
  let choice = normalizeThemeChoice(
    storageAvailable ? windowObject.localStorage.getItem(THEME_STORAGE_KEY) : "system",
  )

  const applyChoice = () => {
    const resolved = resolveThemeChoice(choice, systemPreference.matches)
    documentObject.documentElement.dataset.theme = resolved
    documentObject.documentElement.dataset.themeChoice = choice
    documentObject.documentElement.style.colorScheme = resolved

    controls.forEach((control) => {
      control.setAttribute("aria-checked", String(control.dataset.themeOption === choice))
    })
  }

  controls.forEach((control) => {
    control.addEventListener("click", () => {
      choice = normalizeThemeChoice(control.dataset.themeOption)
      if (storageAvailable) {
        windowObject.localStorage.setItem(THEME_STORAGE_KEY, choice)
      }
      applyChoice()
    })
  })

  systemPreference.addEventListener("change", () => {
    if (choice === "system") {
      applyChoice()
    }
  })

  applyChoice()
}
```

Call `initializeThemeSwitcher(documentObject, windowObject)` at the start of `initializePrototype`.

- [ ] **Step 6: Run focused tests and lint**

Run:

```bash
bun test apps/dev/msg-prototype.test.js
bun run --cwd apps/dev lint
```

Expected: all tests pass and lint reports zero warnings and zero errors.

- [ ] **Step 7: Commit the appearance control**

```bash
git add apps/dev/msg-prototype.test.js apps/dev/public/msg-0000-chat/index.html apps/dev/public/msg-0000-chat/prototype.js
git commit -m "feat(dev): add prototype theme switcher"
```

### Task 3: Browser verification and design QA

**Files:**
- Create: `design-qa.md`
- Create locally: `/tmp/msg-option-2-desktop.png`
- Create locally: `/tmp/msg-option-2-mobile.png`
- Create locally: `/tmp/msg-option-2-comparison.png`

- [ ] **Step 1: Start the worktree artifact server**

Run:

```bash
DEV_ARTIFACTS_PORT=4177 bun run --cwd apps/dev start
```

Expected: the server stays active and serves `/msg-0000-chat/`.

- [ ] **Step 2: Verify the desktop experience**

Use a 1440 by 1024 browser viewport. Dismiss the first-visit modal, then verify:

- The conversation and right room rail match the selected option 2 hierarchy.
- Light, Dark, and System each update the visible theme.
- The saved theme remains after reload.
- Copy link, Download Markdown, Invite your agent, Show full message, Post reply, and Jump to latest still work.
- No browser console errors occur.

Save the screenshot as `/tmp/msg-option-2-desktop.png`.

- [ ] **Step 3: Verify the mobile experience**

Use a 390 by 844 browser viewport. Verify:

- The room rail stacks above the conversation.
- The Appearance control remains visible and usable.
- The three theme choices fit without horizontal overflow.
- The composer, invitation action, and Jump to latest control remain reachable.
- The page has no horizontal overflow.
- No browser console errors occur.

Save the screenshot as `/tmp/msg-option-2-mobile.png`.

- [ ] **Step 4: Compare the desktop implementation with the source design**

Use the selected source image:

```text
/home/ubuntu/.codex/generated_images/019fe0c1-5751-7633-9029-51b2f0e60036/exec-49542232-a312-4424-a32b-5d36500fb05a.png
```

Create a same-height side-by-side comparison with `/tmp/msg-option-2-desktop.png` and save it as `/tmp/msg-option-2-comparison.png`. Open the combined image and review typography, spacing, colors, content, icons, interaction surfaces, and responsive intent.

- [ ] **Step 5: Write the blocking design QA report**

Create `design-qa.md` with:

- Source and implementation paths.
- 1440 by 1024 desktop viewport and 390 by 844 mobile viewport.
- Browser interactions and console check results.
- Full-view and focused comparison evidence.
- Any P0, P1, or P2 findings and fixes.
- Remaining P3 polish, if any.
- `final result: passed` only when no P0, P1, or P2 issue remains.

- [ ] **Step 6: Run the review-ready repository checks**

Run:

```bash
bun test apps/dev/msg-prototype.test.js apps/dev/server.test.js
bun run --cwd apps/dev lint
bun run quality:changed
```

Expected: 21 or more tests pass, lint is clean, and `quality:changed` exits with status 0.

- [ ] **Step 7: Commit QA evidence**

```bash
git add design-qa.md
git commit -m "docs: verify msg prototype redesign"
```

### Task 4: Land and publish

**Files:**
- No new source files.

- [ ] **Step 1: Inspect the final task diff**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -5
```

Expected: only intended committed work exists and `git diff --check` reports no errors.

- [ ] **Step 2: Finish the repository task**

Run:

```bash
bun run work:finish
```

Expected: the quality gate passes, the task lands on local `main`, `main` pushes to `origin`, and the durable task state becomes `complete`.

- [ ] **Step 3: Verify the published artifact route**

Run:

```bash
curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4176/msg-0000-chat/
curl -sS -o /dev/null -w "%{http_code}\n" https://dev.0000.gold/msg-0000-chat/
```

Expected: local returns `200`; the public route returns `200` for an authenticated request or `302` to Cloudflare Access for an unauthenticated request.
