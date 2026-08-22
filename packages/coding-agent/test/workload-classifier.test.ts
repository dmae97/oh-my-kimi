import { describe, expect, it } from "vitest";
import {
	classifyWorkloadCommand,
	scanShellComplexity,
	type WorkloadClassification,
} from "../src/core/workload-classifier.ts";

describe("classifyWorkloadCommand — §9.2 heavy command families", () => {
	const heavyCases: ReadonlyArray<readonly [string, WorkloadClassification["commandFamily"]]> = [
		["npm test", "node-test"],
		["npm run build", "node-build"],
		["pnpm test", "node-test"],
		["pnpm build", "node-build"],
		["yarn test", "node-test"],
		["bun test", "node-test"],
		["vitest", "node-test"],
		["jest", "node-test"],
		["tsc", "typescript"],
		["tsc -p tsconfig.json", "typescript"],
		["go test ./...", "go-test"],
		["go test ./pkg/a ./pkg/b", "go-test"],
		["cargo build", "rust-build"],
		["cargo test", "rust-build"],
		["docker build .", "container-build"],
		["podman build .", "container-build"],
		["nx run-many -t test", "monorepo"],
		["turbo run build", "monorepo"],
		["tar -czf out.tar.gz src", "archive"],
		["zip -r out.zip src", "archive"],
	];
	for (const [command, family] of heavyCases) {
		it(`classifies ${JSON.stringify(command)} as heavy/${family}`, () => {
			const result = classifyWorkloadCommand(command);
			expect(result.workloadClass).toBe("heavy");
			expect(result.commandFamily).toBe(family);
			expect(result.complexity).toBe("simple-argv");
		});
	}
});

describe("classifyWorkloadCommand — light/io/cpu tiers", () => {
	it("keeps read-only commands light so critical pressure never blocks them (§21)", () => {
		for (const command of ["ls -la", "cat file.txt", "rg pattern src", "git status", "git log --oneline", "pwd"]) {
			expect(classifyWorkloadCommand(command).workloadClass).toBe("light");
		}
	});

	it("classifies bounded file operations as io", () => {
		for (const command of ["cp a b", "mv a b", "rsync -a src dst", "tar -xzf in.tar.gz"]) {
			expect(classifyWorkloadCommand(command).workloadClass).toBe("io");
		}
	});

	it("classifies single-target checkers as cpu", () => {
		expect(classifyWorkloadCommand("tsc src/main.ts").workloadClass).toBe("cpu");
		expect(classifyWorkloadCommand("go test ./pkg/a").workloadClass).toBe("cpu");
		expect(classifyWorkloadCommand("eslint src/main.ts").workloadClass).toBe("cpu");
	});

	it("leaves unrecognized simple binaries as unknown/generic-process", () => {
		const result = classifyWorkloadCommand("./my-custom-binary --flag");
		expect(result.workloadClass).toBe("unknown");
		expect(result.commandFamily).toBe("generic-process");
		expect(result.complexity).toBe("simple-argv");
	});
});

describe("classifyWorkloadCommand — wrappers and env prefixes", () => {
	it("classifies through env prefixes and runner wrappers", () => {
		expect(classifyWorkloadCommand("CI=1 npm test").commandFamily).toBe("node-test");
		expect(classifyWorkloadCommand("NODE_ENV=test FOO=bar vitest").commandFamily).toBe("node-test");
		expect(classifyWorkloadCommand("npx vitest").commandFamily).toBe("node-test");
		expect(classifyWorkloadCommand("bunx jest").commandFamily).toBe("node-test");
		expect(classifyWorkloadCommand("pnpm exec vitest").commandFamily).toBe("node-test");
	});
});

describe("scanShellComplexity — §9.3 tokens", () => {
	const complexCases: ReadonlyArray<readonly [string, string]> = [
		["cat a | grep b", "shell.operator.pipe"],
		["echo a|b", "shell.operator.pipe"],
		["echo hi > out.txt", "shell.operator.redirect"],
		["echo a>b", "shell.operator.redirect"],
		["echo hi >> out.txt", "shell.operator.redirect"],
		["cat < in.txt", "shell.operator.redirect"],
		["foo 2>&1", "shell.operator.redirect"],
		["a && b", "shell.operator.list"],
		["a || b", "shell.operator.list"],
		["a; b", "shell.operator.list"],
		["npm test &", "shell.operator.background"],
		["echo $(date)", "shell.operator.substitution"],
		["echo `date`", "shell.operator.substitution"],
		['echo "$(date)"', "shell.operator.substitution"],
		["echo 'unterminated", "shell.unbalanced-quote"],
		["a\nb", "shell.multiline"],
	];
	for (const [command, reason] of complexCases) {
		it(`flags ${JSON.stringify(command)} with ${reason}`, () => {
			const scan = scanShellComplexity(command);
			expect(scan.reasons).toContain(reason);
			const classified = classifyWorkloadCommand(command);
			expect(classified.complexity).toBe("complex-shell");
			expect(classified.workloadClass).toBe("unknown");
		});
	}

	it("treats quoted operators as literals (§9.3 no regex split)", () => {
		for (const command of [
			'echo "a|b"',
			"echo 'a && b'",
			'grep "x > y" file.txt',
			"echo 'a;b'",
			"echo 'x<y'",
			"echo '`not a substitution`'",
			"printf 'a\\nb'",
			"echo \\| pipe-escaped",
		]) {
			expect(scanShellComplexity(command).reasons).toEqual([]);
			expect(classifyWorkloadCommand(command).complexity).toBe("simple-argv");
		}
	});
});

describe("classifyWorkloadCommand — safeToAutoShard (§12)", () => {
	it("marks only known sharders in clean simple-argv form (§12.2)", () => {
		expect(classifyWorkloadCommand("vitest").safeToAutoShard).toBe(true);
		expect(classifyWorkloadCommand("npx vitest run").safeToAutoShard).toBe(true);
		expect(classifyWorkloadCommand("jest").safeToAutoShard).toBe(true);
		expect(classifyWorkloadCommand("go test ./...").safeToAutoShard).toBe(true);
	});

	it("refuses conflicting flags and opaque wrappers (§12.2 conditions)", () => {
		expect(classifyWorkloadCommand("vitest --shard=1/4").safeToAutoShard).toBe(false);
		expect(classifyWorkloadCommand("jest --runInBand").safeToAutoShard).toBe(false);
		expect(classifyWorkloadCommand("vitest --coverage").safeToAutoShard).toBe(false);
		expect(classifyWorkloadCommand("vitest --watch").safeToAutoShard).toBe(false);
		expect(classifyWorkloadCommand("jest -u").safeToAutoShard).toBe(false);
		expect(classifyWorkloadCommand("npm test").safeToAutoShard).toBe(false);
		expect(classifyWorkloadCommand("go test ./... -run TestX").safeToAutoShard).toBe(false);
		expect(classifyWorkloadCommand("cargo test").safeToAutoShard).toBe(false);
	});

	it("property 15 (§23.2, seed 0x0fc52026): complex shell is never auto-shardable", () => {
		const random = mulberry32(0x0fc52026);
		const bases = ["vitest", "jest", "npm test", "go test ./...", "ls", "cargo build"];
		const operators = ["|", "&&", ";", ">", "<", "$(x)", "`x`", "&"];
		for (let i = 0; i < 200; i++) {
			const base = bases[Math.floor(random() * bases.length)];
			const operator = operators[Math.floor(random() * operators.length)];
			const complexCommand = `${base} ${operator} tail`;
			const complexResult = classifyWorkloadCommand(complexCommand);
			expect(complexResult.complexity).toBe("complex-shell");
			expect(complexResult.safeToAutoShard).toBe(false);

			// The same operator inside single quotes keeps the base classification.
			const quoted = `${base} '${operator}'`;
			expect(classifyWorkloadCommand(quoted).complexity).toBe("simple-argv");
		}
	});

	it("never throws on arbitrary byte soup (seeded fuzz)", () => {
		const random = mulberry32(0x0fc52026);
		const alphabet = "abc |&;<>$()`'\"\\\n\t-=/.~*?[]{}!#%^";
		for (let i = 0; i < 300; i++) {
			const length = Math.floor(random() * 40);
			let command = "";
			for (let j = 0; j < length; j++) {
				command += alphabet[Math.floor(random() * alphabet.length)];
			}
			const result = classifyWorkloadCommand(command);
			expect(["simple-argv", "complex-shell"]).toContain(result.complexity);
			if (result.complexity === "complex-shell") {
				expect(result.safeToAutoShard).toBe(false);
			}
		}
	});
});

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
