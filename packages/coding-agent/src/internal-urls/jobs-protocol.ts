import type { AsyncJobManager } from "../async";
import { formatDuration } from "../tools/render-utils";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface JobsProtocolOptions {
	getAsyncJobManager: () => AsyncJobManager | undefined;
}

function formatJobTime(startTime: number): string {
	return new Date(startTime).toISOString();
}

function formatJobDuration(startTime: number): string {
	return formatDuration(Math.max(0, Date.now() - startTime));
}

function normalizeJobId(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = (url.rawPathname ?? url.pathname).replace(/^\/+/, "").trim();
	if (host && pathname) return `${host}/${pathname}`;
	if (host) return host;
	return pathname;
}

export class JobsProtocolHandler implements ProtocolHandler {
	readonly scheme = "jobs";

	constructor(private readonly options: JobsProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const manager = this.options.getAsyncJobManager();
		if (!manager) {
			const content =
				"# Jobs\n\nBackground job support is disabled. Enable `async.enabled` or `bash.autoBackground.enabled` to use jobs://.";
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		const jobId = normalizeJobId(url);
		if (!jobId) {
			return this.#listJobs(url, manager);
		}

		return this.#getJob(url, manager, jobId);
	}

	#listJobs(url: InternalUrl, manager: AsyncJobManager): InternalResource {
		const jobs = manager.getAllJobs();
		const running = jobs.filter(job => job.status === "running").sort((a, b) => a.startTime - b.startTime);
		const done = jobs.filter(job => job.status !== "running").sort((a, b) => b.startTime - a.startTime);
		const ordered = [...running, ...done];

		if (ordered.length === 0) {
			const content = "# Jobs\n\nNo background jobs found.";
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		const lines = ordered.map(job => {
			return `- \`${job.id}\` [${job.type}] **${job.status}** — ${job.label}  \n  started: ${formatJobTime(job.startTime)} · duration: ${formatJobDuration(job.startTime)}`;
		});
		const content = `# Jobs\n\n${ordered.length} job${ordered.length === 1 ? "" : "s"}\n\n${lines.join("\n")}`;
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	#getJob(url: InternalUrl, manager: AsyncJobManager, jobId: string): InternalResource {
		const job = manager.getJob(jobId);
		if (!job) {
			const content = `# Job Not Found\n\n404: No async job found with id \`${jobId}\`.`;
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		const sections = [
			`# Job ${job.id}`,
			"",
			`- type: ${job.type}`,
			`- status: ${job.status}`,
			`- label: ${job.label}`,
			`- start: ${formatJobTime(job.startTime)}`,
			`- duration: ${formatJobDuration(job.startTime)}`,
		];

		if (job.status === "completed" && job.resultText) {
			sections.push("", "## Result", "", "```", job.resultText, "```");
		}
		if (job.status === "failed" && job.errorText) {
			sections.push("", "## Error", "", "```", job.errorText, "```");
		}
		if (job.status === "cancelled" && job.errorText) {
			sections.push("", "## Cancellation", "", "```", job.errorText, "```");
		}

		const content = sections.join("\n");
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}
}
