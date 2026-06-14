# Fix for Gemini Premature Stop and Rule Leaking

This document details the analysis and proposed fix for a premature termination and rule-leaking issue observed with `gemini-3.5-flash` (via the `google-antigravity` provider) in session `be1793`.

## Problem Description

In session `be1793` (UUID `019ec257-7d3b-7000-877b-704c2ebe1793`), after successfully updating a Grafana dashboard and backing up its state, the model returned the following text response and ended generation:

```
Incredibly perfect! The backup has successfully run.
All Git statuses remain clean in the `linkedin-bot-iac` repo since we didn't add any files to Git.

We are completely finished! I will summarize the changes and conclude.
No emdashes. casual, technical, direct, human voice. Let's do that!
```

Because the model produced no tool calls, the framework (OMP) yielded control back to the user, leaving the session paused without the promised summary. The model's last line (`No emdashes. casual, technical, direct, human voice. Let's do that!`) was a leak of its active system prompt guidelines and personality rules.

## Root Cause Analysis

1. **Large Context Size Attention Degradation**: The active conversation context was **353,751 tokens** (input 644, cached 353,107). Long-context models can suffer from attention degradation as the context window fills, causing them to lose track of the boundary between internal planning/instruction compliance and final text generation.
2. **Preamble/Rules Leakage**: The model was attempting to follow rules such as avoiding em dashes and maintaining a casual teammate voice. Instead of processing this internally, the model generated its rule checklist out loud and terminated.
3. **Turn-Yielding Behavior**: Once the model stopped generating (with a normal `STOP` status returned by the Gemini API) and did not request any tools, OMP paused the turn.

## Proposed Fix

To prevent the model from leaking its constraints and stopping prematurely before generating the actual response, we localize the fix directly in the Gemini provider instruction injection block (`packages/ai/src/providers/google-gemini-cli.ts`). 

When constructing the request for Antigravity, we append a critical instruction block directly after the ignore tag instruction:

```typescript
	if (isAntigravity && shouldInjectAntigravitySystemInstruction(model.id)) {
		const existingParts = request.systemInstruction?.parts ?? [];
		request.systemInstruction = {
			role: "user",
			parts: [
				{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
				{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
				{ text: `CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.` },
				...existingParts,
			],
		};
	}
```

This targets the exact injection point that confuses the model, applies exclusively to the `google-gemini-cli` provider under Antigravity, and avoids altering the system prompts globally for all other models and providers.
## Testing and Verification Protocol

### 1. Interactive Reproduction (E2E)

We can resume the exact session using the OMP CLI to verify the behavior in the live environment:

```bash
bun packages/coding-agent/src/cli.ts --resume 019ec257-7d3b-7000-877b-704c2ebe1793
```

- **Before the fix**: Resuming the session will show the model repeating its formatting checklists / rule reminders and stopping early.
- **After the fix**: Resuming the session will result in a clean generation that avoids rule leakage and successfully concludes with the task summary.

### 2. Automated Script-Based Verification

We can write a standalone script `scripts/reproduce-be1793.ts` to programmatically invoke the provider and assert behavior:

1. Read the history up to turn 5351 from the JSONL log file.
2. Call the `streamGoogleGeminiCli` API with this history and active system prompt templates.
3. Verify the output stream:
   - **Before the fix**: The response contains leaked rules (e.g. `No emdashes`, `Let's follow rules`).
   - **After the fix**: The response is clean, contains only the summary, and terminates without preambles.

### 3. Automated Unit Testing

Add a unit test in `packages/ai/test/google-system-prompt.test.ts` to assert that the injected system instructions for Antigravity contain the new critical constraint:
`CRITICAL: NEVER output rule checks, formatting guidelines...`
