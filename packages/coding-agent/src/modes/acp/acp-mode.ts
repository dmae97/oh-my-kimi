import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { postmortem } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

/** Creates sessions requested by an ACP client. */
export type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

/** Creates an ACP connection and exposes its agent when process-level teardown must own it. */
export function createAcpConnection(
	transport: Stream,
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
	onAgent?: (agent: AcpAgent) => void,
): AgentSideConnection {
	return new AgentSideConnection(connection => {
		const agent = new AcpAgent(connection, createSession, initialSession);
		onAgent?.(agent);
		return agent;
	}, transport);
}

/** Serves ACP over stdio until the peer disconnects, then awaits session teardown before exit. */
export async function runAcpMode(createSession: AcpSessionFactory, initialSession?: AgentSession): Promise<void> {
	let agent: AcpAgent | undefined;
	postmortem.register("acp-session-teardown", reason => agent?.dispose(reason));
	postmortem.registerStdioDisconnectHandling();

	const input = stream.Writable.toWeb(process.stdout);
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, createSession, initialSession, createdAgent => {
		agent = createdAgent;
	});
	await connection.closed;
	await postmortem.quit(0);
}
