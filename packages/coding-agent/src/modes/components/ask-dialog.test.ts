import { describe, expect, it } from "bun:test";
import type { ExtensionAskDialogSubmitResult } from "../../extensibility/extensions";
import { AskDialogComponent } from "./ask-dialog";

describe("AskDialogComponent input", () => {
	it("ignores space for a highlighted single-select answer", () => {
		let submitted: ExtensionAskDialogSubmitResult | undefined;
		const dialog = new AskDialogComponent(
			[
				{
					id: "continue",
					question: "Continue?",
					options: [{ label: "Yes" }, { label: "No" }],
					recommended: 0,
				},
			],
			{
				onSubmit(result) {
					submitted = result;
				},
				onCancel() {
					throw new Error("unexpected cancel");
				},
				async onPrompt() {
					throw new Error("unexpected prompt");
				},
			},
		);

		dialog.handleInput(" ");
		expect(submitted).toBeUndefined();

		dialog.handleInput("\r");
		expect(submitted?.results[0]?.selectedOptions).toEqual(["Yes"]);
	});
});
