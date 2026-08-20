import { detectIdenticalLoop, type LoopRecord } from "../../identical-loop.ts";
import type { ExtensionAPI } from "../types.ts";

export default function identicalLoop(omk: ExtensionAPI): void {
	const records: LoopRecord[] = [];

	omk.on("session_start", () => {
		records.length = 0;
	});
	omk.on("input", (event) => {
		if (event.source !== "extension") records.length = 0;
	});
	omk.on("tool_call", (event) => {
		records.push({ toolName: event.toolName, args: event.input });
		const detection = detectIdenticalLoop(records, { warnAfter: 3, stopAfter: 6 });
		if (!detection) return;
		if (detection.kind === "stop") {
			return {
				block: true,
				reason: `identical loop: ${detection.toolName} repeated ${detection.count} times with the same args`,
			};
		}
		omk.sendMessage({
			customType: "identical-loop",
			content: `Same ${detection.toolName} call repeated ${detection.count} times. Change the args or stop.`,
			display: true,
			details: detection,
		});
		return undefined;
	});
}
