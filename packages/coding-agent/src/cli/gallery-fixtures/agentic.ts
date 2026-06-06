// Gallery fixtures for the agentic orchestration tools (task, goal, job).
import type { GalleryFixture } from "./types";

export const agenticFixtures: Record<string, GalleryFixture> = {
	task: {
		label: "Task",
		customRendered: true,
		// Streaming: agent chosen, first task fully arrived, second still landing.
		streamingArgs: {
			agent: "task",
			tasks: [
				{
					id: "AuthLoader",
					description: "Load auth middleware",
					assignment: "Read packages/server/src/auth/*.ts and summarize the session-cookie flow.",
				},
				{ id: "RateLimiter", description: "Audit rate limiter" },
			],
		},
		args: {
			agent: "task",
			context: [
				"# Goal",
				"Harden the HTTP auth stack before the release cut.",
				"# Constraints",
				"Touch only files under packages/server/src/auth/. Do not run gates.",
			].join("\n"),
			tasks: [
				{
					id: "AuthLoader",
					description: "Load auth middleware",
					assignment:
						"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.",
				},
				{
					id: "RateLimiter",
					description: "Audit rate limiter",
					assignment:
						"Inspect packages/server/src/auth/rate-limit.ts. Confirm the 429 path sets Retry-After and report gaps.",
				},
				{
					id: "TokenRotation",
					description: "Check token rotation",
					assignment:
						"Trace refresh-token rotation in packages/server/src/auth/tokens.ts and flag any reuse window.",
				},
			],
		},
		result: {
			content: [
				{
					type: "text",
					text: "3 agents completed: AuthLoader, RateLimiter, TokenRotation.",
				},
			],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 48_200,
				usage: { cost: { total: 0.34 } },
				results: [
					{
						index: 0,
						id: "AuthLoader",
						agent: "task",
						agentSource: "bundled",
						description: "Load auth middleware",
						task: "Read packages/server/src/auth/session.ts and middleware.ts",
						assignment:
							"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.",
						exitCode: 0,
						output: [
							"Session validation runs in middleware.ts:42 via verifySessionCookie().",
							"Cookies are HMAC-signed (SHA-256) and checked against the session store.",
							"TODO at session.ts:88 — sliding-expiration refresh is stubbed.",
						].join("\n"),
						stderr: "",
						truncated: false,
						durationMs: 41_900,
						tokens: 61_400,
						contextTokens: 23_100,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: { cost: { total: 0.12 } },
						outputMeta: { lineCount: 3, charCount: 214 },
					},
					{
						index: 1,
						id: "RateLimiter",
						agent: "task",
						agentSource: "bundled",
						description: "Audit rate limiter",
						task: "Inspect packages/server/src/auth/rate-limit.ts",
						assignment:
							"Inspect packages/server/src/auth/rate-limit.ts. Confirm the 429 path sets Retry-After and report gaps.",
						exitCode: 0,
						output: [
							"rate-limit.ts uses a fixed-window counter keyed by client IP.",
							"429 responses set Retry-After (rate-limit.ts:57).",
							"Gap: no per-account limit, so a botnet across IPs bypasses the cap.",
						].join("\n"),
						stderr: "",
						truncated: false,
						durationMs: 38_500,
						tokens: 54_800,
						contextTokens: 19_700,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: { cost: { total: 0.1 } },
						outputMeta: { lineCount: 3, charCount: 198 },
					},
					{
						index: 2,
						id: "TokenRotation",
						agent: "task",
						agentSource: "bundled",
						description: "Check token rotation",
						task: "Trace refresh-token rotation in packages/server/src/auth/tokens.ts",
						assignment:
							"Trace refresh-token rotation in packages/server/src/auth/tokens.ts and flag any reuse window.",
						exitCode: 0,
						output: [
							"Refresh tokens rotate on every use (tokens.ts:120) and the old jti is revoked.",
							"Reuse of a rotated token triggers full-family revocation — no reuse window found.",
						].join("\n"),
						stderr: "",
						truncated: false,
						durationMs: 48_200,
						tokens: 49_200,
						contextTokens: 17_500,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: { cost: { total: 0.12 } },
						outputMeta: { lineCount: 2, charCount: 160 },
					},
				],
			},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "1 of 3 agents failed: RateLimiter.",
				},
			],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 39_400,
				usage: { cost: { total: 0.21 } },
				results: [
					{
						index: 0,
						id: "AuthLoader",
						agent: "task",
						agentSource: "bundled",
						description: "Load auth middleware",
						task: "Read packages/server/src/auth/session.ts and middleware.ts",
						assignment:
							"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.",
						exitCode: 0,
						output: "Session validation runs in middleware.ts:42 via verifySessionCookie().",
						stderr: "",
						truncated: false,
						durationMs: 31_200,
						tokens: 58_100,
						contextTokens: 21_900,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: { cost: { total: 0.11 } },
						outputMeta: { lineCount: 1, charCount: 70 },
					},
					{
						index: 1,
						id: "RateLimiter",
						agent: "task",
						agentSource: "bundled",
						description: "Audit rate limiter",
						task: "Inspect packages/server/src/auth/rate-limit.ts",
						assignment:
							"Inspect packages/server/src/auth/rate-limit.ts. Confirm the 429 path sets Retry-After and report gaps.",
						exitCode: 1,
						output: "",
						stderr: "ENOENT: packages/server/src/auth/rate-limit.ts",
						truncated: false,
						durationMs: 9_800,
						tokens: 12_300,
						contextTokens: 6_400,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: { cost: { total: 0.1 } },
						error: "Subagent exited 1: target file packages/server/src/auth/rate-limit.ts does not exist.",
						outputMeta: { lineCount: 0, charCount: 0 },
					},
				],
			},
		},
	},

	goal: {
		label: "Goal",
		// Streaming: op is "create"; objective text still being typed.
		streamingArgs: { op: "create", objective: "Ship the auth hardening" },
		args: {
			op: "create",
			objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
			token_budget: 500_000,
		},
		result: {
			content: [
				{
					type: "text",
					text: "Goal set. Working toward: Ship the auth hardening pass.",
				},
			],
			details: {
				op: "create",
				remainingTokens: 451_800,
				completionBudgetReport: null,
				goal: {
					id: "goal_8f2a",
					objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
					status: "active",
					tokenBudget: 500_000,
					tokensUsed: 48_200,
					timeUsedSeconds: 312,
					createdAt: 1_749_200_000_000,
					updatedAt: 1_749_200_312_000,
				},
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Goal tool failed: objective is required when op=create." }],
			details: { op: "create" },
		},
	},

	job: {
		label: "Job",
		// Streaming: polling a single job id; the second id is still arriving.
		streamingArgs: { poll: ["job_a1"] },
		args: { poll: ["job_a1", "job_b2", "job_c3"] },
		result: {
			content: [{ type: "text", text: "3 jobs settled." }],
			details: {
				jobs: [
					{
						id: "job_a1",
						type: "bash",
						status: "completed",
						label: "bun test packages/server/test/auth.test.ts",
						durationMs: 18_400,
						resultText: "42 pass, 0 fail (18.4s)",
					},
					{
						id: "job_b2",
						type: "task",
						status: "completed",
						label: "Migrate rate limiter to a sliding window",
						durationMs: 96_700,
						resultText: "Rewrote rate-limit.ts to a token-bucket; added per-account keys.",
					},
					{
						id: "job_c3",
						type: "bash",
						status: "failed",
						label: "bunx biome check packages/server/src/auth",
						durationMs: 4_100,
						errorText: "biome: 2 errors in tokens.ts — noUnusedVariables, useConst",
					},
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Job cancelled by user." }],
			details: {
				jobs: [
					{
						id: "job_d4",
						type: "task",
						status: "cancelled",
						label: "Refactor the session store to Redis",
						durationMs: 52_300,
						errorText: "Aborted: superseded by goal re-scope.",
					},
				],
				cancelled: [{ id: "job_d4", status: "cancelled" }],
			},
		},
	},
};
