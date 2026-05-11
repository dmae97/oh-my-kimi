import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { commandConsumed, errorMessage, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const shareCommand: AcpBuiltinCommandSpec = {
	name: "share",
	description: "Share session as a secret GitHub gist",
	handle: async (_command, runtime) => {
		const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
		try {
			try {
				await runtime.session.exportToHtml(tmpFile);
			} catch (err) {
				return usage(`Failed to export session: ${errorMessage(err)}`, runtime);
			}
			const result = await $`gh gist create --public=false ${tmpFile}`.quiet().nothrow();
			if (result.exitCode !== 0) {
				return usage(
					`Failed to create gist: ${result.stderr.toString("utf-8").trim() || "unknown error"}`,
					runtime,
				);
			}
			const gistUrl = result.stdout.toString("utf-8").trim();
			const gistId = gistUrl.split("/").pop();
			if (!gistId) return usage("Failed to parse gist ID from gh output", runtime);
			await runtime.output(`Share URL: https://gistpreview.github.io/?${gistId}\nGist: ${gistUrl}`);
			return commandConsumed();
		} catch {
			return usage("GitHub CLI (gh) is required for /share. Install it from https://cli.github.com/.", runtime);
		} finally {
			await fs.rm(tmpFile, { force: true }).catch(() => {});
		}
	},
};
