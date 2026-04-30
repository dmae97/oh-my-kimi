Navigates, clicks, types, scrolls, drags, queries DOM content, and captures screenshots.

<instruction>
- For fetching static web content (articles, docs, issues/PRs, JSON, PDFs, feeds), prefer the `read` tool with a URL — it returns clean reader-mode text without spinning up a browser. Use this tool only when you need JS execution, authentication, or interactive actions.
- `"open"` starts a headless session (or implicitly on first action); `"goto"` navigates to `url`; `"close"` releases the browser
- `"attach"` drives an arbitrary Electron app via CDP. Pass `path` to spawn the binary (any running instance with that exact path is killed first), or `url` to connect to an already-running CDP endpoint (e.g. `http://127.0.0.1:9222`). Optional: `app_args` (extra CLI args), `target` (substring to pick a BrowserWindow when several exist). After attach, every other action drives the user's app; `"close"` disconnects and kills what we spawned.
- `"observe"` captures a numbered accessibility snapshot — prefer `click_id`/`type_id`/`fill_id` using returned `element_id` values; flags: `include_all`, `viewport_only`
- `"click"`, `"type"`, `"fill"`, `"press"`, `"scroll"`, `"drag"` for selector-based interactions — prefer ARIA/text selectors (`p-aria/[name="Sign in"]`, `p-text/Continue`) over brittle CSS
- `"click_id"`, `"type_id"`, `"fill_id"` to interact with observed elements without selectors
- `"wait_for_selector"` before interacting when the page is dynamic
- `"evaluate"` runs a JS expression in page context
- `"get_text"`, `"get_html"`, `"get_attribute"` for DOM queries — batch via `args: [{ selector, attribute? }]`
- `"extract_readable"` returns reader-mode content; `format`: `"markdown"` (default) or `"text"`
- `"screenshot"` captures images (optionally with `selector`); can save to disk via `path`
</instruction>

<critical>
**You **MUST** default to `observe`, not `screenshot`.**
- `observe` is cheaper, faster, and returns structured data — use it to understand page state, find elements, and plan interactions.
- You **SHOULD** only use `screenshot` when visual appearance matters (verifying layout, debugging CSS, capturing a visual artifact for the user).
- You **MUST NOT** screenshot just to "see what's on the page" — `observe` gives you that with element IDs you can act on immediately.
</critical>

<output>
Text for navigation/DOM queries, images for screenshots.
</output>
