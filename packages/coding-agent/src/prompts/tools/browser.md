Drives a real Chromium tab with full puppeteer access via JS execution.

<instruction>
- For fetching static web content (articles, docs, issues/PRs, JSON, PDFs, feeds), prefer the `read` tool with a URL — reader-mode text without spinning up a browser. Use this tool when you need JS execution, authentication, or interactive actions.
- Three actions only:
  - `open` — acquire (or reuse) a named tab. `name` defaults to `"main"`. Optional `url` navigates after the tab is ready. Optional `viewport` sets dimensions.
  - `close` — release a tab by `name`, or every tab with `all: true`. For spawned-app browsers, set `kill: true` to terminate the process tree (default leaves it running).
  - `run` — execute JS against an existing tab. The `code` is the body of an async function with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. The function's return value is JSON-stringified into the tool result; multiple `display(value)` calls accumulate text/images.
- Tabs survive across `run` calls and across in-process subagents. Open once, reuse many times.
- Browser kinds, selected by the `app` field on `open`:
  - default (no `app`) → headless Chromium with stealth patches.
  - `app.path` → spawn an absolute binary (Electron/CDP). If a running instance already exposes a CDP port, it is reused; otherwise stale instances are killed and a fresh one is spawned. No stealth patches — never tamper with a real desktop app.
  - `app.cdp_url` → connect to an existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring matched against url+title to pick a BrowserWindow when the app exposes several.
- Inside `run`, `tab` exposes high-level helpers; reach for `page` (raw puppeteer Page) when you need anything they don't cover. Available helpers:
  - `tab.goto(url, { waitUntil? })` — clears the element cache and navigates.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot. Returns `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. Element ids are stable until the next observe/goto.
  - `tab.id(n)` — resolves an element id from the most recent observe to a real `ElementHandle` you can `.click()`, `.type()`, etc.
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)` / `tab.drag(from, to)` / `tab.waitFor(selector)` — selector-based actions.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — auto-attaches the image to the tool output unless `silent: true`. Saves full-res to `save` (or `browser.screenshotDir` setting) and a downscaled copy to the model.
  - `tab.extract(format = "markdown")` — Readability-extracted page content.
- Selectors accept CSS as well as puppeteer query handlers: `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`. Playwright-style `p-aria/[name="…"]`, `p-text/…`, etc. are normalized.
- Default to `tab.observe()` over `tab.screenshot()` for understanding page state. Screenshot only when visual appearance matters.
</instruction>

<critical>
- You **MUST** call `open` before `run`. `run` does not implicitly create a tab.
- You **MUST NOT** screenshot just to "see what's on the page" — `tab.observe()` returns structured data with element ids you can act on immediately.
- After a `tab.goto()` or any navigation, prior element ids from `tab.observe()` are invalidated. Re-observe before referencing them.
- `code` runs with full Node access. Treat it as your code, not sandboxed code.
</critical>

<examples>
# Open a tab and read structured page data
`{"action":"open","name":"docs","url":"https://example.com"}`
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); display(obs); return obs.elements.length;"}`

# Click an observed element by id
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();"}`

# Save a full-page screenshot to disk
`{"action":"run","name":"docs","code":"await tab.screenshot({ fullPage: true, save: 'screenshot.png' });"}`

# Fill and submit a form via selectors
`{"action":"run","name":"docs","code":"await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');"}`

# Attach to an existing Electron app
`{"action":"open","name":"cursor","app":{"path":"/Applications/Cursor.app/Contents/MacOS/Cursor"}}`

# Close one tab (browser stays alive if other tabs reference it)
`{"action":"close","name":"docs"}`

# Close every tab; leave spawned apps running
`{"action":"close","all":true}`

# Close every tab and kill spawned-app processes too
`{"action":"close","all":true,"kill":true}`
</examples>

<output>
Per call: any `display(value)` outputs (text/images) followed by the JSON-stringified return value of the `code` function. `run` always produces at least a status line.
</output>
