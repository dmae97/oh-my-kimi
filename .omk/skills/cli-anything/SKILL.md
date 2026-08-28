---
name: cli-anything
description: Build a command-line harness that lets an agent drive GUI-only software — Blender, LibreOffice, GIMP, Inkscape, Audacity, QGIS, video editors, CAD tools — by generating the app's native project format and handing it to the real binary for rendering. Use when a task needs software that has no usable CLI, when an agent must produce a real artifact (render, export, conversion) from a desktop application, or when asked to wrap, automate, or headlessly drive a GUI program. Not for software that already ships an adequate CLI.
---

# CLI-Anything

Turn GUI-only software into something an agent can drive, without a display or a mouse.

## The rule that makes it work

**Build the data → call the real software → verify the output.**

The harness is an interface *to* the application, never a replacement for it. It
generates the app's native project file, then invokes the actual binary to render.

This one rule decides whether the harness is useful or a liability:

- The application is a **hard dependency**. If it is not installed, fail with install
  instructions. Never fall back to a Python library that approximates the render.
- A fallback renderer produces plausible output that is wrong in ways nobody checks.
  That is worse than an error, because the agent reports success.

## When to reach for this

Use it when the target has no adequate CLI and the task needs a real artifact:
a render, an export, a format conversion, a scripted edit.

Skip it when the software already ships a CLI that covers the task. `ffmpeg`,
`pandoc`, and `ImageMagick` are the harness you would have written.

## How to build one

**1. Find the engine.** GUI apps separate presentation from logic. Locate the core
library and any CLI the backend already ships — `melt` for Shotcut, `sox` for
Audacity, `libreoffice --headless`, `blender --background --python`. Those are the
building blocks, not things to reimplement.

**2. Read the native format.** The project file is the data layer: MLT XML, ODF ZIP,
SVG, `.blend` driven by a bpy script. Manipulate it directly.

**3. Map GUI actions to calls.** Every button and menu item is a function call. If the
app has undo/redo it almost certainly uses a command pattern, and those commands are
your CLI operations.

**4. Choose the interaction model.** A stateful REPL suits agents that keep context; a
subcommand CLI suits one-shot scripting. Supporting both is usually right. Decide what
persists between commands and where that state lives.

**5. Give the agent introspection.** `info`, `list`, and `status` matter more here than
in a human CLI: an agent cannot look at the screen to see what it just did. Fail loudly
with unambiguous messages so it can self-correct, and keep commands idempotent.

## The trap: the rendering gap

A harness can write a perfectly valid project file and still render nothing. The
registry says a filter exists; the render path never applies it. Every effect the CLI
advertises needs a render mapping, or explicit documentation that it is project-only.

Verify by probing the artifact, not by trusting exit code 0 — sample frames, compare
pixel statistics against the source, check audio RMS at the boundaries. When comparing
across resolutions, exclude letterbox padding or the numbers lie.

## Before installing anything

The upstream registry (`cli-hub install <name>`) distributes community-contributed
Python packages that an agent then executes. That is a supply-chain surface, and
upstream's own security policy is explicit that an agent may autonomously construct and
run commands from untrusted input.

Read a harness before installing it. Prefer writing the harness for the one application
the task needs over installing a registry entry you have not reviewed.

## Upstream

Methodology from [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything)
(Apache-2.0). The full harness specification, per-phase guides, and 80+ reference
harnesses live there; this skill is a condensed operating procedure, not a copy.

The `/cli-anything` command in the `.omk/extensions/cli-anything` extension loads this
skill with a target path or repository already filled in.
