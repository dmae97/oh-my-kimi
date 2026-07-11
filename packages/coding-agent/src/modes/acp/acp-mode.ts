import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

export type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

export function createAcpConnection(
	transport: Stream,
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
): AgentSideConnection {
	return new AgentSideConnection(conn => new AcpAgent(conn, createSession, initialSession), transport);
}

export async function runAcpMode(createSession: AcpSessionFactory, initialSession?: AgentSession): Promise<never> {
	// Humans who run `omp acp` by hand see a silent process and assume it is
	// broken (stdout is the JSON-RPC transport, so nothing may be printed
	// there). When stdin is a TTY no ACP client is attached — say so on stderr
	// before the transport starts.
	if (process.stdin.isTTY) {
		process.stderr.write(
			"omp acp: ACP server speaking JSON-RPC over stdio.\n" +
				'This command is meant to be spawned by an ACP client (e.g. Zed\'s "agent_servers" config), not run directly.\n' +
				"Waiting for protocol frames on stdin; logs: ~/.omp/logs/\n",
		);
	}
	const input = stream.Writable.toWeb(process.stdout);
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, createSession, initialSession);
	await connection.closed;
	process.exit(0);
}
