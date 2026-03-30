/**
 * lib/upstream-sync.ts — Sync self-evolve fork with upstream garrytan/gstack
 *
 * Before each evolve-loop run, syncs with upstream:
 * 1. Ensure upstream remote exists
 * 2. Fetch upstream changes
 * 3. Compare versions
 * 4. Merge upstream/main (self-evolve changes take priority on conflict)
 * 5. Classify learnings: still_valid, reinforced, invalidated, needs_review
 *
 * No network calls if --no-sync is passed. Local-only comparison always available.
 */

import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";

export interface SyncResult {
  status: "synced" | "up_to_date" | "merge_conflict" | "no_remote" | "fetch_failed" | "skipped";
  localVersion: string;
  upstreamVersion: string | null;
  mergedCommits: number;
  changedTemplates: string[];
  message: string;
}

export interface LearningClassification {
  still_valid: string[];     // learning IDs unaffected by upstream changes
  reinforced: string[];      // upstream made similar changes (boost confidence)
  invalidated: string[];     // upstream changed the relevant template significantly
  needs_review: string[];    // related template changed, manual review needed
}

const UPSTREAM_REMOTE = "upstream";
const UPSTREAM_URL = "https://github.com/garrytan/gstack.git";

/**
 * Read local VERSION file.
 */
export function readLocalVersion(repoDir: string): string {
  const vPath = join(repoDir, "VERSION");
  if (existsSync(vPath)) {
    return readFileSync(vPath, "utf-8").trim();
  }
  return "unknown";
}

/**
 * Ensure the upstream remote exists. Add it if missing.
 */
export function ensureUpstreamRemote(repoDir: string): boolean {
  try {
    const remotes = execSync("git remote -v", { cwd: repoDir, encoding: "utf-8" });
    if (remotes.includes(UPSTREAM_REMOTE)) return true;

    execSync(`git remote add ${UPSTREAM_REMOTE} ${UPSTREAM_URL}`, {
      cwd: repoDir,
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch upstream changes. Returns false if network fails.
 */
export function fetchUpstream(repoDir: string): boolean {
  try {
    execSync(`git fetch ${UPSTREAM_REMOTE} --quiet`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 30000, // 30s timeout
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get upstream version from fetched remote.
 */
export function readUpstreamVersionFromRemote(repoDir: string): string | null {
  try {
    const version = execSync(
      `git show ${UPSTREAM_REMOTE}/main:VERSION 2>/dev/null`,
      { cwd: repoDir, encoding: "utf-8" }
    ).trim();
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Get list of template files changed between local and upstream.
 */
export function getChangedTemplates(repoDir: string): string[] {
  try {
    const diff = execSync(
      `git diff HEAD...${UPSTREAM_REMOTE}/main --name-only -- '*/SKILL.md.tmpl' 2>/dev/null`,
      { cwd: repoDir, encoding: "utf-8" }
    );
    return diff.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Count commits between local HEAD and upstream/main.
 */
export function countUpstreamCommits(repoDir: string): number {
  try {
    const count = execSync(
      `git rev-list HEAD..${UPSTREAM_REMOTE}/main --count 2>/dev/null`,
      { cwd: repoDir, encoding: "utf-8" }
    ).trim();
    return parseInt(count, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Merge upstream/main into current branch.
 * Uses "ours" strategy for conflicts (self-evolve changes take priority).
 */
export function mergeUpstream(repoDir: string): { success: boolean; message: string } {
  try {
    // Check for uncommitted changes first
    const status = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf-8" }).trim();
    if (status) {
      return { success: false, message: "Uncommitted changes detected. Commit or stash first." };
    }

    const result = execSync(
      `git merge ${UPSTREAM_REMOTE}/main --no-edit -X ours 2>&1`,
      { cwd: repoDir, encoding: "utf-8" }
    );

    // Check if it was a no-op
    if (result.includes("Already up to date")) {
      return { success: true, message: "Already up to date." };
    }

    return { success: true, message: result.trim() };
  } catch (e: any) {
    return { success: false, message: e.message || "Merge failed" };
  }
}

/**
 * Classify learnings based on which templates changed upstream.
 *
 * Logic:
 * - If a learning's target skill template did NOT change -> still_valid
 * - If a learning's target skill template changed AND the change
 *   includes similar keywords to the learning -> reinforced
 * - If a learning's target skill template was significantly rewritten -> needs_review
 * - If the learning's target skill was removed upstream -> invalidated
 */
export function classifyLearnings(
  learnings: Array<{ id: string; skill: string; pattern: string; tags: string[] }>,
  changedTemplates: string[],
  repoDir: string
): LearningClassification {
  const result: LearningClassification = {
    still_valid: [],
    reinforced: [],
    invalidated: [],
    needs_review: [],
  };

  // Extract skill names from changed template paths
  // e.g., "qa/SKILL.md.tmpl" -> "qa"
  const changedSkills = new Set(
    changedTemplates.map(t => {
      const parts = t.split("/");
      // Handle paths like "qa/SKILL.md.tmpl" or "skills/qa/SKILL.md.tmpl"
      const tmplIdx = parts.findIndex(p => p === "SKILL.md.tmpl");
      return tmplIdx > 0 ? parts[tmplIdx - 1] : parts[0];
    }).filter(Boolean)
  );

  for (const learning of learnings) {
    if (!changedSkills.has(learning.skill)) {
      result.still_valid.push(learning.id);
      continue;
    }

    // The skill's template changed. Check how much.
    try {
      const diff = execSync(
        `git diff HEAD...${UPSTREAM_REMOTE}/main -- '*/${learning.skill}/SKILL.md.tmpl' 2>/dev/null`,
        { cwd: repoDir, encoding: "utf-8" }
      );

      const diffLines = diff.split("\n").filter(l => l.startsWith("+") || l.startsWith("-"));
      const diffSize = diffLines.length;

      // Check if upstream change is similar to the learning
      const patternWords = learning.pattern.toLowerCase().split(/\s+/);
      const diffText = diff.toLowerCase();
      const matchCount = patternWords.filter(w => w.length > 3 && diffText.includes(w)).length;
      const matchRatio = patternWords.length > 0 ? matchCount / patternWords.length : 0;

      if (matchRatio > 0.3) {
        // Upstream made a similar change to what we learned
        result.reinforced.push(learning.id);
      } else if (diffSize > 50) {
        // Large template change, needs manual review
        result.needs_review.push(learning.id);
      } else {
        // Small change, likely still valid
        result.still_valid.push(learning.id);
      }
    } catch {
      // Can't read diff, mark as needs_review
      result.needs_review.push(learning.id);
    }
  }

  return result;
}

/**
 * Full sync-upstream flow. Called by evolve-loop before iterations.
 */
export function syncUpstream(repoDir: string): SyncResult {
  const localVersion = readLocalVersion(repoDir);

  // 1. Ensure remote
  if (!ensureUpstreamRemote(repoDir)) {
    return {
      status: "no_remote",
      localVersion,
      upstreamVersion: null,
      mergedCommits: 0,
      changedTemplates: [],
      message: "Could not set up upstream remote.",
    };
  }

  // 2. Fetch
  if (!fetchUpstream(repoDir)) {
    return {
      status: "fetch_failed",
      localVersion,
      upstreamVersion: null,
      mergedCommits: 0,
      changedTemplates: [],
      message: "Failed to fetch upstream (network issue?).",
    };
  }

  // 3. Compare versions
  const upstreamVersion = readUpstreamVersionFromRemote(repoDir);
  const commitsBehind = countUpstreamCommits(repoDir);

  if (commitsBehind === 0) {
    return {
      status: "up_to_date",
      localVersion,
      upstreamVersion,
      mergedCommits: 0,
      changedTemplates: [],
      message: `Already up to date with upstream v${upstreamVersion || localVersion}.`,
    };
  }

  // 4. Get changed templates before merge
  const changedTemplates = getChangedTemplates(repoDir);

  // 5. Merge
  const mergeResult = mergeUpstream(repoDir);
  if (!mergeResult.success) {
    return {
      status: "merge_conflict",
      localVersion,
      upstreamVersion,
      mergedCommits: 0,
      changedTemplates,
      message: `Merge failed: ${mergeResult.message}`,
    };
  }

  return {
    status: "synced",
    localVersion,
    upstreamVersion,
    mergedCommits: commitsBehind,
    changedTemplates,
    message: `Synced ${commitsBehind} commits from upstream v${upstreamVersion}. ${changedTemplates.length} templates changed.`,
  };
}

/**
 * Format sync result as a readable report for the evolve-loop output.
 */
export function formatSyncReport(result: SyncResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("Upstream Sync");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  switch (result.status) {
    case "synced":
      lines.push(`  Status:    SYNCED (+${result.mergedCommits} commits)`);
      lines.push(`  Local:     v${result.localVersion}`);
      lines.push(`  Upstream:  v${result.upstreamVersion}`);
      if (result.changedTemplates.length > 0) {
        lines.push(`  Templates: ${result.changedTemplates.length} changed`);
        for (const t of result.changedTemplates.slice(0, 5)) {
          lines.push(`    - ${t}`);
        }
        if (result.changedTemplates.length > 5) {
          lines.push(`    ... and ${result.changedTemplates.length - 5} more`);
        }
      }
      break;
    case "up_to_date":
      lines.push(`  Status:    UP TO DATE`);
      lines.push(`  Version:   v${result.localVersion}`);
      break;
    case "fetch_failed":
      lines.push(`  Status:    FETCH FAILED (continuing with local version)`);
      lines.push(`  Local:     v${result.localVersion}`);
      break;
    case "merge_conflict":
      lines.push(`  Status:    MERGE CONFLICT (continuing with local version)`);
      lines.push(`  Details:   ${result.message}`);
      break;
    case "no_remote":
      lines.push(`  Status:    NO REMOTE (not a git repo or cannot add remote)`);
      break;
    case "skipped":
      lines.push(`  Status:    SKIPPED (--no-sync)`);
      break;
  }

  lines.push("");
  return lines.join("\n");
}

// CLI mode
if (import.meta.main) {
  const args = process.argv.slice(2);
  const repoDir = args[0] || process.cwd();

  if (args.includes("--check-only")) {
    // Just check, don't merge
    ensureUpstreamRemote(repoDir);
    if (fetchUpstream(repoDir)) {
      const upVer = readUpstreamVersionFromRemote(repoDir);
      const localVer = readLocalVersion(repoDir);
      const commits = countUpstreamCommits(repoDir);
      const templates = getChangedTemplates(repoDir);
      console.log(`Local: v${localVer}`);
      console.log(`Upstream: v${upVer}`);
      console.log(`Behind: ${commits} commits`);
      console.log(`Changed templates: ${templates.length}`);
      templates.forEach(t => console.log(`  - ${t}`));
    } else {
      console.log("Failed to fetch upstream.");
    }
  } else {
    const result = syncUpstream(repoDir);
    console.log(formatSyncReport(result));
  }
}
