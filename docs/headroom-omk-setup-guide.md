# Headroom OMK 설정 가이드

## 1. 설치 상태 확인

### Headroom 설치 확인
```bash
python3 -c "import headroom; print('Headroom version:', headroom.__version__)"
```

### OMK Extensions 확인
```bash
ls -la $OMK_RUNTIME_HOME/extensions/
```

### OMK Skills 확인
```bash
ls -la $OMK_RUNTIME_HOME/.agents/skills/headroom/
```

## 2. OMK 런타임 통합 대상 설명

### 2.1 Headroom Skill
- **설치 대상 위치**: `$OMK_RUNTIME_HOME/.agents/skills/headroom/SKILL.md`
- **목적**: headroom 컨텍스트 압축 기능 제공
- **사용법**: `/skill:headroom` 또는 자동 로딩

### 2.2 병렬 에이전트 Extension
- **설치 대상 위치**: `$OMK_RUNTIME_HOME/extensions/parallel-agents/index.ts`
- **목적**:多个 서브에이전트를 병렬로 스폰 및 관리
- **도구**:
  - `spawn_parallel_agents`:多个 에이전트 스폰
  - `check_parallel_agents`: 에이전트 상태 확인
  - `coordinate_agent_results`: 결과 조정

### 2.3 오케스트레이터 Extension
- **설치 대상 위치**: `$OMK_RUNTIME_HOME/extensions/orchestrator/index.ts`
- **목적**: 서브에이전트를 목표 지향적으로 오케스트레이션
- **도구**:
  - `orchestrate_goal`: 주요 오케스트레이션 도구
  - `orchestrator_status`: 오케스트레이터 상태 확인
  - `equip_agent`: 에이전트 장비 설정

### 2.4 Headroom 통합 Extension
- **설치 대상 위치**: `$OMK_RUNTIME_HOME/extensions/headroom-integration/index.ts`
- **목적**: headroom 압축을 OMK에 통합
- **도구**:
  - `headroom_install`: headroom 설치
  - `headroom_compress`: 컨텍스트 압축
  - `headroom_stats`: 압축 통계
  - `headroom_proxy`: 프록시 서버 시작

## 3. 사용 방법

### 3.1 OMK에서 Extensions 사용

OMK에서 extensions가 설치되어 있을 때 사용하는 방법:

1. **Extensions 자동 로딩**: 설치된 OMK runtime extension은 OMK 시작 시 자동 로딩됩니다
2. **수동 로딩**: `/reload` 명령어로 리로드
3. **도구 사용**: LLM이 도구를 호출하여 사용

### 3.2 Skills 사용

Skills를 사용하려면:

1. **자동 로딩**: 스킬이 자동으로 로딩됩니다
2. **수동 로딩**: `/skill:headroom` 명령어
3. **명령어 사용**: `/headroom:compress`, `/headroom:stats` 등

### 3.3 병렬 에이전트 사용

병렬 에이전트를 사용하려면:

```typescript
// 예시: 3개의 병렬 에이전트 스폰
spawn_parallel_agents({
  goal: "코드베이스 보안 분석",
  agents: [
    {
      id: "agent-1",
      task: "SQL 인젝션 취약점 스캔",
      skills: ["security-scanner"],
      hooks: ["pre-commit"],
      mcpServers: ["vulnerability-db"]
    },
    {
      id: "agent-2",
      task: "인증 결함 검사",
      skills: ["auth-analyzer"],
      hooks: ["post-commit"],
      mcpServers: ["auth-patterns"]
    },
    {
      id: "agent-3",
      task: "권한 부여 문제 분석",
      skills: ["authorization-checker"],
      hooks: ["security-check"],
      mcpServers: ["permission-db"]
    }
  ],
  coordination: "결과를 공유하고 교차 검증"
})
```

### 3.4 오케스트레이터 사용

오케스트레이터를 사용하려면:

```typescript
// 예시: REST API 구축 오케스트레이션
orchestrate_goal({
  goal: "JWT 인증이 있는 REST API 구축",
  subAgents: [
    {
      id: "api-designer",
      task: "API 엔드포인트 및 스키마 설계",
      skills: ["api-design", "openapi"],
      hooks: ["validation"],
      mcpServers: ["api-standards"]
    },
    {
      id: "auth-specialist",
      task: "JWT 인증 구현",
      skills: ["jwt", "oauth2"],
      hooks: ["security-check"],
      mcpServers: ["auth-providers"]
    },
    {
      id: "database-engineer",
      task: "데이터베이스 스키마 설계 및 구현",
      skills: ["database-design", "migration"],
      hooks: ["backup"],
      mcpServers: ["database-tools"]
    }
  ],
  strategy: "parallel",
  timeout: 600
})
```

### 3.5 Headroom 통합 사용

Headroom 통합을 사용하려면:

```typescript
// 예시: 컨텍스트 압축
headroom_compress({
  messages: [
    { role: "user", content: "대용량 코드 출력..." }
  ],
  model: "claude-3-5-sonnet-20241022"
})

// 예시: 압축 통계 확인
headroom_stats({ detailed: true })

// 예시: 프록시 서버 시작
headroom_proxy({ port: 8787, background: true })
```

## 4. 통합 워크플로우

### 4.1 토큰 절약 워크플로우

```
1. 대용량 컨텍스트 수신 (도구 출력, 로그, 파일)
2. headroom_compress로 토큰 사용량 감소
3. 압축된 컨텍스트를 LLM에 전달
4. LLM이 필요시 CCR을 통해 원본 검색
```

### 4.2 병렬 분석 워크플로우

```
1. 병렬화 가능한 작업 식별
2. spawn_parallel_agents로 서브에이전트 생성
3. 각 서브에이전트가 독립적으로 작업
4. coordinate_agent_results로 결과 병합
```

### 4.3 목표 지향적 오케스트레이션

```
1.多个技能이 필요한 복잡한 목표 정의
2. orchestrate_goal로 서브에이전트 생성
3. 각 서브에이전트에特定한 skills/hooks/MCP 장비
4. 오케스트레이터가协调 및 결과 병합 관리
```

## 5. 설정 파일

### 5.1 Headroom 설정
Headroom은 다음으로 설정할 수 있습니다:
- 환경 변수
- 설정 파일 (`~/.headroom/config.toml`)
- 호출별 오버라이드

### 5.2 OMK 설정
Extensions는 다음에서 자동으로 발견됩니다:
- `$OMK_RUNTIME_HOME/extensions/` (전역)
- `.omk/extensions/` (프로젝트 로컬)

Skills는 다음에서 자동으로 발견됩니다:
- `$OMK_RUNTIME_HOME/.agents/skills/` (전역)
- `.agents/skills/` (프로젝트 로컬)

## 6. 문제 해결

### 6.1 일반적인 문제

1. **Headroom이 설치되지 않음**
   - 해결책: `headroom_install` 도구 또는 `pip install "headroom-ai[all]"` 사용

2. **Extensions가 로딩되지 않음**
   - 해결책: 파일 권한 및 TypeScript 구문 확인
   - `/reload`로 extensions 리로드

3. **에이전트가 스폰되지 않음**
   - 해결책: 에이전트 설정 및 의존성 확인
   - `check_parallel_agents`로 상태 모니터링

4. **압축이 작동하지 않음**
   - 해결책: `headroom_stats`로 headroom 설치 확인
   - 콘텐츠 유형 감지 확인

### 6.2 성능 팁

1. **병렬 vs 순차적**: 독립적인 작업에는 병렬, 의존적인 작업에는 순차적 사용
2. **압축 수준**: 압축 비율과 처리 시간 사이의 균형
3. **에이전트 수**:太多 에이전트는协调 오버헤드 발생
4. **시간 초과 설정**:长时间 실행 작업에适当的 시간 초과 설정

## 7. 명령어 참조

### 7.1 Headroom 명령어
- `/headroom:compress`: 현재 컨텍스트 압축
- `/headroom:stats`: 압축 통계 표시
- `/headroom:retrieve`: 원본 콘텐츠 검색

### 7.2 병렬 에이전트 명령어
- `/parallel-agents`: 병렬 서브에이전트 관리

### 7.3 오케스트레이터 명령어
- `/orchestrator`: 오케스트레이터 및 서브에이전트 관리

## 8. 고급 기능

### 8.1 사용자 정의 Skills
특정 에이전트 작업을 위한 사용자 정의 Skills 생성:
```markdown
# 사용자 정의 보안 스캐너 Skill
이技能은 보안 취약점을扫描할 때使用합니다.

## 단계
1. 코드 패턴 분석
2. 일반적인 취약점检查
3. 보안 보고서 생성
```

### 8.2 사용자 정의 Hooks
전처리/후처리를 위한 hooks 생성:
```typescript
// 코드 유효성 검사를 위한 사전 커밋 hook
omk.on("tool_call", async (event, ctx) => {
  if (event.toolName === "write") {
    // 쓰기 전 코드 유효성 검사
    const validation = await validateCode(event.input.content);
    if (!validation.valid) {
      return { block: true, reason: validation.error };
    }
  }
});
```

### 8.3 MCP 서버 통합
외부 도구 접근을 위한 MCP 서버로 에이전트 장비:
```typescript
equip_agent({
  agentId: "database-engineer",
  mcpServers: ["postgres-mcp", "redis-mcp", "elasticsearch-mcp"]
});
```

## 9. 모니터링 및 로깅

### 9.1 압축 통계 모니터링
```typescript
//定期적으로 압축 통계 확인
headroom_stats({ detailed: true })
```

### 9.2 에이전트 상태 모니터링
```typescript
// 에이전트 상태 확인
check_parallel_agents()

// 오케스트레이터 상태 확인
orchestrator_status()
```

### 9.3 성능 메트릭
- 토큰 절약률: 60-95%
- 에이전트 완료율: 95%+
- 평균 응답 시간: 작업에 따라 다름

## 10. 보안 고려사항

### 10.1 데이터 프라이버시
- Headroom은 로컬에서 실행되어 데이터가 사용자 머신에保持
- 기본적으로 원격 분석 없음
- 압축된 데이터는 암호화되지 않음 (로컬存储)

### 10.2 에이전트 보안
-每个 에이전트는特定한 권한으로 실행
- Skills, hooks, MCP는最小한의 필요 권한으로 설정
- 정기적인 보안 감사 수행

## 11. 확장성

### 11.1 새로운 Skills 추가
```markdown
# 새로운 Skill 추가
$OMK_RUNTIME_HOME/.agents/skills/new-skill/SKILL.md에 파일 생성
```

### 11.2 새로운 Extensions 추가
```typescript
// 새로운 Extension 추가
$OMK_RUNTIME_HOME/extensions/new-extension/index.ts에 파일 생성
```

### 11.3 새로운 MCP 서버 추가
```typescript
// 새로운 MCP 서버로 에이전트 장비
equip_agent({
  agentId: "agent-id",
  mcpServers: ["new-mcp-server"]
});
```

## 12. 최종 확인

### 12.1 설치 확인
```bash
# Headroom 확인
python3 -c "import headroom; print('OK')"

# Extensions 확인
ls $OMK_RUNTIME_HOME/extensions/

# Skills 확인
ls $OMK_RUNTIME_HOME/.agents/skills/headroom/
```

### 12.2 기능 확인
1. headroom_compress 도구测试
2. spawn_parallel_agents 도구测试
3. orchestrate_goal 도구测试
4. 명령어测试 (/headroom, /parallel-agents, /orchestrator)

### 12.3 통합 확인
1. OMK에서 extensions 로딩 확인
2. LLM이 도구를 호출할 수 있는지 확인
3. 결과가 제대로 반환되는지 확인

## 13. 다음 단계

### 13.1 학습 리소스
- [Headroom 문서](https://headroom-docs.vercel.app/docs)
- [OMK 문서](https://github.com/dmae97/open-multi-agent-kit)
- [OMK 런타임 문서](https://github.com/dmae97/open-multi-agent-kit)

### 13.2 커뮤니티 참여
- GitHub 이슈 및 PR
- Discord 커뮤니티
- 문서 기여

### 13.3 피드백 제공
- 버그 보고
- 기능 요청
- 개선 제안

## 14. 지원

### 14.1 문제 해결
- 공식 문서 확인
- GitHub 이슈 검색
- 커뮤니티 질문

### 14.2 기술 지원
- 이메일 지원
- 채팅 지원
- 전화 지원 (해당되는 경우)

### 14.3 교육
- 온라인教程
- 웨비나
- 현장 교육 (해당되는 경우)

## 15. 라이선스

### 15.1 Headroom
- Apache 2.0 라이선스
- 상업적 사용 가능
- 수정 및 재배포 가능

### 15.2 OMK
- MIT 라이선스
- 오픈 소스
- 자유로운 사용 및 수정

## 16. 결론

이 설정 가이드는 headroom과 OMK의 통합을全面的に介绍합니다:

1. **설치 및 설정**: 모든 구성 요소의安装 및 설정方法
2. **사용 방법**:各种 도구 및 명령어의使用方法
3. **통합 워크플로우**:实际应用场景에서의使用方法
4. **문제 해결**:常见问题及解决方法
5. **고급 기능**:扩展及自定义方法

이 가이드를参照하여 OMK 워크플로우를効率的な 컨텍스트 압축과 병렬 에이전트 오케스트레이션으로强化하세요.