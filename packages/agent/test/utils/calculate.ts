import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core/types";
import * as z from "zod/v4";

export interface CalculateResult extends AgentToolResult<undefined> {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
}

export function calculate(expression: string): CalculateResult {
	try {
		const result = new Function(`return ${expression}`)();
		return { content: [{ type: "text", text: `${expression} = ${result}` }], details: undefined };
	} catch (e: any) {
		throw new Error(e.message || String(e));
	}
}

const calculateSchema = z.object({
	expression: z.string().describe("The mathematical expression to evaluate"),
});

type CalculateParams = z.infer<typeof calculateSchema>;

export const calculateTool: AgentTool<typeof calculateSchema, undefined> = {
	label: "Calculator",
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
	execute: async (_toolCallId: string, args: CalculateParams) => {
		return calculate(args.expression);
	},
};
