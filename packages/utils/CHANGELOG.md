# Changelog

## [Unreleased]

### Added

- Added a public profile API to `dirs`: `setProfile` / `getActiveProfile` / `getProfileRootDir` for activating and resolving named profiles, plus `normalizeProfileName` (validates and normalizes a profile name, rejecting `.`/`..`, trailing dots, and Windows reserved device names) and `resolveProfileEnv` (resolves the active profile from `OMP_PROFILE`, falling back to the legacy `PI_PROFILE`).
- Added profile-aware directory resolution: activating a named profile roots the config root and agent directory under `~/.omp/profiles/<name>/...` (XDG: `$XDG_*_HOME/omp/profiles/<name>`) so each profile isolates its own state, while `getInstallId` stays anchored to the base `~/.omp/install-id` shared across all profiles.

## [15.7.3] - 2026-05-31
### Added

- Added `getFastembedCacheDir` to return the FastEmbed model cache directory under ~/.omp/cache/fastembed

### Fixed

- Fixed `$flag` environment parsing to accept lowercase truthy values such as `y`, `true`, `yes`, and `on`

## [15.6.0] - 2026-05-30

### Added

- Added an XDG-aware tiny-title model cache directory helper for coding-agent local title models.