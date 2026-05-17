/**
 * AWS credential resolution for the Bedrock provider.
 *
 * Chain (first hit wins):
 *  1. Static credentials from the environment
 *     (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` [+ `AWS_SESSION_TOKEN`]).
 *  2. Profile in `~/.aws/credentials` (and `~/.aws/config` for SSO):
 *      - static `aws_access_key_id` / `aws_secret_access_key` / `aws_session_token`
 *      - SSO profile referencing a cached token in `~/.aws/sso/cache/*.json`,
 *        which we exchange for short-lived role credentials via
 *        `https://portal.sso.{region}.amazonaws.com/federation/credentials`.
 *  3. EC2 IMDSv2 (only when `AWS_EC2_METADATA_DISABLED` is unset / falsey and
 *     `169.254.169.254` is reachable within a 1 s timeout).
 *
 * Resolved credentials are cached process-wide per profile and refreshed
 * 60 s before `Expiration` to absorb clock skew.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { AwsCredentials } from "./aws-sigv4";

export interface ResolvedCredentials extends AwsCredentials {
	/** Absolute expiration timestamp in ms. `undefined` for non-expiring static creds. */
	expiresAt?: number;
}

export interface CredentialResolveOptions {
	/** Named profile from `~/.aws/credentials` / `~/.aws/config`. */
	profile?: string;
	/** Falls back to env (`AWS_REGION` / `AWS_DEFAULT_REGION`) and finally `us-east-1`. */
	region?: string;
	signal?: AbortSignal;
}

const REFRESH_SKEW_MS = 60_000;

interface CacheEntry {
	creds: ResolvedCredentials;
	expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

export async function resolveAwsCredentials(opts: CredentialResolveOptions = {}): Promise<ResolvedCredentials> {
	const profile = opts.profile || $env.AWS_PROFILE || "default";
	const region = opts.region || $env.AWS_REGION || $env.AWS_DEFAULT_REGION || "us-east-1";
	const cacheKey = `${profile}\x00${region}`;

	const hit = cache.get(cacheKey);
	if (hit && hit.expiresAt - REFRESH_SKEW_MS > Date.now()) return hit.creds;

	const creds = await resolveFresh(profile, region, opts.signal);
	cache.set(cacheKey, { creds, expiresAt: creds.expiresAt ?? Number.POSITIVE_INFINITY });
	return creds;
}

async function resolveFresh(profile: string, region: string, signal?: AbortSignal): Promise<ResolvedCredentials> {
	// 1. Environment first — matches the AWS SDK chain order.
	const envCreds = readEnvCredentials();
	if (envCreds) return envCreds;

	// 2. Profile (static or SSO).
	const profileCreds = await readProfileCredentials(profile, region, signal);
	if (profileCreds) return profileCreds;

	// 3. EC2 IMDSv2.
	if ($env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true") {
		const imdsCreds = await readImdsCredentials(signal);
		if (imdsCreds) return imdsCreds;
	}

	throw new Error(
		`Unable to resolve AWS credentials. Set AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY, ` +
			`or configure profile '${profile}' in ~/.aws/credentials (or ~/.aws/config for SSO).`,
	);
}

function readEnvCredentials(): ResolvedCredentials | undefined {
	const ak = $env.AWS_ACCESS_KEY_ID;
	const sk = $env.AWS_SECRET_ACCESS_KEY;
	if (!ak || !sk) return undefined;
	const token = $env.AWS_SESSION_TOKEN;
	return token
		? { accessKeyId: ak, secretAccessKey: sk, sessionToken: token }
		: { accessKeyId: ak, secretAccessKey: sk };
}

// ---------- INI parsing ----------

/** Map of section name -> map of key -> value. Section names are stripped of
 * any leading `profile ` (so `~/.aws/config` aligns with `~/.aws/credentials`). */
type IniFile = Record<string, Record<string, string>>;

function parseIni(text: string): IniFile {
	const out: IniFile = {};
	let current: Record<string, string> | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			let name = line.slice(1, -1).trim();
			if (name.startsWith("profile ")) name = name.slice(8).trim();
			if (name.startsWith("sso-session ")) name = `sso-session:${name.slice(12).trim()}`;
			let section = out[name];
			if (!section) {
				section = {};
				out[name] = section;
			}
			current = section;
			continue;
		}
		if (!current) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

async function readIniFile(p: string): Promise<IniFile | undefined> {
	try {
		const text = await fs.promises.readFile(p, "utf8");
		return parseIni(text);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

// ---------- Profile / SSO ----------

async function readProfileCredentials(
	profile: string,
	region: string,
	signal: AbortSignal | undefined,
): Promise<ResolvedCredentials | undefined> {
	const home = os.homedir();
	const credentialsPath = $env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, ".aws", "credentials");
	const configPath = $env.AWS_CONFIG_FILE || path.join(home, ".aws", "config");

	const credentialsIni = await readIniFile(credentialsPath);
	const configIni = await readIniFile(configPath);

	// Static credentials live in ~/.aws/credentials; SSO config lives in
	// ~/.aws/config under `[profile foo]`. Merge into a single view.
	const merged: Record<string, string> = { ...(configIni?.[profile] ?? {}), ...(credentialsIni?.[profile] ?? {}) };
	if (Object.keys(merged).length === 0) return undefined;

	if (merged.aws_access_key_id && merged.aws_secret_access_key) {
		const out: ResolvedCredentials = {
			accessKeyId: merged.aws_access_key_id,
			secretAccessKey: merged.aws_secret_access_key,
		};
		if (merged.aws_session_token) out.sessionToken = merged.aws_session_token;
		return out;
	}

	if (merged.sso_account_id && merged.sso_role_name) {
		return readSsoCredentials(merged, configIni, region, signal);
	}

	return undefined;
}

interface SsoCachedToken {
	accessToken?: string;
	expiresAt?: string;
	startUrl?: string;
	region?: string;
}

async function readSsoCredentials(
	profileCfg: Record<string, string>,
	configIni: IniFile | undefined,
	defaultRegion: string,
	signal: AbortSignal | undefined,
): Promise<ResolvedCredentials | undefined> {
	// Two SSO profile shapes:
	//   - legacy: `sso_start_url` + `sso_region` directly on the profile
	//   - sso-session: `sso_session = my-session` references a `[sso-session my-session]` block
	let startUrl = profileCfg.sso_start_url;
	let ssoRegion = profileCfg.sso_region;
	const sessionName = profileCfg.sso_session;
	if (sessionName && configIni) {
		const session = configIni[`sso-session:${sessionName}`];
		if (session) {
			startUrl = startUrl || session.sso_start_url;
			ssoRegion = ssoRegion || session.sso_region;
		}
	}
	if (!startUrl || !ssoRegion) return undefined;

	const token = await loadSsoCachedToken(startUrl, sessionName);
	if (!token?.accessToken) {
		throw new Error(`AWS SSO token for ${startUrl} not found in ~/.aws/sso/cache. Run 'aws sso login' first.`);
	}
	const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : Number.POSITIVE_INFINITY;
	if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
		throw new Error(`AWS SSO token for ${startUrl} has expired. Run 'aws sso login' to refresh.`);
	}

	const url =
		`https://portal.sso.${ssoRegion}.amazonaws.com/federation/credentials` +
		`?account_id=${encodeURIComponent(profileCfg.sso_account_id)}` +
		`&role_name=${encodeURIComponent(profileCfg.sso_role_name)}`;
	const response = await fetch(url, {
		method: "GET",
		headers: { "x-amz-sso_bearer_token": token.accessToken },
		signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`AWS SSO GetRoleCredentials failed: ${response.status} ${body.slice(0, 200)}`);
	}
	const json = (await response.json()) as {
		roleCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number };
	};
	const role = json.roleCredentials;
	if (!role) throw new Error("AWS SSO GetRoleCredentials: missing roleCredentials in response");

	// region is honored at the caller; we only consume defaultRegion to keep the
	// param wired for symmetry with other resolution paths.
	void defaultRegion;

	return {
		accessKeyId: role.accessKeyId,
		secretAccessKey: role.secretAccessKey,
		sessionToken: role.sessionToken,
		expiresAt: role.expiration,
	};
}

async function loadSsoCachedToken(
	startUrl: string,
	sessionName: string | undefined,
): Promise<SsoCachedToken | undefined> {
	const cacheDir = path.join(os.homedir(), ".aws", "sso", "cache");
	let entries: string[];
	try {
		entries = await fs.promises.readdir(cacheDir);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	// Prefer the deterministic hash for legacy `sso_start_url` profiles or the
	// session name for the newer `sso-session` shape; otherwise scan.
	const candidates: string[] = [];
	const hash = await sha1Hex(sessionName || startUrl);
	candidates.push(`${hash}.json`);
	for (const entry of entries) {
		if (entry.endsWith(".json") && !candidates.includes(entry)) candidates.push(entry);
	}
	for (const file of candidates) {
		if (!entries.includes(file)) continue;
		try {
			const text = await fs.promises.readFile(path.join(cacheDir, file), "utf8");
			const parsed = JSON.parse(text) as SsoCachedToken;
			if (parsed.startUrl === startUrl || (sessionName && file === `${hash}.json`)) {
				return parsed;
			}
		} catch (err) {
			logger.debug("aws-credentials: failed to read SSO cache", { file, err: String(err) });
		}
	}
	return undefined;
}

async function sha1Hex(input: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
	const bytes = new Uint8Array(digest);
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}

// ---------- IMDSv2 ----------

const IMDS_HOST = "169.254.169.254";
const IMDS_TIMEOUT_MS = 1000;

async function readImdsCredentials(parentSignal: AbortSignal | undefined): Promise<ResolvedCredentials | undefined> {
	const timeout = AbortSignal.timeout(IMDS_TIMEOUT_MS);
	const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
	try {
		const tokenRes = await fetch(`http://${IMDS_HOST}/latest/api/token`, {
			method: "PUT",
			headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
			signal,
		});
		if (!tokenRes.ok) return undefined;
		const token = await tokenRes.text();

		const roleRes = await fetch(`http://${IMDS_HOST}/latest/meta-data/iam/security-credentials/`, {
			headers: { "x-aws-ec2-metadata-token": token },
			signal,
		});
		if (!roleRes.ok) return undefined;
		const role = (await roleRes.text()).trim();
		if (!role) return undefined;

		const credsRes = await fetch(
			`http://${IMDS_HOST}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
			{
				headers: { "x-aws-ec2-metadata-token": token },
				signal,
			},
		);
		if (!credsRes.ok) return undefined;
		const body = (await credsRes.json()) as {
			AccessKeyId?: string;
			SecretAccessKey?: string;
			Token?: string;
			Expiration?: string;
		};
		if (!body.AccessKeyId || !body.SecretAccessKey) return undefined;
		const out: ResolvedCredentials = {
			accessKeyId: body.AccessKeyId,
			secretAccessKey: body.SecretAccessKey,
		};
		if (body.Token) out.sessionToken = body.Token;
		if (body.Expiration) out.expiresAt = Date.parse(body.Expiration);
		return out;
	} catch {
		return undefined;
	}
}

/** Test/diagnostic helper — drops cached credentials. */
export function clearAwsCredentialCache(): void {
	cache.clear();
}
