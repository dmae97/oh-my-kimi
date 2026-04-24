import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { applyAutoresearchContractToExperimentState } from "../apply-contract-to-state";
import {
	contractListsEqual,
	contractPathListsEqual,
	loadAutoresearchScriptSnapshot,
	readAutoresearchContract,
} from "../contract";
import {
	abandonUnloggedAutoresearchRuns,
	collectLoggedRunNumbers,
	isAutoresearchShCommand,
	readMaxExperiments,
	readPendingRunSummary,
	resolveWorkDir,
	validateWorkDir,
} from "../helpers";
import { cloneExperimentState } from "../state";
import type { AutoresearchToolFactoryOptions, ExperimentState } from "../types";

const initExperimentSchema = Type.Object({
	name: Type.String({
		description: "Human-readable experiment name.",
	}),
	from_autoresearch_md: Type.Optional(
		Type.Boolean({
			description:
				"When true, load benchmark command, metrics, scope, off-limits, and constraints from autoresearch.md instead of passing mirrored fields below.",
		}),
	),
	abandon_unlogged_runs: Type.Optional(
		Type.Boolean({
			description:
				"When true, mark all completed but unlogged run artifacts as abandoned so initialization can proceed without logging them first.",
		}),
	),
	new_segment: Type.Optional(
		Type.Boolean({
			description:
				"When true, force a new segment even when the contract fields have not changed. Without this, re-initialization with matching contract is a no-op.",
		}),
	),
	metric_name: Type.Optional(
		Type.String({
			description: "Primary metric name shown in the dashboard. Required when from_autoresearch_md is false.",
		}),
	),
	metric_unit: Type.Optional(
		Type.String({
			description: "Unit for the primary metric, for example µs, ms, s, kb, or empty.",
		}),
	),
	direction: Type.Optional(
		StringEnum(["lower", "higher"], {
			description: "Whether lower or higher values are better. Defaults to lower.",
		}),
	),
	benchmark_command: Type.Optional(
		Type.String({
			description: "Benchmark command recorded in autoresearch.md. Required when from_autoresearch_md is false.",
		}),
	),
	scope_paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files in Scope from autoresearch.md. Required when from_autoresearch_md is false.",
			minItems: 1,
		}),
	),
	off_limits: Type.Optional(
		Type.Array(Type.String(), {
			description: "Off Limits paths from autoresearch.md.",
		}),
	),
	constraints: Type.Optional(
		Type.Array(Type.String(), {
			description: "Constraints from autoresearch.md.",
		}),
	),
});

interface InitExperimentDetails {
	state: ExperimentState;
}

export function createInitExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof initExperimentSchema, InitExperimentDetails> {
	return {
		name: "init_experiment",
		label: "Init Experiment",
		description:
			"Initialize or reset the autoresearch session for the current optimization target before the first logged run of a segment.",
		parameters: initExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workDirError = validateWorkDir(ctx.cwd);
			if (workDirError) {
				return {
					content: [{ type: "text", text: `Error: ${workDirError}` }],
				};
			}

			const runtime = options.getRuntime(ctx);
			const state = runtime.state;
			const isReinitializing = state.results.length > 0;
			const workDir = resolveWorkDir(ctx.cwd);
			const loggedRunNumbers = collectLoggedRunNumbers(state.results);

			let abandonSummary = "";
			if (params.abandon_unlogged_runs === true) {
				const abandoned = await abandonUnloggedAutoresearchRuns(workDir, loggedRunNumbers);
				if (abandoned > 0) {
					abandonSummary =
						abandoned === 1
							? "Abandoned 1 unlogged run artifact.\n"
							: `Abandoned ${abandoned} unlogged run artifacts.\n`;
				}
			}

			const pendingRun = await readPendingRunSummary(workDir, loggedRunNumbers);
			if (pendingRun) {
				const metricInfo = pendingRun.parsedPrimary !== null ? `, metric=${pendingRun.parsedPrimary}` : "";
				const passedInfo = pendingRun.passed ? "passed" : "failed";
				return {
					content: [
						{
							type: "text",
							text:
								abandonSummary +
								`Error: run #${pendingRun.runNumber} has not been logged yet.\n` +
								`Pending: command="${pendingRun.command}"${metricInfo}, ${passedInfo}\n` +
								"Call log_experiment before re-initializing, or pass abandon_unlogged_runs=true.",
						},
					],
				};
			}

			const contractResult = readAutoresearchContract(workDir);
			const scriptSnapshot = loadAutoresearchScriptSnapshot(workDir);
			const errors = [...contractResult.errors, ...scriptSnapshot.errors];
			if (errors.length > 0) {
				return {
					content: [{ type: "text", text: `${abandonSummary}Error: ${errors.join(" ")}` }],
				};
			}

			const benchmarkContract = contractResult.contract.benchmark;
			const expectedDirection = benchmarkContract.direction ?? "lower";
			const expectedMetricUnit = benchmarkContract.metricUnit;
			if (benchmarkContract.command && !isAutoresearchShCommand(benchmarkContract.command)) {
				return {
					content: [
						{
							type: "text",
							text:
								abandonSummary +
								"Error: Benchmark.command in autoresearch.md must invoke `autoresearch.sh` directly. " +
								"Move the real workload into `autoresearch.sh` and re-run init_experiment.",
						},
					],
				};
			}

			const fromMd = params.from_autoresearch_md === true;
			if (!fromMd) {
				const metricName = params.metric_name?.trim();
				const benchmarkCommand = params.benchmark_command?.trim();
				const scopePaths = params.scope_paths;
				if (!metricName || !benchmarkCommand || !scopePaths || scopePaths.length === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									"Error: when from_autoresearch_md is false or omitted, metric_name, benchmark_command, and scope_paths are required and must match autoresearch.md. " +
									"Alternatively pass from_autoresearch_md=true with only name (plus optional flags).",
							},
						],
					};
				}
				if (benchmarkContract.command !== benchmarkCommand) {
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									"Error: benchmark_command does not match autoresearch.md. " +
									`Expected: ${benchmarkContract.command ?? "(missing)"}\nReceived: ${params.benchmark_command}`,
							},
						],
					};
				}
				if (benchmarkContract.primaryMetric !== metricName) {
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									"Error: metric_name does not match autoresearch.md. " +
									`Expected: ${benchmarkContract.primaryMetric ?? "(missing)"}\nReceived: ${params.metric_name}`,
							},
						],
					};
				}
				if ((params.metric_unit ?? "") !== expectedMetricUnit) {
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									"Error: metric_unit does not match autoresearch.md. " +
									`Expected: ${expectedMetricUnit || "(empty)"}\nReceived: ${params.metric_unit ?? "(empty)"}`,
							},
						],
					};
				}
				if ((params.direction ?? "lower") !== expectedDirection) {
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									"Error: direction does not match autoresearch.md. " +
									`Expected: ${expectedDirection}\nReceived: ${params.direction ?? "lower"}`,
							},
						],
					};
				}
				if (!contractPathListsEqual(scopePaths, contractResult.contract.scopePaths)) {
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									"Error: scope_paths do not match autoresearch.md. " +
									`Expected: ${contractResult.contract.scopePaths.join(", ")}`,
							},
						],
					};
				}
				if (!contractPathListsEqual(params.off_limits ?? [], contractResult.contract.offLimits)) {
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									"Error: off_limits do not match autoresearch.md. " +
									`Expected: ${contractResult.contract.offLimits.join(", ") || "(empty)"}`,
							},
						],
					};
				}
				if (!contractListsEqual(params.constraints ?? [], contractResult.contract.constraints)) {
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									"Error: constraints do not match autoresearch.md. " +
									`Expected: ${contractResult.contract.constraints.join(", ") || "(empty)"}`,
							},
						],
					};
				}
			}

			// Check if contract matches current state — if so, re-init is a no-op
			if (isReinitializing && params.new_segment !== true) {
				const contract = contractResult.contract;
				const bm = contract.benchmark;
				const contractMatches =
					(bm.primaryMetric ?? "metric") === state.metricName &&
					bm.metricUnit === state.metricUnit &&
					(bm.direction ?? "lower") === state.bestDirection &&
					(bm.command ?? null) === state.benchmarkCommand &&
					contractPathListsEqual(contract.scopePaths, state.scopePaths) &&
					contractPathListsEqual(contract.offLimits, state.offLimits) &&
					contractListsEqual(contract.constraints, state.constraints);
				if (contractMatches) {
					runtime.autoresearchMode = true;
					runtime.autoResumeArmed = true;
					options.dashboard.updateWidget(ctx, runtime);
					options.dashboard.requestRender();
					return {
						content: [
							{
								type: "text",
								text:
									abandonSummary +
									`Experiment session already initialized with matching contract. Continuing segment ${state.currentSegment}.`,
							},
						],
						details: { state: cloneExperimentState(state) },
					};
				}
			}

			applyAutoresearchContractToExperimentState(contractResult.contract, state);
			state.name = params.name;
			state.maxExperiments = readMaxExperiments(ctx.cwd);
			state.bestMetric = null;
			state.confidence = null;
			if (isReinitializing) {
				state.currentSegment += 1;
			}

			const jsonlPath = path.join(workDir, "autoresearch.jsonl");
			const configLine = JSON.stringify({
				type: "config",
				name: state.name,
				metricName: state.metricName,
				metricUnit: state.metricUnit,
				bestDirection: state.bestDirection,
				benchmarkCommand: state.benchmarkCommand,
				secondaryMetrics: state.secondaryMetrics.map(metric => metric.name),
				scopePaths: state.scopePaths,
				offLimits: state.offLimits,
				constraints: state.constraints,
			});

			if (isReinitializing) {
				fs.appendFileSync(jsonlPath, `${configLine}\n`);
			} else {
				fs.writeFileSync(jsonlPath, `${configLine}\n`);
			}

			runtime.autoresearchMode = true;
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;
			runtime.lastRunChecks = null;
			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = null;
			runtime.lastRunNumber = null;
			runtime.lastRunSummary = null;
			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			const lines = [
				abandonSummary.trimEnd(),
				`Experiment initialized: ${state.name}`,
				`Metric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)`,
				`Benchmark command: ${state.benchmarkCommand}`,
				`Working directory: ${workDir}`,
				`Files in Scope: ${state.scopePaths.join(", ")}`,
				isReinitializing
					? "Previous results remain in history. This starts a new segment and requires a fresh baseline."
					: "Now run the baseline experiment and log it.",
			].filter(line => line.length > 0);
			if (state.maxExperiments !== null) {
				lines.push(`Max iterations: ${state.maxExperiments}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { state: cloneExperimentState(state) },
			};
		},
		renderCall(args, _options, theme): Text {
			return new Text(renderInitCall(args.name, theme), 0, 0);
		},
		renderResult(result): Text {
			const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
			return new Text(text, 0, 0);
		},
	};
}

function renderInitCall(name: string, theme: Theme): string {
	return `${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg("accent", truncateToWidth(replaceTabs(name), 100))}`;
}
