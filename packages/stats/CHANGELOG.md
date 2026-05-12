# Changelog

## [Unreleased]

## [14.9.7] - 2026-05-12
### Breaking Changes

- Broke backward compatibility of behavior stats fields by replacing `yellingSentences`/`dramaRuns` with `yelling`/`anguish` and adding `negation`, `repetition`, `blame` in query result types and persisted `user_messages` schema

### Added

- Added `SyncOptions` to `syncAllSessions` with `onProgress` and `workers` to optionally show per-file sync progress and tune parser concurrency
- Added new frustration behavior metrics (`negation`, `repetition`, `blame`) plus a `frustration` aggregate in behavior charts, model tables, and summary cards

### Changed

- Changed sync ingestion to parse session files through a worker pool while applying parsed results and database writes on the main thread
- Changed behavior analysis to strip code blocks, XML/URLs, quoted lines, and placeholders before scoring and to suppress signals on long structured messages
- Changed dashboard metrics labels and totals to the new signal names, including replacing the old three-signal totals with `yelling`, `profanity`, `anguish`, and `frustration`
- Changed sync output to print a live terminal progress indicator while processing session files

### Fixed

- Fixed user-message attribution so assistant model/provider links are backfilled during incremental sync instead of being left unknown
- Fixed word-boundary regex handling in profanity detection so matching now works as intended in normal prose

## [14.9.5] - 2026-05-12

### Added

- Added time range selection options (1h, 24h, 7d, 30d, 90d, All) to the dashboard header and bound them to reloading statistics for the selected window
- Added a **Behavior** dashboard page that tracks user yelling (CAPS), profanity, and dramatic punctuation (`!!!` / `???`) per day, with by-model comparisons mirroring the cost page
- Added a per-model behavior table to the **Behavior** page mirroring the Models table: sortable rows of CAPS / profanity / drama hits per model with sparkline trend and an expandable per-model breakdown chart
- Added optional `range` query parameter support on stats endpoints to retrieve metrics scoped to a requested time window

### Changed

- Changed the Costs dashboard summary to report totals, average per day, and top model for the selected time range instead of a fixed 30-day window and removed the previous-30-day trend comparison
- Changed behavior metrics ingestion to compute yelling from user message sentence-level uppercase ratios, filtering out short uppercase fragments so the behavior data is attributed to messages more accurately
- Removed per-chart 14/30/90 day pickers on Costs and Behavior pages so every page obeys the single time-range selector in the header
- Changed dashboard and stats queries to return data from the selected time window instead of always using all-time aggregates
- Changed the default displayed range in the UI/API to last 24h
- Added support for returning all data when `range=all` is requested

### Fixed

- Fixed handling of unknown `range` values by falling back to the last 24h instead of returning unscoped data
- Fixed `omp stats` failing to build the client on globally-installed installs by promoting `tailwindcss` from `devDependencies` to `dependencies` (the client build runs at runtime)

## [14.5.4] - 2026-04-28

### Fixed

- Fixed GPT cost reporting by deriving missing OpenAI Codex costs from the model catalog and backfilling existing zero-cost rows.

## [13.6.0] - 2026-03-03
### Fixed

- Include subtask session files in usage stats ([#250](https://github.com/can1357/oh-my-pi/issues/250))