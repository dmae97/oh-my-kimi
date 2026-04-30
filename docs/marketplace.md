# Marketplace plugin system

The marketplace system lets you discover, install, and manage plugins from Git-hosted catalogs. It is compatible with the Claude Code plugin registry format.

## Quick start

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

Or just type `/marketplace` with no arguments to open the interactive plugin browser.

## Concepts

A **marketplace** is a Git repository (or local directory) containing a catalog file at `.claude-plugin/marketplace.json`. The catalog lists available plugins with their sources, descriptions, and metadata.

A **plugin** is a directory containing skills, commands, hooks, MCP servers, or LSP servers. Plugins are identified by `name@marketplace` (e.g. `code-review@claude-plugins-official`).

**Scopes**: plugins can be installed at two scopes:

- **user** (default) -- available in all projects, stored in `~/.omp/plugins/installed_plugins.json`
- **project** -- available only in the current project, stored in `.omp/plugins/installed_plugins.json`

Project-scoped installs shadow user-scoped installs of the same plugin.

## Commands

### Interactive mode

| Command        | Effect                                    |
| -------------- | ----------------------------------------- |
| `/marketplace` | Open interactive plugin browser (install) |

### Marketplace management

| Command                      | Effect                                       |
| ---------------------------- | -------------------------------------------- |
| `/marketplace add <source>`  | Add a marketplace source                     |
| `/marketplace remove <name>` | Remove a marketplace                         |
| `/marketplace update [name]` | Re-fetch catalog(s); omit name to update all |
| `/marketplace list`          | List configured marketplaces                 |

### Plugin operations

| Command                                                                   | Effect                             |
| ------------------------------------------------------------------------- | ---------------------------------- |
| `/marketplace discover [marketplace]`                                     | Browse available plugins           |
| `/marketplace install [--force] [--scope user\|project] name@marketplace` | Install a plugin                   |
| `/marketplace uninstall [--scope user\|project] name@marketplace`         | Uninstall a plugin                 |
| `/marketplace installed`                                                  | List installed marketplace plugins |
| `/marketplace upgrade [--scope user\|project] [name@marketplace]`         | Upgrade one or all plugins         |

### CLI equivalents

The same operations are available from the command line:

```
omp plugin marketplace add <source>
omp plugin marketplace remove <name>
omp plugin marketplace update [name]
omp plugin marketplace list
omp plugin discover [marketplace]
omp plugin install [--force] [--scope user|project] name@marketplace
omp plugin uninstall [--scope user|project] name@marketplace
omp plugin upgrade [--scope user|project] [name@marketplace]
```

## Marketplace sources

When you run `/marketplace add <source>`, the system classifies the source:

| Source format                   | Type               | Example                                |
| ------------------------------- | ------------------ | -------------------------------------- |
| `owner/repo`                    | GitHub shorthand   | `anthropics/claude-plugins-official`   |
| `https://...*.json`             | Direct catalog URL | `https://example.com/marketplace.json` |
| `https://...*.git` or `git@...` | Git repository     | `https://github.com/org/repo.git`      |
| `./path` or `~/path` or `/path` | Local directory    | `./my-marketplace`                     |

The system clones the repository (or reads the local directory), locates `.claude-plugin/marketplace.json`, validates it, and caches the catalog locally.

## Catalog format (marketplace.json)

A marketplace catalog lives at `.claude-plugin/marketplace.json` in the repository root:

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "description": "A collection of plugins",
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What this plugin does",
      "source": "./plugins/my-plugin",
      "category": "development",
      "homepage": "https://github.com/you/my-plugin"
    }
  ]
}
```

### Required fields

| Field        | Description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`       | Marketplace name. Lowercase alphanumeric, hyphens, and dots. Must start and end with alphanumeric. Max 64 chars. |
| `owner.name` | Marketplace owner name                                                                                           |
| `plugins`    | Array of plugin entries                                                                                          |

### Plugin entry fields

| Field         | Required | Description                                                      |
| ------------- | -------- | ---------------------------------------------------------------- |
| `name`        | yes      | Plugin name (same rules as marketplace name)                     |
| `source`      | yes      | Where to find the plugin (see below)                             |
| `description` | no       | Short description                                                |
| `version`     | no       | Version string                                                   |
| `author`      | no       | `{ name, email? }`                                               |
| `homepage`    | no       | URL                                                              |
| `category`    | no       | Category string (e.g. `development`, `productivity`, `security`) |
| `tags`        | no       | Array of string tags                                             |
| `strict`      | no       | Boolean                                                          |
| `commands`    | no       | Slash commands provided                                          |
| `agents`      | no       | Agents provided                                                  |
| `hooks`       | no       | Hook definitions                                                 |
| `mcpServers`  | no       | MCP server definitions                                           |
| `lspServers`  | no       | LSP server definitions                                           |

### Plugin source formats

The `source` field supports several formats:

**Relative path** (within the marketplace repo):

```json
"source": "./plugins/my-plugin"
```

**Git repository URL**:

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/repo.git",
  "sha": "abc123..."
}
```

**GitHub shorthand**:

```json
"source": {
  "source": "github",
  "repo": "org/repo",
  "ref": "main",
  "sha": "abc123..."
}
```

**Git subdirectory** (monorepo):

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "plugins/my-plugin",
  "ref": "main",
  "sha": "abc123..."
}
```

**npm package**:

```json
"source": {
  "source": "npm",
  "package": "@scope/my-plugin",
  "version": "1.0.0"
}
```

## On-disk layout

```
~/.omp/
  marketplaces.json              # Registry of added marketplaces
  plugins/
    installed_plugins.json       # User-scoped installed plugins
    cache/
      marketplaces/              # Cached marketplace catalogs
      plugins/                   # Cached plugin directories

<project>/.omp/
  plugins/
    installed_plugins.json       # Project-scoped installed plugins
```

## Naming rules

Marketplace and plugin names must:

- Start and end with a lowercase letter or digit
- Contain only lowercase letters, digits, hyphens, and dots
- Be at most 64 characters

Plugin IDs (`name@marketplace`) must be at most 128 characters total.

Valid examples: `my-plugin`, `code-review`, `wordpress.com`, `ai-firstify`
Invalid examples: `-bad`, `bad-`, `.bad`, `Bad`, `under_score`
