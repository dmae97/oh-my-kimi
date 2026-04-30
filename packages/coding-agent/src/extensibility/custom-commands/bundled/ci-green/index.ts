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

export class GreenCommand implements CustomCommand {
	name = "green";
	description = "Generate a prompt to iterate on CI failures until the branch is green";

	constructor(private api: CustomCommandAPI) {}

	async execute(_args: string[], _ctx: HookCommandContext): Promise<string> {
		const headTag = await getHeadTag(this.api);
		return prompt.render(ciGreenRequestTemplate, { headTag });
	}
}
