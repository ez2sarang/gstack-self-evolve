#!/usr/bin/env bash
# collar session-monitor hook — Layer 2 collar hook
# collar-dispatcher.sh 가 stdin을 파이프로 전달해 실행
#
# 트리거 방식 (우선순위):
#   1순위: ctx% 기반 (transcript 파일 크기로 추정)
#   2순위: 메시지 카운트 폴백 (transcript 없을 때)

# stdin에서 hook event JSON 읽기
HOOK_DATA="$(cat)"

# UserPromptSubmit + PostToolUse 이벤트만 처리
EVENT="$(echo "$HOOK_DATA" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('hook_event_name',''))
except: print('')
" 2>/dev/null)"
[ "$EVENT" = "UserPromptSubmit" ] || [ "$EVENT" = "PostToolUse" ] || [ "$EVENT" = "" ] || exit 0

COLLAR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COUNTER_FILE="$COLLAR_DIR/session-counter"
CONFIG_FILE="$COLLAR_DIR/config.json"
PROJECT_DIR="$(cd "$COLLAR_DIR/.." && pwd)"

# ── 설정값 읽기 ────────────────────────────────────────────────────
CTX_THRESHOLD=80   # %: 이 이상이면 compact 실행
CTX_TARGET=15      # %: compact 목표 수준 (collar-compact에 전달)
MSG_THRESHOLD=20   # 폴백: transcript 없을 때 메시지 카운트
AUTO_COMPACT=true

if [ -f "$CONFIG_FILE" ]; then
  eval "$(python3 -c "
import json, pathlib
try:
    d = json.loads(pathlib.Path('$CONFIG_FILE').read_text())
    w = d.get('watchdog', {})
    print('CTX_THRESHOLD=' + str(w.get('ctx_percent_threshold', 60)))
    print('CTX_TARGET='    + str(w.get('ctx_percent_target', 15)))
    print('MSG_THRESHOLD=' + str(w.get('message_threshold', 20)))
    print('AUTO_COMPACT='  + ('true' if w.get('auto_compact', True) else 'false'))
except: pass
" 2>/dev/null)"
fi

# ── memory.md 중복 섹션 자동 감지 + 정리 ─────────────────────────
# PostToolUse는 빈도가 높으므로 UserPromptSubmit에서만 실행
MEMORY_FILE="$COLLAR_DIR/memory.md"
if [ "$EVENT" = "UserPromptSubmit" ] && [ -f "$MEMORY_FILE" ]; then
  DEDUP_RESULT="$(python3 - "$MEMORY_FILE" << 'PYEOF'
import pathlib, re, sys
from collections import defaultdict

memory_path = sys.argv[1]
content = pathlib.Path(memory_path).read_text()

# h3 헤더([DATE] TITLE 형식) 위치 전부 찾기
h3_pattern = re.compile(r'\n(### \[(\d{4}-\d{2}-\d{2})\] (.+))\n')
headers = list(h3_pattern.finditer(content))

if not headers:
    sys.exit(0)

# 섹션별 분리: (start, end, date, title)
sections = []
for i, m in enumerate(headers):
    start = m.start()
    end = headers[i+1].start() if i + 1 < len(headers) else len(content)
    sections.append({'start': start, 'end': end,
                     'date': m.group(2), 'title': m.group(3).strip(),
                     'text': content[start:end]})

# 같은 title이 2개 이상이면 최신 날짜만 유지
by_title = defaultdict(list)
for s in sections:
    by_title[s['title']].append(s)

to_remove = set()
for title, group in by_title.items():
    if len(group) > 1:
        for s in sorted(group, key=lambda x: x['date'])[:-1]:
            to_remove.add(id(s))

if not to_remove:
    sys.exit(0)

preamble = content[:headers[0].start()]
kept = [s for s in sections if id(s) not in to_remove]
pathlib.Path(memory_path).write_text(preamble + ''.join(s['text'] for s in kept))
print(len(to_remove))
PYEOF
  )" 2>/dev/null || true

  if [ -n "$DEDUP_RESULT" ] && [ "$DEDUP_RESULT" != "0" ]; then
    TS_NOW="$(date '+%Y-%m-%d %H:%M')"
    echo "COLLAR_WATCHDOG: [$TS_NOW] memory.md 중복 ${DEDUP_RESULT}개 자동 정리 완료."
  fi
fi

# ── ctx% 추정 ─────────────────────────────────────────────────────
# Claude Code는 200K 토큰 컨텍스트를 사용.
# transcript JSONL 파일 크기로 대화 누적량을 추정한다.
# JSONL에서 실제 토큰으로의 변환 비율: ~37 bytes/token (tool 결과·파일 내용·JSON 래퍼 포함)
# 200K tokens × 37 = 7.4MB → 100%  (실측: 1MB delta ≈ Claude Code ctx 14%, 역산 ~7MB=100%)
TRANSCRIPT="$(echo "$HOOK_DATA" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('transcript_path',''))
except: print('')
" 2>/dev/null)"

CTX_PCT=0
USE_MSG_FALLBACK=false

if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  TRANSCRIPT_BYTES="$(wc -c < "$TRANSCRIPT" 2>/dev/null || echo 0)"
  # compact 이후 delta로 ctx% 계산 (절대값 사용 시 compact 후에도 100% 오탐 발생)
  BASELINE_FILE="$COLLAR_DIR/.transcript-baseline"
  BASELINE_SESSION_FILE="$COLLAR_DIR/.baseline-session-id"

  # 세션 ID 추출 (transcript 파일명 = 세션 UUID)
  CURRENT_SESSION_ID="$(basename "$TRANSCRIPT" .jsonl)"
  SAVED_SESSION_ID=""
  [ -f "$BASELINE_SESSION_FILE" ] && SAVED_SESSION_ID="$(cat "$BASELINE_SESSION_FILE" 2>/dev/null || echo '')"

  BASELINE_BYTES=0
  if [ "$CURRENT_SESSION_ID" != "$SAVED_SESSION_ID" ]; then
    # 새 세션 감지 → baseline 리셋 (이전 세션 크기를 기준값으로 쓰면 delta가 음수가 됨)
    echo "0" > "$BASELINE_FILE"
    echo "$CURRENT_SESSION_ID" > "$BASELINE_SESSION_FILE"
  else
    [ -f "$BASELINE_FILE" ] && BASELINE_BYTES="$(cat "$BASELINE_FILE" 2>/dev/null || echo 0)"
  fi

  DELTA_BYTES=$(( TRANSCRIPT_BYTES - BASELINE_BYTES ))
  [ "$DELTA_BYTES" -lt 0 ] && DELTA_BYTES=0
  # 200K tokens at 37 bytes/token (JSONL overhead) = 7,400,000 bytes (compact 이후 누적분만 측정)
  CTX_PCT="$(python3 -c "print(int($DELTA_BYTES * 100 / 7400000))" 2>/dev/null || echo 0)"
  # 100% 초과 클램핑
  [ "$CTX_PCT" -gt 100 ] 2>/dev/null && CTX_PCT=100
else
  # transcript 경로 없음 → 메시지 카운트 폴백
  USE_MSG_FALLBACK=true
fi

# ── 메시지 카운트 폴백 ─────────────────────────────────────────────
if [ "$USE_MSG_FALLBACK" = "true" ]; then
  CURRENT=0
  [ -f "$COUNTER_FILE" ] && CURRENT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
  CURRENT=$((CURRENT + 1))
  echo "$CURRENT" > "$COUNTER_FILE"
  # 메시지 임계값 미달 → 종료
  [ "$CURRENT" -lt "$MSG_THRESHOLD" ] && exit 0
else
  # ctx% 임계값 미달 → 종료
  [ "$CTX_PCT" -lt "$CTX_THRESHOLD" ] 2>/dev/null && exit 0
fi

# ── compact 실행 ───────────────────────────────────────────────────
[ "$AUTO_COMPACT" != "true" ] && exit 0

# 쿨다운: 마지막 compact 실행 후 5분 이내면 스킵 (PostToolUse 폭발 방지)
LOCK_FILE="$COLLAR_DIR/.compact-lock"
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE="$(python3 -c "import os,time; print(int(time.time() - os.path.getmtime('$LOCK_FILE')))" 2>/dev/null || echo 999)"
  [ "$LOCK_AGE" -lt 300 ] 2>/dev/null && exit 0
fi

COLLAR_COMPACT_BIN=""
command -v collar-compact >/dev/null 2>&1 && COLLAR_COMPACT_BIN="collar-compact"
[ -z "$COLLAR_COMPACT_BIN" ] && [ -x "$HOME/.collar/bin/collar-compact" ] && \
  COLLAR_COMPACT_BIN="$HOME/.collar/bin/collar-compact"

TS="$(date '+%Y-%m-%d %H:%M')"

if [ -z "$COLLAR_COMPACT_BIN" ]; then
  echo "COLLAR_WATCHDOG: [$TS] collar-compact 없음. PATH에 collar/bin 추가 필요."
  exit 0
fi

# 락 파일 갱신 → 5분간 재실행 방지
touch "$LOCK_FILE"

# compact 실행 (프로젝트 디렉토리 기준)
cd "$PROJECT_DIR" && "$COLLAR_COMPACT_BIN" 2>/dev/null

# compact 직후 transcript baseline 저장 (다음 ctx% 계산 기준점)
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  wc -c < "$TRANSCRIPT" 2>/dev/null > "$COLLAR_DIR/.transcript-baseline" || true
  basename "$TRANSCRIPT" .jsonl > "$COLLAR_DIR/.baseline-session-id" 2>/dev/null || true
fi

# 카운터 리셋 (폴백 모드일 때)
[ "$USE_MSG_FALLBACK" = "true" ] && echo "0" > "$COUNTER_FILE"

# ── Claude에 알림 출력 ─────────────────────────────────────────────
if [ "$USE_MSG_FALLBACK" = "true" ]; then
  echo "COLLAR_WATCHDOG: [$TS] 메시지 ${MSG_THRESHOLD}개 도달. 지금 즉시 /compact를 실행하라."
else
  echo "COLLAR_WATCHDOG: [$TS] ctx ${CTX_PCT}% (임계값 ${CTX_THRESHOLD}%) 초과. 지금 즉시 /compact를 실행하라."
fi
