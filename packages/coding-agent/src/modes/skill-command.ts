import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { getSkillSlashCommandName, parseSkillInvocation } from "../extensibility/skills";
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

/** Return true when `text` invokes a registered `/skill:<name>` command. */
export function isKnownSkillCommand(ctx: SkillCommandHost, text: string): boolean {
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	return ctx.skillCommands.has(getSkillSlashCommandName({ name: parsed.name }));
}

/** Build the user-attributed custom message for a registered `/skill:<name>` command. */
export async function buildSkillCommandPrompt(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
	images?: ImageContent[],
): Promise<BuiltSkillCommandPrompt | undefined> {
	const parsed = parseSkillInvocation(text);
	if (!parsed) return undefined;
	const commandName = getSkillSlashCommandName({ name: parsed.name });
	const skillPath = ctx.skillCommands.get(commandName);
	if (!skillPath) return undefined;

	const content = await Bun.file(skillPath).text();
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	const metaLines = [`Skill: ${skillPath}`];
	if (parsed.args) {
		metaLines.push(`User: ${parsed.args}`);
	}
	const message = `${body}\n\n---\n\n${metaLines.join("\n")}`;
	const textBlock: TextContent = { type: "text", text: message };
	const promptContent = images && images.length > 0 ? [textBlock, ...images] : message;
	const details: SkillPromptDetails = {
		name: parsed.name,
		path: skillPath,
		args: parsed.args || undefined,
		lineCount: body ? body.split("\n").length : 0,
	};

	return {
		message: {
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: promptContent,
			display: true,
			details,
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
