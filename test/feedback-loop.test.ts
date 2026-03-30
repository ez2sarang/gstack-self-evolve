import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const ROOT = join(import.meta.dir, '..');
const BIN = join(ROOT, 'bin', 'gstack-telemetry-log');

describe('Feedback Loop (v:2 schema)', () => {
  let tmpDir: string;
  let jsonlFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gstack-fb-'));
    mkdirSync(join(tmpDir, 'analytics'), { recursive: true });
    jsonlFile = join(tmpDir, 'analytics', 'skill-usage.jsonl');
    // Write a minimal config so telemetry tier is "anonymous"
    writeFileSync(join(tmpDir, 'config.yaml'), 'telemetry: anonymous\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(args: string): string {
    const env = {
      ...process.env,
      GSTACK_STATE_DIR: tmpDir,
      GSTACK_DIR: ROOT,
    };
    try {
      return execSync(`bash ${BIN} ${args}`, { env, encoding: 'utf-8', timeout: 5000 });
    } catch {
      return '';
    }
  }

  function parseEvents(): any[] {
    try {
      return readFileSync(jsonlFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  test('v:1 when no feedback fields are set', () => {
    run('--skill qa --duration 60 --outcome success --session-id test-v1');
    const events = parseEvents();
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.v).toBe(1);
    expect(last.bugs_found).toBeUndefined();
  });

  test('v:2 when bugs-found is set', () => {
    run('--skill qa --duration 120 --outcome success --bugs-found 5 --bugs-fixed 3 --session-id test-v2-bugs');
    const events = parseEvents();
    const last = events[events.length - 1];
    expect(last.v).toBe(2);
    expect(last.bugs_found).toBe(5);
    expect(last.bugs_fixed).toBe(3);
  });

  test('v:2 with user-verdict', () => {
    run('--skill review --duration 90 --outcome success --user-verdict accepted --session-id test-v2-verdict');
    const events = parseEvents();
    const last = events[events.length - 1];
    expect(last.v).toBe(2);
    expect(last.user_verdict).toBe('accepted');
  });

  test('v:2 with health scores', () => {
    run('--skill qa --duration 300 --outcome success --health-before 62 --health-after 88 --bugs-found 4 --session-id test-v2-health');
    const events = parseEvents();
    const last = events[events.length - 1];
    expect(last.v).toBe(2);
    expect(last.health_score_before).toBe(62);
    expect(last.health_score_after).toBe(88);
  });

  test('v:2 with all feedback fields', () => {
    run('--skill qa --duration 200 --outcome success --bugs-found 5 --bugs-fixed 3 --false-positives 1 --user-verdict modified --retry-count 2 --failure-reason timeout --context-tags auth,frontend --skill-phase phase-10 --questions-asked 3 --commits-made 2 --health-before 50 --health-after 85 --session-id test-v2-all');
    const events = parseEvents();
    const last = events[events.length - 1];
    expect(last.v).toBe(2);
    expect(last.bugs_found).toBe(5);
    expect(last.bugs_fixed).toBe(3);
    expect(last.false_positives).toBe(1);
    expect(last.user_verdict).toBe('modified');
    expect(last.retry_count).toBe(2);
    expect(last.failure_reason).toBe('timeout');
    expect(last.context_tags).toBe('auth,frontend');
    expect(last.skill_phase).toBe('phase-10');
    expect(last.questions_asked).toBe(3);
    expect(last.commits_made).toBe(2);
    expect(last.health_score_before).toBe(50);
    expect(last.health_score_after).toBe(85);
  });

  test('backward compat: existing v:1 fields still work', () => {
    run('--skill ship --duration 400 --outcome success --error-class timeout --session-id test-compat');
    const events = parseEvents();
    const last = events[events.length - 1];
    expect(last.skill).toBe('ship');
    expect(last.outcome).toBe('success');
    expect(last.error_class).toBe('timeout');
  });

  test('json injection in feedback fields is sanitized', () => {
    run('--skill qa --duration 60 --outcome success --user-verdict "accepted\\"},{bad:true" --failure-reason "test\\ninjection" --session-id test-inject');
    const events = parseEvents();
    const last = events[events.length - 1];
    // Should not have broken JSON — if we parsed it, it's safe
    expect(last.v).toBe(2);
    expect(typeof last.user_verdict).toBe('string');
  });
});
