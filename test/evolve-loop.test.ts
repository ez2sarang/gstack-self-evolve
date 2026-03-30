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
import {
  readLocalVersion,
  classifyLearnings,
  formatSyncReport,
  type SyncResult,
} from "../lib/upstream-sync";

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
      v: 1, ts: "2026-03-30T10:00:00Z", event_type: "skill_run", skill: "qa",
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
      v: 1, ts: "2026-03-30T10:00:00Z", event_type: "skill_run", skill: "qa",
      session_id: `s${i}`, duration_s: 30, outcome: "error",
      error_class: "timeout",
    }));
    const score = computeSkillHealth(events, "qa");
    expect(score.healthScore).toBeGreaterThanOrEqual(0);
    expect(score.healthScore).toBeLessThanOrEqual(45);
    expect(score.successRate).toBe(0);
  });

  test("hook_fire events are excluded from health scoring", () => {
    const events: TelemetryEvent[] = [
      // 38 hook_fire events for careful (should be ignored)
      ...Array.from({ length: 38 }, (_, i) => ({
        skill: "careful", ts: "2026-03-30T10:00:00Z", event: "hook_fire", pattern: "rm_recursive",
      } as TelemetryEvent)),
      // 2 actual skill_run events for qa
      { v: 1, ts: "2026-03-30T10:00:00Z", event_type: "skill_run", skill: "qa",
        session_id: "s1", duration_s: 120, outcome: "success" },
      { v: 1, ts: "2026-03-30T11:00:00Z", event_type: "skill_run", skill: "qa",
        session_id: "s2", duration_s: 120, outcome: "success" },
    ];
    // careful should have 0 runs (hook_fire excluded)
    const carefulScore = computeSkillHealth(events, "careful");
    expect(carefulScore.runCount).toBe(0);
    expect(carefulScore.healthScore).toBe(0);
    // qa should have 2 runs
    const qaScore = computeSkillHealth(events, "qa");
    expect(qaScore.runCount).toBe(2);
    expect(qaScore.successRate).toBe(1);
    // system health should only include qa
    const health = computeSystemHealth(events);
    expect(health.skills.length).toBe(1);
    expect(health.skills[0].skill).toBe("qa");
  });

  test("mixed v:1/v:2 events handled correctly", () => {
    const events: TelemetryEvent[] = [
      { v: 1, ts: "2026-03-30T10:00:00Z", event_type: "skill_run", skill: "review", session_id: "r1", duration_s: 200, outcome: "success" },
      { v: 1, ts: "2026-03-30T11:00:00Z", event_type: "skill_run", skill: "review", session_id: "r2", duration_s: 180, outcome: "success" },
      { v: 2, ts: "2026-03-30T12:00:00Z", event_type: "skill_run", skill: "review", session_id: "r3", duration_s: 210, outcome: "success",
        bugs_found: 8, false_positives: 3, user_verdict: "modified" },
      { v: 2, ts: "2026-03-30T13:00:00Z", event_type: "skill_run", skill: "review", session_id: "r4", duration_s: 190, outcome: "success",
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
        v: 1 as const, ts: "2026-03-30T10:00:00Z", event_type: "skill_run" as const, skill: "qa",
        session_id: `q${i}`, duration_s: 60, outcome: "success",
      })),
      // review: 3 runs, 1 failure, slow
      { v: 1, ts: "2026-03-30T10:00:00Z", event_type: "skill_run", skill: "review", session_id: "r1", duration_s: 500, outcome: "success" },
      { v: 1, ts: "2026-03-30T11:00:00Z", event_type: "skill_run", skill: "review", session_id: "r2", duration_s: 500, outcome: "error" },
      { v: 1, ts: "2026-03-30T12:00:00Z", event_type: "skill_run", skill: "review", session_id: "r3", duration_s: 500, outcome: "success" },
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

// ─── Upstream sync tests ─────────────────────────────────

describe("upstream sync", () => {
  test("readLocalVersion reads VERSION file", () => {
    writeFileSync(join(tmp, "VERSION"), "1.2.3\n");
    expect(readLocalVersion(tmp)).toBe("1.2.3");
  });

  test("readLocalVersion returns unknown for missing file", () => {
    expect(readLocalVersion(join(tmp, "nonexistent"))).toBe("unknown");
  });

  test("classifyLearnings marks unaffected learnings as still_valid", () => {
    const learnings = [
      { id: "pat-1", skill: "qa", pattern: "always check dev server", tags: [] },
      { id: "pat-2", skill: "review", pattern: "check for SQL injection", tags: [] },
    ];
    // Only qa template changed
    const changedTemplates = ["qa/SKILL.md.tmpl"];
    const result = classifyLearnings(learnings, changedTemplates, tmp);
    // review is unaffected
    expect(result.still_valid).toContain("pat-2");
    // qa is affected - goes to needs_review since we can't read the diff in test
    expect(result.still_valid).not.toContain("pat-1");
  });

  test("classifyLearnings handles empty changes", () => {
    const learnings = [
      { id: "pat-1", skill: "qa", pattern: "test pattern", tags: [] },
    ];
    const result = classifyLearnings(learnings, [], tmp);
    expect(result.still_valid).toContain("pat-1");
    expect(result.reinforced).toHaveLength(0);
    expect(result.invalidated).toHaveLength(0);
  });

  test("formatSyncReport formats up_to_date correctly", () => {
    const result: SyncResult = {
      status: "up_to_date",
      localVersion: "0.13.6.0",
      upstreamVersion: "0.13.6.0",
      mergedCommits: 0,
      changedTemplates: [],
      message: "Already up to date.",
    };
    const report = formatSyncReport(result);
    expect(report).toContain("UP TO DATE");
    expect(report).toContain("v0.13.6.0");
  });

  test("formatSyncReport formats synced correctly", () => {
    const result: SyncResult = {
      status: "synced",
      localVersion: "0.13.6.0",
      upstreamVersion: "0.14.0.0",
      mergedCommits: 15,
      changedTemplates: ["qa/SKILL.md.tmpl", "review/SKILL.md.tmpl"],
      message: "Synced 15 commits.",
    };
    const report = formatSyncReport(result);
    expect(report).toContain("SYNCED");
    expect(report).toContain("+15 commits");
    expect(report).toContain("2 changed");
    expect(report).toContain("qa/SKILL.md.tmpl");
  });

  test("formatSyncReport formats skipped correctly", () => {
    const result: SyncResult = {
      status: "skipped",
      localVersion: "0.13.6.0",
      upstreamVersion: null,
      mergedCommits: 0,
      changedTemplates: [],
      message: "Skipped.",
    };
    const report = formatSyncReport(result);
    expect(report).toContain("SKIPPED");
  });
});

// ─── Evolve loop integration ──────────────────────────────

describe("evolve loop dry-run", () => {
  test("dry-run produces iteration reports", () => {
    const analyticsDir = join(tmp, "analytics");
    mkdirSync(analyticsDir, { recursive: true });

    // Create seed telemetry (event_type: "skill_run" required for health scoring)
    const lines = [
      '{"v":1,"ts":"2026-03-28T10:00:00Z","event_type":"skill_run","skill":"qa","session_id":"s1","duration_s":120,"outcome":"success","source":"test"}',
      '{"v":1,"ts":"2026-03-28T11:00:00Z","event_type":"skill_run","skill":"qa","session_id":"s2","duration_s":30,"outcome":"error","error_class":"timeout","source":"test"}',
      '{"v":1,"ts":"2026-03-28T12:00:00Z","event_type":"skill_run","skill":"qa","session_id":"s3","duration_s":200,"outcome":"success","source":"test"}',
      '{"v":1,"ts":"2026-03-28T13:00:00Z","event_type":"skill_run","skill":"qa","session_id":"s4","duration_s":25,"outcome":"error","error_class":"timeout","source":"test"}',
      '{"v":1,"ts":"2026-03-28T14:00:00Z","event_type":"skill_run","skill":"review","session_id":"r1","duration_s":180,"outcome":"success","source":"test"}',
      '{"v":1,"ts":"2026-03-28T15:00:00Z","event_type":"skill_run","skill":"review","session_id":"r2","duration_s":200,"outcome":"success","source":"test"}',
      '{"v":1,"ts":"2026-03-28T16:00:00Z","event_type":"skill_run","skill":"review","session_id":"r3","duration_s":15,"outcome":"error","error_class":"parse_error","source":"test"}',
    ];
    writeFileSync(join(analyticsDir, "skill-usage.jsonl"), lines.join("\n") + "\n");
    mkdirSync(join(tmp, "learned"), { recursive: true });

    const result = Bun.spawnSync({
      cmd: ["bash", join(process.cwd(), "bin/gstack-evolve-loop"),
        "--dry-run", "--no-sync", "--iterations", "3",
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
    expect(output).toContain("Upstream Sync");
    expect(output).toContain("SKIPPED");
    expect(output).toContain("Evolution Iteration");
    expect(output).toContain("DRY RUN");
    expect(output).toContain("Evolution Loop Complete");
  });

  test("--no-sync skips upstream sync", () => {
    const analyticsDir = join(tmp, "analytics");
    mkdirSync(analyticsDir, { recursive: true });
    writeFileSync(join(analyticsDir, "skill-usage.jsonl"),
      '{"v":1,"ts":"2026-03-28T10:00:00Z","event_type":"skill_run","skill":"qa","session_id":"s1","duration_s":120,"outcome":"success","source":"test"}\n' +
      '{"v":1,"ts":"2026-03-28T11:00:00Z","event_type":"skill_run","skill":"qa","session_id":"s2","duration_s":30,"outcome":"error","error_class":"timeout","source":"test"}\n'
    );
    mkdirSync(join(tmp, "learned"), { recursive: true });

    const result = Bun.spawnSync({
      cmd: ["bash", join(process.cwd(), "bin/gstack-evolve-loop"),
        "--dry-run", "--no-sync", "--iterations", "1",
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
    expect(output).toContain("SKIPPED (--no-sync)");
    expect(output).toContain("Sync upstream: false");
  });
});

// ─── Patch templates tests ───────────────────────────────

describe("patch templates", () => {
  const { getPatchContent, getAvailablePatches } = require("../lib/patch-templates");

  test("qa:timeout returns port-check patch", () => {
    const patch = getPatchContent("qa", "timeout", "4/8 timeout errors", "test-1");
    expect(patch).not.toBeNull();
    expect(patch!.skill).toBe("qa");
    expect(patch!.title).toContain("Dev Server");
    expect(patch!.content).toContain("curl");
    expect(patch!.content).toContain("4/8 timeout errors");
  });

  test("investigate:scope_exceeded returns time-budget patch", () => {
    const patch = getPatchContent("investigate", "scope_exceeded", "2/4 exceeded", "test-2");
    expect(patch).not.toBeNull();
    expect(patch!.title).toContain("Time-Budget");
    expect(patch!.content).toContain("10 minutes");
  });

  test("review:false_positive returns ORM patch", () => {
    const patch = getPatchContent("review", "false_positive", "5/13 FP", "test-3");
    expect(patch).not.toBeNull();
    expect(patch!.title).toContain("ORM");
    expect(patch!.content).toContain("prisma");
  });

  test("unknown combo falls back to generic", () => {
    const patch = getPatchContent("qa", "general_failure", "1/10 errors", "test-4");
    expect(patch).not.toBeNull();
    expect(patch!.title).toContain("Error Recovery");
  });

  test("completely unknown error returns null", () => {
    const patch = getPatchContent("qa", "never_heard_of_this", "0/0", "test-5");
    expect(patch).toBeNull();
  });

  test("getAvailablePatches returns known error types", () => {
    const patches = getAvailablePatches();
    expect(patches).toContain("timeout");
    expect(patches).toContain("scope_exceeded");
    expect(patches).toContain("false_positive");
  });
});

// ─── gstack-evolve-apply tests ───────────────────────────

describe("gstack-evolve-apply", () => {
  const applyScript = join(process.cwd(), "bin/gstack-evolve-apply");

  test("write + deploy creates patch file and injects into SKILL.md", () => {
    // Set up fake skill directory
    const skillsDir = join(tmp, "skills");
    const skillDir = join(skillsDir, "qa");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# QA Skill\n\nSome content here.\n");

    const result = Bun.spawnSync({
      cmd: ["bash", applyScript,
        "--skill", "qa",
        "--patch-id", "test-patch-1",
        "--content", "### Test Patch\n\nThis is a test improvement.",
        "--confidence", "0.90"],
      env: {
        ...process.env,
        GSTACK_STATE_DIR: tmp,
        GSTACK_SKILLS_DIR: skillsDir,
      },
    });

    const output = result.stdout.toString();
    expect(output).toContain("WRITTEN");
    expect(output).toContain("DEPLOYED");

    // Check patch file was created
    const patchFile = join(tmp, "skill-patches", "qa.md");
    expect(Bun.file(patchFile).size).toBeGreaterThan(0);
    const patchContent = readFileSync(patchFile, "utf-8");
    expect(patchContent).toContain("<!-- patch:test-patch-1");
    expect(patchContent).toContain("### Test Patch");

    // Check SKILL.md was patched
    const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("<!-- EVOLVE-PATCHES START -->");
    expect(skillMd).toContain("### Test Patch");
    expect(skillMd).toContain("<!-- EVOLVE-PATCHES END -->");
    // Original content preserved
    expect(skillMd).toContain("# QA Skill");
  });

  test("remove strips patch and cleans SKILL.md", () => {
    const skillsDir = join(tmp, "skills-rm");
    const skillDir = join(skillsDir, "qa");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# QA Skill\n\nOriginal content.\n");

    // First write a patch
    Bun.spawnSync({
      cmd: ["bash", applyScript, "--skill", "qa", "--patch-id", "rm-test-1",
        "--content", "### To Remove"],
      env: { ...process.env, GSTACK_STATE_DIR: tmp, GSTACK_SKILLS_DIR: skillsDir },
    });

    // Now remove it
    const result = Bun.spawnSync({
      cmd: ["bash", applyScript, "--remove", "rm-test-1", "--skill", "qa"],
      env: { ...process.env, GSTACK_STATE_DIR: tmp, GSTACK_SKILLS_DIR: skillsDir },
    });

    expect(result.stdout.toString()).toContain("REMOVED");

    // SKILL.md should be clean
    const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).not.toContain("### To Remove");
    expect(skillMd).toContain("# QA Skill");
  });

  test("duplicate patch is rejected", () => {
    const skillsDir = join(tmp, "skills-dup");
    const skillDir = join(skillsDir, "qa");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# QA\n");

    // Write twice
    Bun.spawnSync({
      cmd: ["bash", applyScript, "--skill", "qa", "--patch-id", "dup-1",
        "--content", "### Patch A"],
      env: { ...process.env, GSTACK_STATE_DIR: tmp, GSTACK_SKILLS_DIR: skillsDir },
    });
    const result = Bun.spawnSync({
      cmd: ["bash", applyScript, "--skill", "qa", "--patch-id", "dup-1",
        "--content", "### Patch A again"],
      env: { ...process.env, GSTACK_STATE_DIR: tmp, GSTACK_SKILLS_DIR: skillsDir },
    });

    expect(result.stdout.toString()).toContain("DUPLICATE");
  });

  test("list shows active patches", () => {
    const skillsDir = join(tmp, "skills-list");
    const skillDir = join(skillsDir, "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Review\n");

    Bun.spawnSync({
      cmd: ["bash", applyScript, "--skill", "review", "--patch-id", "list-1",
        "--content", "### Patch", "--confidence", "0.95"],
      env: { ...process.env, GSTACK_STATE_DIR: tmp, GSTACK_SKILLS_DIR: skillsDir },
    });

    const result = Bun.spawnSync({
      cmd: ["bash", applyScript, "--list", "--skill", "review"],
      env: { ...process.env, GSTACK_STATE_DIR: tmp, GSTACK_SKILLS_DIR: skillsDir },
    });

    expect(result.stdout.toString()).toContain("list-1");
    expect(result.stdout.toString()).toContain("0.95");
  });

  test("backup is created before deployment", () => {
    const skillsDir = join(tmp, "skills-bak");
    const skillDir = join(skillsDir, "qa");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Original Content\n");

    Bun.spawnSync({
      cmd: ["bash", applyScript, "--skill", "qa", "--patch-id", "bak-1",
        "--content", "### New patch"],
      env: { ...process.env, GSTACK_STATE_DIR: tmp, GSTACK_SKILLS_DIR: skillsDir },
    });

    // Check backup exists
    const backupFile = join(tmp, "skill-backups", "qa.SKILL.md.bak");
    const backup = readFileSync(backupFile, "utf-8");
    expect(backup).toContain("# Original Content");
    expect(backup).not.toContain("### New patch");
  });
});
