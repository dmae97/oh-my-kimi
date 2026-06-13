# OMK CLI v2 Runtime Architecture

> 목적: 현재 OMK interactive chat/runtime에서 발생하는 **prompt envelope 비대화**, **MCP 전체 강제 활성화**, **theme 미적용**, **NLP 비활성화**, **slash command 비대화형 유지**, **optional MCP 실패 fatal 처리** 문제를 해결하기 위한 CLI/runtime 아키텍처 문서.

- 대상 저장소: `dmae97/open-multi-agent-kit`
- 기준 관찰 로그: `붙여넣은 마크다운(1)(3).md`
- 기준 공개 커밋 맥락: `main` 최신 공개 커밋이 `fix(runtime): reuse fallback provider default in env` 계열로 확인된 상태
- 핵심 방향: **CLI 프레임워크 교체보다 먼저 `CapabilityPlan + RuntimeSidecar + OutputRouter + ProviderEventNormalizer`를 도입한다.**

---

## 0. Executive Summary

현재 OMK의 문제는 개별 provider, Kimi, theme palette, slash command handler 하나의 문제가 아니다. 근본 원인은 다음 한 줄이다.

```txt
OMK control-plane envelope가 machine sidecar로 분리되지 않고 provider model prompt와 provider runtime config로 그대로 누수되고 있다.
```

그 결과 다음 장애가 동시에 발생한다.

```txt
1. 사용자 요청은 짧은데 provider prompt는 수만 글자까지 비대해진다.
2. available MCP/skills가 required activation으로 오인된다.
3. unrelated MCP 하나가 실패해도 전체 turn이 exit=1로 죽는다.
4. provider raw stdout/event가 ThemeRenderer와 NlpRenderer를 우회한다.
5. slash command가 CommandBus와 session state에 연결되지 않고 one-shot local print로 남는다.
6. runtime preset을 줄여도 Kimi isolated HOME 또는 ~/.kimi/mcp.json 전체가 다시 로딩된다.
```

해결책은 CLI를 다음 구조로 재설계하는 것이다.

```txt
User Input / Slash Command
        ↓
CommandBus
        ↓
IntentClassifier
        ↓
CapabilitySelector
        ↓
RuntimeSidecar Builder
        ↓                 ↓
NLP Prompt Compiler       Filtered MCP Config
        ↓                 ↓
ProviderAdapter      Provider Runtime
        ↓
ProviderEventNormalizer
        ↓
OmkEventBus
        ↓
OutputRouter
        ↓
ThemeRenderer / NlpRenderer / JsonRenderer
```

핵심 원칙은 다음과 같다.

```txt
available ≠ required
inventory ≠ activation
prompt ≠ sidecar
provider stdout ≠ user output
slash command ≠ plain text print
optional failure ≠ fatal error
```

---

## 1. 현재 증상 정리

### 1.1 관찰된 사용자 입력

사용자는 interactive shell에서 다음을 입력했다.

```txt
/model
현재 상태는 어때
```

`/model`은 다음처럼 단순 텍스트를 출력했다.

```txt
Current model: kimi-code default
Usage: /model codex/codex-cli
```

그리고 `현재 상태는 어때`라는 9자 요청에 대해 OMK는 아래 상태를 구성했다.

```txt
Selected provider: kimi
Selected runtime: kimi-print
Selected model: kimi-code default
Turn risk: read
Sandbox: read-only
MCP: enabled (21); live-required=false
Skills: enabled (67)
Tools: disabled; tool-calling-required=false
```

하지만 이후 prompt에는 다음 directive가 들어갔다.

```txt
Routing directives (MANDATORY — activate these skills/MCP/tools explicitly):
- Skills (MUST use): 67개 전부
- MCP servers (MUST activate): 21개 전부
```

여기서 구조적 모순이 발생한다.

```txt
live-required=false
requiresMcp=false
requiresToolCalling=false

하지만

MCP servers MUST activate: all 21
Skills MUST use: all 67
```

### 1.2 실제 실패

MCP loading 결과는 다음과 같았다.

```txt
connected=20
total=21
omk-web-bridge status=failed
```

그러나 `omk-web-bridge`가 현재 status query에 required capability가 아님에도 전체 turn은 실패했다.

```txt
Unknown error: Failed to connect MCP servers: {'omk-web-bridge': McpError('Connection closed')}
exit=1
```

### 1.3 핵심 판정

이건 Kimi 자체의 추론 실패가 아니라, OMK runtime envelope 설계 문제다.

```txt
P0 원인:
- Capability inventory와 required activation이 섞임
- prompt envelope가 provider input으로 누수됨
- provider raw event가 renderer를 우회함
- optional failure가 hard failure로 승격됨
```

---

## 2. 목표 아키텍처

### 2.1 High-Level Architecture

```txt
┌──────────────────────────────────────────────────────────────┐
│                        CLI Entrypoint                         │
│                   omk / omk chat / omk run                    │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                         Input Layer                           │
│ argv / stdin / REPL line / slash command / file / goal prompt │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                         CommandBus                            │
│  normal command, slash command, agent turn을 하나의 command로  │
│  정규화한다.                                                  │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                    Intent + Risk Classifier                   │
│ status / resume / memory / repo_read / code_edit / web        │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                     Capability Selector                       │
│ available inventory에서 required/optional/disabled만 선별      │
└──────────────────────────────┬───────────────────────────────┘
                               │
             ┌─────────────────┴─────────────────┐
             │                                   │
┌────────────▼────────────┐        ┌─────────────▼─────────────┐
│ RuntimeSidecar Builder  │        │ Debloat-to-NLP Compiler   │
│ machine execution plan  │        │ model-facing prompt only  │
└────────────┬────────────┘        └─────────────┬─────────────┘
             │                                   │
┌────────────▼────────────┐        ┌─────────────▼─────────────┐
│ Filtered MCP Config     │        │ Provider Prompt           │
│ per-turn mcp.json       │        │ short, natural instruction│
└────────────┬────────────┘        └─────────────┬─────────────┘
             │                                   │
             └─────────────────┬─────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                       ProviderAdapter                         │
│ Kimi / Codex / Claude / DeepSeek / local model adapter        │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                  ProviderEventNormalizer                      │
│ raw TurnBegin/StatusUpdate/MCP snapshots → OMK UI events      │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                         OmkEventBus                           │
│ progress / warning / result / error / trace / memory events   │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                         OutputRouter                          │
│ stdout/stderr/file 분리 + renderer 강제                       │
└──────────────┬────────────────┬────────────────┬─────────────┘
               │                │                │
┌──────────────▼─────┐ ┌────────▼────────┐ ┌─────▼─────────────┐
│ ThemeRenderer      │ │ NlpRenderer     │ │ Json/JsonlRenderer│
│ terminal UI        │ │ human report    │ │ machine output    │
└────────────────────┘ └─────────────────┘ └───────────────────┘
```

### 2.2 Control Plane vs Data Plane

OMK v2에서 가장 중요한 분리는 다음이다.

| Layer | 내용 | 모델 prompt에 들어가는가? | runtime sidecar에 들어가는가? |
|---|---|---:|---:|
| User request | 사용자가 입력한 실제 요청 | Yes | Yes |
| Intent | status/code_edit/web 등 | Limited | Yes |
| Required MCP | 없으면 작업 불가능한 capability | Limited | Yes |
| Optional MCP | 있으면 도움 되는 capability | Limited | Yes |
| Available MCP inventory | 현재 설치된 전체 MCP 목록 | No | Yes 또는 hidden |
| Skill inventory | 전체 skill 목록 | No | Yes 또는 hidden |
| Provider env | HOME, mcp config, fallback provider | No | Yes |
| Telemetry | TurnBegin, StatusUpdate raw dump | No | Event stream only |
| Theme/NLP 설정 | 출력 렌더링 정책 | No | Yes |

정책:

```txt
모델에게는 “지금 무엇을 해야 하는지”만 말한다.
런타임에는 “어떤 capability를 어떻게 붙일지”를 sidecar로 넘긴다.
전체 inventory는 모델 prompt에 절대 직접 넣지 않는다.
```

---

## 3. 핵심 Invariants

다음 invariant는 테스트로 강제해야 한다.

```txt
I-001. availableMcp는 prompt의 MUST activate로 변환되면 안 된다.
I-002. availableSkills는 prompt의 MUST use로 변환되면 안 된다.
I-003. requiredMcp만 hard failure 조건이 될 수 있다.
I-004. optionalMcp failure는 warning이어야 한다.
I-005. provider raw TurnBegin/StatusUpdate는 user-facing stdout에 출력되면 안 된다.
I-006. status intent는 requiredMcp=[]가 기본값이어야 한다.
I-007. status intent는 MCP optional 후보를 최대 2~3개로 제한한다.
I-008. slash command도 CommandBus와 OutputRouter를 반드시 탄다.
I-009. theme 출력은 모든 human-facing output에 적용되어야 한다.
I-010. machine output JSON은 stdout, progress/warning은 stderr에만 쓴다.
I-011. `kimi-print`는 debug raw mode에서만 허용한다.
I-012. prompt envelope schema는 model prompt가 아니라 runtime sidecar로 취급한다.
```

---

## 4. Package / Directory Structure

추천 구조는 다음과 같다.

```txt
packages/
  cli/
    src/
      main.ts
      bootstrap/
        detect-terminal.ts
        load-config.ts
        resolve-theme.ts
        resolve-runtime.ts
      command-bus/
        command-bus.ts
        command-result.ts
        command-context.ts
        handlers/
          chat-command.ts
          run-command.ts
          status-command.ts
          model-command.ts
          memory-command.ts
          theme-command.ts
          doctor-command.ts
      repl/
        repl-loop.ts
        slash-command-parser.ts
        interactive-state.ts
      input/
        argv-parser.ts
        stdin-reader.ts
        goal-file-reader.ts
        command-envelope.ts
      intent/
        classify-intent.ts
        classify-risk.ts
        intent-types.ts
      capability/
        capability-inventory.ts
        capability-selector.ts
        capability-plan.ts
        failure-policy.ts
        mcp-config-filter.ts
      prompt/
        prompt-envelope.ts
        debloat-to-nlp.ts
        prompt-budget.ts
        prompt-validator.ts
      runtime/
        runtime-sidecar.ts
        runtime-orchestrator.ts
        provider-router.ts
      providers/
        provider-adapter.ts
        kimi/
          kimi-adapter.ts
          kimi-mcp-config.ts
          kimi-event-parser.ts
          kimi-runtime-selector.ts
        codex/
          codex-adapter.ts
        claude/
          claude-adapter.ts
      events/
        omk-event.ts
        event-bus.ts
        provider-event-normalizer.ts
      output/
        output-router.ts
        output-profile.ts
        theme-renderer.ts
        nlp-renderer.ts
        json-renderer.ts
        error-renderer.ts
      theme/
        theme-definition.ts
        theme-registry.ts
        theme-writer.ts
        builtins/
          omk.ts
          mono.ts
          minimal.ts
      memory/
        project-memory.ts
        session-ledger.ts
        memory-capsule.ts
        resume-policy.ts
      tests/
        regression-status-no-all-mcp.test.ts
        regression-optional-mcp-warning.test.ts
        regression-no-raw-provider-output.test.ts
```

---

## 5. Core Data Models

### 5.1 Command Envelope

`CommandEnvelope`는 CLI 입력을 runtime이 이해할 수 있는 구조로 정규화한다. 단, 이것은 그대로 provider prompt가 되면 안 된다.

```ts
export type CommandKind =
  | 'chat'
  | 'run'
  | 'status'
  | 'model'
  | 'memory'
  | 'theme'
  | 'doctor';

export type InputSource =
  | 'argv'
  | 'stdin'
  | 'file'
  | 'repl'
  | 'slash-command';

export interface CommandEnvelope {
  readonly kind: CommandKind;
  readonly source: InputSource;
  readonly rawText: string;
  readonly decodedUserRequest: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly projectId?: string;
  readonly providerPolicy: 'auto' | 'kimi' | 'codex' | 'claude' | 'deepseek';
  readonly outputProfile: OutputProfile;
  readonly debug: {
    readonly rawProvider: boolean;
    readonly explainRouting: boolean;
  };
}
```

### 5.2 Intent

```ts
export type RequestIntent =
  | 'status'
  | 'resume'
  | 'memory_query'
  | 'repo_read'
  | 'code_edit'
  | 'debug_error'
  | 'web_research'
  | 'plan'
  | 'chat'
  | 'unknown';
```

### 5.3 Capability Inventory

Inventory는 “설치/발견된 목록”일 뿐이다.

```ts
export interface CapabilityInventory {
  readonly mcp: readonly McpServerDescriptor[];
  readonly skills: readonly SkillDescriptor[];
  readonly hooks: readonly HookDescriptor[];
  readonly toolsEnabled: boolean;
}

export interface McpServerDescriptor {
  readonly name: string;
  readonly scope: 'project' | 'user' | 'global' | 'runtime';
  readonly status: 'unknown' | 'available' | 'connected' | 'failed' | 'disabled';
  readonly tools?: readonly string[];
  readonly lastError?: string;
}
```

### 5.4 Capability Plan

`CapabilityPlan`은 현재 turn에서 실제로 사용할 capability만 선별한다.

```ts
export interface CapabilityPlan {
  readonly availableMcp: readonly string[];
  readonly requiredMcp: readonly string[];
  readonly optionalMcp: readonly string[];
  readonly disabledMcp: readonly string[];

  readonly availableSkills: readonly string[];
  readonly selectedSkills: readonly string[];

  readonly toolCallingRequired: boolean;
  readonly liveMcpRequired: boolean;
  readonly failurePolicy: 'required-only' | 'strict';
}
```

정책:

```txt
availableMcp는 prompt에 출력하지 않는다.
requiredMcp와 optionalMcp만 prompt에 제한적으로 출력한다.
disabledMcp는 warning으로만 출력한다.
```

### 5.5 Runtime Sidecar

Provider 실행기는 prompt 문자열이 아니라 sidecar를 보고 runtime을 구성한다.

```ts
export interface RuntimeSidecar {
  readonly provider: 'kimi' | 'codex' | 'claude' | 'deepseek' | 'local';
  readonly model: string;
  readonly runtime: 'kimi-event' | 'kimi-wire' | 'kimi-print' | 'codex' | 'claude';

  readonly intent: RequestIntent;
  readonly risk: 'read' | 'write' | 'network' | 'dangerous';
  readonly sandbox: 'read-only' | 'workspace-write' | 'full-access';

  readonly requiredMcp: readonly string[];
  readonly optionalMcp: readonly string[];
  readonly disabledMcp: readonly string[];
  readonly selectedSkills: readonly string[];

  readonly failurePolicy: 'required-only' | 'strict';
  readonly outputProfile: OutputProfile;
  readonly projectId?: string;
  readonly sessionId: string;
}
```

### 5.6 Output Profile

```ts
export type OutputFormat = 'theme' | 'nlp' | 'json' | 'jsonl' | 'markdown' | 'silent';

export interface OutputProfile {
  readonly format: OutputFormat;
  readonly progress: 'none' | 'live' | 'compact' | 'jsonl';
  readonly color: 'auto' | 'always' | 'never';
  readonly rawProvider: boolean;
  readonly explainRouting: boolean;
  readonly stdoutMode: 'human' | 'machine';
}
```

---

## 6. Intent Classification

### 6.1 Rule-Based MVP

처음부터 LLM classifier를 쓰지 않는다. CLI control-plane은 deterministic해야 한다.

```ts
export function classifyIntent(userRequest: string): RequestIntent {
  const text = userRequest.trim().toLowerCase();

  if (/현재 상태|상태|status|progress|어때|어디까지|진행|뭐 했/.test(text)) {
    return 'status';
  }

  if (/이어|resume|계속|이전|마지막|left off|where we left/.test(text)) {
    return 'resume';
  }

  if (/기억|memory|remember|잊어|forget|전에/.test(text)) {
    return 'memory_query';
  }

  if (/파일|읽어|구조|repo|repository|코드베이스|찾아/.test(text)) {
    return 'repo_read';
  }

  if (/수정|고쳐|구현|패치|edit|fix|implement|refactor/.test(text)) {
    return 'code_edit';
  }

  if (/검색|웹|최신|news|github|x에서|찾아봐/.test(text)) {
    return 'web_research';
  }

  if (/계획|설계|plan|architecture|알고리즘/.test(text)) {
    return 'plan';
  }

  return 'chat';
}
```

### 6.2 Risk Classification

```ts
export function classifyRisk(intent: RequestIntent, userRequest: string) {
  if (intent === 'code_edit') return 'write';
  if (intent === 'web_research') return 'network';
  if (/삭제|delete|rm -rf|drop table|credential|token/.test(userRequest)) {
    return 'dangerous';
  }
  return 'read';
}
```

---

## 7. Capability Selection Algorithm

### 7.1 기본 정책

```txt
status:
  requiredMcp: []
  optionalMcp: [omk-project, memory]
  selectedSkills: [omk-context-broker, omk-project-rules]

resume:
  requiredMcp: []
  optionalMcp: [omk-project, memory, sqlite]
  selectedSkills: [agentmemory, omk-context-broker, omk-project-rules]

repo_read:
  requiredMcp: [filesystem-readonly] if available
  optionalMcp: [omk-project, memory]

code_edit:
  requiredMcp: [filesystem]
  optionalMcp: [omk-project, memory, sqlite]
  selectedSkills: [omk-flow-feature-dev, omk-typescript-strict, omk-quality-gate]

web_research:
  requiredMcp: [fetch] if available and task explicitly requires network
  optionalMcp: [web-reader, playwright]
```

### 7.2 Implementation

```ts
export function selectCapabilities(input: {
  readonly intent: RequestIntent;
  readonly inventory: CapabilityInventory;
  readonly failedMcp: readonly string[];
}): CapabilityPlan {
  const availableMcp = input.inventory.mcp.map(server => server.name);
  const availableSkills = input.inventory.skills.map(skill => skill.name);

  const hasMcp = (name: string) => availableMcp.includes(name);
  const hasSkill = (name: string) => availableSkills.includes(name);
  const notFailed = (name: string) => !input.failedMcp.includes(name);

  const optionalMcp = (...names: string[]) =>
    names.filter(name => hasMcp(name) && notFailed(name));

  const selectedSkills = (...names: string[]) =>
    names.filter(name => hasSkill(name));

  switch (input.intent) {
    case 'status':
      return {
        availableMcp,
        requiredMcp: [],
        optionalMcp: optionalMcp('omk-project', 'memory'),
        disabledMcp: input.failedMcp,
        availableSkills,
        selectedSkills: selectedSkills('omk-context-broker', 'omk-project-rules'),
        toolCallingRequired: false,
        liveMcpRequired: false,
        failurePolicy: 'required-only',
      };

    case 'repo_read':
      return {
        availableMcp,
        requiredMcp: hasMcp('filesystem-readonly') ? ['filesystem-readonly'] : [],
        optionalMcp: optionalMcp('omk-project', 'memory'),
        disabledMcp: input.failedMcp,
        availableSkills,
        selectedSkills: selectedSkills('omk-repo-explorer', 'omk-project-rules'),
        toolCallingRequired: hasMcp('filesystem-readonly'),
        liveMcpRequired: hasMcp('filesystem-readonly'),
        failurePolicy: 'required-only',
      };

    case 'code_edit':
      return {
        availableMcp,
        requiredMcp: hasMcp('filesystem') ? ['filesystem'] : [],
        optionalMcp: optionalMcp('omk-project', 'memory', 'sqlite'),
        disabledMcp: input.failedMcp,
        availableSkills,
        selectedSkills: selectedSkills(
          'omk-flow-feature-dev',
          'omk-typescript-strict',
          'omk-quality-gate',
          'omk-test-debug-loop',
        ),
        toolCallingRequired: true,
        liveMcpRequired: true,
        failurePolicy: 'required-only',
      };

    case 'web_research':
      return {
        availableMcp,
        requiredMcp: hasMcp('fetch') ? ['fetch'] : [],
        optionalMcp: optionalMcp('web-reader', 'playwright', 'omk-project'),
        disabledMcp: input.failedMcp,
        availableSkills,
        selectedSkills: selectedSkills('omk-research-verify'),
        toolCallingRequired: true,
        liveMcpRequired: true,
        failurePolicy: 'required-only',
      };

    default:
      return {
        availableMcp,
        requiredMcp: [],
        optionalMcp: optionalMcp('omk-project', 'memory'),
        disabledMcp: input.failedMcp,
        availableSkills,
        selectedSkills: selectedSkills('omk-context-broker'),
        toolCallingRequired: false,
        liveMcpRequired: false,
        failurePolicy: 'required-only',
      };
  }
}
```

---

## 8. Failure Policy

### 8.1 잘못된 현재 정책

```txt
mcpFailures.length > 0 → exit=1
```

이 정책은 status/query/chat에서 치명적이다. optional MCP failure가 전체 turn failure로 승격된다.

### 8.2 올바른 정책

```ts
export interface FailurePolicyResult {
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly exitCode: 0 | 1;
}

export function applyMcpFailurePolicy(input: {
  readonly requiredMcp: readonly string[];
  readonly failedMcp: readonly string[];
  readonly failurePolicy: 'required-only' | 'strict';
}): FailurePolicyResult {
  if (input.failurePolicy === 'strict') {
    return {
      blockers: input.failedMcp,
      warnings: [],
      exitCode: input.failedMcp.length > 0 ? 1 : 0,
    };
  }

  const blockers = input.failedMcp.filter(name => input.requiredMcp.includes(name));
  const warnings = input.failedMcp.filter(name => !input.requiredMcp.includes(name));

  return {
    blockers,
    warnings,
    exitCode: blockers.length > 0 ? 1 : 0,
  };
}
```

### 8.3 status query의 기대 결과

입력:

```txt
intent=status
requiredMcp=[]
optionalMcp=[omk-project, memory]
failedMcp=[omk-web-bridge]
```

결과:

```txt
blockers=[]
warnings=[omk-web-bridge]
exitCode=0
```

---

## 9. Debloat-to-NLP Compiler

### 9.1 목적

비대한 OMK prompt envelope를 provider model이 읽기 위한 짧은 자연어 prompt와 runtime sidecar로 분리한다.

```txt
Raw OMK Envelope
  ├─ modelPrompt: short natural language instruction
  └─ runtimeSidecar: machine execution metadata
```

### 9.2 Compiler Input / Output

```ts
export interface DebloatInput {
  readonly envelope: CommandEnvelope;
  readonly intent: RequestIntent;
  readonly risk: 'read' | 'write' | 'network' | 'dangerous';
  readonly capabilityPlan: CapabilityPlan;
  readonly provider: string;
  readonly model: string;
}

export interface DebloatOutput {
  readonly modelPrompt: string;
  readonly runtimeSidecar: RuntimeSidecar;
  readonly diagnostics: DebloatDiagnostics;
}

export interface DebloatDiagnostics {
  readonly originalChars: number;
  readonly finalChars: number;
  readonly compressionRatio: number;
  readonly removedSections: readonly string[];
  readonly warnings: readonly string[];
}
```

### 9.3 Prompt Renderer

```ts
export function renderModelPrompt(input: {
  readonly userRequest: string;
  readonly intent: RequestIntent;
  readonly provider: string;
  readonly model: string;
  readonly risk: string;
  readonly sandbox: string;
  readonly plan: CapabilityPlan;
  readonly warnings: readonly string[];
}): string {
  const lines: string[] = [];

  lines.push('You are the OMK root coordinator.');
  lines.push('');
  lines.push(`User request: ${JSON.stringify(input.userRequest)}`);
  lines.push('');
  lines.push(`Intent: ${input.intent}`);
  lines.push(`Risk: ${input.risk}`);
  lines.push(`Sandbox: ${input.sandbox}`);
  lines.push('');

  if (input.plan.requiredMcp.length > 0) {
    lines.push(`Required capabilities: ${input.plan.requiredMcp.join(', ')}`);
  } else {
    lines.push('Required capabilities: none');
  }

  if (input.plan.optionalMcp.length > 0) {
    lines.push(`Optional capabilities: ${input.plan.optionalMcp.join(', ')}`);
  }

  if (input.plan.selectedSkills.length > 0) {
    lines.push(`Selected skills: ${input.plan.selectedSkills.join(', ')}`);
  }

  if (input.warnings.length > 0) {
    lines.push('');
    lines.push(`Warnings: ${input.warnings.join(', ')} unavailable; continue unless required.`);
  }

  lines.push('');
  lines.push('Instructions:');
  lines.push('- Answer the user request directly.');
  lines.push('- Do not activate unrelated capabilities.');
  lines.push('- Treat optional capability failures as warnings.');
  lines.push('- If project state is unavailable, say so briefly.');
  lines.push('- Keep the answer concise and operational.');

  return lines.join('\n');
}
```

### 9.4 Example: 현재 상태는 어때

Before:

```txt
- User request: 9 characters
- Prompt: OMK envelope + 67 skills + 21 MCP + raw TurnBegin + StatusUpdate
- Runtime: kimi-print
- Result: omk-web-bridge failure exits turn
```

After:

```txt
You are the OMK root coordinator.

User request: "현재 상태는 어때"

Intent: status
Risk: read
Sandbox: read-only

Required capabilities: none
Optional capabilities: omk-project, memory
Selected skills: omk-context-broker, omk-project-rules

Warnings: omk-web-bridge unavailable; continue unless required.

Instructions:
- Report current OMK project/runtime status concisely.
- Do not activate unrelated capabilities.
- Treat optional capability failures as warnings.
- If no active project state is available, say so briefly.
```

---

## 10. Per-Turn MCP Config Filtering

### 10.1 문제

Preset에서 MCP를 줄여도 provider runtime이 `~/.kimi/mcp.json` 전체를 읽으면 다시 21개가 켜진다.

### 10.2 정책

매 turn마다 sidecar 기준으로 임시 MCP config를 생성한다.

```txt
Allowed MCP = requiredMcp ∪ optionalMcp - disabledMcp
```

### 10.3 Implementation

```ts
export interface McpConfig {
  readonly mcpServers: Record<string, unknown>;
}

export function filterMcpConfigForTurn(input: {
  readonly userMcpConfig: McpConfig;
  readonly projectMcpConfig: McpConfig;
  readonly sidecar: RuntimeSidecar;
}): McpConfig {
  const allowed = new Set([
    ...input.sidecar.requiredMcp,
    ...input.sidecar.optionalMcp,
  ]);

  const disabled = new Set(input.sidecar.disabledMcp);

  const merged = {
    ...input.userMcpConfig.mcpServers,
    ...input.projectMcpConfig.mcpServers,
  };

  return {
    mcpServers: Object.fromEntries(
      Object.entries(merged).filter(([name]) => {
        return allowed.has(name) && !disabled.has(name);
      }),
    ),
  };
}
```

### 10.4 status query의 기대 임시 mcp.json

```json
{
  "mcpServers": {
    "omk-project": {},
    "memory": {}
  }
}
```

혹은 memory가 unavailable이면:

```json
{
  "mcpServers": {
    "omk-project": {}
  }
}
```

아예 상태를 local runtime에서 알 수 있다면:

```json
{
  "mcpServers": {}
}
```

---

## 11. Provider Runtime Selection

### 11.1 문제

현재 관찰 로그에서는 `Selected runtime: kimi-print`로 선택된다. 이 runtime은 provider stdout/raw event를 그대로 print하는 경향이 있으므로 theme/NLP를 우회한다.

### 11.2 정책

```txt
kimi-event 또는 kimi-wire:
  default interactive runtime

kimi-print:
  --debug-raw 또는 OMK_DEBUG_RAW_PROVIDER=1에서만 허용
```

### 11.3 Implementation

```ts
export function selectProviderRuntime(input: {
  readonly provider: string;
  readonly intent: RequestIntent;
  readonly debugRaw: boolean;
}): RuntimeSidecar['runtime'] {
  if (input.provider === 'kimi') {
    if (input.debugRaw) return 'kimi-print';
    return 'kimi-event';
  }

  if (input.provider === 'codex') return 'codex';
  if (input.provider === 'claude') return 'claude';

  return 'kimi-event';
}
```

### 11.4 Regression Rule

```ts
expect(selectProviderRuntime({ provider: 'kimi', intent: 'status', debugRaw: false }))
  .not.toBe('kimi-print');

expect(selectProviderRuntime({ provider: 'kimi', intent: 'status', debugRaw: true }))
  .toBe('kimi-print');
```

---

## 12. ProviderEventNormalizer

### 12.1 목적

Provider raw event를 사용자에게 그대로 보여주지 않는다.

금지되는 raw output:

```txt
TurnBegin(...)
StatusUpdate(...)
MCPLoadingBegin()
MCPLoadingEnd()
MCPStatusSnapshot(...)
TextPart(...)
```

이들은 다음 OMK UI event로 정규화되어야 한다.

```ts
export type OmkEvent =
  | { type: 'turn_started'; nodeId: string; provider: string; model: string }
  | { type: 'progress'; message: string }
  | { type: 'mcp_status'; connected: number; total: number; failed: readonly string[] }
  | { type: 'warning'; message: string; code?: string }
  | { type: 'result'; content: string }
  | { type: 'error'; message: string; code: string; fatal: boolean }
  | { type: 'turn_finished'; exitCode: number; durationMs: number };
```

### 12.2 Normalizer Interface

```ts
export interface ProviderEventNormalizer {
  normalize(chunk: ProviderRawChunk): readonly OmkEvent[];
  flush(): readonly OmkEvent[];
}

export interface ProviderRawChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly at: string;
}
```

### 12.3 Kimi Normalizer Example

```ts
export class KimiEventNormalizer implements ProviderEventNormalizer {
  normalize(chunk: ProviderRawChunk): readonly OmkEvent[] {
    const events: OmkEvent[] = [];

    if (chunk.text.includes('MCPLoadingBegin')) {
      events.push({ type: 'progress', message: 'Loading selected MCP servers...' });
    }

    const failure = parseMcpFailure(chunk.text);
    if (failure) {
      events.push({
        type: 'warning',
        code: 'OPTIONAL_MCP_UNAVAILABLE',
        message: `Optional MCP unavailable: ${failure.serverName}`,
      });
    }

    const status = parseMcpStatusSnapshot(chunk.text);
    if (status) {
      events.push({
        type: 'mcp_status',
        connected: status.connected,
        total: status.total,
        failed: status.failedServers,
      });
    }

    return events;
  }

  flush(): readonly OmkEvent[] {
    return [];
  }
}
```

---

## 13. OutputRouter

### 13.1 stdout/stderr 정책

```txt
stdout:
  - 최종 답변
  - JSON/JSONL machine output
  - markdown/nlp report

stderr:
  - progress
  - warnings
  - debug routing
  - MCP loading status
  - provider diagnostics
```

### 13.2 Interface

```ts
export interface OutputRouter {
  onEvent(event: OmkEvent): void;
  complete(result: CommandResult): void;
  fail(error: OmkError): void;
}
```

### 13.3 Implementation Sketch

```ts
export class DefaultOutputRouter implements OutputRouter {
  constructor(
    private readonly profile: OutputProfile,
    private readonly theme: ThemeRenderer,
    private readonly nlp: NlpRenderer,
    private readonly json: JsonRenderer,
    private readonly streams: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream },
  ) {}

  onEvent(event: OmkEvent): void {
    if (this.profile.rawProvider) {
      return;
    }

    if (event.type === 'progress') {
      this.streams.stderr.write(this.theme.renderProgress(event) + '\n');
      return;
    }

    if (event.type === 'warning') {
      this.streams.stderr.write(this.theme.renderWarning(event) + '\n');
      return;
    }

    if (event.type === 'error') {
      this.streams.stderr.write(this.theme.renderError(event) + '\n');
      return;
    }
  }

  complete(result: CommandResult): void {
    if (this.profile.format === 'json') {
      this.streams.stdout.write(this.json.render(result) + '\n');
      return;
    }

    if (this.profile.format === 'nlp') {
      this.streams.stdout.write(this.nlp.render(result) + '\n');
      return;
    }

    this.streams.stdout.write(this.theme.renderResult(result) + '\n');
  }

  fail(error: OmkError): void {
    this.streams.stderr.write(this.theme.renderFatal(error) + '\n');
  }
}
```

---

## 14. Theme Architecture

### 14.1 원칙

Theme는 색상 함수가 아니라 semantic renderer다.

나쁜 방식:

```ts
console.log(chalk.green('Done'));
```

좋은 방식:

```ts
writer.success('Done');
writer.warning('Optional MCP unavailable: omk-web-bridge');
writer.status({ provider, model, runtime });
```

### 14.2 Theme Schema

```ts
export interface ThemeDefinition {
  readonly name: string;
  readonly displayName: string;
  readonly mode: 'dark' | 'light' | 'auto' | 'mono';
  readonly tokens: ThemeTokens;
  readonly icons: ThemeIcons;
  readonly layout: ThemeLayout;
}

export interface ThemeTokens {
  readonly text: string;
  readonly muted: string;
  readonly primary: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly info: string;
  readonly border: string;
  readonly provider: string;
  readonly mcp: string;
  readonly skill: string;
  readonly memory: string;
  readonly trace: string;
}

export interface ThemeIcons {
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly info: string;
  readonly running: string;
  readonly provider: string;
  readonly mcp: string;
}

export interface ThemeLayout {
  readonly compact: boolean;
  readonly useUnicode: boolean;
  readonly maxWidth: number;
}
```

### 14.3 Terminal Capability

```ts
export interface TerminalCapability {
  readonly isTty: boolean;
  readonly supportsColor: boolean;
  readonly colorDepth: 1 | 4 | 8 | 24;
  readonly supportsUnicode: boolean;
  readonly width: number;
  readonly noColor: boolean;
  readonly ci: boolean;
}
```

정책:

```txt
NO_COLOR=true       → mono
TERM=dumb           → mono
CI=true             → compact + no spinner
stdout non-TTY      → progress stderr only
--color=always      → force color
--no-color          → mono
```

---

## 15. NLP Renderer

### 15.1 목적

NLP renderer는 provider prompt compiler와 다르다.

```txt
Debloat-to-NLP Compiler:
  provider에게 보낼 짧은 자연어 지시문 생성

NlpRenderer:
  사용자에게 보여줄 자연어 결과/상태 리포트 생성
```

### 15.2 Interface

```ts
export interface NlpRenderer {
  render(result: CommandResult): string;
  renderStatus(status: OmkStatusResult): string;
  renderError(error: OmkError): string;
}
```

### 15.3 status output 예시

```txt
OMK is running in read-only chat mode.

Provider:
- kimi / kimi-code default

Runtime:
- kimi-event

MCP:
- Required: none
- Optional: omk-project, memory
- Warning: omk-web-bridge is unavailable and was ignored for this status request.

No active run state was found.
```

---

## 16. Slash Command Architecture

### 16.1 문제

현재 `/model`은 단순 local print로 보인다.

```txt
/model
Current model: kimi-code default
Usage: /model codex/codex-cli
```

이 구조에서는 theme, NLP, session state, runtime sidecar와 연결되지 않는다.

### 16.2 목표 구조

```txt
REPL input: /model
        ↓
SlashCommandParser
        ↓
CommandBus.dispatch({ kind: 'model.show' })
        ↓
ModelCommandHandler
        ↓
CommandResult
        ↓
OutputRouter
        ↓
ThemeRenderer or NlpRenderer
```

### 16.3 Slash Command Result

```ts
export interface SlashCommandResult {
  readonly kind: 'status' | 'mutation' | 'error';
  readonly command: string;
  readonly payload: unknown;
  readonly renderMode: 'theme' | 'nlp' | 'json';
  readonly sideEffects: readonly RuntimeSideEffect[];
}

export type RuntimeSideEffect =
  | { type: 'provider_changed'; provider: string; model: string }
  | { type: 'session_updated'; sessionId: string }
  | { type: 'memory_written'; memoryId: string }
  | { type: 'theme_changed'; theme: string };
```

### 16.4 `/model` Handler

```ts
export class ModelCommandHandler {
  async execute(input: SlashCommandInput): Promise<SlashCommandResult> {
    if (!input.args[0]) {
      return {
        kind: 'status',
        command: 'model.show',
        payload: {
          currentProvider: input.state.provider,
          currentModel: input.state.model,
          usage: '/model <provider>/<model>',
        },
        renderMode: 'theme',
        sideEffects: [],
      };
    }

    const parsed = parseProviderModel(input.args[0]);

    return {
      kind: 'mutation',
      command: 'model.set',
      payload: parsed,
      renderMode: 'theme',
      sideEffects: [
        { type: 'provider_changed', provider: parsed.provider, model: parsed.model },
        { type: 'session_updated', sessionId: input.state.sessionId },
      ],
    };
  }
}
```

---

## 17. Persistent Project Memory Integration

### 17.1 목표

프로젝트 폴더로 들어가면 이전 세션의 상태를 자동 복원한다.

```txt
cd project
omk

→ last session, open todos, decisions, current branch, known failure patterns를 자동 로드
```

### 17.2 Memory Mount Flow

```txt
cwd
  ↓
ProjectRootResolver
  ↓
ProjectIdResolver
  ↓
MemoryStore.open(projectId)
  ↓
ProjectStateCapsule load
  ↓
Intent-specific retrieval
  ↓
Context injection to planner/provider prompt
```

### 17.3 State Capsule

```ts
export interface ProjectStateCapsule {
  readonly projectId: string;
  readonly rootPath: string;
  readonly projectName: string;
  readonly currentBranch?: string;

  readonly lastSession?: {
    readonly sessionId: string;
    readonly endedAt: string;
    readonly summary: string;
    readonly lastGoal?: string;
  };

  readonly activeTodos: readonly CapsuleTodo[];
  readonly recentDecisions: readonly CapsuleDecision[];
  readonly projectInvariants: readonly string[];
  readonly preferredCommands: readonly string[];
  readonly knownFailurePatterns: readonly string[];
  readonly importantFiles: readonly string[];
  readonly openQuestions: readonly string[];

  readonly updatedAt: string;
}
```

### 17.4 Memory as Runtime State

Memory는 provider prompt에 무식하게 전부 넣지 않는다.

```txt
Planner:
  capsule summary + relevant decisions

Status:
  last session + active todos + runtime state

Code edit:
  task-local memory + project rules + failure patterns

Reviewer:
  decisions + quality gate + known regressions
```

---

## 18. End-to-End Flow Examples

### 18.1 `현재 상태는 어때`

```txt
Input: 현재 상태는 어때
  ↓
CommandBus: chat.turn
  ↓
IntentClassifier: status
  ↓
RiskClassifier: read
  ↓
CapabilitySelector:
    requiredMcp=[]
    optionalMcp=[omk-project, memory]
    selectedSkills=[omk-context-broker, omk-project-rules]
  ↓
RuntimeSidecar:
    provider=kimi
    runtime=kimi-event
    failurePolicy=required-only
  ↓
Filtered MCP config:
    omk-project, memory only
  ↓
Model prompt:
    concise status request
  ↓
ProviderEventNormalizer:
    raw events → warning/status/progress
  ↓
OutputRouter:
    theme or nlp result
```

Expected result:

```txt
OMK status

Provider: kimi / kimi-code default
Runtime: kimi-event
Mode: read-only

MCP:
- Required: none
- Optional: omk-project, memory

No active run state found.
```

### 18.2 `CLI input parser 고쳐줘`

```txt
Intent: code_edit
Risk: write
Required MCP: filesystem
Optional MCP: omk-project, memory, sqlite
Selected skills: omk-flow-feature-dev, omk-typescript-strict, omk-quality-gate
Sandbox: workspace-write
Failure policy: required-only
```

Expected behavior:

```txt
filesystem unavailable → blocker
memory unavailable → warning
omk-web-bridge unavailable → ignored
```

### 18.3 `/model codex/codex-cli`

```txt
SlashCommandParser
  ↓
CommandBus: model.set
  ↓
Session state mutation
  ↓
Runtime sidecar update
  ↓
OutputRouter
```

Expected output:

```txt
Model switched.

Provider: codex
Model: codex-cli
This change applies to the current OMK session.
```

---

## 19. Migration Plan

### Phase 0 — Hotfix

목표: 현재 장애를 즉시 줄인다.

```txt
1. `MUST activate all` 제거
2. available/required/optional capability 분리
3. optional MCP failure warning 처리
4. status intent requiredMcp=[] 강제
5. `kimi-print`를 debug raw에서만 사용
```

Suggested commits:

```txt
fix(runtime): split capability inventory from required activation
fix(kimi): demote optional mcp connection failures
fix(chat): stop emitting all skills and mcp as mandatory routing hints
fix(runtime): avoid kimi-print outside debug raw mode
```

### Phase 1 — RuntimeSidecar

```txt
1. RuntimeSidecar type 추가
2. ProviderAdapter input을 {modelPrompt, sidecar}로 변경
3. per-turn MCP config 생성
4. prompt envelope를 sidecar로 이동
```

Suggested commits:

```txt
feat(runtime): introduce runtime sidecar for provider execution
feat(kimi): filter mcp config per turn from runtime sidecar
```

### Phase 2 — ProviderEventNormalizer + OutputRouter

```txt
1. provider raw stdout/stderr 수집
2. Kimi raw event parser 추가
3. OMK event로 normalize
4. OutputRouter로만 출력
5. raw mode는 --debug-raw에서만 허용
```

Suggested commits:

```txt
feat(output): route provider events through omk output router
feat(kimi): normalize raw kimi status events before rendering
```

### Phase 3 — Theme / NLP Renderer Activation

```txt
1. ThemeRenderer semantic tokens 정리
2. NlpRenderer status/error/result 구현
3. output profile을 chat path에 강제 적용
4. CI/no-color/non-tty 대응
```

Suggested commits:

```txt
feat(theme): apply semantic renderer to interactive chat output
feat(nlp): enable deterministic status and error reports
```

### Phase 4 — Slash Command CommandBus Migration

```txt
1. SlashCommandParser 추가
2. /model, /status, /memory, /theme부터 CommandBus로 이동
3. SlashCommandResult 도입
4. session state mutation과 memory 기록 연결
```

Suggested commits:

```txt
refactor(repl): route slash commands through command bus
feat(repl): persist provider changes in interactive session state
```

### Phase 5 — CLI Framework Migration

추천 후보:

```txt
1순위: Clipanion + Clack + custom renderer
2순위: oclif + Clack
3순위: Commander/Yargs + Clack
장기 후보: Rust clap + ratatui 또는 Go Cobra + Bubble Tea
```

주의:

```txt
CLI framework만 바꾸면 문제가 해결되지 않는다.
반드시 RuntimeSidecar / OutputRouter / ProviderEventNormalizer를 먼저 넣어야 한다.
```

---

## 20. Regression Tests

### 20.1 status does not load all MCP

```ts
it('does not load all MCP servers for status intent', () => {
  const sidecar = buildTurnSidecar({
    userRequest: '현재 상태는 어때',
    inventory: inventoryWith21Mcp(),
  });

  expect(sidecar.intent).toBe('status');
  expect(sidecar.requiredMcp).toEqual([]);
  expect(sidecar.optionalMcp.length).toBeLessThanOrEqual(2);
  expect(sidecar.optionalMcp).toContain('omk-project');
});
```

### 20.2 no MUST activate leakage

```ts
it('does not leak full inventory into provider prompt', () => {
  const { modelPrompt } = compileTurnPrompt({
    userRequest: '현재 상태는 어때',
    inventory: inventoryWith21McpAnd67Skills(),
  });

  expect(modelPrompt).not.toContain('MUST activate');
  expect(modelPrompt).not.toContain('MUST use');
  expect(modelPrompt).not.toContain('filesystem, codex, web-reader');
  expect(modelPrompt.length).toBeLessThan(1200);
});
```

### 20.3 optional MCP failure is warning

```ts
it('treats optional MCP failure as warning', () => {
  const result = applyMcpFailurePolicy({
    requiredMcp: [],
    failedMcp: ['omk-web-bridge'],
    failurePolicy: 'required-only',
  });

  expect(result.exitCode).toBe(0);
  expect(result.blockers).toEqual([]);
  expect(result.warnings).toEqual(['omk-web-bridge']);
});
```

### 20.4 kimi-print debug only

```ts
it('does not select kimi-print unless debug raw is enabled', () => {
  expect(selectProviderRuntime({
    provider: 'kimi',
    intent: 'status',
    debugRaw: false,
  })).not.toBe('kimi-print');

  expect(selectProviderRuntime({
    provider: 'kimi',
    intent: 'status',
    debugRaw: true,
  })).toBe('kimi-print');
});
```

### 20.5 raw provider event not visible

```ts
it('does not show raw provider event objects in normal output', async () => {
  const output = await runInteractiveTurn('현재 상태는 어때');

  expect(output.stdout).not.toContain('TurnBegin(');
  expect(output.stdout).not.toContain('StatusUpdate(');
  expect(output.stdout).not.toContain('MCPStatusSnapshot(');
});
```

### 20.6 slash command goes through OutputRouter

```ts
it('routes slash command through command bus and output router', async () => {
  const result = await repl.handleLine('/model');

  expect(result.command).toBe('model.show');
  expect(result.renderedBy).toBe('OutputRouter');
  expect(result.rawConsoleLogUsed).toBe(false);
});
```

---

## 21. CLI v2 Candidate Recommendation

### 21.1 Recommended Stack

```txt
Parser / Command Tree:
  Clipanion

Interactive prompts:
  Clack

Rendering:
  custom OMK ThemeRenderer / NlpRenderer

Runtime:
  existing OMK orchestration core + RuntimeSidecar

Provider layer:
  ProviderAdapter abstraction
```

### 21.2 Why Clipanion + Clack

```txt
- TypeScript strict와 잘 맞음
- nested command tree에 강함
- OMK의 /run, /chat, /memory, /doctor, /theme, /provider 구조에 적합
- Clack으로 interactive UX를 정리하기 좋음
- renderer는 직접 통제해야 theme/NLP가 보장됨
```

### 21.3 Non-goal

```txt
- CLI framework migration으로 P0 runtime bug를 해결하려 하지 않는다.
- Kimi 전용 SDK에 CLI 전체를 종속하지 않는다.
- provider raw stdout을 user output으로 쓰지 않는다.
```

---

## 22. Implementation Checklist

### P0 Checklist

```txt
[ ] CapabilityPlan type 추가
[ ] available/required/optional split 적용
[ ] Prompt에서 full skill/MCP inventory 제거
[ ] `MUST activate` / `MUST use` 문구 제거
[ ] status intent requiredMcp=[] 테스트 추가
[ ] optional MCP failure warning 처리
[ ] per-turn filtered mcp.json 생성
[ ] kimi-print debug-only 처리
```

### P1 Checklist

```txt
[ ] RuntimeSidecar Builder 추가
[ ] Debloat-to-NLP Compiler 추가
[ ] ProviderEventNormalizer 추가
[ ] OutputRouter 추가
[ ] ThemeRenderer를 chat path에 강제 적용
[ ] NlpRenderer status/error 구현
[ ] `/model` CommandBus migration
[ ] `/status` CommandBus migration
[ ] raw provider event regression test 추가
```

### P2 Checklist

```txt
[ ] Clipanion 기반 cli-v2 skeleton 추가
[ ] Clack 기반 interactive prompt 추가
[ ] 기존 CLI와 cli-v2 병렬 실행 플래그 추가
[ ] `OMK_CLI_V2=1` smoke test 추가
[ ] docs/runtime-architecture.md 추가
[ ] docs/cli-v2-migration.md 추가
```

---

## 23. Final Target Behavior

### Before

```txt
User: 현재 상태는 어때

OMK:
- 67 skills dump
- 21 MCP dump
- MUST activate all
- TurnBegin raw object 출력
- StatusUpdate raw object 출력
- omk-web-bridge failure
- exit=1
```

### After

```txt
User: 현재 상태는 어때

OMK status

Provider:
- kimi / kimi-code default

Runtime:
- kimi-event

Mode:
- read-only

Capabilities:
- Required MCP: none
- Optional MCP: omk-project, memory
- Ignored MCP: 19 unrelated servers
- Warning: omk-web-bridge unavailable, ignored for this request

Project:
- No active run state found.
```

Exit code:

```txt
0
```

Provider prompt length:

```txt
Before: 30k+ chars
After: < 1.2k chars for status intent
```

MCP loading:

```txt
Before: 21 servers
After: 0~2 servers for status intent
```

---

## 24. Closing Architecture Decision

최종 결정은 다음이다.

```txt
ADR-001:
OMK v2는 provider-neutral orchestration envelope를 model prompt로 보내지 않는다.
Envelope는 RuntimeSidecar로 컴파일하고,
model prompt는 Debloat-to-NLP Compiler가 생성한 최소 자연어 지시문만 사용한다.

ADR-002:
Capability inventory는 activation requirement가 아니다.
requiredMcp와 optionalMcp는 IntentClassifier + CapabilitySelector가 turn 단위로 결정한다.

ADR-003:
Provider raw output은 user output이 아니다.
모든 provider event는 ProviderEventNormalizer와 OutputRouter를 통과해야 한다.

ADR-004:
Slash command도 일반 command와 동일하게 CommandBus를 통과한다.
Plain console print 기반 slash command는 금지한다.

ADR-005:
kimi-print는 debug raw runtime이다.
기본 interactive runtime은 event-normalized runtime이어야 한다.
```

---

## 25. Recommended Next Commit Sequence

```txt
1. fix(runtime): split capability inventory from required activation
2. fix(chat): remove mandatory all-skill and all-mcp routing directives
3. fix(kimi): filter MCP config per turn from runtime sidecar
4. fix(kimi): demote optional MCP connection failures to warnings
5. fix(runtime): disable kimi-print outside debug raw mode
6. feat(prompt): compile prompt envelope into NLP prompt and runtime sidecar
7. feat(output): normalize provider events before rendering
8. feat(theme): route interactive chat output through theme renderer
9. feat(nlp): add deterministic status and error renderer
10. refactor(repl): route slash commands through command bus
11. test(regression): status turn must not load unrelated MCP servers
12. test(regression): optional omk-web-bridge failure must not exit 1
```

---

## 26. Success Metrics

```txt
Metric 1: status prompt size
  Target: < 1,200 chars

Metric 2: status MCP count
  Target: <= 2

Metric 3: optional MCP failure exit behavior
  Target: exit=0 for non-required failures

Metric 4: raw provider event leakage
  Target: 0 occurrences of TurnBegin/StatusUpdate in normal stdout

Metric 5: theme application
  Target: 100% human-facing normal output goes through ThemeRenderer

Metric 6: slash command integration
  Target: /model, /status, /memory, /theme all return CommandResult

Metric 7: JSON machine safety
  Target: `omk run --output json > result.json` contains valid JSON only
```

---

## 27. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|---|---:|---:|---|
| Provider raw event parser가 불완전함 | Medium | Medium | raw mode 유지, parser fixture test 추가 |
| CapabilitySelector가 필요한 MCP를 과소선택함 | Medium | High | intent별 regression, `--explain-routing` 제공 |
| Slash command migration 중 기존 UX 깨짐 | Medium | Medium | legacy alias 유지, CommandBus smoke test |
| ThemeRenderer가 non-TTY/CI에서 깨짐 | Low | Medium | terminal capability detection |
| Kimi isolated HOME이 user config를 다시 읽음 | Medium | High | explicit mcp config file path 강제 |
| NLP renderer가 결과를 과장함 | Medium | Medium | deterministic template 우선, source result hash 포함 |

---

## 28. Decision Summary

지금 당장 필요한 것은 “예쁜 테마”나 “NLP 출력 옵션”을 덧붙이는 게 아니다.

먼저 runtime을 다음처럼 분리해야 한다.

```txt
Control-plane:
  CommandEnvelope, CapabilityInventory, RuntimeSidecar, Provider config

Data-plane:
  modelPrompt, provider response, normalized events, rendered output
```

이 분리가 끝나야 theme, NLP, slash command, memory, MCP 안정화가 모두 정상 작동한다.

최종 권장 순서는 다음이다.

```txt
1. CapabilityPlan
2. RuntimeSidecar
3. Per-turn MCP filtering
4. FailurePolicy
5. ProviderEventNormalizer
6. OutputRouter
7. Theme/NLP Renderer
8. Slash Command CommandBus
9. CLI v2 framework migration
```
