import { untilAborted } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tool-errors";

/** Sleeps inside evaluated browser code while honoring the owning run's cancellation signal. */
export async function waitForBrowserRun(ms: number, signal: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await untilAborted(signal, () => Bun.sleep(ms));
	throwIfAborted(signal);
}
