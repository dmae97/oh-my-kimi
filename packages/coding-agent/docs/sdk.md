> omk can help you use the SDK. Ask it to build an integration for your use case.

# SDK

The SDK provides programmatic access to omk's agent capabilities. Use it to embed omk in other applications, build custom interfaces, or integrate with automated workflows.

**Example use cases:**
- Build a custom UI (web, desktop, mobile)
- Integrate agent capabilities into existing applications
- Create automated pipelines with agent reasoning
- Build custom tools that spawn sub-agents
- Test agent behavior programmatically

See [examples/sdk/](../examples/sdk/) for working examples from minimal to full control.

## Quick Start

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "open-multi-agent-kit";

// Set up credential storage and model registry
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

## Installation

```bash
npm install open-multi-agent-kit
```

The SDK is included in the main package. No separate installation needed.

## Core Concepts

### createAgentSession()

The main factory function for a single `AgentSession`.

`createAgentSession()` uses a `ResourceLoader` to supply extensions, skills, prompt templates, themes, and context files. If you do not provide one, it uses `DefaultResourceLoader` with standard discovery.

```typescript
import { createAgentSession, SessionManager } from "open-multi-agent-kit";

// Minimal: defaults with DefaultResourceLoader
const { session } = await createAgentSession();

// Custom: override specific options
const { session } = await createAgentSession({
  model: myModel,
  tools: ["read", "bash"],
  sessionManager: SessionManager.inMemory(),
});
```

### AgentSession

The session manages agent lifecycle, message history, model state, compaction, and event streaming.

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Lifecycle and termination
  lastTermination: SessionTermination | undefined;
  recordProcessSignal(signal: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT"): SessionTermination;

  // Audit / repair
  transcriptRepair: { insertedToolCallIds: string[]; reason: string } | undefined;
  runJournalRecords: readonly unknown[];
  runJournalQuarantineReport: RunJournalQuarantineReport | null;

  // Workspace mutation signals (used by evidence freshness gating)
  sessionRiskLevel: "normal" | "elevated";
  workspaceMutationCount: number;

  // Model control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // In-place tree navigation within the current session file
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;

  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): void;
}
```

Session replacement APIs such as new-session, resume, fork, and import live on `AgentSessionRuntime`, not on `AgentSession`.

### createAgentSessionRuntime() and AgentSessionRuntime

Use the runtime API when you need to replace the active session and rebuild cwd-bound runtime state.
This is the same layer used by the built-in interactive, print, and RPC modes.

`createAgentSessionRuntime()` takes a runtime factory plus the initial cwd/session target. The factory closes over process-global fixed inputs, recreates cwd-bound services for the effective cwd, resolves session options against those services, and returns a full runtime result.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "open-multi-agent-kit";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});
```

`AgentSessionRuntime` owns replacement of the active runtime across:

- `newSession()`
- `switchSession()`
- `fork()`
- clone flows via `fork(entryId, { position: "at" })`
- `importFromJsonl()`

Important behavior:

- `runtime.session` changes after those operations
- event subscriptions are attached to a specific `AgentSession`, so re-subscribe after replacement
- if you use extensions, call `runtime.session.bindExtensions(...)` again for the new session
- creation returns diagnostics on `runtime.diagnostics`
- if runtime creation or replacement fails, the method throws and the caller decides how to handle it

```typescript
let session = runtime.session;
let unsubscribe = session.subscribe(() => {});

await runtime.newSession();

unsubscribe();
session = runtime.session;
unsubscribe = session.subscribe(() => {});
```

### Run Termination and Replay Binding

Every real AgentSession run emits a `session_termination` event and exposes the latest value as `session.lastTermination`. The typed record includes `kind`, `provider`, `model`, retry flags, `causeCode`, `nextAction`, and `runId`; persisted sessions also fsync lifecycle records to `<session>.runjournal`.

To share evidence freshness ordering with runtime repairs and late tool settlements, pass the same optional replay ledger to the session and `VerifiedEvidenceExecutor`:

```typescript
const ledger = new ReplayLedgerManager(goalId, ledgerPath);
const { session } = await createAgentSession({
  replayLedger: ledger,
  replayGoalId: goalId,
  replayLaneId: laneId,
});
const executor = new VerifiedEvidenceExecutor({ store, ledger });
```

`transcript_repaired`, `tool_timeout`, `tool_late_settlement`, and `workspace_mutation` use that ledger. A receipt at or before a later relevant workspace mutation is blocked by `EvidenceGate`.

### Prompting and Message Queueing

`PromptOptions` controls prompt expansion, queueing behavior while streaming, and prompt preflight notifications:

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

`preflightResult` is called once per `prompt()` invocation:

- `true` when the prompt was accepted, queued, or handled immediately
- `false` when prompt preflight rejected before acceptance

It fires before `prompt()` resolves. `prompt()` still resolves only after the full accepted run finishes, including retries. Failures after acceptance are reported through the normal event and message stream, not through `preflightResult(false)`.

The `prompt()` method handles prompt templates, extension commands, and message sending:

```typescript
// Basic prompt (when not streaming)
await session.prompt("What files are here?");

// With images
await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }]
});

// During streaming: must specify how to queue the message
await session.prompt("Stop and do this instead", { streamingBehavior: "steer" });
await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

**Behavior:**
- **Extension commands** (e.g., `/mycommand`): Execute immediately, even during streaming. They manage their own LLM interaction via `omk.sendMessage()`.
- **File-based prompt templates** (from `.md` files): Expanded to their content before sending or queueing.
- **During streaming without `streamingBehavior`**: Throws an error. Use `steer()` or `followUp()` directly, or specify the option.
- **`preflightResult(true)`**: Means the prompt was accepted, queued, or handled immediately.
- **`preflightResult(false)`**: Means preflight rejected before acceptance.

For explicit queueing during streaming:

```typescript
// Queue a steering message for delivery after the current assistant turn finishes its tool calls
await session.steer("New instruction");

// Wait for agent to finish (delivered only when agent stops)
await session.followUp("After you're done, also do this");
```

Both `steer()` and `followUp()` expand file-based prompt templates but error on extension commands (extension commands cannot be queued).

### Agent and AgentState

The `Agent` class (from `omk-agent-core`) handles the core LLM interaction. Access it via `session.agent`.

```typescript
// Access current state
const state = session.agent.state;

// state.messages: AgentMessage[] - conversation history
// state.model: Model - current model
// state.thinkingLevel: ThinkingLevel - current thinking level
// state.systemPrompt: string - system prompt
// state.tools: AgentTool[] - available tools
// state.streamingMessage?: AgentMessage - current partial assistant message
// state.errorMessage?: string - latest assistant error

// Replace messages (useful for branching or restoration)
session.agent.state.messages = messages; // copies the top-level array

// Replace tools
session.agent.state.tools = tools; // copies the top-level array

// Wait for agent to finish processing
await session.agent.waitForIdle();
```

### Events

Subscribe to events to receive streaming output and lifecycle notifications.

```typescript
session.subscribe((event) => {
  switch (event.type) {
    // Streaming text from assistant
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        // Thinking output (if thinking enabled)
      }
      break;
    
    // Tool execution
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_update":
      // Streaming tool output
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.isError ? "error" : "success"}`);
      break;
    
    // Message lifecycle
    case "message_start":
      // New message starting
      break;
    case "message_end":
      // Message complete
      break;
    
    // Agent lifecycle
    case "agent_start":
      // Agent started processing prompt
      break;
    case "agent_end":
      // Agent finished (event.messages contains new messages)
      break;
    
    // Turn lifecycle (one LLM response + tool calls)
    case "turn_start":
      break;
    case "turn_end":
      // event.message: assistant response
      // event.toolResults: tool results from this turn
      break;
    
    // Session events (queue, compaction, retry, termination, workspace mutation)
    case "queue_update":
      console.log(event.steering, event.followUp);
      break;
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      break;
    case "session_termination":
      // event.termination: latest session termination record
      break;
    case "workspace_mutation":
      // Emitted when a late-settling potentially-writing tool may have mutated the workspace
      break;
  }
});
```

## Options Reference

### Directories

```typescript
const { session } = await createAgentSession({
  // Working directory for DefaultResourceLoader discovery
  cwd: process.cwd(), // default
  
  // Global config directory
  agentDir: "~/.omk/agent", // default (expands ~)
});
```

`cwd` is used by `DefaultResourceLoader` for:
- Project extensions (`.omk/extensions/`)
- Project skills:
  - `.omk/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Project prompts (`.omk/prompts/`)
- Context files (`AGENTS.md` walking up from cwd)
- Session directory naming

`agentDir` is used by `DefaultResourceLoader` for:
- Global extensions (`extensions/`)
- Global skills:
  - `skills/` under `agentDir` (for example `~/.omk/agent/skills/`)
  - `~/.agents/skills/`
- Global prompts (`prompts/`)
- Global context file (`AGENTS.md`)
- Settings (`settings.json`)
- Custom models (`models.json`)
- Credentials (`auth.json`)
- Sessions (`sessions/`)

When you pass a custom `ResourceLoader`, `cwd` and `agentDir` no longer control resource discovery. They still influence session naming and tool path resolution.

### Model

```typescript
import { getModel } from "omk-ai";
import { AuthStorage, ModelRegistry } from "open-multi-agent-kit";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Find specific built-in model (doesn't check if API key exists)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
// (doesn't check if API key exists)
const customModel = modelRegistry.find("my-provider", "my-model");

// Get only models that have valid API keys configured
const available = await modelRegistry.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh
  
  // Models for cycling (Ctrl+P in interactive mode)
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],
  
  authStorage,
  modelRegistry,
});
```

If no model is provided:
1. Tries to restore from session (if continuing)
2. Uses default from settings
3. Falls back to first available model

> See [examples/sdk/02-custom-model.ts](../examples/sdk/02-custom-model.ts)

### API Keys and OAuth

API key resolution priority (handled by AuthStorage):
1. Runtime overrides (via `setRuntimeApiKey`, not persisted)
2. Stored credentials in `auth.json` (API keys or OAuth tokens)
3. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
4. Fallback resolver (for custom provider keys from `models.json`)

```typescript
import { AuthStorage, ModelRegistry } from "open-multi-agent-kit";

// Default: uses ~/.omk/agent/auth.json and ~/.omk/agent/models.json
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");

// Custom auth storage location
const customAuth = AuthStorage.create("/my/app/auth.json");
const customRegistry = ModelRegistry.create(customAuth, "/my/app/models.json");

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: customAuth,
  modelRegistry: customRegistry,
});

// No custom models.json (built-in models only)
const simpleRegistry = ModelRegistry.inMemory(authStorage);
```

> See [examples/sdk/09-api-keys-and-oauth.ts](../examples/sdk/09-api-keys-and-oauth.ts)

### System Prompt

Use a `ResourceLoader` to override the system prompt:

```typescript
import { createAgentSession, DefaultResourceLoader } from "open-multi-agent-kit";

const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/03-custom-prompt.ts](../examples/sdk/03-custom-prompt.ts)

### Tools

Specify which built-in tools to enable:

- Built-in tool names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`
- Default built-ins: `read`, `bash`, `edit`, `write`
- `noTools: "all"` disables all tools
- `noTools: "builtin"` disables default built-ins while keeping extension and custom tools enabled
- `excludeTools` disables specific built-in, extension, or custom tool names after any `tools` allowlist is applied

The `edit` tool returns `details.diff` for OMK's TUI display and `details.patch` as a standard unified patch for SDK consumers.

```typescript
import { createAgentSession } from "open-multi-agent-kit";

// Read-only mode
const { session } = await createAgentSession({
  tools: ["read", "grep", "find", "ls"],
});

// Pick specific tools
const { session } = await createAgentSession({
  tools: ["read", "bash", "grep"],
});

// Disable one tool while keeping the rest available
const { session } = await createAgentSession({
  excludeTools: ["ask_question"],
});
```

#### Tools with Custom cwd

When you pass a custom `cwd`, `createAgentSession()` builds selected built-in tools for that cwd.

```typescript
import { createAgentSession, SessionManager } from "open-multi-agent-kit";

const cwd = "/path/to/project";

// Use default tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
});

// Or pick specific tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  tools: ["read", "bash", "grep"],
  sessionManager: SessionManager.inMemory(cwd),
});
```

> See [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### Custom Tools

```typescript
import { Type } from "typebox";
import { createAgentSession, defineTool } from "open-multi-agent-kit";

// Inline custom tool
const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({
    input: Type.String({ description: "Input value" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
});

// Pass custom tools directly
const { session } = await createAgentSession({
  customTools: [myTool],
});
```

Use `defineTool()` for standalone definitions and arrays like `customTools: [myTool]`. Inline `omk.registerTool({ ... })` already infers parameter types correctly.

Custom tools passed via `customTools` are combined with extension-registered tools. Extensions loaded by the ResourceLoader can also register tools via `omk.registerTool()`.

If you pass `tools`, include each custom or extension tool name you want enabled, for example `tools: ["read", "bash", "my_tool"]`.

> See [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### Extensions

Extensions are loaded by the `ResourceLoader`. `DefaultResourceLoader` discovers extensions from `~/.omk/agent/extensions/`, `.omk/extensions/`, and settings.json extension sources.

```typescript
import { createAgentSession, DefaultResourceLoader } from "open-multi-agent-kit";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [
    (omk) => {
      omk.on("agent_start", () => {
        console.log("[Inline Extension] Agent starting");
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

Extensions can register tools, subscribe to events, add commands, and more. See [extensions.md](extensions.md) for the full API.

**Event Bus:** Extensions can communicate via `omk.events`. Pass a shared `eventBus` to `DefaultResourceLoader` if you need to emit or listen from outside:

```typescript
import { createEventBus, DefaultResourceLoader } from "open-multi-agent-kit";

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  eventBus,
});
await loader.reload();

eventBus.on("my-extension:status", (data) => console.log(data));
```

> See [examples/sdk/06-extensions.ts](../examples/sdk/06-extensions.ts) and [docs/extensions.md](extensions.md)

### Skills

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type Skill,
} from "open-multi-agent-kit";

const customSkill: Skill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};

const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/04-skills.ts](../examples/sdk/04-skills.ts)

### Context Files

```typescript
import { createAgentSession, DefaultResourceLoader } from "open-multi-agent-kit";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# Guidelines\n\n- Be concise" },
    ],
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/07-context-files.ts](../examples/sdk/07-context-files.ts)

### Slash Commands

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type PromptTemplate,
} from "open-multi-agent-kit";

const customCommand: PromptTemplate = {
  name: "deploy",
  description: "Deploy the application",
  source: "(custom)",
  content: "# Deploy\n\n1. Build\n2. Test\n3. Deploy",
};

const loader = new DefaultResourceLoader({
  promptsOverride: (current) => ({
    prompts: [...current.prompts, customCommand],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/08-prompt-templates.ts](../examples/sdk/08-prompt-templates.ts)

### Session Management

Sessions use a tree structure with `id`/`parentId` linking, enabling in-place branching.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "open-multi-agent-kit";

// In-memory (no persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// New persistent session
const { session: persisted } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

// Continue most recent
const { session: continued, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) {
  console.log("Note:", modelFallbackMessage);
}

// Open specific file
const { session: opened } = await createAgentSession({
  sessionManager: SessionManager.open("/path/to/session.jsonl"),
});

// List sessions
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Session replacement API for /new, /resume, /fork, /clone, and import flows.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

// Replace the active session with a fresh one
await runtime.newSession();

// Replace the active session with another saved session
await runtime.switchSession("/path/to/session.jsonl");

// Replace the active session with a fork from a specific user entry
await runtime.fork("entry-id");

// Clone the active path through a specific entry
await runtime.fork("entry-id", { position: "at" });
```

**SessionManager tree API:**

```typescript
const sm = SessionManager.open("/path/to/session.jsonl");

// Session listing
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Tree traversal
const entries = sm.getEntries();        // All entries (excludes header)
const tree = sm.getTree();              // Full tree structure
const path = sm.getPath();              // Path from root to current leaf
const leaf = sm.getLeafEntry();         // Current leaf entry
const entry = sm.getEntry(id);          // Get entry by ID
const children = sm.getChildren(id);    // Direct children of entry

// Labels
const label = sm.getLabel(id);          // Get label for entry
sm.appendLabelChange(id, "checkpoint"); // Set label

// Branching
sm.branch(entryId);                     // Move leaf to earlier entry
sm.branchWithSummary(id, "Summary...");  // Branch with context summary
sm.createBranchedSession(leafId);       // Extract path to new file
```

> See [examples/sdk/11-sessions.ts](../examples/sdk/11-sessions.ts) and [Session Format](session-format.md)

### Settings Management

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "open-multi-agent-kit";

// Default: loads from files (global + project merged)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// With overrides
const settingsManager = SettingsManager.create();
settingsManager.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5 },
});
const { session } = await createAgentSession({ settingsManager });

// In-memory (no file I/O, for testing)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  sessionManager: SessionManager.inMemory(),
});

// Custom directories
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create("/custom/cwd", "/custom/agent"),
});
```

**Static factories:**
- `SettingsManager.create(cwd?, agentDir?)` - Load from files
- `SettingsManager.inMemory(settings?)` - No file I/O

**Project-specific settings:**

Settings load from two locations and merge:
1. Global: `~/.omk/agent/settings.json`
2. Project: `<cwd>/.omk/settings.json`

Project overrides global. Nested objects merge keys. Setters modify global settings by default.

**Persistence and error handling semantics:**

- Settings getters/setters are synchronous for in-memory state.
- Setters enqueue persistence writes asynchronously.
- Call `await settingsManager.flush()` when you need a durability boundary (for example, before process exit or before asserting file contents in tests).
- `SettingsManager` does not print settings I/O errors. Use `settingsManager.drainErrors()` and report them in your app layer.

> See [examples/sdk/10-settings.ts](../examples/sdk/10-settings.ts)

## ResourceLoader

Use `DefaultResourceLoader` to discover extensions, skills, prompts, themes, and context files.

```typescript
import {
  DefaultResourceLoader,
  getAgentDir,
} from "open-multi-agent-kit";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
});
await loader.reload();

const extensions = loader.getExtensions();
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const themes = loader.getThemes();
const contextFiles = loader.getAgentsFiles().agentsFiles;
```

## Return Value

`createAgentSession()` returns:

```typescript
interface CreateAgentSessionResult {
  // The session
  session: AgentSession;
  
  // Extensions result (for runner setup)
  extensionsResult: LoadExtensionsResult;
  
  // Warning if session model couldn't be restored
  modelFallbackMessage?: string;
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
```

## Complete Example

```typescript
import { getModel } from "omk-ai";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "open-multi-agent-kit";

// Set up auth storage (custom location)
const authStorage = AuthStorage.create("/custom/agent/auth.json");

// Runtime API key override (not persisted)
if (process.env.MY_KEY) {
  authStorage.setRuntimeApiKey("anthropic", process.env.MY_KEY);
}

// Model registry (no custom models.json)
const modelRegistry = ModelRegistry.create(authStorage);

// Inline tool
const statusTool = defineTool({
  name: "status",
  label: "Status",
  description: "Get system status",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `Uptime: ${process.uptime()}s` }],
    details: {},
  }),
});

const model = getModel("anthropic", "claude-opus-4-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: "/custom/agent",
  settingsManager,
  systemPromptOverride: () => "You are a minimal assistant. Be concise.",
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: "/custom/agent",

  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,

  tools: ["read", "bash", "status"],
  customTools: [statusTool],
  resourceLoader: loader,

  sessionManager: SessionManager.inMemory(),
  settingsManager,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Get status and list files.");
```

## Run Modes

The SDK exports run mode utilities for building custom interfaces on top of `createAgentSession()`:

### InteractiveMode

Full TUI interactive mode with editor, chat history, and all built-in commands:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "open-multi-agent-kit";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### runPrintMode

Single-shot mode: send prompts, output result, exit:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runPrintMode,
  SessionManager,
} from "open-multi-agent-kit";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: ["Follow up"],
});
```

### runRpcMode

JSON-RPC mode for subprocess integration:

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "open-multi-agent-kit";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runRpcMode(runtime);
```

See [RPC documentation](rpc.md) for the JSON protocol.

## RPC Mode Alternative

For subprocess-based integration without building with the SDK, use the CLI directly:

```bash
omk --mode rpc --no-session
```

See [RPC documentation](rpc.md) for the JSON protocol.

The SDK is preferred when:
- You want type safety
- You're in the same Node.js process
- You need direct access to agent state
- You want to customize tools/extensions programmatically

RPC mode is preferred when:
- You're integrating from another language
- You want process isolation
- You're building a language-agnostic client

## Evidence and Verification

Execution-bound evidence is an optional, application-driven layer. It records a declared verification command and reported outcome between two artifact-set snapshots, then binds that record to a tamper-evident ledger. `VerifiedEvidenceExecutor` never executes the declared command. The opt-in `executeVerifiedBash()` adapter invokes caller-supplied `BashOperations`; `executeVerifiedLocalBash()` instead derives the shell identity and runner from OMK's built-in local backend. The default CLI and AgentSession bash paths remain unverified. The repository CI workflow is the sole built-in callsite: it runs the release-consistency verifier through the local adapter.

### Recorded and invoked inputs

| Input | SDK behavior |
|-------|--------------|
| `request.command` (`EvidenceCommandDescriptor`) | Validates, hashes, and records the structured descriptor; never executes it |
| `request.executor` (`"bash-tool" \| "ci-runner" \| "mcp" \| "internal"`) | Records a label only |
| `request.workspaceScope` (`WorkspaceScope`) | Captures the selected artifact set before and after the callback |
| `request.execute` | Invokes your callback; your application owns its implementation and truthfulness |
| `executeVerifiedBash()` | Passes the exact shell script to injected `BashOperations`; the caller supplies the matching shell identity and trusts the runner |
| `executeVerifiedLocalBash()` | Resolves OMK's local shell identity, creates the matching local `BashOperations`, and delegates to `executeVerifiedBash()` |

### Runner honesty is a trust boundary

The SDK cannot prove that a callback or injected runner executed what it reported. A direct `VerifiedEvidenceExecutor` callback must execute the exact descriptor, normalize the disposition, and return already-redacted `Uint8Array` output.

`executeVerifiedBash()` handles the mechanical shell adapter contract:

- records a `kind: "shell"` descriptor using the same script passed to `BashOperations.exec()`,
- maps exit, timeout, and abort states to receipt dispositions,
- retains a rolling 128 KiB combined-output tail, applies OMK's high-confidence text redaction, then keeps the final 64 KiB, and
- records the combined `BashOperations` stream as receipt `stdout`; receipt `stderr` is empty because that interface does not expose separate channels.

The policy is best-effort masking, not DLP. A credential spanning the rolling-window cut may lose matching context, although receipts persist only the resulting digest and byte count. The runner, declared shell identity, environment, remote execution behavior, and any runner-owned spill files remain caller trust boundaries. The script is stored in the receipt after credential-shaped preflight, so keep secrets out of command strings.

Injected runners must follow the built-in terminal protocol: return an integer exit code, throw `Error("aborted")` for abort, or throw an error whose message starts with `timeout:`. Other failures propagate without a receipt; `null` or non-integer exit codes fail closed with `VerifiedBashAdapterError`.

`executeVerifiedLocalBash()` removes the caller-declared shell mismatch by resolving the descriptor shell and local backend from the same shell setting. It does not bind the inherited environment, prove runner honesty, or provide OS isolation.

### First-party CI callsite

`.github/workflows/ci.yml` invokes the compiled `dist/verify-ci.js` entry after the normal repository check. That entry runs only `node scripts/check-release-consistency.mjs` through `executeVerifiedLocalBash()` with `executor: "ci-runner"`, applies a strict `EvidenceGate`, writes receipts, ledger, and report under `.omk/ci-evidence`, and returns a non-zero process exit when the gate is blocked. CI uploads that directory as `verified-release-consistency`.

This callsite does not wrap the full build, check, or test suite and does not enable receipts for interactive, RPC, or SDK-created AgentSession bash calls. Its workspace freshness scope is limited to the root and coding-agent package manifests.

### Execution ordering

`VerifiedEvidenceExecutor.execute(request)` runs, in order:

1. before artifact-set snapshot (`workspaceBefore`)
2. your callback (`await request.execute()`)
3. after artifact-set snapshot (`workspaceAfter`)
4. replay-ledger `append` + `persist()`
5. envelope binding to the ledger event (`seq`, `eventHash`)
6. no-overwrite store publish (hard-link; cannot replace an existing receipt)

Ledger and receipt publication are fail-closed but not one filesystem transaction. A failure after `ledger.persist()` and before publication can leave a dangling ledger event; a failure after hard-link publication can leave a readable receipt even though `execute()` rejects. Reconcile the ledger and store before retrying an explicit receipt ID.

### Freshness, ledger load, and store hardening

- **Freshness** compares only the caller-selected artifact set (`WorkspaceScope.artifactPaths`). It issues no Git command and carries no Git fingerprint.
- **Ledger**: `ReplayLedgerManager` verifies an existing ledger on construction (sequence order, prev-hash chain, payload hash, event hash) and **fails closed** on any violation.
- **Store**: `EvidenceReceiptStore` uses an owner-only directory, symlink rejection, no-overwrite hard-link publication, and identity rechecks to detect observed path replacement. These checks assume same-UID path mutation is quiescent; they are **not** filesystem sandbox isolation.

### Receipt policy

`EvidenceGate` (default `receiptMode: "prefer"`) gates a `TaskContract` against its satisfied receipts. Pass `executor.createGateOptions()` so the gate resolves receipts, ledger events, and workspace fingerprints from the same store and ledger.

| Mode | Soft missing data | Tamper-grade mismatch | Legacy `hash` / `command` |
|------|-------------------|-----------------------|----------------------------|
| `strict` | blocked | blocked | n/a |
| `prefer` (default) | conditional | blocked | n/a |
| `legacy` | receipt checks skipped | receipt checks skipped | checked by legacy options (enabled by default) |

Soft missing data means no resolver was supplied or a resolver returned `undefined`. Resolver exceptions are hard failures in both `strict` and `prefer`. The resolver from `createGateOptions()` calls `EvidenceReceiptStore.read()`, so a claimed receipt ID that has no stored file throws and blocks the gate.

Tamper-grade mismatches include: receipt ID, goal, or claim mismatch; schema version ≠ 3; status not `passed` or `exitCode` ≠ 0; command-SHA mismatch; lane mismatch; artifact-changed-after-verification; and ledger-binding mismatch.

`createGateOptions()` returns three resolvers bound to the executor's own store and ledger: `resolveReceipt` (read a stored receipt), `resolveLedgerEvent` (find a chain event by `seq`), and `captureWorkspaceFingerprint` (snapshot the selected artifact set). The gate validates every returned value.

### Integration example

```typescript
import {
  EvidenceGate, EvidenceReceiptStore, executeVerifiedLocalBash,
  ReplayLedgerManager, TaskContractBuilder, VerifiedEvidenceExecutor,
  type WorkspaceScope,
} from "open-multi-agent-kit";

const goalId = "goal-123";
const claim = "repository checks passed";
const cwd = process.cwd();
const workspaceScope: WorkspaceScope = { root: cwd, artifactPaths: ["packages/coding-agent/src/index.ts"] };

const store = new EvidenceReceiptStore("/secure/receipts");
const ledger = new ReplayLedgerManager(goalId, "/secure/ledger.jsonl");
const executor = new VerifiedEvidenceExecutor({ store, ledger });

const { evidenceMetadata } = await executeVerifiedLocalBash({
  evidenceExecutor: executor,
  goalId,
  claim,
  script: "npm run check",
  cwd,
  timeoutMs: 30_000,
  workspaceScope,
});

const contract = new TaskContractBuilder(goalId)
  .setClaim(claim)
  .addRequiredEvidence({
    claim, category: "feature",
    receiptId: evidenceMetadata.receiptId, receiptSchemaVersion: 3,
    receiptCommandSha256: evidenceMetadata.receiptCommandSha256,
  })
  .updateEvidenceStatus(claim, "satisfied")
  .setVerdict("pass")
  .build();

const result = new EvidenceGate(executor.createGateOptions()).check(contract);
// result.status: "open" | "conditional" | "blocked"
```

## Exports

The main entry point exports:

```typescript
// Factory
createAgentSession
createAgentSessionFromServices
createAgentSessionRuntime
createAgentSessionServices
AgentSessionRuntime

// Auth and Models
AuthStorage
ModelRegistry

// Resource loading
DefaultResourceLoader
type ResourceLoader
createEventBus

// Helpers
defineTool

// Session management
SessionManager
SettingsManager

// Tool factories
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool
createLocalBashOperations

// Compaction (programmatic primitives)
calculateContextTokens, compact, createCompactionEnvelope,
createCompactionHysteresisConfig, createCompactionHysteresisState,
createCompactionSourceIdentity, createCompactionTransaction,
createSessionRevisionToken, decideCompactionCommit, estimateTokens,
evaluateCompactionBarrier, findCutPoint, findTurnStartIndex,
generateBranchSummary, generateSummary, getLastAssistantUsage,
prepareBranchEntries, serializeConversation, shouldCompact, stepCompactionHysteresis,
validateCompactionEnvelope

// Context-budget v2 and reserved-token budget
planPromptContextBudgetV2, applyContextCacheInvalidation,
createMemoryContextBudgetCacheProviderV2, buildContextBudgetPlanCacheKeyV2,
buildContextBudgetMaterializedRepresentationCacheKeyV2, createContextBudgetCacheKeyBaseV2,
createContextCacheInvalidationSnapshot, serializeContextCacheSnapshot,
CONTEXT_BUDGET_POLICY_VERSION_V2
computeReservedTokenBudget, estimateToolResultReserve, ReservedTokenBudgetError

// Run journal and session termination
RunJournalStore, appendRunJournalRecordDurably, writeQuarantineBytesDurably,
classifySessionTermination, formatSessionTermination, SessionTerminationError

// Execution-bound evidence (optional, application-driven verification receipts)
EvidenceReceiptStore
ReplayLedgerManager
EvidenceGate
FailClosedMergeGate
TaskContractBuilder
VerifiedEvidenceExecutor
VerifiedEvidenceExecutorError
executeVerifiedBash
executeVerifiedLocalBash
VERIFIED_BASH_REDACTION_POLICY_ID
VerifiedBashAdapterError
redactCommandDescriptor
createCommandHmacBinder
EVIDENCE_COMMAND_REDACTION_POLICY_ID
MAX_COMMAND_REDACTION_PLACEHOLDERS
parseCommandHmacBinding
parseCommandRedactionSummary
CommandRedactionError

// Types
type CreateAgentSessionOptions
type CreateAgentSessionResult
type CreateAgentSessionRuntimeFactory
type CreateAgentSessionRuntimeResult
type CreateAgentSessionServicesOptions
type ExtensionFactory
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
type CompactionEnvelope
type CompactionTransaction
type CompactionHysteresisConfig
type CompactionHysteresisState
type CompactionBarrierResult
type CompactionCommitDecision
type ContextBudgetCacheProviderV2
type ContextCacheInvalidationEvent
type ContextCacheInvalidationSnapshot
type ReservedTokenBudgetInput
type ReservedTokenBudgetResult
type RunJournalQuarantineReport
type SessionTermination
type SessionTerminationCause
type SessionTerminationKind
type ToolSchedulerSetting
type AgentRuntimeSettings
type VerifiedBashExecutionRequest
type VerifiedLocalBashExecutionRequest
type EvidenceGateOptions
type VerifiedEvidenceExecutionRequest
type VerifiedEvidenceExecutionResult
type VerifiedEvidenceExecutionOutcome
type EvidenceReceiptMode
type TaskContract
type EvidenceCommandDescriptor
type WorkspaceScope
type CommandRedactionPlaceholder
type CommandRedactionSummary
type EvidenceReceipt
type EvidenceReceiptLedgerBinding
type ReplayEvent
type ReplayEventType
type WorkspaceMutationReplayPayload
type Sha256Hex
type ArtifactSetWorkspaceFingerprint
```

For extension types, see [extensions.md](extensions.md) for the full API.
