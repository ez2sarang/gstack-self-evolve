/**
 * lib/benchmark.ts — Skill health scoring from telemetry JSONL
 *
 * Computes a 0-100 health score per skill from skill-usage.jsonl data.
 * Formula:
 *   healthScore = successRate*40 + verdictAcceptance*30 + (1-falsePositiveRate)*15 + durationScore*15
 *   durationScore = 1 / (1 + e^(0.01 * (avgDurationS - 300)))
 *   overallScore = Σ(skill.score * skill.runs) / Σ(skill.runs)
 */

import { readFileSync, existsSync } from "fs";

export interface TelemetryEvent {
  v?: number;
  ts: string;
  event_type?: string;
  event?: string;
  skill: string;
  session_id?: string;
  gstack_version?: string;
  os?: string;
  arch?: string;
  duration_s?: number | null;
  outcome?: string;
  error_class?: string | null;
  error_message?: string | null;
  failed_step?: string | null;
  used_browse?: boolean;
  sessions?: number;
  installation_id?: string | null;
  source?: string;
  _repo_slug?: string;
  _branch?: string;
  // v:2 feedback fields
  bugs_found?: number | null;
  bugs_fixed?: number | null;
  false_positives?: number | null;
  user_verdict?: string | null;
  retry_count?: number | null;
  failure_reason?: string | null;
  context_tags?: string | null;
  skill_phase?: string | null;
  questions_asked?: number | null;
  commits_made?: number | null;
  health_score_before?: number | null;
  health_score_after?: number | null;
}

export interface SkillHealthScore {
  skill: string;
  successRate: number;
  avgDurationS: number;
  falsePositiveRate: number;
  verdictAcceptance: number;
  healthScore: number;
  runCount: number;
}

export interface SystemHealth {
  skills: SkillHealthScore[];
  overallScore: number;
  computedAt: string;
}

/**
 * Sigmoid duration score: fast skills score high, slow skills score low.
 * Centered at 300s (5min). At 60s → ~0.92, at 600s → ~0.05
 */
export function durationSigmoid(avgDurationS: number): number {
  return 1 / (1 + Math.exp(0.01 * (avgDurationS - 300)));
}

/**
 * Compute health score for a single skill from its telemetry events.
 */
export function computeSkillHealth(events: TelemetryEvent[], skill: string): SkillHealthScore {
  const skillEvents = events.filter(e => e.skill === skill && e.skill !== "gstack" && e.event_type === "skill_run");
  const runCount = skillEvents.length;

  if (runCount === 0) {
    return { skill, successRate: 0, avgDurationS: 0, falsePositiveRate: 0, verdictAcceptance: 0.5, healthScore: 0, runCount: 0 };
  }

  // Success rate
  const successCount = skillEvents.filter(e => e.outcome === "success").length;
  const successRate = successCount / runCount;

  // Average duration
  const durEvents = skillEvents.filter(e => e.duration_s != null && e.duration_s > 0);
  const avgDurationS = durEvents.length > 0
    ? durEvents.reduce((sum, e) => sum + (e.duration_s as number), 0) / durEvents.length
    : 0;

  // False positive rate (v:2 only)
  const fpEvents = skillEvents.filter(e => e.false_positives != null && e.bugs_found != null && (e.bugs_found as number) > 0);
  let falsePositiveRate = 0;
  if (fpEvents.length > 0) {
    const totalFP = fpEvents.reduce((sum, e) => sum + ((e.false_positives as number) || 0), 0);
    const totalBugs = fpEvents.reduce((sum, e) => sum + ((e.bugs_found as number) || 0), 0);
    falsePositiveRate = totalBugs > 0 ? totalFP / totalBugs : 0;
  }

  // Verdict acceptance (v:2 only)
  const verdictEvents = skillEvents.filter(e => e.user_verdict != null && e.user_verdict !== "unknown");
  let verdictAcceptance = 0.5; // neutral default when no v:2 data
  if (verdictEvents.length > 0) {
    const accepted = verdictEvents.filter(e => e.user_verdict === "accepted").length;
    verdictAcceptance = accepted / verdictEvents.length;
  }

  // Composite score
  const durScore = durationSigmoid(avgDurationS);
  const raw = successRate * 40 + verdictAcceptance * 30 + (1 - falsePositiveRate) * 15 + durScore * 15;
  const healthScore = Math.max(0, Math.min(100, Math.round(raw)));

  return { skill, successRate, avgDurationS, falsePositiveRate, verdictAcceptance, healthScore, runCount };
}

/**
 * Compute system-wide health from all telemetry events.
 */
export function computeSystemHealth(events: TelemetryEvent[]): SystemHealth {
  // Get unique skill names (exclude bare "gstack" preamble entries)
  const skillNames = [...new Set(events.filter(e => e.skill && e.skill !== "gstack" && e.event_type === "skill_run").map(e => e.skill))];

  const skills = skillNames.map(name => computeSkillHealth(events, name)).filter(s => s.runCount > 0);

  // Weighted average by run count
  const totalRuns = skills.reduce((sum, s) => sum + s.runCount, 0);
  const overallScore = totalRuns > 0
    ? Math.round(skills.reduce((sum, s) => sum + s.healthScore * s.runCount, 0) / totalRuns)
    : 0;

  return {
    skills: skills.sort((a, b) => b.runCount - a.runCount),
    overallScore,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Parse a telemetry JSONL file into TelemetryEvent array.
 */
export function parseTelemetryFile(filePath: string): TelemetryEvent[] {
  if (!existsSync(filePath)) return [];

  const lines = readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim());
  const events: TelemetryEvent[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.skill) {
        // Normalize duration_s (can be string or number)
        if (typeof obj.duration_s === "string") {
          obj.duration_s = parseInt(obj.duration_s, 10) || null;
        }
        events.push(obj as TelemetryEvent);
      }
    } catch {
      // skip malformed lines
    }
  }

  return events;
}

/**
 * Format system health as a readable table.
 */
export function formatHealthTable(health: SystemHealth): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("Skill Health Benchmark");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`  ${"SKILL".padEnd(16)} ${"RUNS".padStart(5)} ${"OK%".padStart(5)} ${"VERDICT".padStart(8)} ${"SCORE".padStart(6)}`);
  lines.push(`  ${"─".repeat(16)} ${"─".repeat(5)} ${"─".repeat(5)} ${"─".repeat(8)} ${"─".repeat(6)}`);

  for (const s of health.skills) {
    const okPct = `${Math.round(s.successRate * 100)}%`;
    const verdict = s.verdictAcceptance === 0.5 ? "n/a" : `${Math.round(s.verdictAcceptance * 100)}%`;
    lines.push(`  /${s.skill.padEnd(15)} ${String(s.runCount).padStart(5)} ${okPct.padStart(5)} ${verdict.padStart(8)} ${String(s.healthScore).padStart(5)}/100`);
  }

  lines.push("");
  lines.push(`  Overall: ${health.overallScore}/100`);
  lines.push("");

  return lines.join("\n");
}

// CLI mode: bun run lib/benchmark.ts [--file path]
if (import.meta.main) {
  const args = process.argv.slice(2);
  let filePath = `${process.env.HOME}/.gstack/analytics/skill-usage.jsonl`;
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    filePath = args[fileIdx + 1];
  }

  const events = parseTelemetryFile(filePath);
  const health = computeSystemHealth(events);

  if (args.includes("--json")) {
    console.log(JSON.stringify(health, null, 2));
  } else {
    console.log(formatHealthTable(health));
  }
}
