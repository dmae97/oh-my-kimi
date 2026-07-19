import { existsSync, readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Api, findEnvKeys, getModels, getProviders, type KnownProvider, type Model } from "omk-ai";
import { getAgentDir as getConfiguredAgentDir } from "../config.ts";
import { isConfigValueConfigured, resolveConfigValueOrThrow } from "../core/resolve-config-value.ts";
import { stripJsonComments } from "../utils/json.ts";

export type ProviderOrigin = "native" | "custom-openai-compatible" | "local-proxy" | "unknown";
export type ProviderDoctorLevel = 0 | 1 | 2;
export type ProviderDoctorCheckStatus = "ok" | "fail" | "skipped" | "unsupported";
export type DoctorErrorCategory = "network" | "auth" | "model" | "config" | "server" | "unknown";

/** Exact endpoint-probe category model from the v0.90.9 design (§10.4). */
export type EndpointProbeCategory = "ok" | "network" | "auth" | "unsupported-endpoint" | "server";

export type EndpointProbeResult = {
	reachable: boolean;
	authenticated?: boolean;
	modelsSupported?: boolean;
	status?: number;
	category: EndpointProbeCategory;
};

export type ProviderDoctorCode =
	| "ok"
	| "provider-not-found"
	| "models-config-invalid"
	| "auth-config-invalid"
	| "kimi-config-invalid"
	| "unsupported-level"
	| "model-provider-mismatch"
	| "api-missing"
	| "api-unsupported"
	| "base-url-missing"
	| "base-url-invalid"
	| "url-scheme-unsupported"
	| "origin-unsupported"
	| "address-policy-blocked"
	| "auth-missing"
	| "auth-materialization-failed"
	| "transport-required"
	| "address-pinning-required"
	| "redirect-blocked"
	| "authentication-failed"
	| "endpoint-unsupported"
	| "request-aborted"
	| "request-timeout"
	| "network-failure"
	| "server-error"
	| "probe-model-required"
	| "probe-model-conflict"
	| "unexpected-response";

export interface ProviderDoctorEndpoint {
	baseUrl?: string;
	api?: string;
	modelIds?: readonly string[];
	modelId?: string;
}

export type ProviderDoctorHeaderFactory = () => Headers | Promise<Headers>;

export type ProviderDoctorAuthHeaderResolver = (target: ResolvedProviderTarget) => Headers | Promise<Headers>;

/** Fixed-message marker used to classify auth resolution without exposing its cause. */
export class ProviderDoctorAuthMaterializationError extends Error {
	constructor() {
		super("provider doctor authentication could not be materialized");
		this.name = "ProviderDoctorAuthMaterializationError";
	}
}

export interface ProviderDoctorCredentialBinding {
	origin: ProviderOrigin;
	source: string;
	baseUrl: string;
	api: string;
	modelId: string;
}

export interface ProviderDoctorAuth {
	present: boolean;
	source?: string;
	/** Materialized by an injected transport at request time only. */
	createHeaders?: ProviderDoctorHeaderFactory;
	/** Exact endpoint provenance that authorizes createHeaders. */
	binding?: ProviderDoctorCredentialBinding;
}

export interface ResolvedProviderTarget {
	providerId: string;
	origin: ProviderOrigin;
	source: string;
	endpoint: ProviderDoctorEndpoint;
	auth: ProviderDoctorAuth;
}

/** Compatibility name for callers using the design-document terminology. */
export type ResolvedProviderConfig = ResolvedProviderTarget;

export type ProviderDoctorAddressPolicy =
	| { kind: "public"; requireAddressPinning: true }
	| { kind: "loopback-only"; requireAddressPinning: false };

export interface ProviderDoctorTransportRequest {
	url: URL;
	method: "GET" | "POST";
	redirect: "manual";
	signal: AbortSignal;
	addressPolicy: ProviderDoctorAddressPolicy;
	createHeaders: ProviderDoctorHeaderFactory;
	/** Bounded JSON payload; present only for opt-in Level-2 POST model probes. */
	body?: string;
	contentType?: "application/json";
}

export interface ProviderDoctorTransportResponse {
	status: number;
}

export interface ProviderDoctorTransport {
	/** Public requests are rejected unless the transport enforces DNS/address pinning. */
	pinsResolvedAddress?: boolean;
	request(request: ProviderDoctorTransportRequest): Promise<ProviderDoctorTransportResponse>;
}

export interface ProviderDoctorDependencies {
	transport?: ProviderDoctorTransport;
	/** Level-2 only. Called by the transport immediately before each request is dispatched. */
	resolveAuthHeaders?: ProviderDoctorAuthHeaderResolver;
}

export interface ProviderDoctorOptions extends ProviderDoctorDependencies {
	level?: ProviderDoctorLevel;
	modelId?: string;
	/** Level-2 opt-in only: the model probed with one minimal-token generative request. */
	probeModelId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	agentDir?: string;
	/** Path to the Kimi CLI config TOML consulted for the kimi-coding provider. Defaults to ~/.kimi/config.toml. */
	kimiConfigPath?: string;
}

export interface ProviderDoctorCheck {
	name: string;
	status: ProviderDoctorCheckStatus;
	code: ProviderDoctorCode;
	category?: DoctorErrorCategory;
	message?: string;
	/** Exact-category endpoint classification for network probe checks. */
	probe?: EndpointProbeResult;
}

export interface ProviderDoctorResult {
	provider: string;
	status: "ok" | "fail";
	level: ProviderDoctorLevel;
	origin: ProviderOrigin;
	source: string;
	/** Sanitized URL: userinfo, query, and fragment are always removed. */
	targetUrl?: string;
	/** Backwards-compatible alias of targetUrl. */
	baseUrl?: string;
	api?: string;
	modelId?: string;
	authPresent: boolean;
	/** True only when an opt-in Level-2 model probe was dispatched; the request may incur provider costs. */
	costWarning?: boolean;
	checks: ProviderDoctorCheck[];
	error?: {
		category: DoctorErrorCategory;
		code: ProviderDoctorCode;
		message: string;
	};
}

interface ModelEndpointConfig {
	id: string;
	baseUrl?: string;
	api?: string;
}

interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	models?: ModelEndpointConfig[];
}

interface ModelsConfig {
	providers: Record<string, ProviderConfig>;
}

interface AuthConfigEntry {
	type: "api_key" | "oauth";
}

type AuthConfig = Record<string, AuthConfigEntry>;

type LoadedConfig<T> = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; value: T };

type ProbeFailure = {
	category: DoctorErrorCategory;
	code: ProviderDoctorCode;
	message: string;
};

interface ProbeOutcome {
	check: ProviderDoctorCheck;
	failure?: ProbeFailure;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const KNOWN_APIS = new Set<string>([
	"openai-completions",
	"mistral-conversations",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
]);
const OPENAI_COMPATIBLE_APIS = new Set<string>(["openai-completions", "openai-responses"]);
const ABORTED = Symbol("provider-doctor-aborted");

// Family-specific lists: node BlockList canonicalizes IPv4 checks to the v4-mapped v6 form,
// so a combined list containing ::ffff:0:0/96 would block every IPv4 address.
const blockedPublicV4 = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blockedPublicV4.addSubnet(address, prefix, "ipv4");
}
// ::ffff:0:0/96 stays here on purpose: a v4-mapped IPv6 literal or DNS answer is anomalous
// for a public origin and is rejected wholesale (fail closed), covering hex-form mappings too.
const blockedPublicV6 = new BlockList();
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["::ffff:0:0", 96],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blockedPublicV6.addSubnet(address, prefix, "ipv6");
}

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");
loopbackAddresses.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

/** True when the literal IP address is a loopback address. Non-IP input is never loopback. */
export function isLoopbackAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return loopbackAddresses.check(address, "ipv4");
	if (family === 6) return loopbackAddresses.check(address, "ipv6");
	return false;
}

/** True when the literal IP address must not be dialed for a public origin. Non-IP input fails closed. */
export function isBlockedPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return blockedPublicV4.check(address, "ipv4");
	if (family === 6) return blockedPublicV6.check(address, "ipv6");
	return true;
}

export function getAgentDir(): string {
	return getConfiguredAgentDir();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalNonemptyString(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === "string" && value.length > 0);
}

function parseModelsConfig(value: unknown): ModelsConfig | undefined {
	if (!isRecord(value) || !isRecord(value.providers)) return undefined;
	const providers: Record<string, ProviderConfig> = {};

	for (const [providerId, rawProvider] of Object.entries(value.providers)) {
		if (!isRecord(rawProvider)) return undefined;
		if (
			!isOptionalNonemptyString(rawProvider.baseUrl) ||
			!isOptionalNonemptyString(rawProvider.apiKey) ||
			!isOptionalNonemptyString(rawProvider.api)
		) {
			return undefined;
		}

		let headers: Record<string, string> | undefined;
		if (rawProvider.headers !== undefined) {
			if (!isRecord(rawProvider.headers)) return undefined;
			headers = {};
			for (const [name, headerValue] of Object.entries(rawProvider.headers)) {
				if (typeof headerValue !== "string") return undefined;
				headers[name] = headerValue;
			}
		}

		let models: ModelEndpointConfig[] | undefined;
		if (rawProvider.models !== undefined) {
			if (!Array.isArray(rawProvider.models)) return undefined;
			models = [];
			for (const rawModel of rawProvider.models) {
				if (
					!isRecord(rawModel) ||
					typeof rawModel.id !== "string" ||
					rawModel.id.length === 0 ||
					!isOptionalNonemptyString(rawModel.baseUrl) ||
					!isOptionalNonemptyString(rawModel.api)
				) {
					return undefined;
				}
				models.push({ id: rawModel.id, baseUrl: rawModel.baseUrl, api: rawModel.api });
			}
		}

		providers[providerId] = {
			baseUrl: rawProvider.baseUrl,
			apiKey: rawProvider.apiKey,
			api: rawProvider.api,
			headers,
			models,
		};
	}

	return { providers };
}

function parseAuthConfig(value: unknown): AuthConfig | undefined {
	if (!isRecord(value)) return undefined;
	const auth: AuthConfig = {};
	for (const [providerId, rawEntry] of Object.entries(value)) {
		if (!isRecord(rawEntry) || (rawEntry.type !== "api_key" && rawEntry.type !== "oauth")) return undefined;
		if (rawEntry.type === "api_key" && (typeof rawEntry.key !== "string" || rawEntry.key.length === 0)) {
			return undefined;
		}
		auth[providerId] = { type: rawEntry.type };
	}
	return auth;
}

const KIMI_PROVIDER_ID = "kimi-coding";
const TOML_BASIC_ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

type TomlQuote = "basic" | "literal" | "multiline-basic" | "multiline-literal";

interface TomlScanState {
	quote?: TomlQuote;
	containers: ("[" | "{")[];
}

interface KimiTomlProviderEntry {
	name: string;
	type?: string;
	baseUrl?: string;
	modelName?: string;
	apiKey?: string;
}

interface KimiConfigValues {
	baseUrl?: string;
	modelName?: string;
	providers: KimiTomlProviderEntry[];
}

type KimiConfigLoad =
	| { kind: "missing" }
	| { kind: "ok"; value: KimiConfigValues }
	| { kind: "invalid"; line: number; reason: string };

function findBasicStringEnd(text: string, start: number, multiline: boolean): number {
	for (let index = start; index < text.length; index++) {
		if (text[index] === "\\") {
			index++;
			continue;
		}
		if (multiline ? text.startsWith('"""', index) : text[index] === '"') return index;
	}
	return -1;
}

function decodeTomlBasicString(body: string, multiline: boolean): { value: string } | { error: string } {
	let value = "";
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (char !== "\\") {
			const code = char.codePointAt(0) ?? 0;
			if (code < 0x20 && char !== "\t" && !(multiline && (char === "\n" || char === "\r"))) {
				return { error: "invalid control character in string value" };
			}
			value += char;
			continue;
		}

		const escapeChar = body[index + 1];
		if (escapeChar === undefined) return { error: "unterminated escape sequence" };
		if (multiline && (escapeChar === "\n" || escapeChar === "\r")) {
			index++;
			while (index + 1 < body.length && /\s/.test(body[index + 1])) index++;
			continue;
		}
		if (escapeChar === "u" || escapeChar === "U") {
			const width = escapeChar === "u" ? 4 : 8;
			const hex = body.slice(index + 2, index + 2 + width);
			const codePoint = /^[0-9a-fA-F]+$/.test(hex) && hex.length === width ? Number.parseInt(hex, 16) : -1;
			if (codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
				return { error: "invalid unicode escape" };
			}
			value += String.fromCodePoint(codePoint);
			index += 1 + width;
			continue;
		}
		const mapped = TOML_BASIC_ESCAPES[escapeChar];
		if (mapped === undefined) return { error: "invalid escape sequence" };
		value += mapped;
		index++;
	}
	return { value };
}

/** Parses one TOML string value. Errors are fixed and never include raw TOML content. */
function parseTomlStringValue(raw: string, requireNonempty = true): { value: string } | { error: string } {
	const text = raw.trim();
	const multilineBasic = text.startsWith('"""');
	const multilineLiteral = text.startsWith("'''");
	const basic = !multilineBasic && text.startsWith('"');
	const literal = !multilineLiteral && text.startsWith("'");
	if (!multilineBasic && !multilineLiteral && !basic && !literal) {
		return { error: "value must be a quoted string" };
	}

	const delimiterWidth = multilineBasic || multilineLiteral ? 3 : 1;
	const end =
		multilineBasic || basic
			? findBasicStringEnd(text, delimiterWidth, multilineBasic)
			: text.indexOf(multilineLiteral ? "'''" : "'", delimiterWidth);
	if (end < 0) {
		return {
			error:
				multilineBasic || multilineLiteral ? "unterminated multiline string value" : "unterminated string value",
		};
	}
	if (text.slice(end + delimiterWidth).trim().length > 0) {
		return { error: "unexpected content after string value" };
	}

	let body = text.slice(delimiterWidth, end);
	if ((multilineBasic || multilineLiteral) && body.startsWith("\n")) body = body.slice(1);
	const parsed =
		multilineBasic || basic
			? decodeTomlBasicString(body, multilineBasic)
			: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)
				? { error: "invalid control character in string value" as const }
				: { value: body };
	if ("error" in parsed) return parsed;
	return requireNonempty && parsed.value.length === 0 ? { error: "empty string value" } : parsed;
}

function scanTomlLine(text: string, state: TomlScanState): { content: string; error?: string } {
	let content = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (state.quote === "basic") {
			content += char;
			if (char === "\\" && index + 1 < text.length) content += text[++index];
			else if (char === '"') state.quote = undefined;
			continue;
		}
		if (state.quote === "literal") {
			content += char;
			if (char === "'") state.quote = undefined;
			continue;
		}
		if (state.quote === "multiline-basic") {
			if (text.startsWith('"""', index)) {
				content += '"""';
				index += 2;
				state.quote = undefined;
			} else {
				content += char;
				if (char === "\\" && index + 1 < text.length) content += text[++index];
			}
			continue;
		}
		if (state.quote === "multiline-literal") {
			if (text.startsWith("'''", index)) {
				content += "'''";
				index += 2;
				state.quote = undefined;
			} else {
				content += char;
			}
			continue;
		}

		if (char === "#") break;
		if (text.startsWith('"""', index)) {
			content += '"""';
			index += 2;
			state.quote = "multiline-basic";
			continue;
		}
		if (text.startsWith("'''", index)) {
			content += "'''";
			index += 2;
			state.quote = "multiline-literal";
			continue;
		}
		content += char;
		if (char === '"') state.quote = "basic";
		else if (char === "'") state.quote = "literal";
		else if (char === "[" || char === "{") state.containers.push(char);
		else if (char === "]" || char === "}") {
			const expected = char === "]" ? "[" : "{";
			if (state.containers.pop() !== expected) return { content, error: "mismatched value delimiter" };
		}
	}
	if (state.quote === "basic" || state.quote === "literal") {
		return { content, error: "unterminated string value" };
	}
	return { content };
}

function consumeTomlValue(
	lines: readonly string[],
	startLine: number,
	initial: string,
): { value?: string; endLine: number; error?: string } {
	const state: TomlScanState = { containers: [] };
	const chunks: string[] = [];
	for (let line = startLine; line < lines.length; line++) {
		const scanned = scanTomlLine(line === startLine ? initial : lines[line], state);
		chunks.push(scanned.content);
		if (scanned.error) return { endLine: line, error: scanned.error };
		if (!state.quote && state.containers.length === 0) {
			const value = chunks.join("\n").trim();
			return value.length > 0
				? { value, endLine: line }
				: { endLine: startLine, error: "assignment value is missing" };
		}
	}
	return {
		endLine: startLine,
		error: state.quote ? "unterminated multiline string value" : "unterminated compound value",
	};
}

function findTomlTopLevelCharacter(text: string, wanted: string): number {
	const state: TomlScanState = { containers: [] };
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (state.quote === "basic" || state.quote === "multiline-basic") {
			if (char === "\\") index++;
			else if (state.quote === "basic" && char === '"') state.quote = undefined;
			else if (state.quote === "multiline-basic" && text.startsWith('"""', index)) {
				state.quote = undefined;
				index += 2;
			}
			continue;
		}
		if (state.quote === "literal" || state.quote === "multiline-literal") {
			const delimiter = state.quote === "literal" ? "'" : "'''";
			if (text.startsWith(delimiter, index)) {
				state.quote = undefined;
				index += delimiter.length - 1;
			}
			continue;
		}
		if (char === "#") return -1;
		if (text.startsWith('"""', index)) {
			state.quote = "multiline-basic";
			index += 2;
		} else if (text.startsWith("'''", index)) {
			state.quote = "multiline-literal";
			index += 2;
		} else if (char === '"') state.quote = "basic";
		else if (char === "'") state.quote = "literal";
		else if (char === "[" || char === "{") state.containers.push(char);
		else if (char === "]" || char === "}") state.containers.pop();
		else if (char === wanted && state.containers.length === 0) return index;
	}
	return -1;
}

function parseTomlDottedKey(raw: string): string[] | undefined {
	const components: string[] = [];
	let index = 0;
	while (index < raw.length) {
		while (/\s/.test(raw[index] ?? "")) index++;
		let component: string | undefined;
		if (raw[index] === '"') {
			const end = findBasicStringEnd(raw, index + 1, false);
			if (end < 0) return undefined;
			const parsed = parseTomlStringValue(raw.slice(index, end + 1), false);
			if ("error" in parsed) return undefined;
			component = parsed.value;
			index = end + 1;
		} else if (raw[index] === "'") {
			const end = raw.indexOf("'", index + 1);
			if (end < 0) return undefined;
			component = raw.slice(index + 1, end);
			index = end + 1;
		} else {
			const match = /^[A-Za-z0-9_-]+/.exec(raw.slice(index));
			if (!match) return undefined;
			component = match[0];
			index += match[0].length;
		}
		components.push(component);
		while (/\s/.test(raw[index] ?? "")) index++;
		if (index === raw.length) return components;
		if (raw[index] !== ".") return undefined;
		index++;
		if (index === raw.length) return undefined;
	}
	return undefined;
}

function splitTomlTopLevel(raw: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (let index = 0; index < raw.length; index++) {
		if (raw[index] !== ",") continue;
		const relative = findTomlTopLevelCharacter(raw.slice(start, index + 1), ",");
		if (relative !== index - start) continue;
		parts.push(raw.slice(start, index).trim());
		start = index + 1;
	}
	parts.push(raw.slice(start).trim());
	return parts;
}

function isValidTomlScalar(raw: string): boolean {
	return (
		raw === "true" ||
		raw === "false" ||
		/^[+-]?(?:0|[1-9](?:_?\d)*)$/.test(raw) ||
		/^[+-]?0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/.test(raw) ||
		/^[+-]?0o[0-7](?:_?[0-7])*$/.test(raw) ||
		/^[+-]?0b[01](?:_?[01])*$/.test(raw) ||
		/^[+-]?(?:(?:0|[1-9](?:_?\d)*)\.(?:\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|(?:0|[1-9](?:_?\d)*)[eE][+-]?\d(?:_?\d)*|inf|nan)$/.test(
			raw,
		) ||
		/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(raw) ||
		/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
	);
}

function isValidTomlValue(raw: string): boolean {
	const text = raw.trim();
	if (text.startsWith('"') || text.startsWith("'")) return !("error" in parseTomlStringValue(text, false));
	if (text.startsWith("[") && text.endsWith("]")) {
		const parts = splitTomlTopLevel(text.slice(1, -1));
		if (parts.at(-1) === "") parts.pop();
		return parts.every((part) => part.length > 0 && isValidTomlValue(part));
	}
	if (text.startsWith("{") && text.endsWith("}")) {
		const body = text.slice(1, -1).trim();
		if (body.length === 0) return true;
		return splitTomlTopLevel(body).every((part) => {
			const equals = findTomlTopLevelCharacter(part, "=");
			return equals > 0 && !!parseTomlDottedKey(part.slice(0, equals)) && isValidTomlValue(part.slice(equals + 1));
		});
	}
	return isValidTomlScalar(text);
}

function parseTomlTable(line: string): { components?: string[]; array?: boolean; error?: string } {
	const state: TomlScanState = { containers: [] };
	const scanned = scanTomlLine(line, state);
	if (scanned.error || state.quote || state.containers.length > 0) return { error: "malformed table header" };
	const text = scanned.content.trim();
	const array = text.startsWith("[[");
	if (array ? !text.endsWith("]]") : !text.endsWith("]")) return { error: "malformed table header" };
	const inner = text.slice(array ? 2 : 1, array ? -2 : -1).trim();
	const components = parseTomlDottedKey(inner);
	return components && components.length > 0 ? { components, array } : { error: "malformed table header" };
}

/**
 * Strict Kimi TOML subset reader. It validates every table/assignment and generic TOML value,
 * but extracts only root `base_url`/`model_name` and `[providers.<name>]` string fields. Fixed
 * line-number errors ensure credentials and other file content are never echoed.
 */
function loadKimiConfig(path: string): KimiConfigLoad {
	if (!existsSync(path)) return { kind: "missing" };
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return { kind: "invalid", line: 0, reason: "file is unreadable" };
	}
	const value: KimiConfigValues = { providers: [] };
	const lines = content.split(/\r?\n/);
	const assignments = new Set<string>();
	let table: KimiTomlProviderEntry | "root" | "other" = "root";
	let scope = "root";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		if (line.startsWith("[")) {
			const parsed = parseTomlTable(line);
			if (parsed.error || !parsed.components) {
				return { kind: "invalid", line: index + 1, reason: parsed.error ?? "malformed table header" };
			}
			const [first, name] = parsed.components;
			if (first === "providers" && parsed.array) {
				return { kind: "invalid", line: index + 1, reason: "provider table cannot be an array" };
			}
			if (first === "providers" && parsed.components.length === 2 && name !== undefined && name.length > 0) {
				const entry: KimiTomlProviderEntry = { name };
				value.providers.push(entry);
				table = entry;
			} else {
				table = "other";
			}
			scope = `${parsed.array ? "array" : "table"}:${JSON.stringify(parsed.components)}`;
			continue;
		}

		const assignmentLine = index;
		const equals = findTomlTopLevelCharacter(line, "=");
		const key = equals > 0 ? parseTomlDottedKey(line.slice(0, equals)) : undefined;
		if (!key || key.length === 0) return { kind: "invalid", line: index + 1, reason: "invalid assignment" };
		const consumed = consumeTomlValue(lines, index, line.slice(equals + 1));
		if (consumed.error || consumed.value === undefined) {
			return { kind: "invalid", line: assignmentLine + 1, reason: consumed.error ?? "invalid assignment value" };
		}
		index = consumed.endLine;
		if (!isValidTomlValue(consumed.value)) {
			return { kind: "invalid", line: assignmentLine + 1, reason: "invalid assignment value" };
		}
		const assignmentId = `${scope}:${JSON.stringify(key)}`;
		if (assignments.has(assignmentId)) {
			return { kind: "invalid", line: assignmentLine + 1, reason: "duplicate assignment" };
		}
		assignments.add(assignmentId);
		if (key.length !== 1 || table === "other") continue;

		const keyName = key[0];
		const relevant =
			table === "root"
				? keyName === "base_url" || keyName === "model_name"
				: keyName === "base_url" ||
					keyName === "model_name" ||
					keyName === "model" ||
					keyName === "type" ||
					keyName === "api_key";
		if (!relevant) continue;
		const parsedValue = parseTomlStringValue(consumed.value);
		if ("error" in parsedValue) return { kind: "invalid", line: assignmentLine + 1, reason: parsedValue.error };
		if (table === "root") {
			if (keyName === "base_url") value.baseUrl = parsedValue.value;
			else value.modelName = parsedValue.value;
		} else {
			if (keyName === "base_url") table.baseUrl = parsedValue.value;
			else if (keyName === "type") table.type = parsedValue.value;
			else if (keyName === "api_key") table.apiKey = parsedValue.value;
			else table.modelName = parsedValue.value;
		}
	}
	return { kind: "ok", value };
}

function nonemptyEnv(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

interface KimiResolution {
	baseUrl?: string;
	modelName?: string;
	baseUrlSource?: "kimi-environment" | "kimi-config-toml";
	/** First `[providers.<name>]` entry with `type = "openai_legacy"` and a base URL (§10.2). */
	customProvider?: { name: string; baseUrl: string; modelName?: string; apiKey?: string };
	failure?: { line: number; reason: string };
}

function resolveKimiConfig(kimiConfigPath: string | undefined): KimiResolution {
	const path = kimiConfigPath ?? join(homedir(), ".kimi", "config.toml");
	const loaded = loadKimiConfig(path);
	if (loaded.kind === "invalid") return { failure: { line: loaded.line, reason: loaded.reason } };
	const fileValues: KimiConfigValues = loaded.kind === "ok" ? loaded.value : { providers: [] };
	const envBaseUrl = nonemptyEnv("KIMI_BASE_URL");
	const envModelName = nonemptyEnv("KIMI_MODEL_NAME");
	const custom = fileValues.providers.find((entry) => entry.type === "openai_legacy" && entry.baseUrl);
	return {
		baseUrl: envBaseUrl ?? fileValues.baseUrl,
		modelName: envModelName ?? fileValues.modelName,
		baseUrlSource: envBaseUrl ? "kimi-environment" : fileValues.baseUrl ? "kimi-config-toml" : undefined,
		customProvider: custom
			? { name: custom.name, baseUrl: custom.baseUrl as string, modelName: custom.modelName, apiKey: custom.apiKey }
			: undefined,
	};
}

function loadConfig<T>(path: string, parse: (value: unknown) => T | undefined, allowComments = false): LoadedConfig<T> {
	if (!existsSync(path)) return { kind: "missing" };
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(allowComments ? stripJsonComments(content) : content) as unknown;
		const value = parse(parsed);
		return value ? { kind: "ok", value } : { kind: "invalid" };
	} catch {
		return { kind: "invalid" };
	}
}

export function normalizedUrlHostname(url: URL): string {
	return normalizedHostname(url);
}

function normalizedHostname(url: URL): string {
	const hostname = url.hostname.toLowerCase();
	const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return unwrapped.endsWith(".") ? unwrapped.slice(0, -1) : unwrapped;
}

function isLiteralLoopback(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "::1") return true;
	if (isIP(hostname) !== 4) return false;
	return Number(hostname.split(".")[0]) === 127;
}

function isBlockedPublicHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (isIP(hostname) === 0) return false;
	return isBlockedPublicAddress(hostname);
}

function sanitizeUrl(rawUrl: string): URL | undefined {
	try {
		const url = new URL(rawUrl);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url;
	} catch {
		return undefined;
	}
}

export function canonicalProviderEndpointUrl(rawUrl: string | undefined): string | undefined {
	if (!rawUrl) return undefined;
	const url = sanitizeUrl(rawUrl);
	if (!url) return undefined;
	const hostname = normalizedHostname(url);
	const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
	const pathname = url.pathname.replace(/\/+$/, "") || "/";
	return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${pathname}`;
}

function credentialBindingMatchesTarget(
	binding: ProviderDoctorCredentialBinding,
	target: ResolvedProviderTarget,
): boolean {
	return (
		binding.origin === target.origin &&
		binding.source === target.source &&
		binding.baseUrl === canonicalProviderEndpointUrl(target.endpoint.baseUrl) &&
		binding.api === target.endpoint.api &&
		binding.modelId === target.endpoint.modelId
	);
}

function appendPath(url: URL, segment: string): URL {
	const next = new URL(url.href);
	next.pathname = `${next.pathname.replace(/\/$/, "")}/${segment}`;
	return next;
}

function makeRootProbeUrl(url: URL, origin: ProviderOrigin): URL {
	if (origin !== "local-proxy") return new URL(url.href);
	const health = new URL(url.href);
	health.pathname = "/health";
	return health;
}

function publicResult(
	target: ResolvedProviderTarget,
	level: ProviderDoctorLevel,
	checks: ProviderDoctorCheck[],
	url: URL | undefined,
	failure?: ProbeFailure,
	costWarning?: boolean,
): ProviderDoctorResult {
	const targetUrl = url?.href;
	return {
		provider: target.providerId,
		status: failure ? "fail" : "ok",
		level,
		origin: target.origin,
		source: target.source,
		targetUrl,
		baseUrl: targetUrl,
		api: target.endpoint.api,
		modelId: target.endpoint.modelId,
		authPresent: target.auth.present,
		...(costWarning ? { costWarning: true } : {}),
		checks,
		error: failure,
	};
}

function unresolvedFailure(
	providerId: string,
	level: ProviderDoctorLevel,
	code: ProviderDoctorCode,
	message: string,
): ProviderDoctorResult {
	const check: ProviderDoctorCheck = { name: "config", status: "fail", category: "config", code, message };
	return {
		provider: providerId,
		status: "fail",
		level,
		origin: "unknown",
		source: "unresolved",
		authPresent: false,
		checks: [check],
		error: { category: "config", code, message },
	};
}

function staticChecks(target: ResolvedProviderTarget): {
	checks: ProviderDoctorCheck[];
	url?: URL;
	failure?: ProbeFailure;
} {
	const checks: ProviderDoctorCheck[] = [
		{ name: "config-present", status: "ok", code: "ok", message: "Provider configuration resolved" },
	];
	if (target.origin === "custom-openai-compatible") {
		checks.push({
			name: "native-provider-checks",
			status: "skipped",
			code: "ok",
			message: "Custom OpenAI-compatible endpoint; native-only provider checks skipped",
		});
	}
	let failure: ProbeFailure | undefined;
	const recordFailure = (next: ProbeFailure): void => {
		failure ??= next;
	};

	const requestedModel = target.endpoint.modelId;
	const modelIds = target.endpoint.modelIds ?? [];
	if (!requestedModel) {
		checks.push({ name: "model-provider-relation", status: "skipped", code: "ok", message: "No model selected" });
	} else if (!modelIds.includes(requestedModel)) {
		const next: ProbeFailure = {
			category: "model",
			code: "model-provider-mismatch",
			message: "Selected model does not belong to the provider",
		};
		checks.push({ name: "model-provider-relation", status: "fail", ...next });
		recordFailure(next);
	} else {
		checks.push({ name: "model-provider-relation", status: "ok", code: "ok", message: "Model belongs to provider" });
	}

	const api = target.endpoint.api;
	if (!api) {
		const next: ProbeFailure = { category: "config", code: "api-missing", message: "Provider API type is missing" };
		checks.push({ name: "api", status: "fail", ...next });
		recordFailure(next);
	} else if (
		!KNOWN_APIS.has(api) ||
		(target.origin === "custom-openai-compatible" && !OPENAI_COMPATIBLE_APIS.has(api))
	) {
		const next: ProbeFailure = {
			category: "config",
			code: "api-unsupported",
			message: "Provider API type is unsupported",
		};
		checks.push({ name: "api", status: "fail", ...next });
		recordFailure(next);
	} else {
		checks.push({ name: "api", status: "ok", code: "ok", message: "Provider API type is supported" });
	}

	let url: URL | undefined;
	if (!target.endpoint.baseUrl) {
		const next: ProbeFailure = {
			category: "config",
			code: "base-url-missing",
			message: "Provider base URL is missing",
		};
		checks.push({ name: "base-url", status: "fail", ...next });
		recordFailure(next);
	} else {
		url = sanitizeUrl(target.endpoint.baseUrl);
		if (!url) {
			const next: ProbeFailure = {
				category: "config",
				code: "base-url-invalid",
				message: "Provider base URL is invalid",
			};
			checks.push({ name: "base-url", status: "fail", ...next });
			recordFailure(next);
		} else {
			const allowedScheme =
				target.origin === "local-proxy"
					? url.protocol === "http:" || url.protocol === "https:"
					: url.protocol === "https:";
			if (!allowedScheme) {
				const next: ProbeFailure = {
					category: "config",
					code: "url-scheme-unsupported",
					message: "Provider URL scheme is not allowed",
				};
				checks.push({ name: "base-url", status: "fail", ...next });
				recordFailure(next);
			} else {
				checks.push({ name: "base-url", status: "ok", code: "ok", message: "Provider base URL is valid" });
			}
		}
	}

	if (target.origin === "unknown") {
		const next: ProbeFailure = {
			category: "config",
			code: "origin-unsupported",
			message: "Provider origin is unsupported",
		};
		checks.push({ name: "origin-policy", status: "fail", ...next });
		recordFailure(next);
	} else if (url) {
		const hostname = normalizedHostname(url);
		const blocked = target.origin === "local-proxy" ? !isLiteralLoopback(hostname) : isBlockedPublicHost(hostname);
		if (blocked) {
			const next: ProbeFailure = {
				category: "config",
				code: "address-policy-blocked",
				message: "Provider address is blocked by origin policy",
			};
			checks.push({ name: "origin-policy", status: "fail", ...next });
			recordFailure(next);
		} else {
			checks.push({ name: "origin-policy", status: "ok", code: "ok", message: "Provider origin policy passed" });
		}
	} else {
		checks.push({ name: "origin-policy", status: "skipped", code: "ok", message: "No valid URL to inspect" });
	}

	if (target.auth.present) {
		checks.push({ name: "auth-present", status: "ok", code: "ok", message: "Authentication is configured" });
	} else if (target.origin === "custom-openai-compatible" || target.origin === "local-proxy") {
		// Native login checks do not apply: custom/local OpenAI-compatible endpoints may be keyless.
		checks.push({
			name: "auth-present",
			status: "skipped",
			code: "ok",
			message: "No credential configured; custom endpoints may be keyless",
		});
	} else {
		const next: ProbeFailure = {
			category: "auth",
			code: "auth-missing",
			message: "Authentication is not configured",
		};
		checks.push({ name: "auth-present", status: "fail", ...next });
		recordFailure(next);
	}

	return { checks, url, failure };
}

type ProbeEndpointKind = "root" | "models" | "model-probe";

function classifyProbe(name: string, kind: ProbeEndpointKind, status: number): ProbeOutcome {
	const forModels = kind === "models";
	if (Number.isInteger(status) && status >= 200 && status < 300) {
		const probe: EndpointProbeResult = { reachable: true, authenticated: true, status, category: "ok" };
		if (forModels) probe.modelsSupported = true;
		return { check: { name, status: "ok", code: "ok", message: `HTTP ${status}`, probe } };
	}
	if (status >= 300 && status < 400) {
		const failure: ProbeFailure = {
			category: "config",
			code: "redirect-blocked",
			message: "Provider probe returned a blocked redirect",
		};
		return { check: { name, status: "fail", ...failure }, failure };
	}
	if (status === 401 || status === 403) {
		const failure: ProbeFailure = {
			category: "auth",
			code: "authentication-failed",
			message: "Provider rejected authentication",
		};
		const probe: EndpointProbeResult = { reachable: true, authenticated: false, status, category: "auth" };
		return { check: { name, status: "fail", ...failure, probe }, failure };
	}
	if (status === 404 || status === 405 || status === 501) {
		// A root or /models 404 is neutral: OpenAI-compatible servers may not expose these paths.
		const probe: EndpointProbeResult = { reachable: true, status, category: "unsupported-endpoint" };
		if (forModels) probe.modelsSupported = false;
		return {
			check: {
				name,
				status: "unsupported",
				code: "endpoint-unsupported",
				message: `HTTP ${status}; endpoint is not required`,
				probe,
			},
		};
	}
	if (status >= 500 && status <= 599) {
		const failure: ProbeFailure = {
			category: "server",
			code: "server-error",
			message: "Provider endpoint returned a server error",
		};
		const probe: EndpointProbeResult = { reachable: true, status, category: "server" };
		return { check: { name, status: "fail", ...failure, probe }, failure };
	}
	if (status === 408 || status === 429) {
		const failure: ProbeFailure = {
			category: "network",
			code: "network-failure",
			message: "Provider probe failed at the network boundary",
		};
		const probe: EndpointProbeResult = { reachable: true, status, category: "network" };
		return { check: { name, status: "fail", ...failure, probe }, failure };
	}

	const failure: ProbeFailure = {
		category: "config",
		code: "unexpected-response",
		message: "Provider probe returned an unexpected response",
	};
	return { check: { name, status: "fail", ...failure }, failure };
}

function createComposedController(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): {
	controller: AbortController;
	abortKind: () => "aborted" | "timeout" | undefined;
	dispose: () => void;
} {
	const controller = new AbortController();
	let kind: "aborted" | "timeout" | undefined;
	const abortFromCaller = (): void => {
		kind ??= "aborted";
		controller.abort();
	};
	if (signal?.aborted) abortFromCaller();
	else signal?.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => {
		kind ??= "timeout";
		controller.abort();
	}, timeoutMs);

	return {
		controller,
		abortKind: () => kind,
		dispose: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromCaller);
		},
	};
}

function requestWithAbort(
	transport: ProviderDoctorTransport,
	request: ProviderDoctorTransportRequest,
): Promise<ProviderDoctorTransportResponse> {
	return new Promise((resolve, reject) => {
		if (request.signal.aborted) {
			reject(ABORTED);
			return;
		}
		const onAbort = (): void => reject(ABORTED);
		request.signal.addEventListener("abort", onAbort, { once: true });
		let pending: Promise<ProviderDoctorTransportResponse>;
		try {
			pending = transport.request(request);
		} catch (error) {
			request.signal.removeEventListener("abort", onAbort);
			reject(error instanceof ProviderDoctorAuthMaterializationError ? error : undefined);
			return;
		}
		void pending.then(
			(response) => {
				request.signal.removeEventListener("abort", onAbort);
				resolve(response);
			},
			(error: unknown) => {
				request.signal.removeEventListener("abort", onAbort);
				reject(error instanceof ProviderDoctorAuthMaterializationError ? error : undefined);
			},
		);
	});
}

interface ProbePayload {
	body: string;
	contentType: "application/json";
}

async function runProbe(
	name: string,
	kind: ProbeEndpointKind,
	url: URL,
	transport: ProviderDoctorTransport,
	addressPolicy: ProviderDoctorAddressPolicy,
	createHeaders: ProviderDoctorHeaderFactory,
	controller: ReturnType<typeof createComposedController>,
	payload?: ProbePayload,
): Promise<ProbeOutcome> {
	try {
		const response = await requestWithAbort(transport, {
			url,
			method: payload ? "POST" : "GET",
			redirect: "manual",
			signal: controller.controller.signal,
			addressPolicy,
			createHeaders,
			body: payload?.body,
			contentType: payload?.contentType,
		});
		return classifyProbe(name, kind, response.status);
	} catch (error) {
		if (error instanceof ProviderDoctorAuthMaterializationError) {
			const failure: ProbeFailure = {
				category: "auth",
				code: "auth-materialization-failed",
				message: "Configured authentication could not be materialized; verify auth and config references",
			};
			return {
				check: {
					name,
					status: "fail",
					...failure,
					probe: { reachable: false, authenticated: false, category: "auth" },
				},
				failure,
			};
		}
		const abortKind = controller.abortKind();
		const failure: ProbeFailure = abortKind
			? {
					category: "network",
					code: abortKind === "timeout" ? "request-timeout" : "request-aborted",
					message: abortKind === "timeout" ? "Provider probe timed out" : "Provider probe was aborted",
				}
			: { category: "network", code: "network-failure", message: "Provider transport failed" };
		return {
			check: { name, status: "fail", ...failure, probe: { reachable: false, category: "network" } },
			failure,
		};
	}
}

/** Minimal-token generative probe payload; never includes tools (no tool-call probe). */
function modelProbeSpec(api: string, modelId: string): { path: string; payload: ProbePayload } | undefined {
	if (api === "openai-completions") {
		return {
			path: "chat/completions",
			payload: {
				body: JSON.stringify({
					model: modelId,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
					stream: false,
				}),
				contentType: "application/json",
			},
		};
	}
	if (api === "openai-responses") {
		return {
			path: "responses",
			payload: {
				// The responses API rejects max_output_tokens below 16; still the minimal request.
				body: JSON.stringify({ model: modelId, input: "ping", max_output_tokens: 16, stream: false }),
				contentType: "application/json",
			},
		};
	}
	return undefined;
}

function classifyOrigin(
	providerId: string,
	baseUrl: string | undefined,
	api: string | undefined,
	isNative: boolean,
): ProviderOrigin {
	const url = baseUrl ? sanitizeUrl(baseUrl) : undefined;
	if (providerId === "grok-oauth-proxy" || (url && isLiteralLoopback(normalizedHostname(url)))) {
		return "local-proxy";
	}
	if (isNative) return "native";
	if (api && OPENAI_COMPATIBLE_APIS.has(api)) return "custom-openai-compatible";
	return "unknown";
}

function resolveProviderTarget(
	providerId: string,
	options: ProviderDoctorOptions,
): { target?: ResolvedProviderTarget; failure?: ProviderDoctorResult } {
	const level = options.level ?? 0;
	const agentDir = options.agentDir ?? getConfiguredAgentDir();
	const modelsConfig = loadConfig(join(agentDir, "models.json"), parseModelsConfig, true);
	if (modelsConfig.kind === "invalid") {
		return {
			failure: unresolvedFailure(providerId, level, "models-config-invalid", "models.json is invalid"),
		};
	}
	const authConfig = loadConfig(join(agentDir, "auth.json"), parseAuthConfig);
	if (authConfig.kind === "invalid") {
		return { failure: unresolvedFailure(providerId, level, "auth-config-invalid", "auth.json is invalid") };
	}

	const kimi = providerId === KIMI_PROVIDER_ID ? resolveKimiConfig(options.kimiConfigPath) : {};
	if (kimi.failure) {
		return {
			failure: unresolvedFailure(
				providerId,
				level,
				"kimi-config-invalid",
				`Kimi config TOML is invalid (line ${kimi.failure.line}: ${kimi.failure.reason}); fix the Kimi config or set KIMI_BASE_URL/KIMI_MODEL_NAME`,
			),
		};
	}

	const configured = modelsConfig.kind === "ok" ? modelsConfig.value.providers[providerId] : undefined;
	const nativeProviders = getProviders();
	const isNative = nativeProviders.includes(providerId as KnownProvider);
	const nativeModels = isNative ? (getModels(providerId as KnownProvider) as Model<Api>[]) : [];
	const configuredModels = configured?.models ?? [];
	// At Level 2 the probe model is the paid target and therefore drives endpoint resolution.
	const requestedModel = level === 2 ? (options.probeModelId ?? options.modelId) : options.modelId;
	const configuredModel = requestedModel
		? configuredModels.find((model) => model.id === requestedModel)
		: configuredModels[0];

	// §10.2: with no higher-precedence endpoint (models.json > KIMI_BASE_URL > root TOML), a
	// `[providers.<name>]` entry with `type = "openai_legacy"` selects a custom OpenAI-compatible
	// endpoint, so native-only checks and native credential/model inheritance are skipped downstream.
	const kimiCustomSelected =
		!(configuredModel?.baseUrl ?? configured?.baseUrl) && !kimi.baseUrl && kimi.customProvider !== undefined;
	const kimiModelName = kimi.modelName ?? (kimiCustomSelected ? kimi.customProvider?.modelName : undefined);
	const endpointModelId = requestedModel ?? kimiModelName;
	const modelIds = kimiCustomSelected
		? kimiModelName
			? [kimiModelName]
			: []
		: Array.from(
				new Set([
					...nativeModels.map((model) => model.id),
					...configuredModels.map((model) => model.id),
					...(kimiModelName ? [kimiModelName] : []),
				]),
			);
	let nativeModel = kimiCustomSelected
		? undefined
		: requestedModel
			? nativeModels.find((model) => model.id === requestedModel)
			: nativeModels[0];
	if (!nativeModel && !kimiCustomSelected && requestedModel !== undefined && requestedModel === kimiModelName) {
		// A native Kimi TOML/env model rides on the provider defaults for endpoint metadata.
		nativeModel = nativeModels[0];
	}

	let baseUrl = configuredModel?.baseUrl ?? configured?.baseUrl;
	let api = configuredModel?.api ?? configured?.api ?? nativeModel?.api;
	let source = configured ? "models.json" : isNative ? "built-in-model-registry" : "unresolved";
	if (!baseUrl && kimi.baseUrl) {
		baseUrl = kimi.baseUrl;
		source = kimi.baseUrlSource ?? source;
	} else if (kimiCustomSelected && kimi.customProvider) {
		baseUrl = kimi.customProvider.baseUrl;
		api = "openai-completions";
		source = `kimi-config-toml:providers.${kimi.customProvider.name}`;
	} else {
		baseUrl = baseUrl ?? nativeModel?.baseUrl;
	}
	let builtInAuth = false;
	if (providerId === "grok-oauth-proxy" && !baseUrl) {
		baseUrl = "http://127.0.0.1:9996/v1";
		api = "openai-completions";
		source = "built-in-grok-oauth-proxy-defaults";
		builtInAuth = true;
	}

	const storedAuth = authConfig.kind === "ok" && authConfig.value[providerId] !== undefined;
	const environmentAuth = findEnvKeys(providerId) !== undefined;
	const configuredAuth = configured?.apiKey ? isConfigValueConfigured(configured.apiKey) : false;
	const headerAuth = configured?.headers !== undefined && Object.keys(configured.headers).length > 0;
	const customApiKey = kimiCustomSelected ? kimi.customProvider?.apiKey : undefined;
	const customAuthPresent = customApiKey !== undefined && isConfigValueConfigured(customApiKey);
	const authPresent = kimiCustomSelected
		? customAuthPresent
		: storedAuth || environmentAuth || configuredAuth || headerAuth || builtInAuth;
	const authSource = kimiCustomSelected
		? customAuthPresent
			? source
			: undefined
		: storedAuth
			? "auth.json"
			: environmentAuth
				? "environment"
				: configuredAuth || headerAuth
					? "models.json"
					: builtInAuth
						? "built-in"
						: undefined;

	if (!configured && !isNative && !storedAuth && !environmentAuth && providerId !== "grok-oauth-proxy") {
		return { failure: unresolvedFailure(providerId, level, "provider-not-found", "Provider was not found") };
	}

	const origin = classifyOrigin(providerId, baseUrl, api, isNative && !kimiCustomSelected);
	const canonicalBaseUrl = canonicalProviderEndpointUrl(baseUrl);
	const binding =
		canonicalBaseUrl && api && endpointModelId
			? { origin, source, baseUrl: canonicalBaseUrl, api, modelId: endpointModelId }
			: undefined;
	const createHeaders: ProviderDoctorHeaderFactory | undefined =
		kimiCustomSelected && binding
			? () => {
					const headers = new Headers();
					if (customApiKey) {
						headers.set(
							"Authorization",
							`Bearer ${resolveConfigValueOrThrow(customApiKey, "API key for custom Kimi endpoint")}`,
						);
					}
					return headers;
				}
			: undefined;

	return {
		target: {
			providerId,
			origin,
			source,
			endpoint: { baseUrl, api, modelIds, modelId: endpointModelId },
			auth: { present: authPresent, source: authSource, createHeaders, binding },
		},
	};
}

export async function diagnoseResolvedProvider(
	target: ResolvedProviderTarget,
	options: ProviderDoctorOptions = {},
	dependencies: ProviderDoctorDependencies = {},
): Promise<ProviderDoctorResult> {
	const requestedLevel = options.level ?? 0;
	if (requestedLevel !== 0 && requestedLevel !== 1 && requestedLevel !== 2) {
		return unresolvedFailure(target.providerId, 0, "unsupported-level", "Provider doctor level is unsupported");
	}
	const level: ProviderDoctorLevel = requestedLevel;
	// Level 2 is opt-in only: probeModelId is ignored at levels 0/1, which stay GET-only.
	const probeModelId = level === 2 ? options.probeModelId : undefined;
	const effectiveModelId = probeModelId ?? options.modelId;
	const resolvedTarget = effectiveModelId
		? { ...target, endpoint: { ...target.endpoint, modelId: effectiveModelId } }
		: target;
	if (level === 2 && options.modelId && probeModelId && options.modelId !== probeModelId) {
		const failure: ProbeFailure = {
			category: "model",
			code: "probe-model-conflict",
			message: "Validation model and paid probe model must match",
		};
		return publicResult(
			resolvedTarget,
			level,
			[{ name: "model-probe", status: "fail", ...failure }],
			undefined,
			failure,
		);
	}
	if (level === 2 && !probeModelId) {
		const failure: ProbeFailure = {
			category: "config",
			code: "probe-model-required",
			message: "Level 2 requires an explicit probe model (--probe-model)",
		};
		return publicResult(
			resolvedTarget,
			level,
			[{ name: "model-probe", status: "fail", ...failure }],
			undefined,
			failure,
		);
	}
	const validation = staticChecks(resolvedTarget);
	if (validation.failure || level === 0) {
		return publicResult(resolvedTarget, level, validation.checks, validation.url, validation.failure);
	}

	const transport = dependencies.transport ?? options.transport;
	if (!transport) {
		const failure: ProbeFailure = {
			category: "config",
			code: "transport-required",
			message: "Level 1 requires an injected provider transport",
		};
		validation.checks.push({ name: "transport", status: "fail", ...failure });
		return publicResult(resolvedTarget, level, validation.checks, validation.url, failure);
	}
	if (resolvedTarget.origin !== "local-proxy" && transport.pinsResolvedAddress !== true) {
		const failure: ProbeFailure = {
			category: "config",
			code: "address-pinning-required",
			message: "Public provider transport must pin resolved addresses",
		};
		validation.checks.push({ name: "transport", status: "fail", ...failure });
		return publicResult(resolvedTarget, level, validation.checks, validation.url, failure);
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		const failure: ProbeFailure = {
			category: "config",
			code: "unexpected-response",
			message: "Provider probe timeout is invalid",
		};
		validation.checks.push({ name: "transport", status: "fail", ...failure });
		return publicResult(resolvedTarget, level, validation.checks, validation.url, failure);
	}

	const addressPolicy: ProviderDoctorAddressPolicy =
		resolvedTarget.origin === "local-proxy"
			? { kind: "loopback-only", requireAddressPinning: false }
			: { kind: "public", requireAddressPinning: true };
	const resolveAuthHeaders = dependencies.resolveAuthHeaders ?? options.resolveAuthHeaders;
	const credentialBinding = resolvedTarget.auth.binding;
	const boundHeaderFactory = resolvedTarget.auth.createHeaders;
	const endpointBoundHeaders: ProviderDoctorHeaderFactory | undefined =
		credentialBinding && boundHeaderFactory
			? async () => {
					if (!credentialBindingMatchesTarget(credentialBinding, resolvedTarget)) {
						throw new ProviderDoctorAuthMaterializationError();
					}
					try {
						return await boundHeaderFactory();
					} catch {
						throw new ProviderDoctorAuthMaterializationError();
					}
				}
			: undefined;
	const createHeaders: ProviderDoctorHeaderFactory = endpointBoundHeaders
		? endpointBoundHeaders
		: level === 2 && resolveAuthHeaders
			? async () => {
					if (credentialBinding && !credentialBindingMatchesTarget(credentialBinding, resolvedTarget)) {
						throw new ProviderDoctorAuthMaterializationError();
					}
					try {
						return await resolveAuthHeaders(resolvedTarget);
					} catch {
						throw new ProviderDoctorAuthMaterializationError();
					}
				}
			: (resolvedTarget.auth.createHeaders ?? (() => new Headers()));
	const controller = createComposedController(options.signal, timeoutMs);
	try {
		const root = await runProbe(
			"root-endpoint",
			"root",
			makeRootProbeUrl(validation.url!, resolvedTarget.origin),
			transport,
			addressPolicy,
			createHeaders,
			controller,
		);
		validation.checks.push(root.check);
		if (root.failure) {
			validation.checks.push({
				name: "models-endpoint",
				status: "skipped",
				code: "ok",
				message: "Capability probe skipped after root failure",
			});
			return publicResult(resolvedTarget, level, validation.checks, validation.url, root.failure);
		}

		const models = await runProbe(
			"models-endpoint",
			"models",
			appendPath(validation.url!, "models"),
			transport,
			addressPolicy,
			createHeaders,
			controller,
		);
		validation.checks.push(models.check);
		if (level !== 2 || models.failure) {
			return publicResult(resolvedTarget, level, validation.checks, validation.url, models.failure);
		}

		const spec = modelProbeSpec(resolvedTarget.endpoint.api ?? "", probeModelId as string);
		if (!spec) {
			const failure: ProbeFailure = {
				category: "config",
				code: "api-unsupported",
				message: "Model probe supports only OpenAI-compatible APIs",
			};
			validation.checks.push({ name: "model-probe", status: "fail", ...failure });
			return publicResult(resolvedTarget, level, validation.checks, validation.url, failure);
		}
		const probe = await runProbe(
			"model-probe",
			"model-probe",
			appendPath(validation.url!, spec.path),
			transport,
			addressPolicy,
			createHeaders,
			controller,
			spec.payload,
		);
		const dispatched = probe.failure?.code !== "auth-materialization-failed";
		if (dispatched) {
			probe.check.message = `${probe.check.message}; minimal-token generative probe (may incur provider costs)`;
		}
		validation.checks.push(probe.check);
		return publicResult(resolvedTarget, level, validation.checks, validation.url, probe.failure, dispatched);
	} finally {
		controller.dispose();
	}
}

export async function diagnoseProvider(
	providerId: string,
	options: ProviderDoctorOptions = {},
): Promise<ProviderDoctorResult> {
	const requestedLevel = options.level ?? 0;
	if (requestedLevel !== 0 && requestedLevel !== 1 && requestedLevel !== 2) {
		return unresolvedFailure(providerId, 0, "unsupported-level", "Provider doctor level is unsupported");
	}
	const resolved = resolveProviderTarget(providerId, options);
	if (resolved.failure) return resolved.failure;
	return diagnoseResolvedProvider(resolved.target!, options);
}
