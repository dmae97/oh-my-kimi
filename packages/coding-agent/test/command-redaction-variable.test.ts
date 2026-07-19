import { describe, expect, it } from "vitest";
import {
	CommandRedactionError,
	EVIDENCE_COMMAND_REDACTION_POLICY_ID,
	redactCommandDescriptor,
} from "../src/guardrails/command-redaction.ts";
import type { EvidenceCommandDescriptor } from "../src/types/evidence.ts";

function shell(script: string): EvidenceCommandDescriptor {
	return { kind: "shell", shell: "/bin/sh", script };
}

describe("shell variable credential provenance", () => {
	it("accepts one variable only as the complete value of a static credential field", () => {
		// Given: static credential fields whose entire values are placeholders.
		const placeholders = [
			shell("deploy --token $TOKEN"),
			shell("deploy --token=[REDACTED]"),
			shell(`curl -H "Authorization: Bearer \${TOKEN}" https://example.test`),
			shell("API_TOKEN=$API_TOKEN deploy"),
			shell(`curl "https://example.test?api_key=\${TOKEN}"`),
		];

		// When/Then: redaction preserves each already-safe placeholder without metadata inflation.
		for (const command of placeholders) {
			expect(redactCommandDescriptor(command)).toEqual({
				command,
				summary: { policyId: EVIDENCE_COMMAND_REDACTION_POLICY_ID, placeholders: [] },
			});
		}
	});

	it("fails closed when a variable can determine a field, option, header, or query name", () => {
		// Given: variables outside a complete statically classified credential value.
		const scripts = [
			`env API_\${FIELD}=CANARY`,
			"deploy $OPTION CANARY",
			"deploy --region $REGION",
			`deploy --\${OPTION}=CANARY`,
			`curl -H "X-\${HEADER}: CANARY" https://example.test`,
			`curl "https://example.test?\${QUERY}=CANARY"`,
			`deploy --token \${TOKEN}suffix`,
			"deploy --token=prefix$TOKEN",
			"API_TOKEN=$TOKEN/suffix deploy",
			"deploy --token={one,two}",
			"deploy --token='$TOKEN'\"suffix\"",
		];

		// When/Then: no ambiguous expansion is persisted or tokenized as a credential placeholder.
		for (const script of scripts) {
			expect(() => redactCommandDescriptor(shell(script))).toThrow(CommandRedactionError);
		}
	});

	it("fails closed on every active glob in a shell name position", () => {
		// Given: prefix, infix, vendor, env, header, and query names unrelated to the secret canary vocabulary.
		const scripts = [
			"deploy --*region CANARY",
			"deploy --reg?on CANARY",
			"deploy --x-acme-[r]egion CANARY",
			"*_REGION=CANARY deploy",
			"ACME_*_REGION=CANARY deploy",
			"AC?ME_REGION=CANARY deploy",
			"ACME_[R]EGION=CANARY deploy",
			"curl -H *-Request-Id:CANARY https://example.test",
			"curl --header=X-Acme-*-Trace:CANARY https://example.test",
			"curl -H X-Acme-Tr?ce:CANARY https://example.test",
			"curl -H X-Acme-[T]race:CANARY https://example.test",
			"curl https://example.test?*=CANARY",
			"curl https://example.test?reg?on=CANARY",
			"curl https://example.test?x-acme-[r]egion=CANARY",
			"deploy --reg[=]ion CANARY",
			"env ACME_[=]REGION=CANARY deploy",
			"env _?REGION=CANARY deploy",
			"env ?REGION=CANARY deploy",
			"env -i ?REGION=CANARY deploy",
			"SAFE=1 env -i ?REGION=CANARY deploy",
			"SAFE=1 env -u UNUSED curl -H X-Acme-[T]race:CANARY https://example.test",
			"curl -H X-Acme-[=]Trace:CANARY https://example.test",
			"curl https://example.test?x-acme-[=]region=CANARY",
			"curl https://example.test?reg?on",
			"curl api?reg?on=CANARY",
			"curl /api?reg?on=CANARY",
			"curl //example.test?reg?on=CANARY",
			"SAFE=1 curl 'api?'reg?on=CANARY",
			"env -- curl --he[a]der=X-Test:CANARY https://example.test",
			"curl -o -- --he[a]der=X-Test:CANARY https://example.test",
			"curl -so -- --he[a]der=X-Test:CANARY https://example.test",
			"curl -- -o api?reg?on",
			"curl -sH X-Acme-[T]race:CANARY https://example.test",
			"/bin/sh -c 'curl --he[a]der=X-Test:CANARY https://example.test'",
			"/bin/sh -e -c 'curl -H X-Acme-[T]race:CANARY https://example.test'",
			"eval 'curl --he[a]der=X-Test:CANARY https://example.test'",
			"eval 'curl -H' 'X-Acme-[T]race:CANARY' https://example.test",
		];

		// When/Then: pathname expansion cannot synthesize any option or field name.
		for (const script of scripts) {
			expect(() => redactCommandDescriptor(shell(script))).toThrow(CommandRedactionError);
		}
	});

	it("preserves positional and value globs plus quoted or escaped name metacharacters", () => {
		// Given: active globs only in positional/value slots and inert metacharacters in name slots.
		const scripts = [
			"tar -cf output.tar dist/*.js",
			"cat ./--api-?ey",
			"cat ./api-[key",
			"deploy --include dist/*.js",
			"deploy --include=dist/*.js",
			"PATTERN=dist/*.js deploy",
			"curl -H X-Trace:logs/*.txt https://example.test",
			"curl https://example.test?region=build/*.tgz",
			"curl -HX-Trace:logs/*.txt https://example.test",
			"cat -- -report*.txt",
			"cat -- -Hreport*:2026",
			"cat report*:2026",
			"cat file?na*me.txt",
			"cat ?report[A].txt",
			"cat /tmp/report?part[A].txt",
			"curl --upload-file report?part[A].txt https://example.test",
			"curl -so report?part[A].txt https://example.test",
			"curl -oHreport-[2]026.txt https://example.test",
			"curl -H X-Trace:file?na*me https://example.test",
			"ls -H report-[2]026.txt",
			"cat report?na*me=VALUE",
			"ls report[=]*=2026",
			"printf '%s' sh -c 'curl -H X-Acme-[T]race:CANARY https://example.test'",
			"/bin/sh -c 'cat *.txt'",
			"eval 'cat *.txt'",
			"deploy '--reg?on' CANARY",
			"deploy --reg\\?on CANARY",
			'ACME_"*"_REGION=CANARY deploy',
			"curl -H 'X-Acme-*-Trace:CANARY' https://example.test",
			"curl 'https://example.test?reg?on=CANARY'",
		];

		// When/Then: redaction preserves the static command verbatim.
		for (const script of scripts) {
			expect(redactCommandDescriptor(shell(script)).command).toEqual(shell(script));
		}
	});
});
