/**
 * Reasoning-router v4 — the sole `/think auto` classifier/resolver.
 *
 * Deterministic by construction: same (input, weights) -> same
 * ClassifierVerdictV4; same (verdict, availableLevels, laneType, bias, hint) ->
 * same ThinkingLevel. No clock, randomness, I/O, model calls, network access,
 * or state mutation anywhere in this file (ThinkingLevel is a type-only import
 * and is erased).
 *
 * `classifyTaskV4` returns a confidence-bearing verdict: task class, per-class
 * scores, runner-up, margin, confidence band, tie-break flag, fallback reason,
 * bounded-negation audit ids, and compound-intent metadata. None of this carries
 * prompt text — every field is a bounded enum, number, boolean, or a closed set
 * of short diagnostic-id strings.
 *
 * `resolveThinkingLevelV4WithUncertainty` starts from the canonical task-class
 * rule table, applies lane/bias/hint adjustments, and only adds non-negative
 * confidence escalation. A prompt cannot lower its own effort by asking the
 * router to "think less"; low confidence or fallback routing can only hold or
 * raise the resolved level.
 */

import type { ThinkingLevel } from "omk-agent-core";
import {
	DEFAULT_WEIGHTS_V4,
	type ReasoningLaneTypeV4,
	type RouterWeightsV4,
	TASK_CLASSES_V4,
	type TaskClassV4,
} from "./reasoning-router-v4-weights.ts";

export type { ReasoningLaneTypeV4, RouterWeightsV4, TaskClassV4 } from "./reasoning-router-v4-weights.ts";
export { DEFAULT_WEIGHTS_V4, TASK_CLASSES_V4 } from "./reasoning-router-v4-weights.ts";

import { resolveThinkingLevelCore, TASK_CLASS_THINKING_LEVELS } from "./reasoning-router-resolver.ts";
import { extractGeneralizedIntentEvidenceV4 } from "./reasoning-router-v4-normalize.ts";

/** Prompts shorter than this (trimmed) fall back to trivial when no real signal scores > 0. */
const TRIVIAL_MAX_CHARS_V4 = 40;
/** Prompts at/above this length with no real signal fall back to plan (long prose brief). */
const COMPLEX_PROSE_MIN_CHARS_V4 = 2400;
/** Plan-brief prompts at/above this length count as a "long brief" even without PLAN_BRIEF_PATTERN. */
const LONG_BRIEF_MIN_CHARS_V4 = 512;
/** Compound-clause split only applies within this many leading characters (short direct commands, not long prose). */
const COMPOUND_SPLIT_MAX_INDEX_V4 = 300;
/** Minimum trimmed length of a candidate second clause to be worth checking for a leading intent. */
const COMPOUND_SECOND_CLAUSE_MIN_CHARS_V4 = 3;
/** Bounded look-ahead cap when checking a second clause's leading intent (defense in depth; independent of regex cost). */
const COMPOUND_SECOND_CLAUSE_SCAN_CHARS_V4 = 200;

/** Lane fallback class, used only when every scored class is <= 0 (zero-score cascade). */
const LANE_FALLBACK_CLASS_V4: Readonly<Record<ReasoningLaneTypeV4, TaskClassV4>> = {
	planner: "plan",
	security: "review",
	explorer: "review",
	coder: "code-gen",
	reviewer: "review",
	tester: "code-gen",
};

type IntentLexemeClusterRoleV4 = "leading-intent" | "whole-prompt" | "object-shape" | "korean-morphology";

type IntentLexemeClusterV4 = {
	readonly id: string;
	readonly taskClass: TaskClassV4;
	readonly role: IntentLexemeClusterRoleV4;
	readonly surfaces: readonly string[];
	readonly phrases: readonly RegExp[];
	readonly negativeControlIds: readonly string[];
};

const INTENT_LEXEME_CLUSTERS_V4: readonly IntentLexemeClusterV4[] = [
	{
		id: "debug-leading-actions",
		taskClass: "debug",
		role: "leading-intent",
		surfaces: ["debug", "investigate why", "reproduce", "trace", "fix this traceback/panic/error"],
		phrases: [/^(?:debug|investigate\s+why|reproduce|trace\b)|^fix\s+this\s+(?:traceback|panic|error)\b/i],
		negativeControlIds: ["negated-debug-action", "generic-error-handling"],
	},
	{
		id: "review-leading-actions",
		taskClass: "review",
		role: "leading-intent",
		surfaces: ["review", "audit", "critique", "inspect", "assess", "approve", "double-check", "lgtm"],
		phrases: [/^(?:review|audit(?!\s+log\b)|critique|inspect|assess|approve|double-?check|lgtm)\b/i],
		negativeControlIds: ["audit-log-not-review", "review-negated-before-code-gen"],
	},
	{
		id: "review-leading-synonyms",
		taskClass: "review",
		role: "leading-intent",
		surfaces: [
			"give this PR a once-over",
			"look over",
			"sanity-check",
			"eyeball",
			"poke holes",
			"pressure-test",
			"tell me whether/if",
			"what could go wrong",
		],
		phrases: [
			/^(?:give\s+(?:this|the|my)?\s*(?:pr|pull\s+request|diff|code|change|branch)?\s*(?:a\s+)?once-?over|look\s+over|sanity[-\s]?check|eyeball|poke\s+holes(?:\s+in)?|pressure[-\s]?test|sign\s+off|tell\s+me\s+(?:if|whether)|tell\s+me\s+what\s+could\s+go\s+wrong|where\s+would\b[^.!?;\n]{0,100}\bfall\s+apart|what\s+am\s+i\s+missing|check\s+whether|look\s+for\s+(?:edge\s+cases|risks?|flaws?)|find\s+(?:flaws|risks?|issues?)|validate\s+(?:the\s+)?reasoning|give\s+me\s+a\s+thumbs[-\s]?up\/?down|read\s+(?:this|the|my)\b[^.!?;\n]{0,80}\bchallenge|(?:is|are|does|do|can|could|would|should)\s+(?:this|these|my|the)\b[^.!?;\n]{0,100}\b(?:right\s+way|handle|cover|safe|sane|clean|overkill|prove|leak|ship|concurrent|hidden\s+coupling)|(?:at\s+architecture\s+level|architecture[-\s]?level)\b[^.!?;\n]{0,80}\bhidden\s+coupling)\b/i,
		],
		negativeControlIds: ["sanity-check-setup-script", "future-self-review-context", "check-whether-implementation"],
	},
	{
		id: "plan-leading-actions",
		taskClass: "plan",
		role: "leading-intent",
		surfaces: ["plan", "design", "architect", "decompose", "map out", "draw up", "think through"],
		phrases: [
			/^(?:let(?:'|’)s\s+)?(?:plan|design|architect|decompose|map\s+out|draw\s+up|think\s+through)\b/i,
			/^(?:write|create)\s+(?:a\s+)?(?:technical\s+)?(?:spec|roadmap|strategy|plan)\b/i,
		],
		negativeControlIds: ["design-token-edit", "draw-up-implementation-only"],
	},
	{
		id: "refactor-leading-actions",
		taskClass: "refactor",
		role: "leading-intent",
		surfaces: ["refactor", "extract", "rename", "deduplicate", "simplify", "clean up", "untangle"],
		phrases: [
			/^(?:refactor(?:ing|ed)?|extract|rename|deduplicate|consolidate|modularize|reorganize|simplify|restructure|untangle)\b|^clean\s+up\b|^split\s+(?:the\s+)?module\b|^move\s+logic\b/i,
		],
		negativeControlIds: ["negated-refactor", "future-self-refactor"],
	},
	{
		id: "simple-edit-leading-actions",
		taskClass: "simple-edit",
		role: "leading-intent",
		surfaces: ["correct", "update", "swap", "remove", "adjust", "fix", "add", "change", "trim", "reword"],
		phrases: [/^(?:correct|update|swap|remove|adjust|fix|add|change|trim|reword|tweak|bump)\b/i],
		negativeControlIds: ["add-feature-not-simple-edit", "fix-crash-not-simple-edit"],
	},
	{
		id: "code-gen-leading-actions",
		taskClass: "code-gen",
		role: "leading-intent",
		surfaces: [
			"implement",
			"write",
			"create",
			"build",
			"generate",
			"scaffold",
			"prototype",
			"add",
			"whip up",
			"cook me",
		],
		phrases: [/^(?:implement|write|create|build|generate|scaffold|prototype|add|whip\s+up|cook\s+me)\b/i],
		negativeControlIds: ["write-a-plan", "create-a-review"],
	},
	{
		id: "debug-whole-prompt",
		taskClass: "debug",
		role: "whole-prompt",
		surfaces: ["debug", "investigate why", "reproduce", "track down", "figure out why", "get to the bottom"],
		phrases: [
			/^(?:debug|investigate\s+why|reproduce|trace\b)|\bfix\s+this\s+(?:traceback|panic|error)\b|\btrack\s+down\b|\bfigure\s+out\s+why\b|\bget\s+to\s+the\s+bottom\b|디버깅|디버그|재현|원인\s*분석/i,
		],
		negativeControlIds: ["not-a-bug-report", "error-handling-feature"],
	},
	{
		id: "review-whole-prompt",
		taskClass: "review",
		role: "whole-prompt",
		surfaces: [
			"review",
			"critique",
			"assess",
			"inspect",
			"once-over",
			"look over",
			"sanity-check",
			"eyeball",
			"poke holes",
			"pressure-test",
			"tell me whether correct",
		],
		phrases: [
			/\b(review|critique|assess|inspect|approve|lgtm|double-?check|sanity[-\s]?check|once-?over|look\s+over|eyeball|poke\s+holes|pressure[-\s]?test|sign\s+off|thumbs[-\s]?up\/?down|what\s+could\s+go\s+wrong|what\s+am\s+i\s+missing|challenge\s+the\s+assumptions|hidden\s+coupling|tell\s+me\s+(?:if|whether)[^.!?;\n]{0,80}\bcorrect|audit(?!\s+log\b))\b|리뷰|검토|점검|괜찮은지\s*봐\s*줘|맞는지\s*봐\s*줘|처리되는지\s*확인|허점.{0,10}찾|문제\s*없는지/i,
		],
		negativeControlIds: ["review-free-implementation", "audit-log"],
	},
	{
		id: "plan-whole-prompt",
		taskClass: "plan",
		role: "whole-prompt",
		surfaces: ["plan", "design", "architecture", "roadmap", "map out", "draw up", "think through"],
		phrases: [
			/\b(plan|design|architect|architecture|roadmap|spec(?:ification)?|strategy|decompose|milestones?|map\s+out|phases|draw\s+up|think\s+through|write\s+a\s+(?:technical\s+)?spec|create\s+a\s+(?:roadmap|strategy|plan))\b|설계|로드맵|아키텍처|계획.{0,6}세워|기획/i,
		],
		negativeControlIds: ["rather-than-design", "design-token-edit"],
	},
	{
		id: "code-gen-whole-prompt",
		taskClass: "code-gen",
		role: "whole-prompt",
		surfaces: ["implement", "write", "create", "build", "generate", "scaffold", "prototype", "whip up", "cook me"],
		phrases: [
			/\b(implement|write|create|build|generate|scaffold|prototype|whip\s+up|cook\s+me)\b|구현|만들어\s*줘|생성|작성|추가해/i,
		],
		negativeControlIds: ["write-plan", "create-roadmap"],
	},
	{
		id: "code-gen-artifact-request",
		taskClass: "code-gen",
		role: "object-shape",
		surfaces: ["I need a script", "we need a utility", "I need an endpoint", "we need a test"],
		phrases: [
			/\b(?:i|we)\s+need\s+(?:a|an|the|some)?\s*(?:small\s+|quick\s+|new\s+)?(?:script|utility|helper|component|endpoint|migration|test|tool|function|service)\b(?!\s+(?:plan|strategy|review|audit|roadmap|spec))/i,
		],
		negativeControlIds: ["need-a-plan", "need-a-review", "need-help-debugging"],
	},
	{
		id: "evaluative-review-object",
		taskClass: "review",
		role: "object-shape",
		surfaces: ["holes", "looks off", "correct", "safe", "risky", "issues", "regressions"],
		phrases: [/\b(holes?|looks?\s+off|correct|safe|risky|issues?|regressions?)\b/i],
		negativeControlIds: ["fix-holes", "implement-issue-fix"],
	},
	{
		id: "korean-debug-morphology",
		taskClass: "debug",
		role: "korean-morphology",
		surfaces: [
			"오류",
			"에러",
			"실패",
			"원인 찾아줘",
			"원인 파악",
			"숫자가 이상해",
			"합계가 안 맞아",
			"빈 파일",
			"CI가 빨개",
			"디버깅",
		],
		phrases: [
			/오류|에러|실패|안\s*돼|안\s*됨|깨졌|깨짐|고장|디버깅|디버그|재현|원인\s*(?:분석|파악|찾(?:아|기)?|찾아\s*줘)?|숫자.{0,12}(?:이상|틀려|안\s*맞)|합계.{0,12}(?:안\s*맞|틀려|이상)|빈\s*파일|(?:CI|러너).{0,12}빨개/i,
		],
		negativeControlIds: ["korean-error-handling-feature", "korean-greeting"],
	},
	{
		id: "korean-simple-edit-morphology",
		taskClass: "simple-edit",
		role: "korean-morphology",
		surfaces: [
			"오타",
			"맞춤법",
			"띄어쓰기",
			"문구",
			"제목",
			"바꿔",
			"바꾸",
			"수정",
			"변경",
			"고쳐",
			"고치",
			"삭제",
			"제거",
			"옮겨",
			"옮기",
		],
		phrases: [
			// Typo/copy nouns plus modification verbs. Creation verbs live in
			// korean-code-gen-morphology; modifying an existing artifact is an edit,
			// not a generation. (016: moved from code-gen after hard-negative mining.)
			/오타|맞춤법|띄어쓰기|문구|제목|바꿔|바꾸|수정|변경|고쳐|고치|삭제|지워|지우|제거|옮겨|옮기|넣어/i,
		],
		negativeControlIds: ["korean-feature-edit"],
	},
	{
		id: "korean-review-morphology",
		taskClass: "review",
		role: "korean-morphology",
		surfaces: ["리뷰", "검토", "점검", "괜찮은지 봐줘", "맞는지 봐줘", "허점 찾아줘"],
		phrases: [/리뷰|검토|점검|괜찮은지\s*봐\s*줘|맞는지\s*봐\s*줘|처리되는지\s*확인|허점.{0,10}찾|문제\s*없는지/i],
		negativeControlIds: ["korean-review-negated"],
	},
	{
		id: "korean-plan-morphology",
		taskClass: "plan",
		role: "korean-morphology",
		surfaces: ["설계", "로드맵", "아키텍처", "계획 세워", "계획 짜", "계획 수립", "계획 정리"],
		phrases: [/설계|로드맵|아키텍처|계획.{0,8}(?:세워|짜|수립|정리)|기획/i],
		negativeControlIds: ["korean-plan-negated"],
	},
	{
		id: "korean-refactor-morphology",
		taskClass: "refactor",
		role: "korean-morphology",
		surfaces: ["리팩토링", "리팩터링", "구조 개선"],
		phrases: [/리팩토링|리팩터링|구조\s*개선/i],
		negativeControlIds: ["korean-refactor-negated"],
	},
	{
		id: "korean-code-gen-morphology",
		taskClass: "code-gen",
		role: "korean-morphology",
		surfaces: ["구현", "만들", "생성", "작성", "추가", "테스트"],
		phrases: [/구현|만들|생성|작성|추가|테스트/i],
		negativeControlIds: ["korean-greeting", "korean-codegen-negated"],
	},
] as const;

function clusterMatchesRoleV4(text: string, taskClass: TaskClassV4, role: IntentLexemeClusterRoleV4): boolean {
	return INTENT_LEXEME_CLUSTERS_V4.some(
		(cluster) =>
			cluster.taskClass === taskClass &&
			cluster.role === role &&
			cluster.phrases.some((pattern) => pattern.test(text)),
	);
}

// ============================================================================
// Whole-prompt / leading-clause patterns used by the v4 scorer.
// ============================================================================

const LOCAL_EDIT_OBJECT_PATTERN =
	/\b(spelling|grammar|capitalization|date\s+format|author\s+e-?mail|copyright\s+year|headline|title|tooltip|placeholder|punctuation|comma|period|semicolon|closing\s+html\s+tag|closing\s+tag|double\s+space|whitespace|indentation|table\s+alignment|typos?|one-?liner?|single\s+line|sentence|stray|trailing)\b|오타|맞춤법|띄어쓰기|문구|제목/i;
const LOCAL_EDIT_ACTION_OBJECT_PATTERN =
	/\b(update|change|swap|remove|correct|fix|add|adjust|trim)\s+(?:the\s+|a\s+|an\s+)?(?:missing\s+|stray\s+|author\s+|two\s+)?(?:e-?mail|comma|period|semicolon|tag|word|words|headline|title|copyright|spelling|grammar)\b/i;
const IMPLEMENTATION_OBJECT_PATTERN =
	/\b(error\s+handling|input\s+validation|validation|auth(?:entication)?|retry|endpoint|migration|component|function|utility|helper|module|service|database|schema|column|middleware|rate\s+limiter|cache|caching|oauth|jwt|webhook)\b|에러\s*처리|오류\s*처리|입력\s*검증|인증|재시도|엔드포인트|마이그레이션|컴포넌트|함수|유틸|헬퍼|모듈|서비스|데이터베이스|스키마|미들웨어|레이트\s*리미터|캐시|웹훅|기능/i;
const HARD_DIAGNOSTIC_PATTERN =
	/\b(stack\s*trace|traceback|panic|segfault|crash(?:es|ing|ed)?|throws?|fails?|failing|flaky|hangs?|timeout|500|EADDRINUSE|silently\s+(?:fails?|produces?|returns?|creates?)|(?:ci|build)\s+(?:is\s+)?red|runner\s+(?:goes|went|is)\s+red|comes?\s+out\s+wrong|totals?\s+(?:are\s+)?off|drift(?:ed|ing)?|mismatch(?:ed|es)?|mismatched|no\s+longer\s+matches|says\s+success\s+but|exits?\s+0\s+but|empty\s+file|opens?\s+blank|black\s+image|zero[-\s]?byte\s+files?|headers\s+only|rows?\s+are\s+missing|missing\s+rows|stale\s+(?:index|prices?|cache|results?)|search\s+index\s+(?:is\s+)?stale|duplicate\s+rows|NaN|never\s+(?:send|sends|appear|appears|land|lands|writes?|written|updates?)|works\s+locally\s+and\s+breaks|worked\s+yesterday|settings\s+revert|side\s+effect\s+never|stops?\s+updating|data\s+disappears)\b|\b(?:TypeError|ReferenceError|RangeError|Error):|크래시|스택\s*트레이스|세그폴트|먹통|멈춰|타임아웃|숫자.{0,12}(?:이상|틀려|안\s*맞)|합계.{0,12}(?:안\s*맞|틀려|이상)|빈\s*파일|(?:CI|러너).{0,12}빨개/i;
const BUG_OBJECT_PATTERN =
	/\b(null\s+pointer|null\s+deref|race(?:\s+condition)?|heap(?:\s+overflow)?|use-after-free|memory\s+leak|leaks?|deadlock|data\s+corruption|stale\s+data|off-by-one|encoding\s+bug|regression\s+(?:was\s+)?introduced|exceptions?|assertion\s+error|bugs?)\b|버그|예외|메모리\s*누수|데드락|무한\s*루프/i;
const NON_DIAGNOSTIC_DEBUG_CONTEXT_PATTERN = /\berror\s+(?:handling|messages?|budgets?)\b|에러\s*처리|오류\s*처리/i;
const GENERIC_DIAGNOSTIC_PATTERN = /\b(errors?|broken|wrong\s+results|rolls?\s+back|rollback)\b/i;
const PLAN_BRIEF_PATTERN =
	/\b(context\s+and\s+constraints|starting\s+state|target\s+state|cross-cutting|deliver:|deliverables?|roadmap|migration\s+wave|top\s+(?:ten\s+)?risks|component\s+diagram|data\s+model|architecture|go\/no-go|phased\s+(?:delivery|rollout)|bounded\s+contexts?|strangler\s+fig|event-driven|quarter-by-quarter|milestone)\b/i;
const OPERATIONAL_RUNBOOK_SIGNAL_PATTERNS: readonly { pattern: RegExp; critical: boolean }[] = [
	{ pattern: /\b(?:commit|commits|committed|committing)\b|커밋/i, critical: false },
	{ pattern: /\b(?:push|pushed|pushing)\b|푸시|푸쉬/i, critical: true },
	{
		pattern: /\b(?:release|releases|tag|version\s+bump|bump\s+(?:the\s+)?version)\b|릴리즈|태그|버전/i,
		critical: true,
	},
	{ pattern: /\bnpm\s+publish\b|\bpublish(?:ing|ed)?\b|퍼블리시|배포/i, critical: true },
	{ pattern: /\b(?:CHANGELOG\.md|changelog|release\s+notes?)\b|채널로그|체인지로그/i, critical: false },
	{ pattern: /\bREADME\.md\b|\breadme\b/i, critical: false },
	{ pattern: /\bci\s*\/\s*cd\b|\bgithub\s+actions?\b|\bworkflow\b|깃허브\s*액션|깃헙\s*액션/i, critical: false },
];
const EXPLICIT_RELEASE_RUNBOOK_PATTERN =
	/\bnpm\s+publish\b|\brelease\b[^\n]{0,80}\bv?\d+\.\d+\.\d+\b|릴리즈[^\n]{0,80}\d+\.\d+\.\d+/i;
const REVIEW_SCOPE_PATTERN =
	/\b(pr|pull\s+request|diff|codebase|approach|structure|module\s+boundary|locking\s+strategy|abstraction|assumptions?|parser\s+change|rollback\s+strategy|concurrent\s+case|concurrency\s+plan|hidden\s+coupling|failure\s+mode|test\s+quality|implementation\s+details|strategy|plan|spec|schema|design|api|coverage|security\s+posture|licensing|risks?|edge\s+cases|clarity|consistency|dependencies|third-party|ci\s+pipeline|threat\s+model|retry\s+logic|error\s+handling\s+strategy|error\s+messages?)\b/i;
const REFACTOR_CUE_PATTERN =
	/\b(refactor(?:ing|ed)?|extract|rename|deduplicate|consolidate|modularize|reorganize|simplify|clean\s*up|tidy\s+up|restructure|split\s+module|move\s+logic|untangle|merge\s+duplicate)\b|리팩토링(?!하지\s*마|하지\s*말)|리팩터링(?!하지\s*마|하지\s*말)|구조\s*개선/i;
const ADD_KEYWORD_PATTERN = /\badd\b/i;
const LOW_RISK_EDIT_ACTION_PATTERN = /^(?:correct|update|swap|remove|reword|tweak|bump|trim)\b/i;

/** Short-range compound-clause conjunction boundary. Only bare/compound "then"/"and also"/";" — never bare "and". */
const COMPOUND_SPLIT_PATTERN = /\band\s+then\b|\bthen\b|\band\s+also\b|;/i;

/**
 * Bounded negation-cue vocabulary (spec 008 plan.md "bounded negation window").
 * Deliberately excludes bare "not" (too broad; verified against the current
 * GOLD_SET that every listed cue here is either absent or occurs AFTER, not
 * before, a tracked keyword — see this lane's evidence file for the audit).
 */
const NEGATION_CUE_PATTERN =
	/\b(?:don't|do\s+not|doesn't|does\s+not|didn't|did\s+not|won't|will\s+not|shouldn't|should\s+not|wouldn't|would\s+not|can't|cannot|isn't|is\s+not|aren't|are\s+not|never|avoid|skip|without|instead\s+of|rather\s+than|no\s+need\s+(?:to|for)|no\s+longer\s+need(?:\s+(?:to|for))?)\b/i;
const DIRECT_NOT_OBJECT_CUE_PATTERN_V4 = /\b(?:not|no)\s+(?:a\s+|an\s+|the\s+)?$/i;
const DOUBLE_NEGATION_RESCUE_PATTERN_V4 =
	/\b(?:don't|do\s+not|doesn't|does\s+not|didn't|did\s+not|won't|will\s+not|shouldn't|should\s+not|wouldn't|would\s+not|can't|cannot)\s+(?:skip|avoid)\s+(?:the\s+|a\s+|an\s+)?$/i;
const DELIBERATIVE_QUESTION_RESCUE_PATTERN_V4 =
	/\b(?:shouldn't|should\s+not|wouldn't|would\s+not|can't|cannot)\s+(?:we|i|you)\s*$/i;
const POSTPOSITIONED_NEGATION_CUE_PATTERN_V4 =
	/^\s*(?:-\s*free\b|(?:is|are|was|were)?\s*(?:not\s+(?:needed|required|desired)|unnecessary|not\s+necessary)|(?:[은는이가을를도만]\s*)?(?:하지\s*(?:마(?:라|세요|십시오)?|말(?:고|아|라)?|않(?:아|는|고|을|게)?)|말고|금지))/i;

/** A closed set of clause-boundary characters; a negation cue never reaches across one of these into a prior clause. */
const CLAUSE_BOUNDARY_CHARS = [".", "!", "?", ";", ","] as const;

function hasCodeFence(text: string): boolean {
	return text.includes("```");
}

/** Explicit hunk headers or `diff --git` count alone; bare +/- only count together. */
function hasDiffMarkers(text: string): boolean {
	if (/^@@[^\n]*@@/m.test(text) || /^diff --git /m.test(text)) return true;
	return /^\+(?!\+)/m.test(text) && /^-(?!-)/m.test(text);
}

/** First line (after stripping one polite prefix), capped at 180 chars. */
// Non-imperative preamble shapes stripped before ^-anchored intent tests
// (goal 016/M3+M5): quoted-speech attribution (my teammate said "..." but
// actually: ...) and labeled filler lines (background:/context:/note:).
// Bounded to 3 repetitions so a wall of filler cannot loop the classifier.
const QUOTED_SPEECH_PREFIX_V4 = /^.{0,60}?\bsaid\s+"[^"]*"[,.]?\s*(?:but\s+actually[,:]?\s*)?/i;
const LABELED_FILLER_PREFIX_V4 = /^(?:background|context|note)\s*:[^.!?\n]*[.!?]?\s*/i;

function stripNonImperativePrefixV4(text: string): string {
	let result = text;
	for (let i = 0; i < 3; i++) {
		const stripped = result.replace(QUOTED_SPEECH_PREFIX_V4, "").replace(LABELED_FILLER_PREFIX_V4, "");
		if (stripped === result) break;
		result = stripped;
	}
	return result;
}

function firstClause(prompt: string): string {
	const firstLine =
		stripNonImperativePrefixV4(
			prompt.replace(/^(?:please|pls|can you|could you|would you|help me|i need you to)\s+/i, ""),
		).split("\n")[0] ?? "";
	return firstLine.slice(0, 180);
}

// --- Leading-clause intent tests. All are `^`-anchored against the LEADING
// clause text only, so a negation cue at the start ("don't refactor...") can
// never match one of these: none of the alternations include "don't"/"never"/
// etc, so they are negation-immune by construction.

function hasLeadingReviewIntent(text: string): boolean {
	return clusterMatchesRoleV4(text, "review", "leading-intent");
}

function hasLeadingPlanIntent(text: string): boolean {
	return clusterMatchesRoleV4(text, "plan", "leading-intent");
}

function hasLeadingRefactorIntent(text: string): boolean {
	return clusterMatchesRoleV4(text, "refactor", "leading-intent");
}

function hasLeadingDebugAction(text: string): boolean {
	return clusterMatchesRoleV4(text, "debug", "leading-intent");
}

function hasLeadingCodeGenIntent(text: string): boolean {
	return clusterMatchesRoleV4(text, "code-gen", "leading-intent");
}

function hasLeadingSimpleEditIntent(text: string): boolean {
	return clusterMatchesRoleV4(text, "simple-edit", "leading-intent");
}

// --- Quoted-speech masking (goal 016/M3) ---------------------------------
// A double-quoted span that itself reads as an imperative ("my teammate said
// 'implement it'") is reported speech, not the requester's intent: mask it so
// it cannot fire whole-prompt evidence. Quoted nouns/objects are preserved
// ("fix the 'undefined' error" keeps its debug signal).

const QUOTED_SPAN_PATTERN_V4 = /"([^"\n]{1,80})"/g;

function quotedSpanIsImperativeV4(span: string): boolean {
	const text = span.trim();
	return (
		hasLeadingDebugAction(text) ||
		hasLeadingReviewIntent(text) ||
		hasLeadingPlanIntent(text) ||
		hasLeadingRefactorIntent(text) ||
		hasLeadingCodeGenIntent(text) ||
		hasLeadingSimpleEditIntent(text)
	);
}

function maskQuotedImperativesV4(text: string): string {
	return text.replace(QUOTED_SPAN_PATTERN_V4, (whole: string, inner: string) =>
		quotedSpanIsImperativeV4(inner) ? " ".repeat(whole.length) : whole,
	);
}

// ============================================================================
// Bounded negation gating
// ============================================================================

interface UnnegatedMatchResultV4 {
	/** True when the pattern matched at least once and at least one occurrence was NOT preceded by a negation cue. */
	readonly matched: boolean;
	/** True when the pattern matched at least once but EVERY occurrence was negated (useful for suppressedFeatureIds). */
	readonly suppressed: boolean;
}

const NO_MATCH_RESULT_V4: UnnegatedMatchResultV4 = { matched: false, suppressed: false };

function matchOperationalRunbookV4(prompt: string, windowChars: number): UnnegatedMatchResultV4 {
	let distinctSignals = 0;
	let criticalSignals = 0;
	let sawSuppressed = false;
	for (const { pattern, critical } of OPERATIONAL_RUNBOOK_SIGNAL_PATTERNS) {
		const result = matchUnnegated(prompt, pattern, windowChars);
		if (result.matched) {
			distinctSignals += 1;
			if (critical) criticalSignals += 1;
		}
		if (result.suppressed) sawSuppressed = true;
	}
	const explicitRelease = matchUnnegated(prompt, EXPLICIT_RELEASE_RUNBOOK_PATTERN, windowChars).matched;
	const matched = explicitRelease || distinctSignals >= 3 || (criticalSignals >= 2 && distinctSignals >= 2);
	return { matched, suppressed: !matched && sawSuppressed };
}

/**
 * Negation-aware whole-prompt pattern scan. Finds every occurrence of `pattern`
 * in `prompt`; for each, looks back up to
 * `windowChars` characters (never crossing a `.,;!?` boundary into a prior
 * clause) for a `NEGATION_CUE_PATTERN` hit, and looks forward inside the same
 * bounded window for Hangul-only post-positioned negation cues such as
 * "하지 말고". `matched` is true iff at least one occurrence survives
 * un-negated. Deterministic, single pass per pattern, no shared regex state (a
 * fresh global-flag RegExp is constructed per call).
 */
function hasPrePositionedNegationCueV4(scoped: string): boolean {
	if (!NEGATION_CUE_PATTERN.test(scoped) && !DIRECT_NOT_OBJECT_CUE_PATTERN_V4.test(scoped)) return false;
	return !DOUBLE_NEGATION_RESCUE_PATTERN_V4.test(scoped) && !DELIBERATIVE_QUESTION_RESCUE_PATTERN_V4.test(scoped);
}

function hasPostPositionedNegationCueV4(prompt: string, matchEnd: number, windowChars: number): boolean {
	const scoped = prompt.slice(matchEnd, Math.min(prompt.length, matchEnd + windowChars));
	return POSTPOSITIONED_NEGATION_CUE_PATTERN_V4.test(scoped);
}

function matchUnnegated(prompt: string, pattern: RegExp, windowChars: number): UnnegatedMatchResultV4 {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	const globalPattern = new RegExp(pattern.source, flags);
	let sawMatch = false;
	let sawUnnegated = false;
	let match = globalPattern.exec(prompt);
	while (match !== null) {
		sawMatch = true;
		const matchStart = match.index;
		const windowStart = Math.max(0, matchStart - windowChars);
		const windowText = prompt.slice(windowStart, matchStart);
		let boundary = -1;
		for (const boundaryChar of CLAUSE_BOUNDARY_CHARS) {
			const idx = windowText.lastIndexOf(boundaryChar);
			if (idx > boundary) boundary = idx;
		}
		const scoped = boundary >= 0 ? windowText.slice(boundary + 1) : windowText;
		const preNegated = hasPrePositionedNegationCueV4(scoped);
		const postNegated =
			!preNegated && hasPostPositionedNegationCueV4(prompt, matchStart + match[0].length, windowChars);
		if (!preNegated && !postNegated) sawUnnegated = true;
		if (match[0].length === 0) globalPattern.lastIndex += 1;
		match = globalPattern.exec(prompt);
	}
	return { matched: sawUnnegated, suppressed: sawMatch && !sawUnnegated };
}

function matchClusterUnnegatedV4(
	prompt: string,
	taskClass: TaskClassV4,
	role: IntentLexemeClusterRoleV4,
	windowChars: number,
): UnnegatedMatchResultV4 {
	let sawSuppressed = false;
	for (const cluster of INTENT_LEXEME_CLUSTERS_V4) {
		if (cluster.taskClass !== taskClass || cluster.role !== role) continue;
		for (const pattern of cluster.phrases) {
			const result = matchUnnegated(prompt, pattern, windowChars);
			if (result.matched) return { matched: true, suppressed: false };
			if (result.suppressed) sawSuppressed = true;
		}
	}
	return { matched: false, suppressed: sawSuppressed };
}

// ============================================================================
// Bounded compound-intent detection
// ============================================================================

interface CompoundSecondClauseV4 {
	readonly text: string;
	readonly startIndex: number;
}

/**
 * Splits off a bounded second clause after a short-range conjunction
 * ("then"/"and then"/"and also"/";"), only when the split point is within the
 * first `COMPOUND_SPLIT_MAX_INDEX_V4` characters (short direct commands, not
 * long prose briefs — verified this never fires inside the GOLD_SET's
 * >=2400-char plan entries). Returns null when no qualifying split exists.
 */
function splitCompoundClauseV4(prompt: string): CompoundSecondClauseV4 | null {
	const match = COMPOUND_SPLIT_PATTERN.exec(prompt);
	if (match === null || match.index > COMPOUND_SPLIT_MAX_INDEX_V4) return null;
	const startIndex = match.index + match[0].length;
	const second = prompt.slice(startIndex).trim();
	if (second.length < COMPOUND_SECOND_CLAUSE_MIN_CHARS_V4) return null;
	return { text: second, startIndex };
}

function hasFutureSelfClauseV4(clause: string): boolean {
	return /^(?:(?:i|we)(?:'|’)ll\b|(?:i|we)\s+will\b|(?:i|we)(?:'|’)m\s+going\s+to\b|before\s+(?:i|we)\b|after\s+(?:i|we)\b)/i.test(
		clause,
	);
}

function agentDirectedSecondClauseV4(clause: string): string | null {
	if (hasFutureSelfClauseV4(clause)) return null;
	return clause.replace(/^(?:please|pls|also|then|can\s+you|could\s+you|would\s+you|help\s+me(?:\s+to)?)\s+/i, "");
}

/**
 * Leading-intent test for a compound prompt's SECOND clause. Reuses the same
 * `^`-anchored leading-intent tests as the primary clause (so it is equally
 * negation-immune), without the primary clause's diagnosticEvidence/localEdit
 * gating (a short second-clause fragment carries no such context of its own).
 * First-person future/context clauses ("I'll...", "we will...", "before I...")
 * are user context, not an agent-directed second task.
 */
function secondClauseLeadingIntentV4(clause: string): TaskClassV4 | null {
	const agentDirectedClause = agentDirectedSecondClauseV4(clause);
	if (agentDirectedClause === null) return null;
	const bounded = agentDirectedClause.slice(0, COMPOUND_SECOND_CLAUSE_SCAN_CHARS_V4);
	return leadingIntentFromLeadingClauseV4(bounded);
}

function leadingIntentFromLeadingClauseV4(leading: string): TaskClassV4 | null {
	if (hasLeadingDebugAction(leading)) return "debug";
	if (hasLeadingReviewIntent(leading)) return "review";
	if (hasLeadingPlanIntent(leading)) return "plan";
	if (hasLeadingRefactorIntent(leading)) return "refactor";
	if (hasLeadingSimpleEditIntent(leading)) return "simple-edit";
	if (hasLeadingCodeGenIntent(leading)) return "code-gen";
	return null;
}

function leadingIntentIsPostNegatedV4(leading: string, windowChars: number): boolean {
	const leadingIntentMatch =
		/^(?:debug|investigate\s+why|reproduce|trace\b|fix\s+this\s+(?:traceback|panic|error)|review|audit(?!\s+log\b)|critique|inspect|assess|approve|double-?check|lgtm|plan|design|architect|decompose|write\s+(?:a\s+)?(?:technical\s+)?(?:spec|roadmap|strategy|plan)|create\s+(?:a\s+)?(?:technical\s+)?(?:spec|roadmap|strategy|plan)|refactor(?:ing|ed)?|extract|rename|deduplicate|consolidate|modularize|reorganize|simplify|restructure|untangle|clean\s+up|split\s+(?:the\s+)?module|move\s+logic|correct|update|swap|remove|adjust|fix|add|change|trim|reword|tweak|bump|implement|build|generate|scaffold|prototype)\b/i.exec(
			leading,
		);
	return (
		leadingIntentMatch !== null && hasPostPositionedNegationCueV4(leading, leadingIntentMatch[0].length, windowChars)
	);
}

function classifyShortKoreanZeroScoreTaskV4(prompt: string, windowChars: number): TaskClassV4 | null {
	const generalizedEvidence = extractGeneralizedIntentEvidenceV4(prompt);
	for (const taskClass of TASK_CLASSES_V4) {
		if (generalizedEvidence.skeletonMatch[taskClass]) return taskClass;
	}
	if (matchClusterUnnegatedV4(prompt, "debug", "korean-morphology", windowChars).matched) return "debug";
	if (matchClusterUnnegatedV4(prompt, "simple-edit", "korean-morphology", windowChars).matched) return "simple-edit";
	if (matchClusterUnnegatedV4(prompt, "review", "korean-morphology", windowChars).matched) return "review";
	if (matchClusterUnnegatedV4(prompt, "plan", "korean-morphology", windowChars).matched) return "plan";
	if (matchClusterUnnegatedV4(prompt, "refactor", "korean-morphology", windowChars).matched) return "refactor";
	if (matchClusterUnnegatedV4(prompt, "code-gen", "korean-morphology", windowChars).matched) return "code-gen";
	for (const taskClass of TASK_CLASSES_V4) {
		if (generalizedEvidence.clusterMatch[taskClass]) return taskClass;
	}
	return null;
}

// ============================================================================
// Feature extraction
// ============================================================================

interface ContextualFeaturesV4 {
	readonly firstClause: string;
	readonly codeFence: boolean;
	readonly diffHunk: boolean;
	readonly localEdit: boolean;
	readonly diagnosticEvidence: boolean;
	readonly reviewScope: boolean;
	readonly planBrief: boolean;
	readonly operationalRunbook: boolean;
	readonly refactorCue: boolean;
	readonly implementationObject: boolean;
	readonly codeGenArtifactRequest: boolean;
	readonly evaluativeReviewObject: boolean;
	readonly leadingIntent: TaskClassV4 | null;
	readonly secondClauseIntent: TaskClassV4 | null;
	readonly compoundIntent: boolean;
	readonly keywordFamilyMatch: Readonly<Record<TaskClassV4, boolean>>;
	readonly normalizedIntentClusterMatch: Readonly<Record<TaskClassV4, boolean>>;
	readonly intentSkeletonMatch: Readonly<Record<TaskClassV4, boolean>>;
	readonly generalizedEvidenceCount: Readonly<Record<TaskClassV4, number>>;
	readonly addKeywordMatch: boolean;
}

interface LeadingIntentInputV4 {
	readonly firstClause: string;
	readonly localEdit: boolean;
	readonly diagnosticEvidence: boolean;
}

/** Decision order for the leading intent classifier. */
function leadingIntentV4(input: LeadingIntentInputV4): TaskClassV4 | null {
	if (
		input.diagnosticEvidence &&
		(hasLeadingDebugAction(input.firstClause) || hasLeadingSimpleEditIntent(input.firstClause))
	)
		return "debug";
	if (hasLeadingReviewIntent(input.firstClause)) return "review";
	if (hasLeadingPlanIntent(input.firstClause)) return "plan";
	if (hasLeadingRefactorIntent(input.firstClause)) return "refactor";
	if (input.localEdit && hasLeadingSimpleEditIntent(input.firstClause)) return "simple-edit";
	if (!input.localEdit && hasLeadingCodeGenIntent(input.firstClause)) return "code-gen";
	return null;
}

/** Diagnostic-evidence decision structure, parameterized over precomputed negation-aware matches. */
function hasDiagnosticEvidenceV4(
	leading: string,
	hardDiagnosticMatched: boolean,
	bugObjectMatched: boolean,
	genericDiagnosticMatched: boolean,
	nonDiagnosticContext: boolean,
): boolean {
	if (hasLeadingDebugAction(leading) || hardDiagnosticMatched) return true;
	const hasContextualDiagnostic = bugObjectMatched || (genericDiagnosticMatched && !nonDiagnosticContext);
	if (!hasContextualDiagnostic) return false;
	return !hasLeadingReviewIntent(leading) && !hasLeadingPlanIntent(leading) && !hasLeadingRefactorIntent(leading);
}

type GeneralizedIntentEvidenceV4 = ReturnType<typeof extractGeneralizedIntentEvidenceV4>;

function isDeferredClassV4(evidence: GeneralizedIntentEvidenceV4, taskClass: TaskClassV4): boolean {
	return evidence.deferredClasses.includes(taskClass);
}

function suppressGeneralizedClassesV4(
	evidence: GeneralizedIntentEvidenceV4,
	suppressedClasses: readonly TaskClassV4[],
): GeneralizedIntentEvidenceV4 {
	if (suppressedClasses.length === 0) return evidence;
	const clusterMatch = { ...evidence.clusterMatch };
	const skeletonMatch = { ...evidence.skeletonMatch };
	for (const taskClass of suppressedClasses) {
		clusterMatch[taskClass] = false;
		skeletonMatch[taskClass] = false;
	}
	return { ...evidence, clusterMatch, skeletonMatch };
}

function countGeneralizedEvidenceV4(evidence: GeneralizedIntentEvidenceV4): Record<TaskClassV4, number> {
	const counts = emptyScoresV4();
	for (const taskClass of TASK_CLASSES_V4) {
		counts[taskClass] = (evidence.clusterMatch[taskClass] ? 1 : 0) + (evidence.skeletonMatch[taskClass] ? 1 : 0);
	}
	return counts;
}

/**
 * Extracts every v4 feature from one prompt, negation-gating every
 * whole-prompt scan exactly once and recording a `negation:<channel>` id in
 * `suppressed` whenever a match existed but every occurrence was negated.
 */
function extractFeaturesV4(prompt: string, weights: RouterWeightsV4, suppressed: string[]): ContextualFeaturesV4 {
	const leading = firstClause(prompt);
	const window = weights.negationWindowChars;
	const secondClause = splitCompoundClauseV4(prompt);
	const agentSignalPrompt = maskQuotedImperativesV4(
		secondClause !== null && hasFutureSelfClauseV4(secondClause.text)
			? prompt.slice(0, secondClause.startIndex).trim()
			: prompt,
	);
	const generalizedEvidence = extractGeneralizedIntentEvidenceV4(agentSignalPrompt);
	const shortKoreanPrompt = prompt.length < TRIVIAL_MAX_CHARS_V4 && /[가-힣]/.test(prompt);
	const shortKoreanDebugFallbackOnly =
		shortKoreanPrompt &&
		(generalizedEvidence.clusterMatch.debug || generalizedEvidence.skeletonMatch.debug) &&
		!generalizedEvidence.clusterMatch.refactor &&
		!generalizedEvidence.skeletonMatch.refactor &&
		!generalizedEvidence.clusterMatch.review &&
		!generalizedEvidence.skeletonMatch.review;
	const scoredGeneralizedEvidence = suppressGeneralizedClassesV4(
		generalizedEvidence,
		shortKoreanDebugFallbackOnly
			? [...generalizedEvidence.deferredClasses, "debug"]
			: generalizedEvidence.deferredClasses,
	);
	for (const taskClass of generalizedEvidence.deferredClasses) suppressed.push(`deferral:${taskClass}`);

	const implementationObjectResult = matchUnnegated(agentSignalPrompt, IMPLEMENTATION_OBJECT_PATTERN, window);
	if (implementationObjectResult.suppressed) suppressed.push("negation:implementation-object");
	const implementationObject = !shortKoreanDebugFallbackOnly && implementationObjectResult.matched;

	const codeGenArtifactResult = matchClusterUnnegatedV4(agentSignalPrompt, "code-gen", "object-shape", window);
	if (codeGenArtifactResult.suppressed) suppressed.push("negation:code-gen-artifact-request");
	const codeGenArtifactRequest = codeGenArtifactResult.matched;

	const lowRiskEditAction = LOW_RISK_EDIT_ACTION_PATTERN.test(leading);
	const localEditObjectResult = matchUnnegated(agentSignalPrompt, LOCAL_EDIT_OBJECT_PATTERN, window);
	if (localEditObjectResult.suppressed) suppressed.push("negation:local-edit-object");
	const localEditActionResult = matchUnnegated(agentSignalPrompt, LOCAL_EDIT_ACTION_OBJECT_PATTERN, window);
	if (localEditActionResult.suppressed) suppressed.push("negation:local-edit-action-object");
	const localEdit =
		!implementationObject &&
		!scoredGeneralizedEvidence.clusterMatch.review &&
		!scoredGeneralizedEvidence.skeletonMatch.review &&
		(lowRiskEditAction || localEditObjectResult.matched || localEditActionResult.matched);

	const hardDiagnosticResult = matchUnnegated(agentSignalPrompt, HARD_DIAGNOSTIC_PATTERN, window);
	if (hardDiagnosticResult.suppressed) suppressed.push("negation:hard-diagnostic");
	const bugObjectResult = matchUnnegated(agentSignalPrompt, BUG_OBJECT_PATTERN, window);
	if (bugObjectResult.suppressed) suppressed.push("negation:bug-object");
	const genericDiagnosticResult = matchUnnegated(agentSignalPrompt, GENERIC_DIAGNOSTIC_PATTERN, window);
	const nonDiagnosticContext = NON_DIAGNOSTIC_DEBUG_CONTEXT_PATTERN.test(agentSignalPrompt);
	if (genericDiagnosticResult.suppressed && !nonDiagnosticContext) suppressed.push("negation:generic-diagnostic");
	const diagnosticEvidence =
		!isDeferredClassV4(generalizedEvidence, "debug") &&
		hasDiagnosticEvidenceV4(
			leading,
			hardDiagnosticResult.matched,
			bugObjectResult.matched,
			genericDiagnosticResult.matched,
			nonDiagnosticContext,
		);

	const reviewScopeResult = matchUnnegated(agentSignalPrompt, REVIEW_SCOPE_PATTERN, window);
	if (reviewScopeResult.suppressed) suppressed.push("negation:review-scope");
	const reviewScope =
		!isDeferredClassV4(generalizedEvidence, "review") && hasLeadingReviewIntent(leading) && reviewScopeResult.matched;

	const planBriefResult = matchUnnegated(agentSignalPrompt, PLAN_BRIEF_PATTERN, window);
	if (planBriefResult.suppressed) suppressed.push("negation:plan-brief");
	const planBrief =
		!isDeferredClassV4(generalizedEvidence, "plan") &&
		hasLeadingPlanIntent(leading) &&
		(planBriefResult.matched || prompt.length >= LONG_BRIEF_MIN_CHARS_V4);

	const operationalRunbookResult = matchOperationalRunbookV4(agentSignalPrompt, window);
	if (operationalRunbookResult.suppressed) suppressed.push("negation:operational-runbook");
	const operationalRunbook = operationalRunbookResult.matched;

	const refactorCueResult = matchUnnegated(agentSignalPrompt, REFACTOR_CUE_PATTERN, window);
	if (refactorCueResult.suppressed) suppressed.push("negation:refactor-cue");
	const refactorCue = !isDeferredClassV4(generalizedEvidence, "refactor") && refactorCueResult.matched;

	const rawPrimaryIntent = leadingIntentV4({ firstClause: leading, localEdit, diagnosticEvidence });
	const primaryIntent =
		rawPrimaryIntent !== null &&
		(leadingIntentIsPostNegatedV4(leading, window) || isDeferredClassV4(generalizedEvidence, rawPrimaryIntent))
			? null
			: rawPrimaryIntent;

	const secondClauseIntent = secondClause === null ? null : secondClauseLeadingIntentV4(secondClause.text);
	const compoundIntent = secondClauseIntent !== null && secondClauseIntent !== primaryIntent;

	const debugKeywordResult = diagnosticEvidence
		? matchClusterUnnegatedV4(agentSignalPrompt, "debug", "whole-prompt", window)
		: NO_MATCH_RESULT_V4;
	if (debugKeywordResult.suppressed) suppressed.push("negation:keyword-debug");

	const reviewKeywordResult = isDeferredClassV4(generalizedEvidence, "review")
		? NO_MATCH_RESULT_V4
		: matchClusterUnnegatedV4(agentSignalPrompt, "review", "whole-prompt", window);
	if (reviewKeywordResult.suppressed) suppressed.push("negation:keyword-review");

	const planKeywordResult = isDeferredClassV4(generalizedEvidence, "plan")
		? NO_MATCH_RESULT_V4
		: matchClusterUnnegatedV4(agentSignalPrompt, "plan", "whole-prompt", window);
	if (planKeywordResult.suppressed) suppressed.push("negation:keyword-plan");

	const codeGenKeywordResult = matchClusterUnnegatedV4(agentSignalPrompt, "code-gen", "whole-prompt", window);
	if (codeGenKeywordResult.suppressed) suppressed.push("negation:keyword-code-gen");

	const evaluativeReviewResult =
		!isDeferredClassV4(generalizedEvidence, "review") && hasLeadingReviewIntent(leading)
			? matchClusterUnnegatedV4(agentSignalPrompt, "review", "object-shape", window)
			: NO_MATCH_RESULT_V4;
	if (evaluativeReviewResult.suppressed) suppressed.push("negation:evaluative-review-object");
	const evaluativeReviewObject = evaluativeReviewResult.matched;

	const addKeywordResult = localEdit
		? NO_MATCH_RESULT_V4
		: matchUnnegated(agentSignalPrompt, ADD_KEYWORD_PATTERN, window);
	if (addKeywordResult.suppressed) suppressed.push("negation:add-keyword");

	return {
		firstClause: leading,
		codeFence: hasCodeFence(prompt),
		diffHunk: hasDiffMarkers(prompt),
		localEdit,
		diagnosticEvidence,
		reviewScope,
		planBrief,
		operationalRunbook,
		refactorCue,
		implementationObject,
		codeGenArtifactRequest,
		evaluativeReviewObject,
		leadingIntent: primaryIntent,
		secondClauseIntent,
		compoundIntent,
		keywordFamilyMatch: {
			trivial: false,
			debug: debugKeywordResult.matched,
			refactor: refactorCue,
			review: reviewKeywordResult.matched,
			plan: planKeywordResult.matched,
			"simple-edit": localEditObjectResult.matched,
			"code-gen": codeGenKeywordResult.matched,
		},
		normalizedIntentClusterMatch: scoredGeneralizedEvidence.clusterMatch,
		intentSkeletonMatch: scoredGeneralizedEvidence.skeletonMatch,
		generalizedEvidenceCount: countGeneralizedEvidenceV4(scoredGeneralizedEvidence),
		addKeywordMatch: addKeywordResult.matched,
	};
}

// ============================================================================
// Scoring
// ============================================================================

function emptyScoresV4(): Record<TaskClassV4, number> {
	return {
		trivial: 0,
		"simple-edit": 0,
		"code-gen": 0,
		debug: 0,
		refactor: 0,
		review: 0,
		plan: 0,
	};
}

function computeScoresV4(features: ContextualFeaturesV4, weights: RouterWeightsV4): Record<TaskClassV4, number> {
	const scores = emptyScoresV4();
	if (features.codeFence || features.diffHunk) scores["code-gen"] += weights.codeFenceOrDiff;
	if (features.leadingIntent !== null) scores[features.leadingIntent] += weights.leadingIntent;
	if (features.secondClauseIntent !== null) scores[features.secondClauseIntent] += weights.secondClauseIntent;
	if (features.localEdit) scores["simple-edit"] += weights.localEdit;
	if (features.diagnosticEvidence) scores.debug += weights.diagnosticEvidence;
	if (features.reviewScope) scores.review += weights.reviewScope;
	if (features.planBrief) scores.plan += weights.planBrief;
	if (features.operationalRunbook) scores.plan += weights.operationalRunbook;
	if (features.refactorCue) scores.refactor += weights.refactorCue;
	if (features.implementationObject) scores["code-gen"] += weights.implementationObject;
	if (features.codeGenArtifactRequest) scores["code-gen"] += weights.codeGenArtifactRequest;
	if (features.evaluativeReviewObject) scores.review += weights.evaluativeReviewObject;

	for (const taskClass of TASK_CLASSES_V4) {
		if (features.keywordFamilyMatch[taskClass]) scores[taskClass] += weights.keywordFamily[taskClass];
		if (features.normalizedIntentClusterMatch[taskClass]) scores[taskClass] += weights.normalizedIntentCluster;
		if (features.intentSkeletonMatch[taskClass]) scores[taskClass] += weights.intentSkeleton;
	}
	if (features.addKeywordMatch) scores["code-gen"] += weights.addKeyword;

	return scores;
}

/**
 * Extension signals (history / context-pressure / judge vote). Every
 * coefficient is 0 under DEFAULT_WEIGHTS_V4 (inert until calibrated by a
 * future governance-backed lane); the mechanism exists so
 * `TaskClassifierInputV4`'s optional fields are meaningfully wired rather than
 * silently accepted-and-ignored.
 */
function applyExtensionSignalsV4(
	scores: Record<TaskClassV4, number>,
	input: TaskClassifierInputV4,
	weights: RouterWeightsV4,
): void {
	// Gate (goal 016/L2): extension votes apply only when a real signal already
	// exists. On a zero-score state the fallback cascade (trivial-length,
	// ko-short, long-prose, lane) owns the verdict — a stray history/judge vote
	// must not hijack it (measured: any weight >= 1 flips gold-0001 "hi" to the
	// voted class otherwise). With the gate, inert weights can be nonzero safely.
	let topScore = 0;
	for (const c of TASK_CLASSES_V4) topScore = Math.max(topScore, scores[c]);
	if (topScore <= 0) return;

	const priorClass = input.history !== undefined && input.history.length > 0 ? input.history[0] : null;
	if (priorClass !== null && weights.multiTurnPrior !== 0) scores[priorClass] += weights.multiTurnPrior;

	const judgeVote = input.judgeVote ?? null;
	if (judgeVote !== null && weights.judgeVote !== 0) scores[judgeVote] += weights.judgeVote;

	const pressureBucket = input.pressureBucket ?? 0;
	if (pressureBucket > 0 && weights.pressureBucket !== 0) {
		const bump = pressureBucket * weights.pressureBucket;
		scores.debug += bump;
		scores.review += bump;
		scores.plan += bump;
	}
}

function clampConfidenceV4(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function confidenceEvidenceStrengthV4(topScore: number, margin: number, weights: RouterWeightsV4): number {
	if (topScore <= 0) return 0;
	const separation = clampConfidenceV4(margin / topScore);
	const evidenceFloor = weights.leadingIntent > 0 ? weights.leadingIntent : 1;
	return Math.min(separation, clampConfidenceV4(topScore / evidenceFloor));
}

// ============================================================================
// Public types
// ============================================================================

/**
 * Caller-supplied turn input. Identical shape to `TaskClassifierInputV3` /
 * `TaskClassifierInputV2` (prompt + optional lane/history/pressure/judge
 * slots), so existing callers can switch versions without reshaping data.
 */
export interface TaskClassifierInputV4 {
	prompt: string;
	laneType?: ReasoningLaneTypeV4;
	history?: readonly TaskClassV4[];
	pressureBucket?: number;
	judgeVote?: TaskClassV4 | null;
}

/** Confidence band derived from score separation plus absolute evidence strength. */
export type ConfidenceBandV4 = "low" | "medium" | "high";

/** Which branch of the zero-score fallback cascade decided `taskClass`; null when a real weighted signal decided it. */
export type FallbackReasonV4 =
	| "code-fence-or-diff"
	| "trivial-length"
	| "ko-short-task-signal"
	| "long-prose"
	| "lane-fallback"
	| "default";

/**
 * The full, privacy-safe classification verdict (spec 008 Req 2). Every field
 * is a bounded enum, number, boolean, or a closed set of short diagnostic-id
 * strings (`suppressedFeatureIds`) — never raw prompt text, so this value is
 * safe to pass to evaluation, learning, and Adaptorch-advisory code.
 */
export interface ClassifierVerdictV4 {
	/** The decided task class (post zero-score-cascade if one fired). */
	readonly taskClass: TaskClassV4;
	/** Raw per-class score map from the weighted signals (pre-cascade; audit-only). */
	readonly scores: Readonly<Record<TaskClassV4, number>>;
	/** Second-highest-scoring class by the argmax, or null if every other class tied at the bottom. */
	readonly runnerUp: TaskClassV4 | null;
	/** `scores[argmaxClass] - scores[runnerUp]` (pre-cascade); 0 or negative-margin-free by construction (weights are non-negative). */
	readonly margin: number;
	/** Normalized confidence in [0, 1], combining `margin / topScore` with absolute evidence strength. */
	readonly confidence: number;
	/** Confidence bucketed by `weights.lowConfidenceThreshold` / `highConfidenceThreshold`. */
	readonly confidenceBand: ConfidenceBandV4;
	/** True when the argmax class won only via precedence-order tie-break over an exact score tie with the runner-up. */
	readonly tieBreak: boolean;
	/** Non-null exactly when the zero-score cascade (not a real weighted signal) decided `taskClass`. */
	readonly fallbackReason: FallbackReasonV4 | null;
	/** Audit trail of `negation:<channel>` ids for every whole-prompt signal that had a match but was fully negated. */
	readonly suppressedFeatureIds: readonly string[];
	/** True when a distinct second-clause leading intent was detected (bounded compound-intent detection). */
	readonly compoundIntent: boolean;
	/** The second clause's own leading intent, or null when no compound structure (or no distinct intent) was found. */
	readonly secondClauseIntent: TaskClassV4 | null;
}

// ============================================================================
// Classifier
// ============================================================================

/**
 * Deterministic confidence-bearing classifier (spec 008 Req 2).
 *
 * Pipeline: extract negation/compound-aware contextual features -> score every
 * class from `weights` -> argmax with `TASK_CLASSES_V4` precedence tie-break,
 * tracking the runner-up -> compute margin/confidence/confidenceBand/tieBreak
 * from RAW score separation plus evidence strength -> if `topScore <= 0`, replace `taskClass` (and record
 * `fallbackReason`) via the zero-score cascade (fence/diff -> code-gen;
 * length < 40 -> trivial; length >= 2400 -> plan; lane fallback; default
 * code-gen) — the raw scores/margin/runnerUp/tieBreak fields still reflect the
 * pre-cascade computation, for audit purposes.
 *
 * Pure: same (input, weights) -> same ClassifierVerdictV4.
 */
export function classifyTaskV4(
	input: TaskClassifierInputV4,
	weights: RouterWeightsV4 = DEFAULT_WEIGHTS_V4,
): ClassifierVerdictV4 {
	const prompt = input.prompt.trim();
	const suppressed: string[] = [];
	const features = extractFeaturesV4(prompt, weights, suppressed);
	const scores = computeScoresV4(features, weights);
	applyExtensionSignalsV4(scores, input, weights);

	let top: TaskClassV4 = TASK_CLASSES_V4[0];
	for (const c of TASK_CLASSES_V4) {
		if (scores[c] > scores[top]) top = c;
	}
	let runnerUp: TaskClassV4 | null = null;
	for (const c of TASK_CLASSES_V4) {
		if (c === top) continue;
		if (runnerUp === null || scores[c] > scores[runnerUp]) runnerUp = c;
	}

	const topScore = scores[top];
	const runnerUpScore = runnerUp !== null ? scores[runnerUp] : 0;
	const margin = topScore - runnerUpScore;
	const tieBreak = runnerUp !== null && topScore === runnerUpScore;
	const rawConfidence = confidenceEvidenceStrengthV4(topScore, margin, weights);
	const singleGeneralizedEvidence =
		features.generalizedEvidenceCount[top] === 1 &&
		topScore <= Math.max(weights.normalizedIntentCluster, weights.intentSkeleton);
	const confidence = singleGeneralizedEvidence
		? Math.min(rawConfidence, Math.max(0, weights.highConfidenceThreshold - 0.01))
		: rawConfidence;
	const confidenceBand: ConfidenceBandV4 =
		confidence <= weights.lowConfidenceThreshold
			? "low"
			: confidence >= weights.highConfidenceThreshold
				? "high"
				: "medium";

	let taskClass: TaskClassV4 = top;
	let fallbackReason: FallbackReasonV4 | null = null;
	if (topScore <= 0) {
		if (features.codeFence || features.diffHunk) {
			taskClass = "code-gen";
			fallbackReason = "code-fence-or-diff";
		} else {
			// Hangul zero-score prompts route by morphology at ANY length, not just
			// short ones: previously a >40-char Korean edit request fell through to
			// the code-gen default even when a morphology cluster matched. (016)
			const koreanTaskClass = /[가-힣]/.test(prompt)
				? classifyShortKoreanZeroScoreTaskV4(prompt, weights.negationWindowChars)
				: null;
			if (koreanTaskClass !== null) {
				taskClass = koreanTaskClass;
				fallbackReason = "ko-short-task-signal";
			} else if (prompt.length < TRIVIAL_MAX_CHARS_V4) {
				taskClass = "trivial";
				fallbackReason = "trivial-length";
			} else if (prompt.length >= COMPLEX_PROSE_MIN_CHARS_V4) {
				taskClass = "plan";
				fallbackReason = "long-prose";
			} else if (input.laneType !== undefined) {
				taskClass = LANE_FALLBACK_CLASS_V4[input.laneType];
				fallbackReason = "lane-fallback";
			} else {
				taskClass = "code-gen";
				fallbackReason = "default";
			}
		}
	}

	return {
		taskClass,
		scores,
		runnerUp,
		margin,
		confidence,
		confidenceBand,
		tieBreak,
		fallbackReason,
		suppressedFeatureIds: suppressed,
		compoundIntent: features.compoundIntent,
		secondClauseIntent: features.secondClauseIntent,
	};
}

// ============================================================================
// Resolver
// ============================================================================

/**
 * Static rule table: task class -> recommended ThinkingLevel. Re-exported
 * from the shared resolver core (byte-identical values; previously a
 * duplicated literal here — see reasoning-router-resolver.ts).
 */
export const TASK_CLASS_THINKING_LEVELS_V4 = TASK_CLASS_THINKING_LEVELS;

/**
 * Bounded, strictly non-negative escalation applied when the verdict's own
 * confidence is low or a fallback (not a real signal) decided the class. This
 * is the ONLY place confidence touches the target index, and it can only add:
 * confidence can never lower effort (spec 008 Req 2 acceptance criterion).
 */
const LOW_CONFIDENCE_ESCALATION_STEPS_V4 = 1;

/**
 * Thin auto-mode wrapper with no uncertainty adjustment: base rule table ->
 * lane step -> clamp to availableLevels. This is v4's "confident" path and
 * delegates to the shared resolver core with bias=0, hint=null, escalationSteps=0.
 */
export function resolveThinkingLevelV4ForAuto(
	taskClass: TaskClassV4,
	availableLevels: readonly ThinkingLevel[],
	laneType: ReasoningLaneTypeV4 | undefined,
): ThinkingLevel {
	return resolveThinkingLevelCore(taskClass, availableLevels, laneType, 0, null, 0);
}

/**
 * Uncertainty-aware resolver (spec 008 Req 2 / plan.md step 5).
 *
 * Pipeline: base rule table for `verdict.taskClass` -> lane step -> bounded
 * bias [-2,+2] -> optional hint fusion (±2 bounded) -> bounded
 * non-negative confidence escalation (+1 ladder step exactly when
 * `verdict.confidenceBand === "low"` or `verdict.fallbackReason !== null`) ->
 * clamp to `availableLevels`.
 *
 * The confidence-escalation term is strictly `>= 0`: low confidence can only
 * hold the base+lane+bias+hint target or push it one step higher, never lower
 * it. This guarantees a low-confidence verdict never resolves BELOW what
 * `resolveThinkingLevelV4ForAuto` would give the same class (with bias=0,
 * hint=null) — text alone cannot talk the resolver down.
 */
export function resolveThinkingLevelV4WithUncertainty(
	verdict: ClassifierVerdictV4,
	availableLevels: readonly ThinkingLevel[],
	laneType: ReasoningLaneTypeV4 | undefined,
	bias = 0,
	hint: { level: ThinkingLevel; confidence: number } | null = null,
): ThinkingLevel {
	const escalationSteps =
		verdict.confidenceBand === "low" || verdict.fallbackReason !== null ? LOW_CONFIDENCE_ESCALATION_STEPS_V4 : 0;
	return resolveThinkingLevelCore(verdict.taskClass, availableLevels, laneType, bias, hint, escalationSteps);
}
