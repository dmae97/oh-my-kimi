# Changelog

## [Unreleased]

## [15.12.0] - 2026-06-12

### Added

- Added support for optional write tokens in collaboration links so full links can embed the room key and write token (48-byte fragment) while legacy key-only (32-byte) links remain supported
- Added parsing of web deep links in the form `https://<relay>/#<room>#<key>` so links opened from a page URL hash resolve correctly
- Added a `readOnly` field to guest snapshots to indicate whether the connected guest has view-only access
- Link parsing accepts full web deep links (`https://<relay>/#<link>`) pasted into the connect screen, matching the URL `/collab` now prints
- Site metadata for the deployed client: favicon set, web app manifest, robots.txt, sitemap, JSON-LD, and Open Graph/Twitter cards with a collab-specific og-image; static assets live in `public/` and are copied into `dist/` at build
- Added `src/tool-render/`: a shared per-tool React renderer suite (one view per built-in tool — bash, read, edit diffs, todo boards, eval cells, task batches, LSP, search, browser screenshots, …) with a common chrome (`ToolView`), design tokens that adapt to the host theme, and an `<omp-tool-view>` web-component wrapper; `scripts/build-tool-views.ts` bundles it (React included) for embedding into coding-agent HTML session exports
- Task tool cards now render agent ids as drill-down links: clicking one opens the matching subagent drawer in the live client (and the embedded sub-session overlay in HTML exports) via the new `ToolRenderHost` seam

### Changed

- Changed composer input to disable prompting and show a read-only session placeholder when guests connect in view-only mode
- Changed agent drawer to hide kill/revive controls and message input for read-only guests
- Changed header bar to show a read-only session chip and label read-only participants as view-only
- Restyled the client onto the omp brand palette: deep-purple surfaces, pink accent, cyan focus ring (was warm amber); og-image re-rendered to match
- Transcript tool cards now use the per-tool renderers instead of the generic args/result JSON dump — structured summaries in the collapsed header and tool-specific bodies (commands, diffs, todo boards, result images) when expanded

## [15.11.8] - 2026-06-12
### Added

- Added deep-link auto-connection support from `#<roomId>#<key>` URLs when opening the web app
- Added subagent-focused UI with a side rail and detail drawer that surfaces each subagent’s lifecycle, running progress, and per-subagent transcript
- Added session status controls in the shell, including connection banners, toast notifications, and rejoin/new-link actions after a session ends
- Added the collab web package with the browser guest client, mock host, local relay, and relay contract tests.

### Changed

- Changed relay socket behavior to retry transient disconnections with exponential backoff while treating terminal relay-close conditions and decryption failures as non-retriable
- Changed subagent transcript decoding to handle streamed JSONL payload chunks incrementally by preserving carry-over data across chunks
- Replaced the vendored collab wire type mirror with shared `@oh-my-pi/pi-wire` protocol contracts.

### Security

- Hardened transcript Markdown rendering by escaping embedded HTML and allowing only safe link schemes