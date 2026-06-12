import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core/types";
import { z } from "zod/v4";

export interface GetCurrentTimeResult extends AgentToolResult<{ utcTimestamp: number }> {}

export async function getCurrentTime(timezone?: string): Promise<GetCurrentTimeResult> {
	const date = new Date();
	if (timezone) {
		try {
			const timeStr = date.toLocaleString("en-US", {
				timeZone: timezone,
				dateStyle: "full",
				timeStyle: "long",
			});
			return {
				content: [{ type: "text", text: timeStr }],
				details: { utcTimestamp: date.getTime() },
			};
		} catch {
			throw new Error(`Invalid timezone: ${timezone}. Current UTC time: ${date.toISOString()}`);
		}
	}
	const timeStr = date.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" });
	return {
		content: [{ type: "text", text: timeStr }],
		details: { utcTimestamp: date.getTime() },
	};
}

const getCurrentTimeSchema = z.object({
	timezone: z.string().describe("Optional timezone (e.g., 'America/New_York', 'Europe/London')").optional(),
});

type GetCurrentTimeParams = z.infer<typeof getCurrentTimeSchema>;

export const getCurrentTimeTool: AgentTool<typeof getCurrentTimeSchema, { utcTimestamp: number }> = {
	label: "Current Time",
	name: "get_current_time",
	description: "Get the current date and time",
	parameters: getCurrentTimeSchema,
	execute: async (_toolCallId: string, args: GetCurrentTimeParams) => {
		return getCurrentTime(args.timezone);
	},
};
