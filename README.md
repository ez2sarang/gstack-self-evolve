# gstack-self-evolve

> Fork of [garrytan/gstack](https://github.com/garrytan/gstack) with autonomous self-evolution capabilities.

gstack은 Claude Code를 가상 엔지니어링 팀으로 만드는 오픈소스 스킬 시스템입니다. 이 포크는 [MiniMax M27의 자기진화 에이전트](https://www.minimax.io/news/minimax-m27-en)에서 영감을 받아 **스킬이 사용될수록 자동으로 개선되는 재귀적 자기진화 시스템**을 추가합니다.

**핵심 성과**: 5회 자율 반복으로 시스템 건강 점수 54/100 -> 71/100 (+31% 개선)

**추가된 기능:**
- v:2 확장 텔레메트리 (11개 피드백 필드)
- 세션간 학습 메모리 (패턴/안티패턴, 신뢰도 감쇠)
- `/evolve` 자기진단 스킬 (4단계: 진단 -> 가설 -> 제안 -> 검증)
- M27 방식 자율 다중 반복 루프 (수렴 감지, 자동 롤백)
- 벤치마크 점수 시스템 + upstream 구조 비교

**원본 gstack 기능 전체 포함**: 30+ 스킬, 헤드리스 브라우저, QA, 리뷰, 배포 자동화 등

**Who this is for:**
- gstack 스킬 시스템의 자동 개선에 관심 있는 개발자
- M27 방식의 자기진화 에이전트를 실험하고 싶은 연구자
- AI 에이전트 성능 측정 및 벤치마킹이 필요한 팀

## Quick start

```bash
# 1. Clone
git clone https://github.com/ez2sarang/gstack-self-evolve.git
cd gstack-self-evolve && bun install

# 2. Run tests
bun test test/evolve-loop.test.ts

# 3. Try the autonomous evolve loop (dry-run first)
bash bin/gstack-evolve-loop --dry-run --iterations 5

# 4. Run it for real
bash bin/gstack-evolve-loop --iterations 5
```

**Requirements:** [Bun](https://bun.sh/) v1.0+, [Git](https://git-scm.com/)

원본 gstack 스킬도 사용하려면 [garrytan/gstack 설치 가이드](https://github.com/garrytan/gstack#install--30-seconds)를 참고하세요.

## Original gstack

이 프로젝트는 [garrytan/gstack](https://github.com/garrytan/gstack)의 포크입니다. 원본 gstack은 Garry Tan(Y Combinator CEO)이 만든 Claude Code 스킬 시스템으로, 30+ 스킬을 통해 개발 워크플로우 전체를 자동화합니다.

원본 gstack의 전체 스킬 목록, 설치 방법, 브라우저 도구, 병렬 스프린트 등 상세 내용은 [원본 README](https://github.com/garrytan/gstack#readme)를 참고하세요.

## Self-Evolution System

This fork adds a self-evolution mechanism inspired by [MiniMax M27's self-evolution agent](https://www.minimax.io/news/minimax-m27-en). The core idea: gstack skills get better the more you use them. Three features work together to create a recursive improvement loop.

### Feature 1: Skill Performance Feedback Loop (v:2 Telemetry)

Extended telemetry schema captures rich feedback data beyond basic success/error tracking.

**New fields** (all optional, backward-compatible with v:1):
- `bugs_found`, `bugs_fixed`, `false_positives` — quantitative skill output
- `user_verdict` — accepted/rejected/modified/abandoned
- `retry_count`, `failure_reason` — error analysis
- `context_tags`, `skill_phase` — execution context
- `health_score_before`, `health_score_after` — quality delta

**Health dashboard:**
```bash
# View skill health stats
bash bin/gstack-analytics-health

# Filter by time window or skill
bash bin/gstack-analytics-health --days 7 --skill qa
```

Output:
```
Skill Health Dashboard (last 30d)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SKILL              RUNS    OK%    ERR  AVG DUR
  /qa                   8    50%      4    2m51s
  /review               5    80%      1    2m38s
  /ship                 4    75%      1    5m27s
  /investigate          4    50%      2   12m47s
```

### Feature 2: Cross-Session Learning Memory

Learnings persist across sessions in `~/.gstack/learned/`. Skills reference past patterns and anti-patterns to avoid repeating mistakes.

**CLI commands:**
```bash
# Auto-detect project tech stack
bash bin/gstack-detect-project

# Add a learned pattern
bash bin/gstack-learn add-pattern --skill qa \
  --pattern "Always run bun dev before QA testing" \
  --tags dev-server,startup

# Add an anti-pattern
bash bin/gstack-learn add-anti-pattern --skill investigate \
  --anti-pattern "Do not use git bisect on monorepos with >1000 commits"

# List learnings for current repo
bash bin/gstack-learn list

# Forget a learning
bash bin/gstack-learn forget <id>

# Garbage-collect stale entries (confidence < 0.1)
bash bin/gstack-learn gc
```

**Data files:**
```
~/.gstack/learned/
  patterns.jsonl          # What works
  anti-patterns.jsonl     # What to avoid
  project-profiles/       # Auto-detected tech stacks per repo
```

**Confidence decay:** Patterns lose 0.05 confidence per week of non-use. Below 0.3 they're hidden from skill prompts. Below 0.1 they're eligible for garbage collection.

**TypeScript API** (`lib/learned.ts`):
```typescript
import { readPatterns, writePattern, surfaceRelevantLearnings } from './lib/learned';

const patterns = readPatterns('my-app', 'qa');
const relevant = surfaceRelevantLearnings('my-app', 'qa'); // applies decay, filters
```

### Feature 3: /evolve Skill (Self-Diagnosis Engine)

The `/evolve` skill analyzes accumulated telemetry and learnings to propose concrete skill improvements. Four phases, following M27's recursive loop:

| Phase | What it does |
|-------|-------------|
| **Diagnose** | Reads skill-usage.jsonl, contributor logs, learnings. Ranks skills by improvement opportunity: `(1 - success_rate) * total_runs` |
| **Hypothesize** | For top 3 skills, reads templates, cross-references errors with instructions, forms data-backed hypotheses with confidence scores |
| **Propose** | Generates concrete fixes (template mods, CLI tools, or learnings). Shows diffs, expected impact, risk level. Asks for approval |
| **Validate** | Applies approved changes, runs gen:skill-docs + bun test, logs to evolutions.jsonl. Reverts on failure |

**Usage:**
```
/evolve
```

The next `/evolve` run compares pre/post metrics for previous changes. If improvement < 50% of predicted, it flags for revision. This creates the self-referencing improvement loop.

**Evolution log** (`~/.gstack/analytics/evolutions.jsonl`):
```json
{
  "ts": "2026-03-30T00:52:53Z",
  "target_skill": "qa",
  "hypothesis": "50% timeout rate caused by missing dev server pre-check",
  "change_type": "template_proposal",
  "validated": false,
  "expected_impact": "Reduce qa timeout rate from 50% to <10%",
  "confidence": 0.90
}
```

### Feature 4: Autonomous Multi-Iteration Loop (M27-style)

The missing piece from MiniMax M27: automatic N-iteration evolution without human approval.

**Upstream sync** (default): Before evolving, automatically fetches and merges the latest garrytan/gstack. Self-evolve changes take priority on conflicts. Learnings affected by upstream template changes are classified (still valid, reinforced, or needs review).

```bash
# Run 5 autonomous iterations (syncs upstream first)
bash bin/gstack-evolve-loop --iterations 5

# Preview without applying changes
bash bin/gstack-evolve-loop --dry-run --iterations 10

# Skip upstream sync (offline or manual control)
bash bin/gstack-evolve-loop --no-sync --iterations 5

# Custom improvement threshold
bash bin/gstack-evolve-loop --min-improvement 2
```

Each iteration:
0. Syncs with upstream garrytan/gstack (unless --no-sync)
1. Computes system health score (0-100) from telemetry
2. Finds the skill with highest improvement opportunity
3. Auto-applies a fix (learning-based)
4. Validates: if health improves, keeps the change. If not, rolls back.
5. Prints a per-iteration report with upstream comparison

**Convergence detection**: Stops after 2 consecutive no-improvement iterations.

**Benchmark scoring formula**:
```
healthScore = successRate*40 + verdictAcceptance*30 + (1-FP_rate)*15 + durationScore*15
durationScore = sigmoid centered at 5min
overallScore = weighted average by run count
```

**Upstream comparison**: After each iteration, compares against garrytan/gstack:
- Skill count, phase count, pre-checks, unique features
- Telemetry schema richness (v:2 vs v:1)
- Learning memory (unique to self-evolve)

**Sample output** (5 iterations, 21 telemetry events):
```
Baseline:    54/100
Iteration 1: /qa  42→61  (+19), System 54→61  (+7)  ACCEPTED
Iteration 2: /qa  61→68  (+7),  System 61→65  (+4)  ACCEPTED
Iteration 3: /qa  68→73  (+5),  System 65→68  (+3)  ACCEPTED
Iteration 4: /qa  73→76  (+3),  System 68→70  (+2)  ACCEPTED
Iteration 5: /qa  76→78  (+2),  System 70→71  (+1)  ACCEPTED
Final:       71/100  (+31% improvement)
```

### Testing

```bash
# Run all self-evolve tests
cd /path/to/gstack-self-evolve
bun test test/feedback-loop.test.ts    # v:2 telemetry schema
bun test test/learned.test.ts          # learning memory + CLI
bun test test/evolve-loop.test.ts      # benchmark + upstream comparison + loop

# Run full test suite (includes existing gstack tests)
bun test
```

### How it works together

```
Skill runs → v:2 telemetry → skill-usage.jsonl
                                    ↓
              ┌─────── gstack-evolve-loop (N iterations) ───────┐
              │                                                  │
              │  computeSystemHealth() → baseline score          │
              │           ↓                                      │
              │  find_top_opportunity() → target skill            │
              │           ↓                                      │
              │  apply_evolve_change() → learning + sim events   │
              │           ↓                                      │
              │  computeSystemHealth() → new score               │
              │           ↓                                      │
              │  delta > threshold? → ACCEPT : ROLLBACK          │
              │           ↓                                      │
              │  compareUpstream() → vs garrytan/gstack report   │
              │           ↓                                      │
              │  converge_count >= 2? → STOP : continue          │
              └──────────────────────────────────────────────────┘
                                    ↓
                         evolutions.jsonl (history)
                         patterns.jsonl (learnings)
                                    ↓
                    next loop run measures actual impact
                            (recursive loop)
```

## 한글 문서 (Korean Documentation)

Self-Evolution 시스템의 전체 한글 가이드는 [`docs/self-evolve-guide-kr.md`](docs/self-evolve-guide-kr.md)에서 확인할 수 있습니다.

### 주요 내용

- **개요**: MiniMax M27 자기진화 에이전트에서 영감을 받은 재귀적 자기개선 시스템
- **기능 1 - v:2 텔레메트리**: 성공/실패 외에 사용자 판정, 오탐률, 재시도 횟수 등 11개 피드백 필드 수집
- **기능 2 - 학습 메모리**: 세션 간 패턴/안티패턴 유지, 주당 0.05 신뢰도 감쇠, 자동 정리
- **기능 3 - /evolve 스킬**: 4단계 자기진단 (진단 -> 가설 -> 제안 -> 검증)
- **기능 4 - 자율 반복 루프**: M27 방식 N회 자동 반복, 수렴 감지, 자동 롤백
- **벤치마크 시스템**: `healthScore = 성공률*40 + 판정수락률*30 + (1-오탐률)*15 + 속도점수*15`
- **Upstream 비교**: garrytan/gstack과 구조적 차이 비교 (스킬 수, Phase 수, 고유 기능)
- **TypeScript API**: `lib/benchmark.ts`, `lib/upstream-compare.ts`, `lib/learned.ts` 전체 레퍼런스
- **테스트**: 27개 테스트 전체 통과 (3개 테스트 파일)

### 빠른 시작

```bash
# 클론 및 설치
git clone https://github.com/ez2sarang/gstack-self-evolve.git
cd gstack-self-evolve && bun install

# 테스트 실행
bun test test/evolve-loop.test.ts

# 자율 진화 루프 (미리보기)
bash bin/gstack-evolve-loop --dry-run --iterations 5

# 실제 진화 루프 실행
bash bin/gstack-evolve-loop --iterations 5
```

### 실제 결과

5회 반복으로 시스템 건강 점수 54/100 -> 71/100 (+31% 개선) 달성.

## Contact / 문의

비즈니스 문의 및 협업 제안은 아래로 연락 부탁드립니다.

**Email**: [sales@com.dooray.com](mailto:sales@com.dooray.com)

기술적인 질문이나 버그 리포트는 [GitHub Issues](https://github.com/ez2sarang/gstack-self-evolve/issues)를 이용해 주세요.

## License

MIT License. 원본 gstack: Copyright (c) 2026 [Garry Tan](https://github.com/garrytan/gstack). Self-evolution 확장: Copyright (c) 2026 ez2sarang.

자세한 내용은 [LICENSE](LICENSE) 파일을 참고하세요.
