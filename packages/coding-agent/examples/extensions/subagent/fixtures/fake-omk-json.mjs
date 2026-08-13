#!/usr/bin/env node

const expectedModel = process.env.OMK_EXPECTED_MODEL;
if (expectedModel) {
	const modelIndex = process.argv.indexOf("--model");
	const actualModel = modelIndex === -1 ? undefined : process.argv[modelIndex + 1];
	if (actualModel !== expectedModel) {
		process.stderr.write(`expected --model ${expectedModel}, received ${actualModel ?? "none"}\n`);
		process.exit(2);
	}
}

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
