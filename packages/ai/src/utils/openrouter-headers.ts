import packageJson from "../../package.json" with { type: "json" };

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `Oh-My-Pi/${packageJson.version}`,
		"HTTP-Referer": "https://omp.sh/",
		"X-OpenRouter-Title": "Oh-My-Pi",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
