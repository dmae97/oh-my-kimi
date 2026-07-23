#!/usr/bin/env node

process.stdout.write(
	`${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "fixture subagent completed" }],
			provider: "fixture-provider",
			model: "fixture-model",
		},
	})}\n`,
);
