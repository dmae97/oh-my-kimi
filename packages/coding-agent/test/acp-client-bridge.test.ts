import { describe, expect, it } from "bun:test";
import type { AgentSideConnection, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createAcpClientBridge } from "../src/modes/acp/acp-client-bridge";

describe("ACP client bridge permission requests", () => {
	it("forwards pending tool-call status to session/request_permission", async () => {
		let request: RequestPermissionRequest | undefined;
		const connection = {
			async requestPermission(params: RequestPermissionRequest) {
				request = params;
				return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
			},
		} as unknown as AgentSideConnection;

		const bridge = createAcpClientBridge(connection, "session-1", {});

		await bridge.requestPermission!(
			{
				toolCallId: "call-1",
				toolName: "bash",
				title: "echo hi",
				kind: "execute",
				status: "pending",
				rawInput: { command: "echo hi" },
				content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
			},
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		);

		expect(request?.toolCall).toMatchObject({
			toolCallId: "call-1",
			title: "echo hi",
			kind: "execute",
			status: "pending",
			rawInput: { command: "echo hi" },
			content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
		});
	});
});
