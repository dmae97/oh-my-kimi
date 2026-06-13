/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { describe, expect, it } from "bun:test";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import {
	obfuscateMessages,
	obfuscateProviderContext,
	SecretObfuscator,
} from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { compileSecretRegex } from "@oh-my-pi/pi-coding-agent/secrets/regex";
import { z } from "zod/v4";

describe("compileSecretRegex", () => {
	it("adds global flag when not provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+", "i");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("gi");
	});

	it("defaults to global flag when no flags provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("g");
	});

	it("rejects invalid regex pattern", () => {
		expect(() => compileSecretRegex("(")).toThrow();
	});
	it("rejects invalid regex flags", () => {
		expect(() => compileSecretRegex("x", "zz")).toThrow();
	});
});

describe("SecretObfuscator regex behavior", () => {
	it("obfuscates and deobfuscates regex matches with flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = "API_KEY=abc and api-key=def";
		const obfuscated = obfuscator.obfuscate(original);
		expect(obfuscated).not.toEqual(original);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(original);
	});

	it("supports bare regex patterns without explicit flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+" }]);
		const text = "api_key=abc and API_KEY=def";
		const obfuscated = obfuscator.obfuscate(text);
		expect(obfuscated).not.toEqual(text);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(text);
	});
	it("deobfuscates placeholders through object payloads", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = {
			cmd: "API_KEY=abc and api-key=def",
			status: "ok",
		};
		const obfuscated = {
			cmd: obfuscator.obfuscate(original.cmd),
			status: original.status,
		};
		expect(obfuscator.deobfuscateObject(obfuscated)).toEqual({
			cmd: original.cmd,
			status: original.status,
		});
	});

	it("obfuscates nested provider request payloads", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const payload = {
			systemPrompt: [`workspace contains ${secret}`],
			messages: [],
			tools: [
				{
					name: "handoff",
					description: `preserve ${secret}`,
					parameters: {
						type: "object",
						properties: { note: { type: "string", description: `write ${secret}` } },
					},
				},
			],
		};

		const obfuscated = obfuscateProviderContext(obfuscator, payload);
		const serialized = JSON.stringify(obfuscated);

		expect(serialized).not.toContain(secret);
		expect(obfuscator.deobfuscateObject(obfuscated).tools?.[0]?.description).toEqual(payload.tools[0]?.description);
	});

	it("redacts Zod tool schemas without cloning the live schema instance", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const parameters = z.object({
			note: z.string().describe(`write ${secret}`),
		});
		const context: Context = {
			messages: [],
			tools: [
				{
					name: "extension_tool",
					description: `preserve ${secret}`,
					parameters,
				},
			],
		};

		const obfuscated = obfuscateProviderContext(obfuscator, context);

		expect(obfuscator.obfuscateObject(parameters)).toBe(parameters);
		expect(context.tools?.[0]?.parameters).toBe(parameters);
		expect(obfuscated.tools?.[0]?.parameters).not.toBe(parameters);
		expect(JSON.stringify(obfuscated)).not.toContain(secret);
	});

	it("obfuscates system reminders and assistant tool calls in messages", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const messages: Message[] = [
			{ role: "developer", content: `system reminder ${secret}`, timestamp: 1 },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "handoff",
						arguments: { note: secret },
						intent: `handoff ${secret}`,
					},
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		];

		const obfuscated = obfuscateMessages(obfuscator, messages);

		expect(JSON.stringify(obfuscated)).not.toContain(secret);
		expect(obfuscator.deobfuscateObject(obfuscated)).toEqual(messages);
	});
});
