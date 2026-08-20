import { applyToolPairRepair } from "../../tool-pair-repair.ts";
import type { ContextEvent, ContextEventResult, ExtensionAPI } from "../types.ts";

export default function toolPairRepair(omk: ExtensionAPI): void {
	omk.on("context", (event: ContextEvent): ContextEventResult | undefined => {
		const repaired = applyToolPairRepair(event.messages);
		const unchanged =
			repaired.length === event.messages.length &&
			repaired.every((message, index) => message === event.messages[index]);
		if (unchanged) return undefined;
		return { messages: repaired };
	});
}
