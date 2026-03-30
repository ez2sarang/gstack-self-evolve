/**
 * Cross-session learning memory for gstack skills.
 *
 * Data lives in ~/.gstack/learned/:
 *   patterns.jsonl       — successful approaches per project/skill
 *   anti-patterns.jsonl  — failed approaches to avoid
 *   project-profiles/    — per-repo tech stack detection
 *
 * Confidence decays by 0.05 per week since last_used.
 * Patterns below 0.3 are not surfaced. Below 0.1 are GC candidates.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const LEARNED_DIR = path.join(os.homedir(), '.gstack', 'learned');
const PATTERNS_FILE = path.join(LEARNED_DIR, 'patterns.jsonl');
const ANTI_PATTERNS_FILE = path.join(LEARNED_DIR, 'anti-patterns.jsonl');
const PROFILES_DIR = path.join(LEARNED_DIR, 'project-profiles');

const DECAY_RATE = 0.05;  // per week
const SURFACE_THRESHOLD = 0.3;
const GC_THRESHOLD = 0.1;

export interface Pattern {
  id: string;
  ts: string;
  repo_slug: string;
  skill: string;
  pattern: string;
  evidence: string;
  confidence: number;
  last_used: string;
  use_count: number;
  tags: string[];
}

export interface AntiPattern {
  id: string;
  ts: string;
  repo_slug: string;
  skill: string;
  anti_pattern: string;
  evidence: string;
  confidence: number;
  last_seen: string;
  occurrence_count: number;
  tags: string[];
}

export interface ProjectProfile {
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
  test_patterns?: {
    convention?: string;
    setup?: string;
    ci?: string;
  };
  ports?: Record<string, number>;
  skill_notes: Record<string, string>;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function weeksSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  return Math.max(0, (now - then) / (7 * 24 * 60 * 60 * 1000));
}

export function applyDecay(confidence: number, lastUsed: string): number {
  const weeks = weeksSince(lastUsed);
  return Math.max(0, confidence - (weeks * DECAY_RATE));
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as T; }
      catch { return null; }
    })
    .filter((x): x is T => x !== null);
}

function appendJsonl(filePath: string, record: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

// ─── Patterns ──────────────────────────────────────────────

export function readPatterns(repoSlug?: string, skill?: string): Pattern[] {
  const all = readJsonl<Pattern>(PATTERNS_FILE);
  return all
    .filter(p => (!repoSlug || p.repo_slug === repoSlug))
    .filter(p => (!skill || p.skill === skill))
    .map(p => ({ ...p, confidence: applyDecay(p.confidence, p.last_used) }))
    .filter(p => p.confidence >= SURFACE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);
}

export function writePattern(pattern: Omit<Pattern, 'id' | 'ts'>): Pattern {
  const full: Pattern = {
    id: generateId('pat'),
    ts: new Date().toISOString(),
    ...pattern,
  };
  appendJsonl(PATTERNS_FILE, full);
  return full;
}

// ─── Anti-Patterns ─────────────────────────────────────────

export function readAntiPatterns(repoSlug?: string, skill?: string): AntiPattern[] {
  const all = readJsonl<AntiPattern>(ANTI_PATTERNS_FILE);
  return all
    .filter(p => (!repoSlug || p.repo_slug === repoSlug))
    .filter(p => (!skill || p.skill === skill))
    .map(p => ({ ...p, confidence: applyDecay(p.confidence, p.last_seen) }))
    .filter(p => p.confidence >= SURFACE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);
}

export function writeAntiPattern(anti: Omit<AntiPattern, 'id' | 'ts'>): AntiPattern {
  const full: AntiPattern = {
    id: generateId('anti'),
    ts: new Date().toISOString(),
    ...anti,
  };
  appendJsonl(ANTI_PATTERNS_FILE, full);
  return full;
}

// ─── Project Profiles ──────────────────────────────────────

export function readProjectProfile(repoSlug: string): ProjectProfile | null {
  const filePath = path.join(PROFILES_DIR, `${repoSlug}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeProjectProfile(profile: ProjectProfile): void {
  ensureDir(PROFILES_DIR);
  const filePath = path.join(PROFILES_DIR, `${profile.repo_slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2) + '\n');
}

// ─── Surface relevant learnings ────────────────────────────

export function surfaceRelevantLearnings(repoSlug: string, skill: string): string {
  const patterns = readPatterns(repoSlug, skill).slice(0, 5);
  const antiPatterns = readAntiPatterns(repoSlug, skill).slice(0, 3);
  const profile = readProjectProfile(repoSlug);

  const lines: string[] = [];

  if (patterns.length > 0) {
    lines.push('## Learned Patterns (from prior sessions)');
    for (const p of patterns) {
      lines.push(`- [${p.confidence.toFixed(2)}] ${p.pattern} (used ${p.use_count}x)`);
    }
    lines.push('');
  }

  if (antiPatterns.length > 0) {
    lines.push('## Anti-Patterns (avoid these)');
    for (const a of antiPatterns) {
      lines.push(`- [${a.confidence.toFixed(2)}] ${a.anti_pattern}`);
    }
    lines.push('');
  }

  if (profile) {
    lines.push('## Project Profile');
    const ts = profile.tech_stack;
    const parts: string[] = [];
    if (ts.framework) parts.push(`Framework: ${ts.framework}${ts.framework_version ? ' ' + ts.framework_version : ''}`);
    if (ts.language) parts.push(`Language: ${ts.language}`);
    if (ts.test_runner) parts.push(`Tests: ${ts.test_runner}`);
    if (ts.package_manager) parts.push(`PM: ${ts.package_manager}`);
    if (ts.db) parts.push(`DB: ${ts.db}`);
    if (ts.css) parts.push(`CSS: ${ts.css}`);
    lines.push(parts.join(' | '));

    if (profile.skill_notes[skill]) {
      lines.push(`Note: ${profile.skill_notes[skill]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Garbage collection ────────────────────────────────────

export function gcStaleEntries(): { patterns: number; antiPatterns: number } {
  let pRemoved = 0;
  let aRemoved = 0;

  // GC patterns
  if (fs.existsSync(PATTERNS_FILE)) {
    const all = readJsonl<Pattern>(PATTERNS_FILE);
    const kept = all.filter(p => applyDecay(p.confidence, p.last_used) >= GC_THRESHOLD);
    pRemoved = all.length - kept.length;
    if (pRemoved > 0) {
      fs.writeFileSync(PATTERNS_FILE, kept.map(p => JSON.stringify(p)).join('\n') + '\n');
    }
  }

  // GC anti-patterns
  if (fs.existsSync(ANTI_PATTERNS_FILE)) {
    const all = readJsonl<AntiPattern>(ANTI_PATTERNS_FILE);
    const kept = all.filter(a => applyDecay(a.confidence, a.last_seen) >= GC_THRESHOLD);
    aRemoved = all.length - kept.length;
    if (aRemoved > 0) {
      fs.writeFileSync(ANTI_PATTERNS_FILE, kept.map(a => JSON.stringify(a)).join('\n') + '\n');
    }
  }

  return { patterns: pRemoved, antiPatterns: aRemoved };
}
