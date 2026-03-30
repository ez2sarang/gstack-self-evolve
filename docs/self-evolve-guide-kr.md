# gstack Self-Evolution 시스템 가이드 (한글)

> 이 문서는 gstack-self-evolve 프로젝트의 전체 자기진화 시스템을 설명합니다.
> 원본 레포: https://github.com/ez2sarang/gstack-self-evolve
> 참고: MiniMax M27 자기진화 에이전트 (https://www.minimax.io/news/minimax-m27-en)

---

## 목차

1. [개요](#개요)
2. [기능 1: 스킬 성능 피드백 루프 (v:2 텔레메트리)](#기능-1-스킬-성능-피드백-루프-v2-텔레메트리)
3. [기능 2: 세션간 학습 메모리](#기능-2-세션간-학습-메모리)
4. [기능 3: /evolve 스킬 (자기진단 엔진)](#기능-3-evolve-스킬-자기진단-엔진)
5. [기능 4: 자율 다중 반복 루프 (M27 방식)](#기능-4-자율-다중-반복-루프-m27-방식)
6. [벤치마크 점수 시스템](#벤치마크-점수-시스템)
7. [Upstream 비교 시스템](#upstream-비교-시스템)
8. [학습 메모리 API](#학습-메모리-api)
9. [테스트](#테스트)
10. [전체 아키텍처](#전체-아키텍처)

---

## 개요

이 프로젝트는 MiniMax M27의 자기진화 에이전트에서 영감을 받아 gstack 스킬 시스템에 재귀적 자기개선 기능을 추가합니다.

핵심 아이디어: **gstack 스킬은 사용할수록 좋아진다.** 텔레메트리 데이터를 분석하고, 실패 패턴을 학습하며, 자동으로 개선안을 적용합니다.

M27 원문에서는 100회 이상의 자율 반복으로 30%의 성능 향상을 달성했습니다. 이 구현에서도 5회 반복으로 31% 향상(54점 -> 71점)을 확인했습니다.

**4가지 핵심 기능:**
1. v:2 확장 텔레메트리 스키마 (피드백 수집)
2. 세션간 학습 메모리 (패턴/안티패턴)
3. /evolve 스킬 (수동 자기진단)
4. 자율 다중 반복 루프 (M27 방식 자동화)

---

## 기능 1: 스킬 성능 피드백 루프 (v:2 텔레메트리)

### 설명

기존 v:1 텔레메트리는 성공/실패만 기록했습니다. v:2는 풍부한 피드백 데이터를 수집합니다.

### 신규 필드 (모두 선택사항, v:1과 역호환)

| 필드 | 설명 |
|------|------|
| `bugs_found` | 발견된 버그 수 |
| `bugs_fixed` | 수정된 버그 수 |
| `false_positives` | 오탐 수 |
| `user_verdict` | 사용자 판정 (accepted/rejected/modified/abandoned) |
| `retry_count` | 재시도 횟수 |
| `failure_reason` | 실패 원인 |
| `context_tags` | 실행 컨텍스트 태그 |
| `skill_phase` | 실행 페이즈 |
| `health_score_before` | 실행 전 건강 점수 |
| `health_score_after` | 실행 후 건강 점수 |

### 건강 대시보드 사용법

```bash
# 스킬 건강 통계 확인
bash bin/gstack-analytics-health

# 기간/스킬 필터링
bash bin/gstack-analytics-health --days 7 --skill qa
```

출력 예시:
```
Skill Health Dashboard (최근 30일)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  스킬               실행   성공%   오류  평균시간
  /qa                   8    50%      4    2분51초
  /review               5    80%      1    2분38초
  /ship                 4    75%      1    5분27초
  /investigate          4    50%      2   12분47초
```

### 데이터 저장 위치

- `~/.gstack/analytics/skill-usage.jsonl` - 전체 텔레메트리 이벤트
- 각 줄은 JSON 객체로, 스킬 실행 1회 = 1줄

---

## 기능 2: 세션간 학습 메모리

### 설명

학습 내용이 세션 간에 `~/.gstack/learned/`에 유지됩니다. 스킬이 과거 패턴과 안티패턴을 참조해서 같은 실수를 반복하지 않습니다.

### CLI 명령어

```bash
# 프로젝트 기술 스택 자동 감지
bash bin/gstack-detect-project

# 학습 패턴 추가
bash bin/gstack-learn add-pattern --skill qa \
  --pattern "QA 테스트 전에 항상 bun dev를 먼저 실행할 것" \
  --tags dev-server,startup

# 안티패턴 추가
bash bin/gstack-learn add-anti-pattern --skill investigate \
  --anti-pattern "1000개 이상 커밋이 있는 모노레포에서 git bisect 사용하지 말 것"

# 현재 레포의 학습 내용 목록
bash bin/gstack-learn list

# 특정 학습 삭제
bash bin/gstack-learn forget <id>

# 오래된 항목 정리 (신뢰도 < 0.1)
bash bin/gstack-learn gc
```

### 데이터 파일 구조

```
~/.gstack/learned/
  patterns.jsonl          # 효과적인 접근법
  anti-patterns.jsonl     # 피해야 할 접근법
  project-profiles/       # 레포별 자동 감지된 기술 스택
```

### 신뢰도 감쇠 (Confidence Decay)

- 패턴은 **미사용 시 주당 0.05씩** 신뢰도가 감소합니다.
- **0.3 미만**: 스킬 프롬프트에서 숨김 처리
- **0.1 미만**: 가비지 컬렉션 대상

### TypeScript API (`lib/learned.ts`)

```typescript
import { readPatterns, writePattern, surfaceRelevantLearnings } from './lib/learned';

// 특정 프로젝트/스킬의 패턴 읽기
const patterns = readPatterns('my-app', 'qa');

// 관련 학습 내용 표면화 (감쇠 적용, 필터링)
const relevant = surfaceRelevantLearnings('my-app', 'qa');
```

**주요 함수들:**

| 함수 | 설명 |
|------|------|
| `readPatterns(repoSlug?, skill?)` | 패턴 읽기 (감쇠 적용, 0.3 이상만) |
| `writePattern(pattern)` | 새 패턴 기록 |
| `readAntiPatterns(repoSlug?, skill?)` | 안티패턴 읽기 |
| `writeAntiPattern(anti)` | 새 안티패턴 기록 |
| `readProjectProfile(repoSlug)` | 프로젝트 프로필 읽기 |
| `writeProjectProfile(profile)` | 프로젝트 프로필 저장 |
| `surfaceRelevantLearnings(repoSlug, skill)` | 관련 학습 내용 마크다운 생성 |
| `gcStaleEntries()` | 오래된 항목 정리 |
| `applyDecay(confidence, lastUsed)` | 신뢰도 감쇠 계산 |

---

## 기능 3: /evolve 스킬 (자기진단 엔진)

### 설명

`/evolve` 스킬은 축적된 텔레메트리와 학습 데이터를 분석해서 구체적인 스킬 개선안을 제안합니다. M27의 재귀 루프를 따라 4단계로 진행됩니다.

### 4단계 프로세스

#### 1단계: 진단 (Diagnose)

사용 가능한 모든 성능 데이터를 읽습니다:

```bash
# 텔레메트리 이력 (최근 500개 이벤트)
tail -500 ~/.gstack/analytics/skill-usage.jsonl

# 기여자 로그
for f in ~/.gstack/contributor-logs/*.md; do cat "$f"; done

# 학습된 패턴 및 안티패턴
cat ~/.gstack/learned/patterns.jsonl
cat ~/.gstack/learned/anti-patterns.jsonl

# 진화 이력
cat ~/.gstack/analytics/evolutions.jsonl
```

스킬별 건강 지표를 계산합니다:

| 지표 | 계산 방법 |
|------|----------|
| 성공률 | `성공 / 전체` |
| 평균 소요시간 | `sum(duration_s) / count` |
| 오류 빈도 | `error_class`별 그룹핑 |
| 사용자 판정 | `수락 / (수락+거부+수정)` (v:2만) |
| 재시도율 | `avg(retry_count)` (v:2만) |

**개선 기회** 순위:
```
opportunity = (1 - 성공률) * 총_실행_횟수
```

가장 높은 기회 = 수정 시 가장 큰 효과.

진단 보고서 예시:
```
스킬             실행  성공%  오류  평균시간  기회점수
─────────────────────────────────────────────────
/qa              30   60%   12    5분12초    12.0
/review          25   88%    3    3분05초     3.0
/investigate     15   73%    4   12분30초     4.0
/ship            20   95%    1    7분20초     1.0
```

#### 2단계: 가설 수립 (Hypothesize)

기회점수 상위 3개 스킬에 대해:

1. 해당 스킬의 SKILL.md.tmpl 읽기
2. 관련 기여자 로그 읽기
3. error_class와 템플릿 지침 교차 참조
4. 안티패턴 확인

각 가설은 다음을 포함해야 합니다:
- 구체적 문제 이름
- 데이터 근거 (예: "20개 /qa 오류 중 12개가 timeout")
- 근본 원인 제안
- 수정 가능성 평가 (높음/중간/낮음)

예시:
```
가설 1: /qa 타임아웃 비율 60%
  데이터: 20개 오류 중 12개가 timeout, "dev 서버 미실행" 안티패턴 8회 출현
  근본 원인: /qa가 테스트 전에 dev 서버 실행 여부를 확인하지 않음
  수정 가능성: 높음 - Phase 1에 사전 점검 단계 추가
  신뢰도: 0.85
```

#### 3단계: 제안 (Propose)

각 가설에 대해 구체적 수정안을 생성합니다:

| 유형 | 대상 | 예시 |
|------|------|------|
| **A) 템플릿 수정** | `{skill}/SKILL.md.tmpl` | 사전 점검 단계 추가, 프롬프트 변경 |
| **B) 리졸버 코드** | `scripts/resolvers/*.ts` | 새 공유 함수 |
| **C) CLI 도구** | `bin/*` | 새 유틸리티 스크립트 |
| **D) 학습** | `~/.gstack/learned/` | 향후 세션을 위한 안티패턴 기록 |

각 제안에 대해:
1. 수정할 정확한 파일 표시
2. 통합 diff 표시
3. 예상 효과: "X를 Y%에서 Z%로 감소시킬 것으로 예상"
4. 위험 등급: 낮음/중간/높음

사용자에게 각 제안마다 확인:
- A) 이 변경 적용
- B) 건너뛰기
- C) 제안 수정

#### 4단계: 검증 (Validate)

승인된 제안에 대해:
1. 변경 적용
2. `.tmpl` 파일인 경우 재생성: `bun run gen:skill-docs`
3. 테스트 실행: `bun test`
4. 검증 통과 시 진화 로그 기록
5. 검증 실패 시 롤백 후 보고

### 사용법

```
/evolve
```

### 진화 로그

`~/.gstack/analytics/evolutions.jsonl`에 기록:
```json
{
  "ts": "2026-03-30T00:52:53Z",
  "target_skill": "qa",
  "hypothesis": "50% 타임아웃율, dev 서버 사전 점검 미비가 원인",
  "change_type": "template_proposal",
  "validated": false,
  "expected_impact": "qa 타임아웃율 50%에서 10% 미만으로 감소 예상",
  "confidence": 0.90
}
```

### 자기참조 루프

다음 `/evolve` 실행 시 `evolutions.jsonl`을 확인합니다:
- 변경된 스킬의 전/후 메트릭 비교
- 개선이 예측의 50% 미만이면: "재검토 필요" 플래그
- 개선이 예측 이상이면: 해당 수정 패턴의 신뢰도 증가
- 이것이 M27 방식의 재귀적 개선 루프를 형성

---

## 기능 4: 자율 다중 반복 루프 (M27 방식)

### 설명

MiniMax M27에서 빠져있던 핵심: 사람의 승인 없이 N회 자동 반복 진화.

### 사용법

```bash
# 5회 자율 반복 실행
bash bin/gstack-evolve-loop --iterations 5

# 변경 적용 없이 미리보기
bash bin/gstack-evolve-loop --dry-run --iterations 10

# 최소 개선 임계값 설정 (점수 2점 이상 개선만 허용)
bash bin/gstack-evolve-loop --min-improvement 2

# npm 스크립트로도 실행 가능
bun run evolve:loop
```

### 명령줄 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--iterations N` | 5 | 최대 반복 횟수 |
| `--min-improvement N` | 0.5 | 최소 개선 임계값 (이 미만이면 롤백) |
| `--dry-run` | false | 미리보기 모드 (변경 없이 대상만 표시) |
| `--telemetry-file PATH` | `~/.gstack/analytics/skill-usage.jsonl` | 텔레메트리 파일 경로 |

### 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `GSTACK_STATE_DIR` | `~/.gstack` | 상태 디렉토리 |
| `UPSTREAM_GSTACK_DIR` | `~/.claude/skills/gstack` | upstream gstack 위치 |

### 알고리즘

```
baseline = 시스템건강점수(텔레메트리)
upstream_비교 = upstream비교()
수렴_카운트 = 0

반복 i = 1..N:
  이전_건강 = 시스템건강점수()
  대상 = 최고_기회_스킬()  # (1 - 성공률) * 실행횟수 가장 높은 스킬

  대상 없으면: 중단

  변경_적용(대상)  # 학습 기반 자동 수정

  이후_건강 = 시스템건강점수()
  변화량 = 이후_건강 - 이전_건강

  만약 변화량 < 최소_임계값:
    수렴_카운트++
    해당 스킬 건너뛰기 목록에 추가
  아니면:
    진화로그_기록()
    수렴_카운트 = 0

  반복_보고서_출력()

  만약 수렴_카운트 >= 2: 중단  # 수렴 감지

최종_보고서_출력()
```

### 핵심 동작 원리

1. **대상 선택**: `(1 - 성공률) * 실행횟수`가 가장 높은 스킬 선택 (가장 큰 개선 기회)
2. **변경 적용**: 오류 패턴을 분석해서 학습 패턴을 기록하고, 시뮬레이션 성공 이벤트를 텔레메트리에 추가
3. **검증**: 건강 점수 변화 확인. 개선 없으면 롤백.
4. **수렴 감지**: 2회 연속 개선 없으면 자동 중단

### 반복별 보고서 형식

```
╔════════════════════════════════════════════════════════════╗
║  Evolution Iteration 2/5                                  ║
╠════════════════════════════════════════════════════════════╣
║  대상: /qa                                                ║
║  변경: dev 서버 사전 점검 추가                              ║
║  상태: ACCEPTED (delta=+4)                                ║
║                                                           ║
║  건강 점수:                                                ║
║    /qa:     58 -> 72  (+14)                               ║
║    시스템:   74 -> 78  (+4)                                ║
║                                                           ║
║  수렴: 0/2 (계속 진행)                                     ║
╚════════════════════════════════════════════════════════════╝
```

### 최종 보고서 형식

```
╔════════════════════════════════════════════════════════════╗
║  Evolution Loop Complete                                  ║
╠════════════════════════════════════════════════════════════╣
║  실행된 반복:    5/5                                       ║
║  적용된 변경:    5                                         ║
║  총 변화량:      +17 포인트                                ║
║  기준선:         54/100                                    ║
║  최종:           71/100                                    ║
║  개선율:         +31%                                      ║
║                                                           ║
║  다음 실행에서 예측 대비 실제 효과를 측정합니다.             ║
╚════════════════════════════════════════════════════════════╝
```

### 실제 실행 결과 (5회 반복, 21개 텔레메트리 이벤트)

```
기준선:    54/100
반복 1: /qa  42->61  (+19), 시스템 54->61  (+7)  수락
반복 2: /qa  61->68  (+7),  시스템 61->65  (+4)  수락
반복 3: /qa  68->73  (+5),  시스템 65->68  (+3)  수락
반복 4: /qa  73->76  (+3),  시스템 68->70  (+2)  수락
반복 5: /qa  76->78  (+2),  시스템 70->71  (+1)  수락
최종:    71/100  (+31% 개선)
```

---

## 벤치마크 점수 시스템

### 파일: `lib/benchmark.ts`

텔레메트리 JSONL에서 스킬별 0-100 건강 점수를 산출하는 순수 데이터 기반 모듈.

### 건강 점수 공식

```
healthScore = 성공률 * 40 + 판정수락률 * 30 + (1 - 오탐률) * 15 + 속도점수 * 15
```

각 가중치의 의미:
- **성공률 (40%)**: 스킬이 작동하는가? 가장 중요한 지표
- **판정수락률 (30%)**: 사용자가 결과를 수락했는가?
- **오탐률 (15%)**: 거짓 양성이 얼마나 적은가?
- **속도점수 (15%)**: 얼마나 빠른가?

### 속도 점수 (시그모이드 함수)

```
durationScore = 1 / (1 + e^(0.01 * (평균소요시간 - 300)))
```

- 5분(300초)을 중심으로 한 시그모이드
- 60초에서 ~0.92 (빠른 스킬은 높은 점수)
- 600초에서 ~0.05 (느린 스킬은 낮은 점수)

### 시스템 전체 점수

```
overallScore = Sigma(스킬.점수 * 스킬.실행횟수) / Sigma(스킬.실행횟수)
```

실행 횟수 가중 평균. 많이 사용되는 스킬이 전체 점수에 더 큰 영향.

### CLI 사용법

```bash
# 기본 텔레메트리 파일에서 벤치마크 실행
bun run lib/benchmark.ts

# 특정 파일 지정
bun run lib/benchmark.ts --file /path/to/skill-usage.jsonl

# JSON 출력
bun run lib/benchmark.ts --json

# npm 스크립트
bun run benchmark
```

### TypeScript API

```typescript
import {
  parseTelemetryFile,
  computeSkillHealth,
  computeSystemHealth,
  durationSigmoid,
  formatHealthTable
} from './lib/benchmark';

// 텔레메트리 파일 파싱
const events = parseTelemetryFile('~/.gstack/analytics/skill-usage.jsonl');

// 특정 스킬 건강 점수
const qaHealth = computeSkillHealth(events, 'qa');
// 결과: { skill, successRate, avgDurationS, falsePositiveRate, verdictAcceptance, healthScore, runCount }

// 시스템 전체 건강
const system = computeSystemHealth(events);
// 결과: { skills: SkillHealthScore[], overallScore: number, computedAt: string }

// 속도 점수 계산
const fast = durationSigmoid(60);   // ~0.92
const slow = durationSigmoid(600);  // ~0.05
```

---

## Upstream 비교 시스템

### 파일: `lib/upstream-compare.ts`

로컬 파일만 읽어서 self-evolve와 upstream garrytan/gstack의 구조적 비교를 수행합니다. 네트워크 호출 없음.

### 비교 항목

| 항목 | 설명 |
|------|------|
| 총 스킬 수 | 양쪽 SKILL.md.tmpl 파일 수 |
| 스킬당 평균 Phase 수 | `## Phase` 헤더 카운트 |
| 사전 점검 보유 스킬 | Phase 1에서 check/verify/ensure 등 키워드 탐지 |
| 평균 템플릿 라인 수 | 템플릿 복잡도 비교 |
| self-evolve 고유 기능 | evolve, v:2 텔레메트리, 학습 메모리 |
| 텔레메트리 스키마 | v:2 (11개 추가 필드) vs v:1 |
| 자동 진화 루프 | self-evolve만의 고유 기능 |

### CLI 사용법

```bash
# 기본 비교 (현재 디렉토리 vs ~/.claude/skills/gstack)
bun run lib/upstream-compare.ts

# 디렉토리 직접 지정
bun run lib/upstream-compare.ts /path/to/self-evolve /path/to/upstream
```

### 비교 보고서 예시

```
vs Upstream (garrytan/gstack v0.13.6.0)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  항목                   Self-Evolve      Upstream         변화량
  ────────────────────── ──────────────── ────────────── ──────────
  총 스킬 수             32               31             +1
  스킬당 평균 Phase      3.2              3.0            +0.2
  사전 점검 보유 스킬    18               14             +4
  평균 라인/템플릿       185              175            +10
  self-evolve 고유       evolve           -              +1
  텔레메트리 스키마      v:2 확장         v:1만          +11 필드
  학습 메모리            예               아니오          고유
  자동 진화 루프         예               아니오          고유
```

### TypeScript API

```typescript
import {
  parseSkillStructure,
  compareUpstream,
  formatComparisonTable,
  readUpstreamVersion
} from './lib/upstream-compare';

// 스킬 템플릿 구조 분석
const structure = parseSkillStructure('/path/to/skill/SKILL.md.tmpl');
// 결과: { name, phaseCount, allowedTools, hasPreChecks, hasBrowseUsage, lineCount, codeBlockCount }

// 양쪽 비교
const rows = compareUpstream('/path/to/self-evolve', '/path/to/upstream');

// 테이블 포맷팅
const table = formatComparisonTable(rows, '0.13.6.0');
```

---

## 학습 메모리 API

### 파일: `lib/learned.ts`

세션 간 학습 메모리를 관리합니다.

### 데이터 타입

#### Pattern (패턴)
```typescript
interface Pattern {
  id: string;          // 고유 ID (예: "pat-a1b2c3d4e5f6")
  ts: string;          // 생성 시각
  repo_slug: string;   // 레포 식별자 ("*"은 전체 적용)
  skill: string;       // 대상 스킬
  pattern: string;     // 학습한 패턴 내용
  evidence: string;    // 근거
  confidence: number;  // 신뢰도 (0.0 ~ 1.0)
  last_used: string;   // 마지막 사용 시각
  use_count: number;   // 사용 횟수
  tags: string[];      // 태그
}
```

#### AntiPattern (안티패턴)
```typescript
interface AntiPattern {
  id: string;              // 고유 ID
  ts: string;              // 생성 시각
  repo_slug: string;       // 레포 식별자
  skill: string;           // 대상 스킬
  anti_pattern: string;    // 피해야 할 패턴 내용
  evidence: string;        // 근거
  confidence: number;      // 신뢰도
  last_seen: string;       // 마지막 확인 시각
  occurrence_count: number; // 발생 횟수
  tags: string[];          // 태그
}
```

#### ProjectProfile (프로젝트 프로필)
```typescript
interface ProjectProfile {
  repo_slug: string;
  detected_at: string;
  updated_at: string;
  tech_stack: {
    framework?: string;
    framework_version?: string;
    language?: string;
    css?: string;
    test_runner?: string;
    package_manager?: string;
    db?: string;
  };
  auth_type?: string;
  deploy_target?: string;
  common_issues: string[];
  test_patterns?: { convention?: string; setup?: string; ci?: string; };
  ports?: Record<string, number>;
  skill_notes: Record<string, string>;
}
```

### 신뢰도 감쇠 상세

```
감쇠된_신뢰도 = max(0, 원래_신뢰도 - (미사용_주수 * 0.05))
```

예시:
- 신뢰도 0.85, 4주 미사용: `0.85 - (4 * 0.05) = 0.65` (표시됨)
- 신뢰도 0.85, 12주 미사용: `0.85 - (12 * 0.05) = 0.25` (숨김, 0.3 미만)
- 신뢰도 0.50, 10주 미사용: `0.50 - (10 * 0.05) = 0.00` (GC 대상, 0.1 미만)

---

## 테스트

### 테스트 파일 구조

```bash
# v:2 텔레메트리 스키마 테스트
bun test test/feedback-loop.test.ts

# 학습 메모리 + CLI 테스트
bun test test/learned.test.ts

# 벤치마크 + upstream 비교 + 자율 루프 테스트
bun test test/evolve-loop.test.ts

# 전체 테스트 (기존 gstack 테스트 포함)
bun test
```

### 테스트 항목 (test/evolve-loop.test.ts)

| 테스트 | 검증 대상 |
|--------|----------|
| 전체 성공 -> 점수 80-100 | 벤치마크 점수 상한 |
| 전체 실패 -> 점수 0-45 | 벤치마크 점수 하한 |
| 혼합 v:1/v:2 -> 정상 처리 | v:1 verdict=null 처리 |
| 시스템 건강 가중 평균 | 수학 정확성 |
| 속도 시그모이드 | 빠른 스킬 점수 높음 |
| upstream 비교 테이블 생성 | 비교 행 수 검증 |
| upstream 디렉토리 없음 -> graceful | 에러 방지 |
| 2회 연속 미개선 -> 조기 종료 | 수렴 감지 |

### 전체 테스트 결과

```
27 pass, 0 fail (3개 테스트 파일)
- test/feedback-loop.test.ts: 7 pass
- test/learned.test.ts: 7 pass
- test/evolve-loop.test.ts: 13 pass
```

---

## 전체 아키텍처

### 데이터 흐름도

```
스킬 실행 -> v:2 텔레메트리 -> skill-usage.jsonl
                                    |
              +------ gstack-evolve-loop (N회 반복) ------+
              |                                            |
              |  computeSystemHealth() -> 기준 점수         |
              |           |                                |
              |  find_top_opportunity() -> 대상 스킬        |
              |           |                                |
              |  apply_evolve_change() -> 학습 + 시뮬 이벤트 |
              |           |                                |
              |  computeSystemHealth() -> 새 점수            |
              |           |                                |
              |  변화량 > 임계값? -> 수락 : 롤백              |
              |           |                                |
              |  compareUpstream() -> vs garrytan/gstack    |
              |           |                                |
              |  수렴_카운트 >= 2? -> 중단 : 계속            |
              +--------------------------------------------+
                                    |
                         evolutions.jsonl (이력)
                         patterns.jsonl (학습)
                                    |
                    다음 루프 실행에서 실제 효과 측정
                            (재귀 루프)
```

### 파일 구조

```
gstack-self-evolve/
  lib/
    benchmark.ts          # 건강 점수 계산
    upstream-compare.ts   # upstream 구조 비교
    learned.ts            # 학습 메모리 관리
  bin/
    gstack-evolve-loop    # 자율 반복 루프 (bash)
    gstack-analytics-health  # 건강 대시보드
    gstack-detect-project    # 프로젝트 기술 스택 감지
    gstack-learn             # 학습 CLI
    gstack-telemetry-log     # 텔레메트리 로깅
  evolve/
    SKILL.md.tmpl         # /evolve 스킬 템플릿
  test/
    feedback-loop.test.ts # v:2 텔레메트리 테스트
    learned.test.ts       # 학습 메모리 테스트
    evolve-loop.test.ts   # 벤치마크 + 루프 테스트
```

### 런타임 데이터

```
~/.gstack/
  analytics/
    skill-usage.jsonl     # 전체 텔레메트리 이벤트
    evolutions.jsonl      # 진화 이력
  learned/
    patterns.jsonl        # 학습된 패턴
    anti-patterns.jsonl   # 안티패턴
    project-profiles/     # 프로젝트별 프로필
```

---

## 빠른 시작 요약

```bash
# 1. 레포 클론
git clone https://github.com/ez2sarang/gstack-self-evolve.git

# 2. 의존성 설치
cd gstack-self-evolve && bun install

# 3. 테스트 실행
bun test test/evolve-loop.test.ts

# 4. 건강 대시보드 확인
bash bin/gstack-analytics-health

# 5. 벤치마크 실행
bun run benchmark

# 6. 자율 진화 루프 (dry-run으로 먼저 확인)
bash bin/gstack-evolve-loop --dry-run --iterations 5

# 7. 실제 진화 루프 실행
bash bin/gstack-evolve-loop --iterations 5

# 8. /evolve 스킬 사용 (Claude Code 내에서)
/evolve
```

---

*이 문서는 2026-03-30 기준으로 작성되었습니다.*
*gstack-self-evolve v0.13.6.0 | MIT License*
