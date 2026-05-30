export function sha256Hex16(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
}

export function generateId(content: string, now: Date = new Date()): string {
	return sha256Hex16(`${content}${now.toISOString()}`);
}

export function stableMemoryId(content: string, source = ""): string {
	return source ? sha256Hex16(`${content}\0${source}`) : sha256Hex16(content);
}
