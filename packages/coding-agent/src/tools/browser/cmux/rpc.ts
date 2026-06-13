import type { Observation, ObservationEntry } from "../tab-protocol";

export interface CmuxKind {
	kind: "cmux";
	socketPath: string;
	password?: string;
	surface?: string;
}

export interface CmuxOpenSplitResult {
	surface_id?: unknown;
	url?: unknown;
	workspace_id?: unknown;
	created_split?: unknown;
	placement_strategy?: unknown;
}

export interface CmuxSnapshotRef {
	role?: unknown;
	name?: unknown;
}

export interface CmuxSnapshotPage {
	title?: unknown;
	url?: unknown;
	ready_state?: unknown;
	text?: unknown;
	html?: unknown;
}

export interface CmuxSnapshotResult {
	snapshot?: unknown;
	refs?: Record<string, CmuxSnapshotRef>;
	page?: CmuxSnapshotPage;
	url?: unknown;
	title?: unknown;
	ready_state?: unknown;
	surface_id?: unknown;
}

export interface CmuxEvalResult {
	value?: unknown;
	surface_id?: unknown;
	content_world?: unknown;
}

export interface CmuxUrlGetResult {
	url?: unknown;
	surface_id?: unknown;
	workspace_id?: unknown;
}

export interface CmuxScreenshotResult {
	png_base64?: unknown;
	path?: unknown;
	url?: unknown;
	surface_id?: unknown;
	width?: unknown;
	height?: unknown;
}

export interface CmuxGeometry {
	innerWidth: number;
	innerHeight: number;
	dpr: number;
	scrollX: number;
	scrollY: number;
	scrollWidth: number;
	scrollHeight: number;
}

export const GEOMETRY_SCRIPT =
	"(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio||1, scrollX: window.scrollX, scrollY: window.scrollY, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }))()";

export function cmuxSnapshotToObservation(
	result: CmuxSnapshotResult,
	viewport: Observation["viewport"],
	geometry: CmuxGeometry,
): Observation {
	const elements: ObservationEntry[] = [];
	const refs = result.refs ?? {};
	for (const ref in refs) {
		const value = refs[ref];
		if (!value) continue;
		const id = Number.parseInt(ref.replace(/^@?e/, ""), 10);
		if (Number.isNaN(id)) continue;
		const role = typeof value.role === "string" && value.role.length > 0 ? value.role : "generic";
		const name = typeof value.name === "string" && value.name.length > 0 ? value.name : undefined;
		elements.push({ id, role, name, states: [] });
	}
	elements.sort((a, b) => a.id - b.id);

	const url =
		(typeof result.url === "string" && result.url.length > 0 ? result.url : undefined) ??
		(typeof result.page?.url === "string" && result.page.url.length > 0 ? result.page.url : undefined) ??
		"about:blank";
	const title =
		(typeof result.title === "string" && result.title.length > 0 ? result.title : undefined) ??
		(typeof result.page?.title === "string" && result.page.title.length > 0 ? result.page.title : undefined);
	return {
		url,
		title,
		viewport,
		scroll: {
			x: geometry.scrollX,
			y: geometry.scrollY,
			width: geometry.innerWidth,
			height: geometry.innerHeight,
			scrollWidth: geometry.scrollWidth,
			scrollHeight: geometry.scrollHeight,
		},
		elements,
	};
}

export function serializeEval(fn: string | ((...args: unknown[]) => unknown), args: unknown[]): string {
	if (typeof fn === "string") {
		return fn;
	}
	return `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(",")})`;
}

export function mapWaitUntil(waitUntil: string | undefined): "interactive" | "complete" {
	return waitUntil === "domcontentloaded" ? "interactive" : "complete";
}

const TRUTHY_ENV_VALUES = new Set(["1", "Y", "y", "TRUE", "true", "YES", "yes", "ON", "on"]);

function resolveCmuxEnabled(envValue: string | undefined, settingEnabled: boolean): boolean {
	if (!envValue) return settingEnabled;
	return TRUTHY_ENV_VALUES.has(envValue);
}

export interface ResolveCmuxKindOptions {
	surface?: string;
	settingEnabled?: boolean;
}

export function resolveCmuxKind(
	options?: ResolveCmuxKindOptions | null,
	env: Record<string, string | undefined> = process.env,
): CmuxKind | null {
	if (!resolveCmuxEnabled(env.PI_BROWSER_CMUX, options?.settingEnabled ?? true)) {
		return null;
	}
	const socketPath = env.CMUX_SOCKET_PATH;
	if (!socketPath) {
		return null;
	}
	return {
		kind: "cmux",
		socketPath,
		password: env.CMUX_SOCKET_PASSWORD || undefined,
		surface: options?.surface,
	};
}
