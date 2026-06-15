import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { AuthStorage } from "../session/auth-storage";
import {
	isManagedMCPOAuthCredentialId,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
	mcpOAuthCredentialProfile,
} from "./oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export interface MCPOAuthCredentialLookup {
	credentialId: string;
	credential: MCPStoredOAuthCredential;
}

export type MCPOAuthRefreshMaterial = MCPStoredOAuthCredential | MCPAuthConfig | undefined;

export function mcpOAuthCredentialIdsForServerUrl(serverUrl: string | undefined): string[] {
	if (!serverUrl) return [];
	const ids: string[] = [];
	for (const url of [expandEnvVarsDeep(serverUrl), serverUrl]) {
		const id = mcpOAuthCredentialId(url);
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

export function hasMcpAuthorizationHeader(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") return false;
	return Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === "authorization");
}

export function lookupMcpOAuthCredentialForServer(
	authStorage: AuthStorage | null | undefined,
	auth: MCPAuthConfig | undefined,
	serverUrl: string | undefined,
	options: { allowUrlKeyedFallback?: boolean } = {},
): MCPOAuthCredentialLookup | undefined {
	if (!authStorage) return undefined;
	if (auth && auth.type !== "oauth") return undefined;
	const urlKeyedCredentialIds = mcpOAuthCredentialIdsForServerUrl(serverUrl);
	if (
		auth?.credentialId &&
		(!auth.credentialId.startsWith("mcp_oauth:profile:") || urlKeyedCredentialIds.includes(auth.credentialId))
	) {
		const credential = authStorage.get(auth.credentialId);
		if (credential?.type === "oauth") {
			return { credentialId: auth.credentialId, credential };
		}
	}
	if (options.allowUrlKeyedFallback === false) return undefined;
	for (const credentialId of urlKeyedCredentialIds) {
		const credential = authStorage.get(credentialId);
		if (credential?.type === "oauth") {
			return { credentialId, credential };
		}
	}
	return undefined;
}

export function lookupMcpOAuthCredential(
	authStorage: AuthStorage | null | undefined,
	config: MCPServerConfig,
): MCPOAuthCredentialLookup | undefined {
	const auth = config.auth;
	if (config.type !== "http" && config.type !== "sse") {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, undefined);
	}
	if (hasMcpAuthorizationHeader(config)) {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url, { allowUrlKeyedFallback: false });
	}
	return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url);
}

export function selectMcpOAuthRefreshMaterial(
	credential: MCPStoredOAuthCredential,
	auth: MCPAuthConfig | undefined,
): MCPOAuthRefreshMaterial {
	return credential.tokenUrl ? credential : auth;
}

export async function removeManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: string | undefined,
): Promise<boolean> {
	if (!isManagedMCPOAuthCredentialId(credentialId)) return false;
	const scopedProfile = mcpOAuthCredentialProfile(credentialId);
	if (scopedProfile !== undefined && scopedProfile !== (getActiveProfile() ?? "default")) return false;
	if (authStorage.get(credentialId)?.type !== "oauth") return false;
	await authStorage.remove(credentialId);
	return true;
}

export async function removeManagedMcpOAuthCredentials(
	authStorage: AuthStorage,
	credentialIds: readonly (string | undefined)[],
): Promise<boolean> {
	let removed = false;
	for (const credentialId of credentialIds) {
		removed = (await removeManagedMcpOAuthCredential(authStorage, credentialId)) || removed;
	}
	return removed;
}
