Drives real Chromium tab; full puppeteer access via JS execution.

<instruction>
- Static content (articles, docs, issues/PRs, JSON, PDFs, feeds)? Use `read` with the URL. Reach for browser only for JS execution, authentication, or interactive actions.
- Three actions:
  - `open` — acquire or reuse named tab (`name` defaults `"main"`). Optional `url` (navigate once ready), `viewport`, `dialogs: "accept" | "dismiss"` (auto-handle `alert`/`confirm`/`beforeunload`; unhandled dialogs hang the page until you wire `page.on('dialog', …)`).
  - `close` — release tab by `name`, or every tab with `all: true`. `kill: true` also terminates spawned-app process trees (default leaves them running).
  - `run` — execute JS in an existing tab. `code` is the body of an async function with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. Return value is JSON-stringified into the result; `display(value)` calls accumulate text/images.
- Tabs survive across `run` calls and in-process subagents — open once, reuse.
- Browser kinds (`app` field on `open`):
  - default (no `app`) → headless Chromium with stealth patches.
  - `app.path` → spawn absolute binary (Electron/CDP); a running instance with an open CDP port is reused. No stealth patches — NEVER tamper with a real desktop app.
  - `app.cdp_url` → connect to existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring matched against url+title to pick a BrowserWindow.
- `tab` helpers; drop to raw puppeteer `page` for anything they don't cover:
  - `tab.goto(url, { waitUntil? })` — navigate; clears element cache.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot: `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. Ids stable until next observe/goto.
  - `tab.id(n)` — element id from last observe → `ElementHandle` (`.click()`, `.type()`, …).
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)`.
  - `tab.waitFor(selector)` — wait until attached; returns the `ElementHandle`.
  - `tab.drag(from, to)` — endpoints: selector (center-to-center) or `{ x, y }` viewport point (canvases, sliders).
  - `tab.scrollIntoView(selector)` — center element in viewport; use before clicking off-screen elements.
  - `tab.select(selector, …values)` — set `<select>` option(s); returns resulting selection. `tab.fill` NEVER works for selects.
  - `tab.uploadFile(selector, …filePaths)` — attach files to `<input type="file">`; paths relative to cwd.
  - `tab.waitForUrl(pattern, { timeout? })` — substring or `RegExp`; polls `location.href` (catches SPA pushState). Returns matched URL.
  - `tab.waitForResponse(pattern, { timeout? })` — substring, `RegExp`, or `(response) => boolean`; returns puppeteer `HTTPResponse` (`.text()`/`.json()`/`.status()`/`.headers()`).
  - `tab.evaluate(fn, …args)` — `page.evaluate` with abort signal wired; use for ad-hoc DOM reads.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — capture and attach for viewing (`silent: true` skips). Pass `save` (a path) only when a later step needs the file.
  - `tab.extract(format = "markdown")` — Readability-extracted content (`"markdown"` | `"text"`); throws when nothing readable.
- Selectors: CSS plus puppeteer handlers `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`; Playwright-style `p-aria/…`, `p-text/…` normalized.
</instruction>

<critical>
- MUST `open` before `run` — `run` never creates a tab.
- Default to `tab.observe()` for page state — structured data with actionable element ids. Screenshot ONLY when visual appearance matters.
- Navigation invalidates element ids — re-observe before using them.
- `code` runs with full Node access. Treat as your code, not sandboxed code.
</critical>

<examples>
# Open a tab and read structured page data
`{"action":"open","name":"docs","url":"https://example.com"}`
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); display(obs); return obs.elements.length;"}`

# Click an observed element by id
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();"}`

# Fill and submit a form via selectors
`{"action":"run","name":"docs","code":"await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');"}`

# Screenshot to look at the page — no save path
`{"action":"run","name":"docs","code":"await tab.screenshot();"}`

# Attach to an existing Electron app
`{"action":"open","name":"cursor","app":{"path":"/Applications/Cursor.app/Contents/MacOS/Cursor"}}`

# Close every tab and kill spawned-app processes
`{"action":"close","all":true,"kill":true}`
</examples>

<output>
Per call: `display(value)` outputs (text/images), then the JSON-stringified return value of `code`. `run` always produces at least a status line.
</output>
