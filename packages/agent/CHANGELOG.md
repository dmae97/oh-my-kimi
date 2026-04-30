# Changelog

## [Unreleased]

### Added

- Added an `onResponse` stream option for observing provider response metadata after response headers arrive.

## [14.2.0] - 2026-04-23

### Changed

- Changed tool dispatch to match model-returned tool calls by either internal tool name or custom wire name, enabling custom OpenAI tool names such as `apply_patch`.

## [14.0.1] - 2026-04-08
### Added

- Added `onAssistantMessageEvent` callback option to inspect assistant streaming events before they are emitted, enabling abort decisions before buffered events continue flowing
- Added `setAssistantMessageEventInterceptor()` method to dynamically set or update the assistant message event interceptor

## [13.13.0] - 2026-03-18

### Added

- Added `startup.checkUpdate` setting, set to `true` by default, can be disabled to skip the update check on agent initialization

## [13.12.7] - 2026-03-16

### Added

- Added overload for `prompt()` method accepting a string input with optional options parameter

### Fixed

- Fixed stale forced toolChoice being passed to provider after tools are refreshed mid-turn

## [13.9.16] - 2026-03-10
### Added

- Added `onPayload` option to `AgentOptions` to inspect or replace provider payloads before they are sent

## [13.9.3] - 2026-03-07

### Added

- Exported `ThinkingLevel` selector constants and types for configuring agent reasoning behavior
- Added `inherit` thinking level option to defer reasoning configuration to higher-level selectors
- Added `serviceTier` option to configure service tier for agent requests

### Changed

- Changed `thinkingLevel` from required string to optional `Effort` type, allowing undefined state
- Updated `setThinkingLevel()` method to accept `Effort | undefined` instead of `ThinkingLevel` string

## [13.4.0] - 2026-03-01
### Added

- Added `getToolChoice` option to dynamically override tool choice per LLM call

## [13.3.8] - 2026-02-28
### Changed

- Changed intent field name from `agent__intent` to `_i` in tool schemas

### Fixed

- Fixed synthetic tool result text formatting so aborted/error tool results no longer emit `Tool execution was aborted.: Request was aborted` style punctuation.
## [13.3.7] - 2026-02-27
### Added

- Added `lenientArgValidation` option to tools to allow graceful handling of argument validation errors by passing raw arguments to execute() instead of returning an error to the LLM

## [13.3.1] - 2026-02-26
### Added

- Added `topP`, `topK`, `minP`, `presencePenalty`, and `repetitionPenalty` options to `AgentOptions` for fine-grained sampling control
- Added getter and setter properties for sampling parameters on the `Agent` class to allow runtime configuration

## [13.1.0] - 2026-02-23

### Changed

- Removed per-tool `agent__intent` field description from injected schema to reduce token usage; intent format is now documented once in the system prompt instead of repeated in every tool definition
## [12.19.0] - 2026-02-22
### Changed

- Updated tool result messages to include error details when tool execution fails

## [12.14.0] - 2026-02-19

### Added

- Added `intentTracing` option to enable intent goal extraction from tool calls, allowing models to specify high-level goals via a required `_intent` field that is automatically injected into tool schemas and stripped from arguments before execution

## [12.11.0] - 2026-02-19

### Added

- Exported `AgentBusyError` exception class for handling concurrent agent operations

### Changed

- Agent now throws `AgentBusyError` instead of generic `Error` when attempting concurrent operations

## [12.8.0] - 2026-02-16

### Added

- Added `transformToolCallArguments` option to `AgentOptions` and `AgentLoopConfig` for transforming tool call arguments before execution (e.g. secret deobfuscation)

## [12.2.0] - 2026-02-13

### Added

- Added `providerSessionState` option to share provider state map for session-scoped transport and session caches
- Added `preferWebsockets` option to hint that websocket transport should be preferred when supported by the provider implementation

## [11.10.0] - 2026-02-10

### Added

- Added `temperature` option to `AgentOptions` to control LLM sampling temperature
- Added `temperature` getter and setter to `Agent` class for runtime configuration

## [11.6.0] - 2026-02-07

### Added

- Added `hasQueuedMessages()` method to check for pending steering/follow-up messages
- Resume queued steering and follow-up messages from `continue()` after auto-compaction

### Changed

- Extracted `dequeueSteeringMessages()` and `dequeueFollowUpMessages()` from inline config callbacks
- Added `skipInitialSteeringPoll` option to `_runLoop()` for correct queue resume ordering

## [11.3.0] - 2026-02-06

### Added

- Added `maxRetryDelayMs` option to AgentOptions to cap server-requested retry delays, allowing higher-level retry logic to handle long waits with user visibility

### Changed

- Updated ThinkingLevel documentation to include support for gpt-5.3 and gpt-5.3-codex models with 'xhigh' thinking level

## [11.2.0] - 2026-02-05

### Fixed

- Fixed handling of aborted requests to properly throw abort errors when stream terminates without a terminal event

## [10.5.0] - 2026-02-04

### Added

- Added `concurrency` option to `AgentTool` to control tool scheduling: "shared" (default, runs in parallel) or "exclusive" (runs alone)
- Implemented parallel execution of shared tools within a single agent turn for improved performance

### Changed

- Refactored tool execution to support concurrent scheduling with proper interrupt handling and steering message checks

## [9.2.2] - 2026-01-31

### Added

- Added toolChoice option to AgentPromptOptions for controlling tool selection

## [8.2.0] - 2026-01-24

### Changed

- Updated TypeScript configuration for better publish-time configuration handling with tsconfig.publish.json

## [8.0.0] - 2026-01-23

### Added

- Added `nonAbortable` option to tools to ignore abort signals during execution

## [6.8.0] - 2026-01-20

### Changed

- Updated proxy stream processing to use utility function for reading lines

## [6.2.0] - 2026-01-19

### Added

- Enhanced getToolContext to receive tool call batch information including batchId, index, total count, and tool call details

## [5.6.7] - 2026-01-18

### Fixed

- Added proper tool result messages for tool calls that are aborted or error out
- Ensured tool_use/tool_result pairing is maintained when tool execution fails

## [4.6.0] - 2026-01-12

### Changed

- Modified assistant message handling to split messages around tool results for improved readability when using Cursor tools

### Fixed

- Fixed tool result ordering in Cursor mode by buffering results and emitting them at the correct position within assistant messages

## [4.3.0] - 2026-01-11

### Added

- Added `cursorExecHandlers` and `cursorOnToolResult` options for local tool execution with cursor-based streaming
- Added `emitExternalEvent` method to allow external event injection into the agent state

## [4.0.0] - 2026-01-10

### Added

- Added `popLastSteer()` and `popLastFollowUp()` methods to remove and return the last queued message (LIFO) for dequeue operations
- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level
- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`

## [3.33.0] - 2026-01-08

### Fixed

- Ensured aborted assistant responses always include an error message for callers.
- Filtered thinking blocks from Cerebras request context to keep multi-turn prompts compatible.

## [3.21.0] - 2026-01-06

### Changed

- Switched from local `@oh-my-pi/pi-ai` to upstream `@oh-my-pi/pi-ai` package

### Added

- Added `sessionId` option for provider caching (e.g., OpenAI Codex session-based prompt caching)
- Added `sessionId` getter/setter on Agent class for runtime session switching

## [3.20.0] - 2026-01-06

### Breaking Changes

- Replaced `queueMessage`/`queueMode` with steering + follow-up queues: use `steer`, `setSteeringMode`, and `getSteeringMode` for mid-run interruptions, and `followUp`, `setFollowUpMode`, and `getFollowUpMode` for post-turn messages
- Agent loop callbacks now use `getSteeringMessages` and `getFollowUpMessages` instead of `getQueuedMessages`

### Added

- Added follow-up message queue support so new user messages can continue a run after the agent would otherwise stop
- Added `RenderResultOptions.spinnerFrame` for animated tool-result rendering

### Changed

- `prompt()` and `continue()` now throw when the agent is already streaming; use steering or follow-up queues instead

## [3.4.1337] - 2026-01-03

### Added

- Added `popMessage()` method to Agent class for removing and retrieving the last message
- Added abort signal checks during response streaming for faster interruption handling

### Fixed

- Fixed abort handling to properly return aborted message state when stream is interrupted mid-response

## [1.341.0] - 2026-01-03

### Added

- Added `interruptMode` option to control when queued messages interrupt tool execution.
- Implemented "immediate" mode (default) to check queue after each tool and interrupt remaining tools.
- Implemented "wait" mode to defer queue processing until the entire turn completes.
- Added getter and setter methods for `interruptMode` on Agent class.

## [1.337.1] - 2026-01-02

### Changed

- Forked to @oh-my-pi scope with unified versioning across all packages

## [1.337.0] - 2026-01-02

Initial release under @oh-my-pi scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.

- **Agent options renamed**:
  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`

- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.

- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.

- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.

- **Agent loop moved from `@oh-my-pi/pi-ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@oh-my-pi/pi-agent` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from pi-ai.

- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.

- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).

- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.

- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).

- `queueMessage()` is now synchronous (no longer returns a Promise).
