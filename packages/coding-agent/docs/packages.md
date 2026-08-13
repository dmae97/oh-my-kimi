> omk can help you create omk packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# OMK Packages

OMK packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under `omk` or the compatible `pi` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Pi Compatibility and Package Doctor](#pi-compatibility-and-package-doctor)
- [Package Sources](#package-sources)
- [Creating a OMK Package](#creating-a-omk-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** OMK packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
omk install npm:@foo/bar@1.0.0
omk install git:github.com/user/repo@v1
omk install https://github.com/user/repo  # raw URLs work too
omk install /absolute/path/to/package
omk install ./relative/path/to/package

omk remove npm:@foo/bar
omk list                     # show installed packages from settings
omk package doctor npm:@foo/bar@1.0.0  # static compatibility report as JSON
omk update                   # update omk, update packages, and reconcile pinned git refs
omk update --extensions      # update packages and reconcile pinned git refs only
omk update --self            # update omk only
omk update --self --force    # reinstall omk even if current
omk update npm:@foo/bar      # update one package
omk update --extension npm:@foo/bar
```

These commands manage omk packages, not the omk CLI installation. To uninstall omk itself, see [Quickstart](quickstart.md#uninstall).

By default, `install` and `remove` write to user settings (`~/.omk/agent/settings.json`). Use `-l` to write to project settings (`.omk/settings.json`) instead. Project settings can be shared with your team, and omk installs any missing packages automatically on startup.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
omk -e npm:@foo/bar
omk -e git:github.com/user/repo
```

## Pi Compatibility and Package Doctor

OMK reads package manifests in strict priority order: `omk`, then `pi`, then conventional directories. The first present manifest is authoritative. If it is malformed, OMK reports the error instead of silently falling back. When both keys exist, `omk` wins and the doctor reports that `pi` was shadowed.

A Pi extension directory entry such as `"extensions": ["./"]` resolves to its `index.ts`, `index.js`, `index.mjs`, or `index.cjs`. It is not recursively treated as a directory of independent extensions.

Inspect a local, npm, or git source before installing it:

```bash
omk package doctor ./local-package
omk package doctor npm:@scope/package@1.2.3 > package-doctor.json
omk package doctor git:github.com/user/repo@v1
```

The command emits a versioned JSON report and returns `0` when no compatibility error is found, `1` for an incompatible package or inspection failure, and `2` for invalid CLI usage. It checks manifest precedence, declared resources, legacy Pi runtime imports, `.pi` storage paths, lifecycle event names, headless UI guards, and resume signals.

The doctor never imports extension modules. For npm sources it downloads the registry tarball with `npm pack --ignore-scripts` and extracts bounded regular files without installing dependencies. Git inspection clones without running `npm install`. These static checks are advisory and do not make third-party code trusted.

## Package Sources

OMK accepts three source types in settings and `omk install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`omk update`, `omk update --extensions`).
- User installs go under `~/.omk/agent/npm/`.
- Project installs go under `.omk/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `omk update` and `omk update --extensions` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `omk install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.omk/agent/git/<host>/<path>` (global) or `.omk/git/<host>/<path>` (project).
- When reconciliation changes the checkout, omk resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**

```bash
# git@host:path shorthand (requires git: prefix)
omk install git:git@github.com:user/repo

# ssh:// protocol format
omk install ssh://git@github.com/user/repo

# With version ref
omk install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, omk loads resources using package rules.

## Creating a OMK Package

Add an `omk` manifest to `package.json` or use conventional directories. OMK also reads a Pi-compatible `pi` manifest when `omk` is absent. Include the `omk-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["omk-package"],
  "omk": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Gallery Metadata

The [package gallery](https://github.com/dmae97/omk) displays packages tagged with `omk-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["omk-package"],
  "omk": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If neither an `omk` nor a `pi` manifest is present, omk auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. Normal npm and git installation installs runtime dependencies automatically. `omk package doctor` is different: it does not install dependencies or execute lifecycle scripts.

OMK bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `omk-ai`, `omk-agent-core`, `open-multi-agent-kit`, `omk-tui`, `typebox`.

Other omk packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. OMK loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "omk": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `omk config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. Works for both global (`~/.omk/agent`) and project (`.omk/`) scopes.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
