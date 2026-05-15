# Custom Tools Examples

Example custom tools for omp-coding-agent.

## Examples

Each example uses the `subdirectory/index.ts` structure required for tool discovery.

### hello/

Minimal example showing the basic structure of a custom tool.

### todo/

Full-featured example demonstrating:

- `onSession` for state reconstruction from session history
- Custom `renderCall` and `renderResult`
- Proper branching support via details storage
- State management without external files

## Usage

```bash
# Test directly (can point to any .ts file)
omp --tool examples/custom-tools/todo/index.ts

# Or copy entire folder to tools directory for persistent use
cp -r todo ~/.omp/agent/tools/
```

Then in omp:

```
> add a todo "test custom tools"
> list todos
> toggle todo #1
> clear todos
```

## Writing Custom Tools

See [docs/custom-tools.md](../../docs/custom-tools.md) for full documentation.

### Key Points

**Factory pattern:**

```typescript
import { StringEnum } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
	name: "my_tool",
	label: "My Tool",
	description: "Tool description for LLM",
	parameters: pi.zod.object({
		action: StringEnum(["list", "add"] as const),
	}),

	// Called on session start/switch/branch/clear
	onSession(event) {
		// Reconstruct state from event.entries
	},

	async execute(toolCallId, params) {
		return {
			content: [{ type: "text", text: "Result" }],
			details: {
				/* for rendering and state reconstruction */
			},
		};
	},
});

export default factory;
```

**Legacy:** `parameters: pi.typebox.Type.Object({ ... })` still works; the injected `typebox` is a small Zod-backed shim, and schemas flow through the same Zod pipeline as `pi.zod` schemas.

**Custom rendering:**

```typescript
renderCall(args, theme) {
  return new Text(
    theme.fg("toolTitle", theme.bold("my_tool ")) + args.action,
    0, 0  // No padding - Box handles it
  );
},

renderResult(result, { expanded, isPartial }, theme) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Working..."), 0, 0);
  }
  return new Text(theme.fg("success", "✓ Done"), 0, 0);
},
```

**Use `StringEnum` for discriminated string tool args** (required for Google API compatibility):

```typescript
import { StringEnum } from "@oh-my-pi/pi-ai";

const { z } = pi.zod;

// Good — Google-safe enum wiring
parameters: z.object({
	action: StringEnum(["list", "add"] as const),
});

// Avoid raw union-of-literals patterns that don't degrade well for strict JSON Schema providers
```
