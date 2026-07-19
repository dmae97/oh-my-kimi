export type CurlValue = { readonly kind: "file" | "header"; readonly offset: number };

const CURL_FILE_LONG = ["--config", "--output", "--upload-file"] as const;
export const ENV_VALUE_OPTIONS = new Set(["-C", "--chdir", "-S", "--split-string", "-a", "--argv0", "-u", "--unset"]);

export function curlValue(text: string): CurlValue | undefined {
	for (const option of CURL_FILE_LONG) {
		if (text === option) return { kind: "file", offset: text.length };
		if (text.startsWith(`${option}=`)) return { kind: "file", offset: option.length + 1 };
	}
	if (text === "--header") return { kind: "header", offset: text.length };
	if (text.startsWith("--header=")) return { kind: "header", offset: 9 };
	if (!text.startsWith("-") || text.startsWith("--")) return undefined;
	for (let index = 1; index < text.length; index++) {
		if ("KoT".includes(text[index])) return { kind: "file", offset: index + 1 };
		if (text[index] === "H") return { kind: "header", offset: index + 1 };
	}
	return undefined;
}
