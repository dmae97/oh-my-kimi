/**
 * First-party Level-1/Level-2 transport for the provider doctor.
 *
 * Safety properties:
 * - GET, plus bounded JSON POST for the opt-in Level-2 model probe; redirects are
 *   never followed (the raw 3xx status is returned).
 * - POST bodies are capped, must be JSON, and are never echoed anywhere.
 * - The response is dropped as soon as the status line arrives: no body, headers,
 *   or error details ever leave this module, and thrown errors use fixed messages.
 * - Loopback-only policies require every resolved address to be loopback.
 * - Public policies validate every resolved address against the doctor blocklist and
 *   pin the socket to one validated address; the hostname is never re-resolved
 *   (DNS-rebinding safe) and TLS identity is still checked against the original hostname.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import {
	isBlockedPublicAddress,
	isLoopbackAddress,
	normalizedUrlHostname,
	ProviderDoctorAuthMaterializationError,
	type ProviderDoctorTransport,
	type ProviderDoctorTransportRequest,
	type ProviderDoctorTransportResponse,
} from "./doctor-provider.ts";

/** Resolves a hostname to every address it maps to. */
export type ProviderDoctorLookup = (hostname: string) => Promise<readonly string[]>;

/** The validated connection target handed to the test-only socket seam. */
export interface ProviderDoctorPinnedConnection {
	address: string;
	port: number;
	hostname: string;
}

export interface ProviderDoctorTransportOptions {
	/** DNS resolver returning every address for a hostname. Defaults to node:dns lookup({ all: true }). */
	lookup?: ProviderDoctorLookup;
	/**
	 * Test-only seam (plain http) that builds the socket for a validated, pinned address.
	 * Production requests always dial the pinned address directly.
	 */
	createConnection?: (pinned: ProviderDoctorPinnedConnection) => Socket;
}

const SCHEME_UNSUPPORTED = "provider doctor transport rejected an unsupported URL scheme";
const METHOD_UNSUPPORTED = "provider doctor transport only performs GET and bounded POST requests";
const REQUEST_SHAPE_INVALID = "provider doctor transport rejected an invalid request shape";
const MAX_POST_BODY_BYTES = 4_096;
const RESOLUTION_FAILED = "provider doctor transport could not resolve the endpoint hostname";
const RESOLUTION_BLOCKED = "provider doctor transport blocked hostname re-resolution";
const ADDRESS_BLOCKED = "provider doctor transport blocked a resolved address by policy";
const REQUEST_FAILED = "provider doctor transport request failed";
const REQUEST_ABORTED = "provider doctor transport request was aborted";
const STRIPPED_REQUEST_HEADERS = new Set([
	"connection",
	"content-length",
	"expect",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const SINGLE_VALUE_CREDENTIAL_HEADERS = new Set(["authorization", "cf-aig-authorization"]);
const ADDITIONAL_AUTHORIZATION_VALUE = /,\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s+/;

const defaultLookup: ProviderDoctorLookup = async (hostname) => {
	const results = await dnsLookup(hostname, { all: true, verbatim: true });
	return results.map((result) => result.address);
};

async function resolveAddresses(hostname: string, lookup: ProviderDoctorLookup): Promise<readonly string[]> {
	if (isIP(hostname) !== 0) return [hostname];
	let addresses: readonly string[];
	try {
		addresses = await lookup(hostname);
	} catch {
		throw new Error(RESOLUTION_FAILED);
	}
	if (addresses.length === 0) throw new Error(RESOLUTION_FAILED);
	return addresses;
}

function assertRequestActive(signal: AbortSignal): void {
	if (signal.aborted) throw new Error(REQUEST_ABORTED);
}

function assertAddressesAllowed(
	addresses: readonly string[],
	policy: ProviderDoctorTransportRequest["addressPolicy"],
): void {
	for (const address of addresses) {
		const allowed = policy.kind === "loopback-only" ? isLoopbackAddress(address) : !isBlockedPublicAddress(address);
		if (!allowed) throw new Error(ADDRESS_BLOCKED);
	}
}

export function createProviderDoctorTransport(options: ProviderDoctorTransportOptions = {}): ProviderDoctorTransport {
	const lookup = options.lookup ?? defaultLookup;

	return {
		pinsResolvedAddress: true,
		async request(request: ProviderDoctorTransportRequest): Promise<ProviderDoctorTransportResponse> {
			assertRequestActive(request.signal);
			const isPost = request.method === "POST";
			if (request.method !== "GET" && !isPost) throw new Error(METHOD_UNSUPPORTED);
			if (!isPost && request.body !== undefined) throw new Error(REQUEST_SHAPE_INVALID);
			if (isPost) {
				if (typeof request.body !== "string" || request.contentType !== "application/json") {
					throw new Error(REQUEST_SHAPE_INVALID);
				}
				if (Buffer.byteLength(request.body, "utf-8") > MAX_POST_BODY_BYTES) {
					throw new Error(REQUEST_SHAPE_INVALID);
				}
			}
			const url = request.url;
			const isHttps = url.protocol === "https:";
			if (!isHttps && url.protocol !== "http:") throw new Error(SCHEME_UNSUPPORTED);

			const hostname = normalizedUrlHostname(url);
			const addresses = await resolveAddresses(hostname, lookup);
			assertAddressesAllowed(addresses, request.addressPolicy);
			assertRequestActive(request.signal);
			const pinned = addresses[0];
			const port = url.port.length > 0 ? Number(url.port) : isHttps ? 443 : 80;

			let materializedHeaders: Headers;
			try {
				materializedHeaders = await request.createHeaders();
			} catch {
				throw new ProviderDoctorAuthMaterializationError();
			}
			assertRequestActive(request.signal);
			const headers: Record<string, string> = {};
			for (const [name, value] of materializedHeaders) {
				const normalizedName = name.toLowerCase();
				if (STRIPPED_REQUEST_HEADERS.has(normalizedName)) continue;
				if (SINGLE_VALUE_CREDENTIAL_HEADERS.has(normalizedName) && ADDITIONAL_AUTHORIZATION_VALUE.test(value)) {
					throw new ProviderDoctorAuthMaterializationError();
				}
				headers[normalizedName] = value;
			}
			headers.host = url.host;
			if (isPost) {
				headers["content-type"] = "application/json";
				headers["content-length"] = String(Buffer.byteLength(request.body as string, "utf-8"));
			}

			const base: RequestOptions = {
				method: request.method,
				path: `${url.pathname}${url.search}`,
				headers,
				signal: request.signal,
				setHost: false,
			};
			const seam = options.createConnection;
			const requestOptions: RequestOptions = seam
				? { ...base, createConnection: () => seam({ address: pinned, port, hostname }) }
				: {
						...base,
						host: pinned,
						port,
						agent: false,
						// Fail closed if anything below ever tries to resolve a name again.
						lookup: (_hostname, lookupOptions, callback) => {
							const done = typeof lookupOptions === "function" ? lookupOptions : callback;
							(done as (error: Error) => void)(new Error(RESOLUTION_BLOCKED));
						},
						...(isHttps
							? {
									servername: isIP(hostname) === 0 ? hostname : "",
									checkServerIdentity: (
										_host: string,
										certificate: Parameters<typeof checkServerIdentity>[1],
									) => checkServerIdentity(hostname, certificate),
								}
							: {}),
					};

			assertRequestActive(request.signal);
			return new Promise<ProviderDoctorTransportResponse>((resolve, reject) => {
				let settled = false;
				const settle = (action: () => void): void => {
					if (settled) return;
					settled = true;
					action();
				};
				if (request.signal.aborted) {
					settle(() => reject(new Error(REQUEST_ABORTED)));
					return;
				}
				const clientRequest = (isHttps ? httpsRequest : httpRequest)(requestOptions, (response) => {
					const status = response.statusCode ?? 0;
					// Drop the response immediately: the doctor only needs the status,
					// so no body is ever read or buffered (bounded by construction).
					response.destroy();
					settle(() => resolve({ status }));
				});
				clientRequest.on("error", () => settle(() => reject(new Error(REQUEST_FAILED))));
				if (request.signal.aborted) {
					clientRequest.destroy();
					settle(() => reject(new Error(REQUEST_ABORTED)));
					return;
				}
				clientRequest.end(isPost ? (request.body as string) : undefined);
			});
		},
	};
}
