import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { buildSkillPromptMessage } from "../extensibility/skills";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../session/messages";
import type { InteractiveModeContext } from "./types";

type SkillCommandHost = Pick<InteractiveModeContext, "skillCommands" | "session" | "showError">;

type SkillPromptMessage = Pick<
	CustomMessage<SkillPromptDetails>,
	"customType" | "content" | "display" | "details" | "attribution"
> & {
	customType: typeof SKILL_PROMPT_MESSAGE_TYPE;
	content: string | (TextContent | ImageContent)[];
	display: true;
	details: SkillPromptDetails;
	attribution: "user";
};

type SkillPromptOptions = {
	streamingBehavior: "steer" | "followUp";
	queueChipText: string;
};

interface ParsedSkillCommand {
	commandName: string;
	args: string;
}

interface InvokeSkillCommandOptions {
	propagateErrors?: boolean;
	queueOnly?: boolean;
	images?: ImageContent[];
}

/** Built custom-message payload and delivery options for a `/skill:` command. */
export interface BuiltSkillCommandPrompt {
	message: SkillPromptMessage;
	options: SkillPromptOptions;
}

function parseSkillCommand(text: string): ParsedSkillCommand | undefined {
	if (!text.startsWith("/skill:")) return undefined;
	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	return { commandName, args };
}

/** Return true when `text` names a registered `/skill:<name>` command. */
export function isKnownSkillCommand(ctx: SkillCommandHost, text: string): boolean {
	const parsed = parseSkillCommand(text);
	if (!parsed) return false;
	return ctx.skillCommands.has(parsed.commandName);
}

/** Build the user-attributed custom message for a registered `/skill:<name>` command. */
export async function buildSkillCommandPrompt(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
	images?: ImageContent[],
): Promise<BuiltSkillCommandPrompt | undefined> {
	const parsed = parseSkillCommand(text);
	if (!parsed) return undefined;
	const skill = ctx.skillCommands.get(parsed.commandName);
	if (!skill) return undefined;

	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	const textBlock: TextContent = { type: "text", text: built.message };
	const promptContent = images && images.length > 0 ? [textBlock, ...images] : built.message;

	return {
		message: {
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: promptContent,
			display: true,
			details: built.details,
			attribution: "user",
		},
		options: { streamingBehavior, queueChipText: text },
	};
}

/** Invoke a registered `/skill:<name>` command as a user-attributed custom message. */
export async function invokeSkillCommandFromText(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
	options?: InvokeSkillCommandOptions,
): Promise<boolean> {
	try {
		const built = await buildSkillCommandPrompt(ctx, text, streamingBehavior, options?.images);
		if (!built) return false;
		const promptOptions = options?.queueOnly ? { ...built.options, queueOnly: true } : built.options;
		await ctx.session.promptCustomMessage(built.message, promptOptions);
		return true;
	} catch (err) {
		if (options?.propagateErrors) {
			throw err;
		}
		ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
		return true;
	}
}
