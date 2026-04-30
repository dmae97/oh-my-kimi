# Plugin manager and installer plumbing

This document describes how `omp plugin` operations mutate plugin state on disk and how installed plugins become runtime capabilities (tools and extensions today, hooks/commands path resolution available).

## Scope and architecture

There are two plugin-management implementations in the codebase:

1. **Active path used by CLI commands**: `PluginManager` (`src/extensibility/plugins/manager.ts`)
2. **Legacy helper module**: installer functions (`src/extensibility/plugins/installer.ts`)

`omp plugin ...` command execution goes through `PluginManager`.

`installer.ts` still documents important safety checks and filesystem behavior, but it is not the path used by `src/commands/plugin.ts` + `src/cli/plugin-cli.ts`.

## Lifecycle: from CLI invocation to runtime availability

```text
omp plugin <action> ...
  -> src/commands/plugin.ts
  -> runPluginCommand(...) in src/cli/plugin-cli.ts
  -> PluginManager method (install/list/uninstall/link/...)
  -> mutate ~/.omp/plugins/{package.json,node_modules,omp-plugins.lock.json}
  -> runtime discovery: discoverAndLoadCustomTools(...) and discoverAndLoadExtensions(...)
  -> getAllPluginToolPaths(cwd) / getAllPluginExtensionPaths(cwd)
  -> custom tool loader imports tool modules; extension loader imports extension modules
```

### Command entrypoints

- `src/commands/plugin.ts` defines command/flags and forwards to `runPluginCommand`.
- `src/cli/plugin-cli.ts` maps subcommands to `PluginManager` methods:
  - `install`, `uninstall`, `list`, `link`, `doctor`, `features`, `config`, `enable`, `disable`
- No explicit `update` action exists; update is done by re-running `install` with a new package/version spec.

## On-disk model

Global plugin state lives under `~/.omp/plugins`:

- `package.json` — dependency manifest used by `bun install`/`bun uninstall`
- `node_modules/` — installed plugin packages or symlinks
- `omp-plugins.lock.json` — runtime state:
  - enabled/disabled per plugin
  - selected feature set per plugin
  - persisted plugin settings

Project-local overrides live at:

- `<cwd>/.omp/plugin-overrides.json`

Overrides are read-only from manager/loader perspective (no write path here) and can disable plugins or override features/settings for this project.

## Plugin spec parsing and metadata interpretation

## Install spec grammar

`parsePluginSpec` (`parser.ts`) supports:

- `pkg` -> `features: null` (defaults behavior)
- `pkg[*]` -> enable all manifest features
- `pkg[]` -> enable no optional features
- `pkg[a,b]` -> enable named features
- `@scope/pkg@1.2.3[feat]` -> scoped + versioned package with explicit feature selection

`extractPackageName` strips version suffix for on-disk path lookup after install.

## Manifest source and required fields

Manifest is resolved as:

1. `package.json.omp`
2. fallback `package.json.pi`
3. fallback `{ version: package.version }`

Implications:

- There is no strict schema validation in manager/loader.
- A package missing `omp`/`pi` is still installable and listable.
- Runtime plugin loading (`getEnabledPlugins`) skips packages without `omp`/`pi` manifest.
- `manifest.version` is always overwritten from package `version`.

Malformed `package.json` JSON is a hard failure at read time; malformed manifest shape may fail later only when specific fields are consumed.

## Install/update flow (`PluginManager.install`)

1. Parse feature bracket syntax from install spec.
2. Validate package name against regex + shell-metacharacter denylist.
3. Ensure plugin `package.json` exists (`omp-plugins`, private dependencies map).
4. Run `bun install <packageSpec>` in `~/.omp/plugins`.
5. Read installed package `node_modules/<name>/package.json`.
6. Resolve manifest and compute `enabledFeatures`:
   - `[*]`: all declared features (or `null` if no feature map)
   - `[a,b]`: validates each feature exists in manifest features map
   - `[]`: empty feature list
   - bare spec: `null` (use defaults policy later in loader)
7. Upsert lockfile runtime state: `{ version, enabledFeatures, enabled: true }`.

### Update semantics

Because update is install-driven:

- `omp plugin install pkg@newVersion` updates dependency and lockfile version.
- Existing settings are preserved; state entry is overwritten for version/features/enabled.
- No separate “check updates” or transactional migration logic exists.

## Remove flow (`PluginManager.uninstall`)

1. Validate package name.
2. Run `bun uninstall <name>` in plugin dir.
3. Remove plugin runtime state from lockfile:
   - `config.plugins[name]`
   - `config.settings[name]`

If uninstall command fails, runtime state is not changed.

## List flow (`PluginManager.list`)

1. Read plugin dependency map from `~/.omp/plugins/package.json`.
2. Load lockfile runtime config (missing file -> empty defaults).
3. Load project overrides (`<cwd>/.omp/plugin-overrides.json`, parse/read errors -> empty object with warning).
4. For each dependency with a resolvable package.json:
   - build `InstalledPlugin` record
   - merge feature/enable state:
     - base from lockfile (or defaults)
     - project overrides can replace feature selection
     - project `disabled` list masks plugin as disabled

This is the effective state used by CLI status output and settings/features operations.

## Link flow (`PluginManager.link`)

`link` supports local plugin development by symlinking a local package into `~/.omp/plugins/node_modules/<pkg.name>`.

Behavior:

1. Resolve `localPath` against manager cwd.
2. Require local `package.json` and `name` field.
3. Ensure plugin dirs exist.
4. For scoped names, create scope directory.
5. Remove existing path at target link location.
6. Create symlink.
7. Add runtime lockfile entry enabled with default features (`null`).

Caveat: current `PluginManager.link` does not enforce the `cwd` path-boundary check present in legacy `installer.ts` (`normalizedPath.startsWith(normalizedCwd)`), so trust is the caller’s responsibility.

## Runtime loading: from installed plugin to callable capabilities

## Discovery gate

`getEnabledPlugins(cwd)` (`plugins/loader.ts`) reads:

- plugin dependency manifest (`package.json`)
- lockfile runtime state
- project overrides via `getConfigDirPaths("plugin-overrides.json", { user: false, cwd })`

Filtering:

- skip if no plugin package.json
- skip if manifest (`omp`/`pi`) absent
- skip if globally disabled in lockfile
- skip if project-disabled

## Capability path resolution

For each enabled plugin:

- `resolvePluginExtensionPaths(plugin)`
- `resolvePluginToolPaths(plugin)`
- `resolvePluginHookPaths(plugin)`
- `resolvePluginCommandPaths(plugin)`

Each resolver includes base entries plus feature entries:

- explicit feature list -> only selected features
- `enabledFeatures === null` -> enable features marked `default: true`

Missing files are silently skipped (`existsSync` guard).

## Current runtime wiring differences

- **Tools are wired into runtime today** via `discoverAndLoadCustomTools` (`custom-tools/loader.ts`), which calls `getAllPluginToolPaths(cwd)`.
- **Extensions are wired into runtime today** via `discoverAndLoadExtensions` (`extensions/loader.ts`), which calls `getAllPluginExtensionPaths(cwd)`.
- Paths are de-duplicated by resolved absolute path in custom tool and extension discovery (`seen` set, first path wins).
- **Hooks/commands resolvers exist** and are exported, but this code path does not currently wire them into a runtime registry in the same way tools and extensions are wired.

## Lock/state management details

`PluginManager` caches runtime config in memory per instance (`#runtimeConfig`) and lazily loads once.

Load behavior:

- lockfile missing -> `{ plugins: {}, settings: {} }`
- lockfile read/parse failure -> warning + same empty defaults

Save behavior:

- writes full lockfile JSON pretty-printed each mutation

No cross-process locking or merge strategy exists; concurrent writers can overwrite each other.

## Safety checks and trust boundaries

## Input/package validation

Active manager path enforces package-name validation:

- regex for scoped/unscoped package specs (optionally with version)
- explicit shell metacharacter denylist (`[;&|`$(){}[]<>\\]`)

This limits command-injection risk when invoking `bun install/uninstall`.

## Filesystem trust boundary

- Plugin code executes in-process when custom tool modules are imported; no sandboxing.
- Manifest relative paths are joined against plugin package directory and only existence-checked.
- The plugin package itself is trusted code once installed.

## Legacy installer-only checks

`installer.ts` includes additional link-time checks not mirrored in `PluginManager.link`:

- local path must resolve inside project cwd
- extra package name/path traversal guards for symlink target naming

Because CLI uses `PluginManager`, these stricter link guards are not currently on the main path.

## Failure, partial success, and rollback behavior

The plugin manager is not transactional.

| Operation stage                                          | Failure behavior           | Rollback                                                                      |
| -------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| `bun install` fails                                      | install aborts with stderr | N/A (no state writes yet)                                                     |
| Install succeeds, then manifest/feature validation fails | command fails              | No uninstall rollback; dependency may remain in `node_modules`/`package.json` |
| Install succeeds, then lockfile write fails              | command fails              | No rollback of installed package                                              |
| `bun uninstall` succeeds, lockfile write fails           | command fails              | Package removed, stale runtime state may remain                               |
| `link` removes old target then symlink creation fails    | command fails              | No restoration of previous link/dir                                           |

Operationally, `doctor --fix` can repair some drift (`bun install`, orphaned config cleanup, invalid-feature cleanup), but it is best-effort.

## Malformed/missing manifest behavior summary

- Missing `omp`/`pi` field:
  - install/list: tolerated (minimal manifest)
  - runtime enabled-plugin discovery: skipped as non-plugin
- Missing feature referenced by install spec or `features --set/--enable`: hard error with available feature list
- Invalid `plugin-overrides.json`: ignored with fallback to `{}` in both manager and loader paths
- Missing tool/hook/command file paths referenced by manifest: silently ignored during resolver expansion; flagged as errors only by `doctor`

## Mode differences and precedence

- `--dry-run` (install): returns synthetic install result, no filesystem/network/state writes.
- `--json`: output formatting only, no behavior change.
- Project overrides always take precedence over global lockfile for feature/settings view.
- Effective enablement is `runtimeEnabled && !projectDisabled`.

## Implementation files

- [`src/commands/plugin.ts`](../packages/coding-agent/src/commands/plugin.ts) — CLI command declaration and flag mapping
- [`src/cli/plugin-cli.ts`](../packages/coding-agent/src/cli/plugin-cli.ts) — action dispatch, user-facing command handlers
- [`src/extensibility/plugins/manager.ts`](../packages/coding-agent/src/extensibility/plugins/manager.ts) — active install/remove/list/link/state/doctor implementation
- [`src/extensibility/plugins/installer.ts`](../packages/coding-agent/src/extensibility/plugins/installer.ts) — legacy installer helpers and additional link safety checks
- [`src/extensibility/plugins/loader.ts`](../packages/coding-agent/src/extensibility/plugins/loader.ts) — enabled-plugin discovery and tool/hook/command path resolution
- [`src/extensibility/plugins/parser.ts`](../packages/coding-agent/src/extensibility/plugins/parser.ts) — install spec and package-name parsing helpers
- [`src/extensibility/plugins/types.ts`](../packages/coding-agent/src/extensibility/plugins/types.ts) — manifest/runtime/override type contracts
- [`src/extensibility/custom-tools/loader.ts`](../packages/coding-agent/src/extensibility/custom-tools/loader.ts) — runtime wiring for plugin-provided tool modules
- [`src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts) — runtime wiring for plugin-provided extension modules
