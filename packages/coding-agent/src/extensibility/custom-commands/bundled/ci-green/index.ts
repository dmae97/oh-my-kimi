import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import ciGreenRequestTemplate from "../../../../prompts/ci-green-request.md" with { type: "text" };
import * as git from "../../../../utils/git";

async function getHeadTag(api: CustomCommandAPI): Promise<string | undefined> {
	try {
		return (await git.ref.tags(api.cwd))[0];
	} catch {
		return undefined;
	}
}

async function getCurrentBranch(api: CustomCommandAPI): Promise<string> {
	try {
		return (await git.branch.current(api.cwd)) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

async function getPushRemote(api: CustomCommandAPI, branch: string): Promise<string | undefined> {
	try {
		return (
			(await git.config.getBranch(api.cwd, branch, "pushRemote")) ??
			(await git.config.getBranch(api.cwd, branch, "remote"))
		);
	} catch {
		return undefined;
	}
}

async function getHeadTagContext(api: CustomCommandAPI): Promise<{ branch: string; headTag?: string; remote: string }> {
	const branch = await getCurrentBranch(api);
	const [headTag, pushRemote] = await Promise.all([getHeadTag(api), getPushRemote(api, branch)]);
	return {
		headTag,
		branch,
		remote: pushRemote ?? "origin",
	};
}

export class GreenCommand implements CustomCommand {
	name = "green";
	description = "Generate a prompt to iterate on CI failures until the branch is green";

	constructor(private api: CustomCommandAPI) {}

	async execute(_args: string[], _ctx: HookCommandContext): Promise<string> {
		const { headTag, branch, remote } = await getHeadTagContext(this.api);
		return prompt.render(ciGreenRequestTemplate, { headTag, branch, remote });
	}
}
