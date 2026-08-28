/**
 * CLI-Anything commands for OMK.
 *
 * Upstream ships a Pi extension that injects a vendored copy of its harness
 * specification into the session. This one injects the `cli-anything` skill
 * instead: OMK already loads skills on demand, so vendoring an Apache-2.0
 * document into an MIT repository would add attribution obligations and a
 * second copy to keep in step with upstream, in exchange for nothing.
 *
 * Each command is a thin front end. It validates that a target was given, then
 * hands the agent the skill plus the target, which is the whole job.
 */

import type { ExtensionAPI } from "open-multi-agent-kit";

const SKILL = "cli-anything";

type CommandSpec = {
	/** Slash command name. */
	name: string;
	/** Shown in the command list. */
	description: string;
	/** Printed when the command is invoked with no target. */
	usage: string;
	/** What the agent is being asked to do with the target. */
	instruction: string;
};

const COMMANDS: CommandSpec[] = [
	{
		name: "cli-anything",
		description: "Build a CLI harness that lets an agent drive GUI-only software",
		usage: "Usage: /cli-anything <path-or-repo>\n\nA local path to the software's source, or a GitHub repository URL.",
		instruction:
			"Build a CLI harness for this software so an agent can drive it without a display. Follow the skill's procedure: find the engine, read the native format, then generate that format and hand it to the real binary.",
	},
	{
		name: "cli-anything:refine",
		description: "Widen an existing CLI harness's coverage",
		usage:
			'Usage: /cli-anything:refine <harness-path> [focus]\n\nExample: /cli-anything:refine ./gimp-cli "batch filters"',
		instruction:
			"Widen this existing harness's coverage. Check the rendering gap first: every effect the CLI advertises needs a render mapping, or documentation saying it is project-only.",
	},
	{
		name: "cli-anything:test",
		description: "Verify a CLI harness renders what it claims",
		usage: "Usage: /cli-anything:test <harness-path>\n\nA local path to the harness to exercise.",
		instruction:
			"Verify this harness by probing the artifacts it produces, not by trusting exit codes. Sample the output and compare it against the source.",
	},
];

/** Compose the message that carries the skill and the target to the agent. */
export function buildCommandMessage(spec: CommandSpec, target: string): string {
	return [`!skill:${SKILL}`, "", spec.instruction, "", `Target: ${target}`].join("\n");
}

export default function cliAnythingExtension(omk: ExtensionAPI): void {
	for (const spec of COMMANDS) {
		omk.registerCommand(spec.name, {
			description: spec.description,
			handler: async (args, ctx) => {
				const target = args.trim();
				if (!target) {
					ctx.ui.notify(spec.usage, "warning");
					return;
				}
				// The command context carries the UI; message delivery is on the API.
				omk.sendUserMessage(buildCommandMessage(spec, target));
			},
		});
	}
}

/** Exported for the command-surface tests. */
export const commandSpecs: readonly CommandSpec[] = COMMANDS;
