import { describe, expect, it } from "vitest";
import { scheduleDagLevels } from "../src/tool-dag-scheduler.ts";
import type { ClaimableToolCall, RegisteredToolClaimDefinition } from "../src/tool-resource-claims.ts";

const cwd = "/proj";
type PolicyMap = Map<string, "sequential" | "parallel">;
function schedule(
	toolCalls: ClaimableToolCall[],
	options: {
		maxConcurrency?: number;
		toolPolicies?: PolicyMap;
		registeredTools?: RegisteredToolClaimDefinition[];
		strictExtensionClaims?: boolean;
	} = {},
) {
	return scheduleDagLevels(toolCalls, { cwd, ...options });
}

describe("scheduleDagLevels registered custom claims", () => {
	it("serializes cwd-relative custom paths against absolute built-in read/write aliases", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "custom_read",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "read" }],
			},
			{
				name: "custom_write",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "write" }],
			},
		];
		const customReadBuiltInWrite = await schedule(
			[
				{ name: "custom_read", arguments: {} },
				{ name: "write", arguments: { path: "/proj/a.ts" } },
			],
			{ registeredTools },
		);
		const customWriteBuiltInRead = await schedule(
			[
				{ name: "custom_write", arguments: {} },
				{ name: "read", arguments: { path: "/proj/a.ts" } },
			],
			{ registeredTools },
		);

		expect(customReadBuiltInWrite.levels).toEqual([[0], [1]]);
		expect(customWriteBuiltInRead.levels).toEqual([[0], [1]]);
	});

	it("co-schedules a cwd-relative custom write with a disjoint absolute built-in write", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "custom_write",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "write" }],
			},
		];
		const plan = await schedule(
			[
				{ name: "custom_write", arguments: {} },
				{ name: "write", arguments: { path: "/proj/b.ts" } },
			],
			{ registeredTools },
		);

		expect(plan.levels).toEqual([[0, 1]]);
	});

	it("serializes a Windows relative custom path with a drive-absolute built-in alias", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "custom_write",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "write" }],
			},
		];
		const plan = await scheduleDagLevels(
			[
				{ name: "custom_write", arguments: {} },
				{ name: "read", arguments: { path: "C:\\proj\\a.ts" } },
			],
			{ cwd: "C:\\proj", registeredTools },
		);

		expect(plan.levels).toEqual([[0], [1]]);
	});

	it("co-schedules disjoint custom writes and serializes overlapping writes", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "extension_store",
				resourceClaims: (args) => {
					const key =
						typeof args === "object" && args !== null && "key" in args && typeof args.key === "string"
							? args.key
							: "invalid";
					return [{ kind: "global", key, access: "write" }];
				},
			},
		];
		const disjoint = await schedule(
			[
				{ id: "a", name: "extension_store", arguments: { key: "alpha" } },
				{ id: "b", name: "extension_store", arguments: { key: "beta" } },
			],
			{ registeredTools },
		);
		const overlapping = await schedule(
			[
				{ id: "a", name: "extension_store", arguments: { key: "shared" } },
				{ id: "b", name: "extension_store", arguments: { key: "shared" } },
			],
			{ registeredTools },
		);

		expect(disjoint.levels).toEqual([[0, 1]]);
		expect(overlapping.levels).toEqual([[0], [1]]);
	});

	it("awaits async claims for every call before returning a plan", async () => {
		const resolvedIds: string[] = [];
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "async_extension",
				resourceClaims: async (_args, context) => {
					await Promise.resolve();
					resolvedIds.push(context.toolCallId);
					return [{ kind: "session", key: "shared", access: "write" }];
				},
			},
		];
		const plan = await schedule(
			[
				{ id: "first", name: "async_extension", arguments: {} },
				{ id: "second", name: "async_extension", arguments: {} },
			],
			{ registeredTools },
		);

		expect(resolvedIds).toEqual(["first", "second"]);
		expect(plan.levels).toEqual([[0], [1]]);
	});

	it("isolates malformed and empty custom claims from every other call", async () => {
		const malformedResolver = (() => [
			{ kind: "invalid", key: "unsafe", access: "write" },
		]) as unknown as RegisteredToolClaimDefinition["resourceClaims"];
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{ name: "malformed_claims", resourceClaims: malformedResolver },
			{ name: "empty_claims", resourceClaims: () => [] },
			{
				name: "safe_claims",
				resourceClaims: () => [{ kind: "global", key: "safe", access: "write" }],
			},
		];
		const plan = await schedule(
			[
				{ id: "malformed", name: "malformed_claims", arguments: {} },
				{ id: "empty", name: "empty_claims", arguments: {} },
				{ id: "safe", name: "safe_claims", arguments: {} },
			],
			{ registeredTools },
		);

		expect(plan.levels).toEqual([[0], [1], [2]]);
	});

	it("isolates throwing and rejecting resolvers from every other call", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "throws_claims",
				resourceClaims: () => {
					throw new Error("claim failure");
				},
			},
			{
				name: "safe_claims",
				resourceClaims: () => [{ kind: "global", key: "safe", access: "write" }],
			},
			{
				name: "rejects_claims",
				resourceClaims: () => Promise.reject(new Error("claim rejection")),
			},
		];
		const plan = await schedule(
			[
				{ id: "throws", name: "throws_claims", arguments: {} },
				{ id: "safe", name: "safe_claims", arguments: {} },
				{ id: "rejects", name: "rejects_claims", arguments: {} },
			],
			{ registeredTools },
		);

		expect(plan.levels).toEqual([[0], [1], [2]]);
	});
});
