import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as capability from "@oh-my-pi/pi-coding-agent/capability";
import type { SSHHost } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { CapabilityResult } from "@oh-my-pi/pi-coding-agent/capability/types";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SshProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/ssh-protocol";

// Live integration against `ssh localhost`. Skips automatically where key-based
// localhost SSH is unavailable (CI without sshd). Capability lookup is mocked
// empty so "localhost"/"-oProxy…" resolve through the opaque-destination branch,
// exercising the real connection-manager + file-transfer over a real ssh process.
const SSH_OK = (() => {
	try {
		const r = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "localhost", "true"]);
		return r.exitCode === 0;
	} catch {
		return false;
	}
})();

function mockEmptyHosts(): void {
	const result: CapabilityResult<SSHHost> = {
		items: [],
		sources: [],
		diagnostics: [],
	} as unknown as CapabilityResult<SSHHost>;
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

const sh = async (script: string) => {
	await Bun.$`ssh -o BatchMode=yes localhost ${script}`.quiet();
};

describe.skipIf(!SSH_OK)("ssh:// handler against a real localhost ssh", () => {
	const handler = new SshProtocolHandler();
	const TMP = `/tmp/omp-ssh-e2e-${process.pid}`;

	beforeAll(async () => {
		await sh(`mkdir -p ${TMP}`);
	});

	afterAll(async () => {
		await Bun.$`ssh -o BatchMode=yes localhost rm -rf ${TMP}`.nothrow().quiet();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads a real remote text file byte-exact", async () => {
		mockEmptyHosts();
		await sh(`printf 'alpha\\n\\tbeta\\n' > ${TMP}/read.txt`);
		const res = await handler.resolve(parseInternalUrl(`ssh://localhost${TMP}/read.txt`));
		expect(res.content).toBe("alpha\n\tbeta\n");
	});

	it("rejects an argument-injecting host before spawning ssh (no side effect runs)", async () => {
		mockEmptyHosts();
		await sh(`rm -f ${TMP}/PWNED`);
		// `-oProxyCommand=touch …` would execute locally if it reached ssh's argv.
		const url = parseInternalUrl(`ssh://-oProxyCommand=touch%20${encodeURIComponent(`${TMP}/PWNED`)}/etc/hostname`);
		await expect(handler.resolve(url)).rejects.toThrow(/must not begin with/);
		const pwned = await Bun.$`ssh -o BatchMode=yes localhost test -e ${TMP}/PWNED && echo yes || echo no`.text();
		expect(pwned.trim()).toBe("no");
	});

	it("rejects a real binary file via full-buffer validation", async () => {
		mockEmptyHosts();
		// 9000 'a' bytes (valid past the old 8 KiB window) then one invalid UTF-8 byte.
		await sh(`sh -c 'head -c 9000 /dev/zero | tr "\\0" a > ${TMP}/bin; printf "\\377" >> ${TMP}/bin'`);
		await expect(handler.resolve(parseInternalUrl(`ssh://localhost${TMP}/bin`))).rejects.toThrow(
			/binary or non-UTF-8/,
		);
	});

	it("writes byte-exact, leaves no temp, and the read path round-trips", async () => {
		mockEmptyHosts();
		const dest = `${TMP}/write.txt`;
		await handler.write(parseInternalUrl(`ssh://localhost${dest}`), "hi\n\t!\n");
		const back = await handler.resolve(parseInternalUrl(`ssh://localhost${dest}`));
		expect(back.content).toBe("hi\n\t!\n");
		// The uniquely-named temp must have been renamed away (no leftovers).
		const leftovers = await Bun.$`ssh -o BatchMode=yes localhost ls ${TMP} | grep -c omp-tmp || true`.text();
		expect(leftovers.trim()).toBe("0");
	});

	it("replaces a symlinked destination with a regular file (documented v1 limit)", async () => {
		mockEmptyHosts();
		await sh(`sh -c 'printf orig > ${TMP}/sym-target; ln -sf ${TMP}/sym-target ${TMP}/sym-link'`);
		await handler.write(parseInternalUrl(`ssh://localhost${TMP}/sym-link`), "replaced\n");
		const isLink =
			await Bun.$`ssh -o BatchMode=yes localhost test -L ${TMP}/sym-link && echo link || echo regular`.text();
		expect(isLink.trim()).toBe("regular");
		const back = await handler.resolve(parseInternalUrl(`ssh://localhost${TMP}/sym-link`));
		expect(back.content).toBe("replaced\n");
	});
});
