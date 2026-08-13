import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	ApprovalReceiptStore,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	PlannotatorApprovalBridge,
} from "open-multi-agent-kit";

interface LoadedPlan {
	path: string;
	content: string;
}

function loadWorkspacePlan(cwd: string, input: string): LoadedPlan {
	const workspaceRoot = realpathSync(cwd);
	const planPath = realpathSync(resolve(workspaceRoot, input));
	const relativePath = relative(workspaceRoot, planPath);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error("Plan must be a file inside the current workspace");
	}
	if (!statSync(planPath).isFile()) throw new Error("Plan must be a regular file");
	return { path: relativePath.split(sep).join("/"), content: readFileSync(planPath, "utf8") };
}

export default function plannotatorApprovalBridgeExtension(omk: ExtensionAPI): void {
	let bridge: PlannotatorApprovalBridge | undefined;

	function initializeBridge(ctx: ExtensionContext): void {
		bridge?.dispose();
		bridge = new PlannotatorApprovalBridge({
			eventBus: omk.events,
			store: new ApprovalReceiptStore(join(ctx.sessionManager.getSessionDir(), "approval-receipts")),
			workspaceRoot: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			interactive: ctx.mode === "tui" && ctx.hasUI,
			requestTimeoutMs: 5_000,
			onReceipt: (receipt, write) => {
				omk.appendEntry("approval-receipt-v1", receipt);
				ctx.ui.notify(
					`Approval ${receipt.core.decision}; immutable receipt ${write.created ? "created" : "verified"}. No execution was started.`,
					receipt.core.decision === "approved" ? "info" : "warning",
				);
			},
			onError: () => ctx.ui.notify("Ignored an invalid or uncorrelated Plannotator event.", "warning"),
		});
		bridge.start();
	}

	omk.on("session_start", async (_event, ctx) => initializeBridge(ctx));
	omk.on("session_shutdown", async () => {
		bridge?.dispose();
		bridge = undefined;
	});

	omk.registerCommand("approval-review", {
		description: "Review a workspace plan with Plannotator and persist a non-executing approval receipt",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("Approval review requires interactive TUI mode.", "error");
				return;
			}
			if (!bridge) initializeBridge(ctx);
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /approval-review <workspace-relative-plan.md>", "warning");
				return;
			}
			try {
				const plan = loadWorkspacePlan(ctx.cwd, input);
				const correlation = await bridge?.requestReview({ planPath: plan.path, planContent: plan.content });
				if (!correlation) throw new Error("Approval bridge is unavailable");
				ctx.ui.notify(
					`Plannotator review opened (${correlation.reviewId}); waiting for an explicit decision.`,
					"info",
				);
			} catch {
				ctx.ui.notify("Approval review failed. Confirm the plan path and that Plannotator is loaded.", "error");
			}
		},
	});
}
