import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createDurableGoal, DurableGoalError, type DurableGoalSnapshot } from "../../durable-goal.ts";
import { formatDurableGoalCheckpoint, parseDurableGoalCheckpointCommand } from "../../durable-goal-checkpoint.ts";
import { DurableGoalStore } from "../../durable-goal-store.ts";
import { decideGoalContinuation } from "../../goal-continuation.ts";
import type { ExtensionAPI } from "../types.ts";

function goalPath(cwd: string): string {
	return join(cwd, ".omk", "goals", "current.json");
}

function renderGoal(goal: DurableGoalSnapshot): string {
	return `goal ${goal.ref.id} r${goal.ref.revision} ${goal.status} ${goal.completedRounds}/${goal.maxRounds}\n${formatDurableGoalCheckpoint(goal)}`;
}

function checkpointPayload(text: string): string | null {
	if (text === "checkpoint") return "";
	return text.startsWith("checkpoint ") ? text.slice("checkpoint ".length).trim() : null;
}

function unavailableWorkspaceCode(error: unknown): "ENODEV" | "ESTALE" | "ENOTCONN" | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return code === "ENODEV" || code === "ESTALE" || code === "ENOTCONN" ? code : undefined;
}

function continuationSeam(goal: DurableGoalSnapshot, trustedDigests: ReadonlySet<string>): string {
	const checkpoint = goal.checkpoint;
	if (!checkpoint) return "";
	if (trustedDigests.has(checkpoint.digest)) {
		return `\n\nSeam checkpoint (explicit user continuity context, not current-round proof):\n${formatDurableGoalCheckpoint(goal)}`;
	}
	return `\n\nAn untrusted workspace checkpoint exists at digest ${checkpoint.digest}; its prose was not loaded as user authority.`;
}

export default function goalController(omk: ExtensionAPI): void {
	const trustedCheckpointDigests = new Set<string>();
	omk.registerCommand("goal", {
		description: "Show, set, checkpoint, pause, resume, complete, or clear the durable session goal",
		handler: async (args, ctx) => {
			const store = new DurableGoalStore(goalPath(ctx.cwd));
			const text = args.trim();
			try {
				if (text.length === 0) {
					const current = await store.current();
					ctx.ui.notify(current ? renderGoal(current) : "no durable goal", "info");
					return;
				}
				const existing = await store.current();
				if (text === "pause" || text === "resume" || text === "complete" || text === "clear") {
					if (!existing) throw new DurableGoalError("store-missing", "durable goal does not exist");
					const next = await store.transition({ kind: text, ref: existing.ref }, new Date().toISOString());
					if (text === "clear") trustedCheckpointDigests.clear();
					ctx.ui.notify(renderGoal(next), "info");
					return;
				}
				const payload = checkpointPayload(text);
				if (payload !== null) {
					if (!existing) throw new DurableGoalError("store-missing", "durable goal does not exist");
					if (payload.length === 0) {
						throw new DurableGoalError(
							"invalid-input",
							'usage: /goal checkpoint {"core":[],"verified":[],"open":[],"next":"..."}',
						);
					}
					const now = new Date().toISOString();
					const next = await store.transition(
						{
							kind: "record-checkpoint",
							ref: existing.ref,
							checkpoint: parseDurableGoalCheckpointCommand(payload, now),
						},
						now,
					);
					const checkpoint = next.checkpoint;
					if (!checkpoint) throw new DurableGoalError("invalid-store", "durable goal journal is invalid");
					omk.appendEntry("goal_checkpoint", {
						goalId: next.ref.id,
						goalRevision: next.ref.revision,
						checkpointDigest: checkpoint.digest,
					});
					trustedCheckpointDigests.add(checkpoint.digest);
					ctx.ui.notify(renderGoal(next), "info");
					return;
				}
				if (existing && existing.status !== "cleared" && existing.status !== "completed") {
					const next = await store.transition(
						{ kind: "edit", ref: existing.ref, objective: text },
						new Date().toISOString(),
					);
					ctx.ui.notify(renderGoal(next), "info");
					return;
				}
				if (existing) await rm(goalPath(ctx.cwd), { force: true });
				const created = await store.create(
					createDurableGoal({ id: "session", objective: text, maxRounds: 8, now: new Date().toISOString() }),
				);
				ctx.ui.notify(renderGoal(created), "info");
			} catch (error) {
				const message = error instanceof DurableGoalError ? error.message : "goal command failed";
				ctx.ui.notify(message, "error");
			}
		},
	});

	omk.on("agent_end", async (_event, ctx) => {
		const store = new DurableGoalStore(goalPath(ctx.cwd));
		let current: DurableGoalSnapshot | null;
		try {
			current = await store.current();
		} catch (error) {
			const code = unavailableWorkspaceCode(error);
			if (!code) throw error;
			omk.appendEntry("goal_workspace_unavailable", { code });
			return;
		}
		if (!current) return;
		const decision = decideGoalContinuation({
			status: current.status,
			completedRounds: current.completedRounds,
			maxRounds: current.maxRounds,
			hasQueuedMessages: ctx.hasPendingMessages(),
		});
		if (decision.reason === "queued" || !decision.continue) return;
		const advanced = await store.transition({ kind: "advance-round", ref: current.ref }, new Date().toISOString());
		const seam = continuationSeam(advanced, trustedCheckpointDigests);
		omk.sendUserMessage(
			`Continue the active goal (${advanced.completedRounds}/${advanced.maxRounds}): ${advanced.objective}${seam}`,
		);
	});
}
