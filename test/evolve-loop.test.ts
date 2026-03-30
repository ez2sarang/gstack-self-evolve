import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  computeSkillHealth,
  computeSystemHealth,
  parseTelemetryFile,
  durationSigmoid,
  type TelemetryEvent,
} from "../lib/benchmark";
import {
  parseSkillStructure,
  compareUpstream,
  formatComparisonTable,
} from "../lib/upstream-compare";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "evolve-loop-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Benchmark scoring tests ──────────────────────────────

describe("benchmark scoring", () => {
  test("all-success events score 85-100", () => {
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) => ({
      v: 1, ts: "2026-03-30T10:00:00Z", skill: "qa",
      session_id: `s${i}`, duration_s: 120, outcome: "success",
    }));
    const score = computeSkillHealth(events, "qa");
    expect(score.healthScore).toBeGreaterThanOrEqual(80);
    expect(score.healthScore).toBeLessThanOrEqual(100);
    expect(score.successRate).toBe(1);
    expect(score.runCount).toBe(10);
  });

  test("all-failure events score 0-15", () => {
    const events: TelemetryEvent[] = Array.from({ length: 10 }, (_, i) => ({
      v: 1, ts: "2026-03-30T10:00:00Z", skill: "qa",
      session_id: `s${i}`, duration_s: 30, outcome: "error",
      error_class: "timeout",
    }));
    const score = computeSkillHealth(events, "qa");
    expect(score.healthScore).toBeGreaterThanOrEqual(0);
    expect(score.healthScore).toBeLessThanOrEqual(45);
    expect(score.successRate).toBe(0);
  });

  test("mixed v:1/v:2 events handled correctly", () => {
    const events: TelemetryEvent[] = [
      { v: 1, ts: "2026-03-30T10:00:00Z", skill: "review", session_id: "r1", duration_s: 200, outcome: "success" },
      { v: 1, ts: "2026-03-30T11:00:00Z", skill: "review", session_id: "r2", duration_s: 180, outcome: "success" },
      { v: 2, ts: "2026-03-30T12:00:00Z", skill: "review", session_id: "r3", duration_s: 210, outcome: "success",
        bugs_found: 8, false_positives: 3, user_verdict: "modified" },
      { v: 2, ts: "2026-03-30T13:00:00Z", skill: "review", session_id: "r4", duration_s: 190, outcome: "success",
        bugs_found: 5, false_positives: 1, user_verdict: "accepted" },
    ];
    const score = computeSkillHealth(events, "review");
    expect(score.runCount).toBe(4);
    expect(score.successRate).toBe(1);
    // Only 2 events have verdicts: 1 accepted, 1 modified → 50% acceptance
    expect(score.verdictAcceptance).toBe(0.5);
    // FP rate: (3+1)/(8+5) = 4/13 ≈ 0.31
    expect(score.falsePositiveRate).toBeCloseTo(4 / 13, 2);
    expect(score.healthScore).toBeGreaterThan(50);
  });

  test("system health weighted average is correct", () => {
    const events: TelemetryEvent[] = [
      // qa: 5 runs, all success, fast
      ...Array.from({ length: 5 }, (_, i) => ({
        v: 1 as const, ts: "2026-03-30T10:00:00Z", skill: "qa",
        session_id: `q${i}`, duration_s: 60, outcome: "success",
      })),
      // review: 3 runs, 1 failure, slow
      { v: 1, ts: "2026-03-30T10:00:00Z", skill: "review", session_id: "r1", duration_s: 500, outcome: "success" },
      { v: 1, ts: "2026-03-30T11:00:00Z", skill: "review", session_id: "r2", duration_s: 500, outcome: "error" },
      { v: 1, ts: "2026-03-30T12:00:00Z", skill: "review", session_id: "r3", duration_s: 500, outcome: "success" },
    ];

    const health = computeSystemHealth(events);
    expect(health.skills.length).toBe(2);
    // qa has more runs, so it should weight more in overall score
    const qaScore = health.skills.find(s => s.skill === "qa")!;
    const reviewScore = health.skills.find(s => s.skill === "review")!;
    expect(qaScore.healthScore).toBeGreaterThan(reviewScore.healthScore);
    // Weighted: (qa.score*5 + review.score*3) / 8
    const expectedOverall = Math.round((qaScore.healthScore * 5 + reviewScore.healthScore * 3) / 8);
    expect(health.overallScore).toBe(expectedOverall);
  });

  test("duration sigmoid: fast scores high, slow scores low", () => {
    const fast = durationSigmoid(60);   // 60s
    const mid = durationSigmoid(300);   // 5min (center)
    const slow = durationSigmoid(600);  // 10min

    expect(fast).toBeGreaterThan(0.8);
    expect(mid).toBeCloseTo(0.5, 1);
    expect(slow).toBeLessThan(0.1);
  });

  test("parseTelemetryFile handles string duration_s", () => {
    const file = join(tmp, "test.jsonl");
    writeFileSync(file, '{"v":1,"skill":"qa","duration_s":"120","outcome":"success","ts":"2026-03-30T10:00:00Z"}\n');
    const events = parseTelemetryFile(file);
    expect(events.length).toBe(1);
    expect(events[0].duration_s).toBe(120);
  });

  test("parseTelemetryFile skips malformed lines", () => {
    const file = join(tmp, "test.jsonl");
    writeFileSync(file, 'invalid json\n{"v":1,"skill":"qa","duration_s":60,"outcome":"success","ts":"2026-03-30T10:00:00Z"}\n');
    const events = parseTelemetryFile(file);
    expect(events.length).toBe(1);
  });

  test("empty skill returns zero score", () => {
    const score = computeSkillHealth([], "nonexistent");
    expect(score.healthScore).toBe(0);
    expect(score.runCount).toBe(0);
  });
});

// ─── Upstream comparison tests ────────────────────────────

describe("upstream comparison", () => {
  test("parseSkillStructure extracts phase count and tools", () => {
    const skillDir = join(tmp, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md.tmpl"), `---
name: test-skill
allowed-tools:
  - Bash
  - Read
  - Edit
---

# /test-skill

## Phase 1: Setup

Check prerequisites. Verify dev server running.

\`\`\`bash
echo "setup"
\`\`\`

## Phase 2: Execute

Do the work.

\`\`\`bash
echo "execute"
\`\`\`

## Phase 3: Validate

Confirm results.
`);
    const structure = parseSkillStructure(join(skillDir, "SKILL.md.tmpl"));
    expect(structure).not.toBeNull();
    expect(structure!.phaseCount).toBe(3);
    expect(structure!.allowedTools).toContain("Bash");
    expect(structure!.allowedTools).toContain("Read");
    expect(structure!.allowedTools).toContain("Edit");
    expect(structure!.hasPreChecks).toBe(true);
    expect(structure!.codeBlockCount).toBe(2);
  });

  test("compareUpstream generates comparison rows", () => {
    // Create self-evolve dir with 2 skills
    const selfDir = join(tmp, "self");
    mkdirSync(join(selfDir, "qa"), { recursive: true });
    mkdirSync(join(selfDir, "evolve"), { recursive: true });
    writeFileSync(join(selfDir, "qa", "SKILL.md.tmpl"), "---\nname: qa\nallowed-tools:\n  - Bash\n---\n## Phase 1: Test\ncheck stuff\n## Phase 2: Fix\n");
    writeFileSync(join(selfDir, "evolve", "SKILL.md.tmpl"), "---\nname: evolve\nallowed-tools:\n  - Bash\n  - Read\n---\n## Phase 1: Diagnose\n## Phase 2: Hypothesize\n## Phase 3: Propose\n## Phase 4: Validate\n");

    // Create upstream dir with 1 skill (no evolve)
    const upDir = join(tmp, "upstream");
    mkdirSync(join(upDir, "qa"), { recursive: true });
    writeFileSync(join(upDir, "qa", "SKILL.md.tmpl"), "---\nname: qa\nallowed-tools:\n  - Bash\n---\n## Phase 1: Test\n## Phase 2: Fix\n");

    const rows = compareUpstream(selfDir, upDir);
    expect(rows.length).toBeGreaterThan(5);

    // Check total skills
    const totalRow = rows.find(r => r.dimension === "Total skills");
    expect(totalRow).toBeDefined();
    expect(totalRow!.selfEvolve).toBe("2");
    expect(totalRow!.upstream).toBe("1");
    expect(totalRow!.delta).toBe("+1");

    // Check unique to self-evolve includes "evolve"
    const uniqueRow = rows.find(r => r.dimension === "Unique to self-evolve");
    expect(uniqueRow).toBeDefined();
    expect(uniqueRow!.selfEvolve).toContain("evolve");
  });

  test("compareUpstream handles missing upstream gracefully", () => {
    const selfDir = join(tmp, "self-only");
    mkdirSync(join(selfDir, "qa"), { recursive: true });
    writeFileSync(join(selfDir, "qa", "SKILL.md.tmpl"), "---\nname: qa\n---\n## Phase 1\n");

    const rows = compareUpstream(selfDir, join(tmp, "nonexistent"));
    expect(rows.length).toBeGreaterThan(0);
    const totalRow = rows.find(r => r.dimension === "Total skills");
    expect(totalRow!.upstream).toBe("0");
  });

  test("formatComparisonTable produces readable output", () => {
    const rows = [
      { dimension: "Total skills", selfEvolve: "32", upstream: "31", delta: "+1" },
      { dimension: "Telemetry schema", selfEvolve: "v:2", upstream: "v:1", delta: "+11 fields" },
    ];
    const table = formatComparisonTable(rows, "0.13.6.0");
    expect(table).toContain("garrytan/gstack v0.13.6.0");
    expect(table).toContain("Total skills");
    expect(table).toContain("+1");
  });
});

// ─── Evolve loop integration ──────────────────────────────

describe("evolve loop dry-run", () => {
  test("dry-run produces iteration reports", () => {
    const analyticsDir = join(tmp, "analytics");
    mkdirSync(analyticsDir, { recursive: true });

    // Create seed telemetry
    const lines = [
      '{"v":1,"ts":"2026-03-28T10:00:00Z","skill":"qa","session_id":"s1","duration_s":120,"outcome":"success","source":"test"}',
      '{"v":1,"ts":"2026-03-28T11:00:00Z","skill":"qa","session_id":"s2","duration_s":30,"outcome":"error","error_class":"timeout","source":"test"}',
      '{"v":1,"ts":"2026-03-28T12:00:00Z","skill":"qa","session_id":"s3","duration_s":200,"outcome":"success","source":"test"}',
      '{"v":1,"ts":"2026-03-28T13:00:00Z","skill":"qa","session_id":"s4","duration_s":25,"outcome":"error","error_class":"timeout","source":"test"}',
      '{"v":1,"ts":"2026-03-28T14:00:00Z","skill":"review","session_id":"r1","duration_s":180,"outcome":"success","source":"test"}',
      '{"v":1,"ts":"2026-03-28T15:00:00Z","skill":"review","session_id":"r2","duration_s":200,"outcome":"success","source":"test"}',
      '{"v":1,"ts":"2026-03-28T16:00:00Z","skill":"review","session_id":"r3","duration_s":15,"outcome":"error","error_class":"parse_error","source":"test"}',
    ];
    writeFileSync(join(analyticsDir, "skill-usage.jsonl"), lines.join("\n") + "\n");
    mkdirSync(join(tmp, "learned"), { recursive: true });

    const result = Bun.spawnSync({
      cmd: ["bash", join(process.cwd(), "bin/gstack-evolve-loop"),
        "--dry-run", "--iterations", "3",
        "--telemetry-file", join(analyticsDir, "skill-usage.jsonl")],
      env: {
        ...process.env,
        GSTACK_DIR: process.cwd(),
        GSTACK_STATE_DIR: tmp,
        UPSTREAM_GSTACK_DIR: join(process.env.HOME || "", ".claude/skills/gstack"),
      },
      cwd: process.cwd(),
    });

    const output = result.stdout.toString();
    expect(output).toContain("Evolution Iteration");
    expect(output).toContain("DRY RUN");
    expect(output).toContain("Evolution Loop Complete");
  });
});
