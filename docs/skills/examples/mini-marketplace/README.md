# mini-marketplace

A minimal `oh-my-pi` marketplace catalog that demonstrates the `marketplace.json` format. It lists one plugin (`hello-extension`) using a relative path source.

## Install command

```
/marketplace add ./docs/skills/examples/mini-marketplace
/marketplace install my-plugin@example-marketplace
```

Or from the CLI:

```
omp plugin marketplace add ./docs/skills/examples/mini-marketplace
omp plugin install my-plugin@example-marketplace
```

## What it demonstrates

- Minimum required `marketplace.json` fields: `name`, `owner.name`, `plugins`
- Relative path plugin source using `./` prefix (`"source": "./my-plugin"`)
- Plugin bundled inside the same directory tree as the marketplace catalog

## Structure

```
mini-marketplace/
  marketplace.json        ← catalog (normally at .claude-plugin/marketplace.json in a real repo)
  README.md
  my-plugin/
    package.json          ← omp.extensions manifest
    index.ts              ← extension entry point
```

In a real published marketplace, `marketplace.json` lives at `.claude-plugin/marketplace.json` inside the Git repository root. For this local example it is at the directory root so you can point `/marketplace add` directly at this folder.
