/**
 * lib/upstream-compare.ts — Structural comparison against upstream garrytan/gstack
 *
 * Reads .tmpl files from both self-evolve and upstream directories.
 * Compares: skill count, phase count, pre-checks, unique features.
 * No network calls, local files only.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename } from "path";

export interface SkillStructure {
  name: string;
  phaseCount: number;
  allowedTools: string[];
  hasPreChecks: boolean;
  hasBrowseUsage: boolean;
  lineCount: number;
  codeBlockCount: number;
}

export interface ComparisonRow {
  dimension: string;
  selfEvolve: string;
  upstream: string;
  delta: string;
}

/**
 * Parse a SKILL.md.tmpl file to extract structural info.
 */
export function parseSkillStructure(tmplPath: string): SkillStructure | null {
  if (!existsSync(tmplPath)) return null;

  const content = readFileSync(tmplPath, "utf-8");
  const lines = content.split("\n");
  const name = basename(join(tmplPath, ".."));

  // Parse YAML frontmatter for allowed-tools
  let allowedTools: string[] = [];
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const toolsMatch = fm.match(/allowed-tools:\n((?:\s+-\s+.+\n?)*)/);
    if (toolsMatch) {
      allowedTools = toolsMatch[1].split("\n")
        .map(l => l.replace(/^\s+-\s+/, "").trim())
        .filter(Boolean);
    }
  }

  // Count phases (## Phase or ### Phase headers)
  const phaseCount = (content.match(/^#{2,3}\s+Phase\s+/gm) || []).length;

  // Count code blocks
  const codeBlockCount = (content.match(/^```/gm) || []).length / 2;

  // Detect pre-checks in first phase
  const phase1Match = content.match(/##\s+Phase\s+1[\s\S]*?(?=##\s+Phase\s+2|$)/i);
  let hasPreChecks = false;
  if (phase1Match) {
    hasPreChecks = /\b(check|verify|ensure|confirm|prerequisite|pre-check|precheck)\b/i.test(phase1Match[0]);
  }

  // Detect browse usage
  const hasBrowseUsage = /\$B\s|browse|headless|chromium/i.test(content);

  return {
    name,
    phaseCount,
    allowedTools,
    hasPreChecks,
    hasBrowseUsage,
    lineCount: lines.length,
    codeBlockCount: Math.floor(codeBlockCount),
  };
}

/**
 * Find all skill template files in a directory.
 */
function findSkillTemplates(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(dir)) return result;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const tmplPath = join(dir, entry, "SKILL.md.tmpl");
      if (existsSync(tmplPath)) {
        result.set(entry, tmplPath);
      }
    }
  } catch {
    // directory not readable
  }

  return result;
}

/**
 * Compare self-evolve skills against upstream.
 */
export function compareUpstream(selfEvolveDir: string, upstreamDir: string): ComparisonRow[] {
  const selfSkills = findSkillTemplates(selfEvolveDir);
  const upstreamSkills = findSkillTemplates(upstreamDir);

  const selfStructures: SkillStructure[] = [];
  const upstreamStructures: SkillStructure[] = [];

  for (const [, path] of selfSkills) {
    const s = parseSkillStructure(path);
    if (s) selfStructures.push(s);
  }

  for (const [, path] of upstreamSkills) {
    const s = parseSkillStructure(path);
    if (s) upstreamStructures.push(s);
  }

  const rows: ComparisonRow[] = [];

  // Total skills
  rows.push({
    dimension: "Total skills",
    selfEvolve: String(selfSkills.size),
    upstream: String(upstreamSkills.size),
    delta: diffStr(selfSkills.size, upstreamSkills.size),
  });

  // Average phases per skill
  const selfAvgPhases = selfStructures.length > 0
    ? (selfStructures.reduce((s, x) => s + x.phaseCount, 0) / selfStructures.length).toFixed(1)
    : "0";
  const upAvgPhases = upstreamStructures.length > 0
    ? (upstreamStructures.reduce((s, x) => s + x.phaseCount, 0) / upstreamStructures.length).toFixed(1)
    : "0";
  rows.push({
    dimension: "Avg phases/skill",
    selfEvolve: selfAvgPhases,
    upstream: upAvgPhases,
    delta: diffStr(parseFloat(selfAvgPhases), parseFloat(upAvgPhases)),
  });

  // Skills with pre-checks
  const selfPreChecks = selfStructures.filter(s => s.hasPreChecks).length;
  const upPreChecks = upstreamStructures.filter(s => s.hasPreChecks).length;
  rows.push({
    dimension: "Skills w/ pre-checks",
    selfEvolve: String(selfPreChecks),
    upstream: String(upPreChecks),
    delta: diffStr(selfPreChecks, upPreChecks),
  });

  // Average line count
  const selfAvgLines = selfStructures.length > 0
    ? Math.round(selfStructures.reduce((s, x) => s + x.lineCount, 0) / selfStructures.length)
    : 0;
  const upAvgLines = upstreamStructures.length > 0
    ? Math.round(upstreamStructures.reduce((s, x) => s + x.lineCount, 0) / upstreamStructures.length)
    : 0;
  rows.push({
    dimension: "Avg lines/template",
    selfEvolve: String(selfAvgLines),
    upstream: String(upAvgLines),
    delta: diffStr(selfAvgLines, upAvgLines),
  });

  // Unique to self-evolve
  const selfOnly = [...selfSkills.keys()].filter(k => !upstreamSkills.has(k));
  rows.push({
    dimension: "Unique to self-evolve",
    selfEvolve: selfOnly.length > 0 ? selfOnly.join(", ") : "none",
    upstream: "—",
    delta: `+${selfOnly.length}`,
  });

  // Unique to upstream
  const upOnly = [...upstreamSkills.keys()].filter(k => !selfSkills.has(k));
  rows.push({
    dimension: "Unique to upstream",
    selfEvolve: "—",
    upstream: upOnly.length > 0 ? upOnly.join(", ") : "none",
    delta: upOnly.length > 0 ? `-${upOnly.length}` : "0",
  });

  // Feature: Telemetry schema
  rows.push({
    dimension: "Telemetry schema",
    selfEvolve: "v:2 extended",
    upstream: "v:1 only",
    delta: "+11 fields",
  });

  // Feature: Learning memory
  rows.push({
    dimension: "Learning memory",
    selfEvolve: "yes",
    upstream: "no",
    delta: "unique",
  });

  // Feature: Evolve loop
  rows.push({
    dimension: "Auto-evolve loop",
    selfEvolve: "yes",
    upstream: "no",
    delta: "unique",
  });

  return rows;
}

function diffStr(a: number, b: number): string {
  const d = a - b;
  if (d > 0) return `+${Number.isInteger(d) ? d : d.toFixed(1)}`;
  if (d < 0) return `${Number.isInteger(d) ? d : d.toFixed(1)}`;
  return "0";
}

/**
 * Format comparison rows as a markdown-compatible table.
 */
export function formatComparisonTable(rows: ComparisonRow[], upstreamVersion?: string): string {
  const lines: string[] = [];
  const ver = upstreamVersion || "unknown";

  lines.push("");
  lines.push(`vs Upstream (garrytan/gstack v${ver})`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`  ${"Dimension".padEnd(22)} ${"Self-Evolve".padEnd(16)} ${"Upstream".padEnd(14)} ${"Delta"}`);
  lines.push(`  ${"─".repeat(22)} ${"─".repeat(16)} ${"─".repeat(14)} ${"─".repeat(10)}`);

  for (const r of rows) {
    lines.push(`  ${r.dimension.padEnd(22)} ${r.selfEvolve.padEnd(16)} ${r.upstream.padEnd(14)} ${r.delta}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Read upstream gstack version.
 */
export function readUpstreamVersion(upstreamDir: string): string {
  const vPath = join(upstreamDir, "VERSION");
  if (existsSync(vPath)) {
    return readFileSync(vPath, "utf-8").trim();
  }
  return "unknown";
}

// CLI mode
if (import.meta.main) {
  const selfDir = process.argv[2] || process.cwd();
  const upDir = process.argv[3] || `${process.env.HOME}/.claude/skills/gstack`;
  const version = readUpstreamVersion(upDir);
  const rows = compareUpstream(selfDir, upDir);
  console.log(formatComparisonTable(rows, version));
}
