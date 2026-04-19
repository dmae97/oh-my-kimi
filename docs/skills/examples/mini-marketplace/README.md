# mini-marketplace

A minimal `oh-my-pi` marketplace catalog that demonstrates the `marketplace.json` format. It lists one plugin (`hello-extension`) using a relative path source.

## Install command

```
/marketplace add ./docs/skills/examples/mini-marketplace
/marketplace install hello-extension@example-marketplace
```

Or from the CLI:

```
omp plugin marketplace add ./docs/skills/examples/mini-marketplace
omp plugin install hello-extension@example-marketplace
```

## What it demonstrates

- Minimum required `marketplace.json` fields: `name`, `owner.name`, `plugins`
- Relative path plugin source (`"source": "../hello-extension"`)
- Plugin entry with `name` and `description`

## Structure

```
mini-marketplace/
  marketplace.json   ← catalog (normally at .claude-plugin/marketplace.json in a real repo)
  README.md
```

In a real published marketplace, `marketplace.json` lives at `.claude-plugin/marketplace.json` inside the Git repository root. For this local example it is at the directory root so you can point `/marketplace add` directly at this folder.
