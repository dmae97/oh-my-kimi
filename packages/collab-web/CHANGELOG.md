# Changelog

## [Unreleased]

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
