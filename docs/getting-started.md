# Getting Started

Source release target: `open-multi-agent-kit@0.78.8`. Treat npm latest claims as valid only after registry verification and release gates pass.

## Prerequisites

- Node.js 20+
- Git
- At least one supported provider (Kimi, Codex CLI, Gemini CLI, Claude Code, OpenRouter, etc.)

## Install

```bash
npm install -g open-multi-agent-kit
```

## Initialize a project

```bash
omk init
```

This creates:
- `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `DESIGN.md`
- `.kimi/skills/` (runtime skills, with Kimi as the first and most mature adapter)
- `.agents/skills/` (portable skills)
- packaged workflow skills such as `agentmemory`, `react-doctor`, and `multica`
- `.omk/` (config, hooks, memory, agents)

## Run

```bash
omk doctor
omk chat
omk plan "refactor auth module"
omk run feature-dev "add user dashboard"
```
