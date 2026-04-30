import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

export type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

export async function runAcpMode(session: AgentSession, createSession: AcpSessionFactory): Promise<never> {
	const input = stream.Writable.toWeb(process.stdout);
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = new AgentSideConnection(conn => new AcpAgent(conn, session, createSession), transport);
	await connection.closed;
	process.exit(0);
}
