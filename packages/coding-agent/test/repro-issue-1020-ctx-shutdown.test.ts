import { describe, expect, test } from "bun:test";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../src/extensibility/extensions";
import type { InteractiveModeContext } from "../src/modes/types";

/**
 * Issue #1020: `ctx.shutdown()` is a no-op in interactive mode.
 *
 * The `contextActions.shutdown` handler wired by
 * `ExtensionUiController.initializeHookRunner` is supposed to flip
 * `InteractiveMode.shutdownRequested` so the main loop's
 * `checkShutdownRequested()` can drive the graceful shutdown path.
 */
describe("issue #1020 - ctx.shutdown() in interactive mode", () => {
	test("contextActions.shutdown sets InteractiveModeContext.shutdownRequested", () => {
		let capturedContextActions: ExtensionContextActions | undefined;

		const fakeExtensionRunner = {
			initialize(
				_actions: ExtensionActions,
				contextActions: ExtensionContextActions,
				_commandContextActions?: ExtensionCommandContextActions,
				_uiContext?: ExtensionUIContext,
			): void {
				capturedContextActions = contextActions;
			},
		};

		const ctxStub = {
			shutdownRequested: false,
			session: {
				extensionRunner: fakeExtensionRunner,
				// other session fields are only touched lazily by other actions; we
				// only invoke `shutdown`, so leave them out.
			},
		} as unknown as InteractiveModeContext;

		const controller = new ExtensionUiController(ctxStub);
		controller.initializeHookRunner({} as ExtensionUIContext, false);

		expect(capturedContextActions).toBeDefined();
		expect(typeof capturedContextActions?.shutdown).toBe("function");

		capturedContextActions?.shutdown();

		expect(ctxStub.shutdownRequested).toBe(true);
	});
});
