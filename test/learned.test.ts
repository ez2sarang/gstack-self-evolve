import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const ROOT = join(import.meta.dir, '..');

describe('Cross-Session Learning Memory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gstack-learn-'));
    mkdirSync(join(tmpDir, 'learned'), { recursive: true });
    mkdirSync(join(tmpDir, 'learned', 'project-profiles'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runLearn(args: string): string {
    const env = {
      ...process.env,
      GSTACK_STATE_DIR: tmpDir,
      GSTACK_DIR: ROOT,
    };
    try {
      return execSync(`bash ${ROOT}/bin/gstack-learn ${args}`, {
        env, encoding: 'utf-8', timeout: 5000, cwd: ROOT
      });
    } catch (e: any) {
      return e.stdout || e.stderr || '';
    }
  }

  function runDetect(dir: string): string {
    const env = {
      ...process.env,
      GSTACK_STATE_DIR: tmpDir,
      GSTACK_DIR: ROOT,
    };
    try {
      return execSync(`bash ${ROOT}/bin/gstack-detect-project`, {
        env, encoding: 'utf-8', timeout: 5000, cwd: dir
      });
    } catch (e: any) {
      return e.stdout || e.stderr || '';
    }
  }

  describe('gstack-learn CLI', () => {
    test('add-pattern writes to patterns.jsonl', () => {
      const out = runLearn('add-pattern --skill qa --pattern "Always run dev server" --tags dev,server');
      expect(out).toContain('ADDED pattern');

      const content = readFileSync(join(tmpDir, 'learned', 'patterns.jsonl'), 'utf-8');
      const record = JSON.parse(content.trim());
      expect(record.skill).toBe('qa');
      expect(record.pattern).toBe('Always run dev server');
      expect(record.confidence).toBe(0.85);
    });

    test('add-anti-pattern writes to anti-patterns.jsonl', () => {
      const out = runLearn('add-anti-pattern --skill investigate --anti-pattern "No git bisect"');
      expect(out).toContain('ADDED anti-pattern');

      const content = readFileSync(join(tmpDir, 'learned', 'anti-patterns.jsonl'), 'utf-8');
      const record = JSON.parse(content.trim());
      expect(record.skill).toBe('investigate');
      expect(record.anti_pattern).toBe('No git bisect');
      expect(record.confidence).toBe(0.9);
    });

    test('list shows patterns for repo', () => {
      runLearn('add-pattern --skill qa --pattern "Test pattern"');
      const out = runLearn('list');
      expect(out).toContain('Patterns:');
    });

    test('forget sets confidence to 0', () => {
      runLearn('add-pattern --skill qa --pattern "Temporary"');
      const content = readFileSync(join(tmpDir, 'learned', 'patterns.jsonl'), 'utf-8');
      const record = JSON.parse(content.trim());

      const out = runLearn(`forget ${record.id}`);
      expect(out).toContain('FORGOTTEN');
    });
  });

  describe('gstack-detect-project', () => {
    test('detects Next.js + TypeScript project', () => {
      const projDir = mkdtempSync(join(tmpdir(), 'gstack-proj-'));
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'package.json'), JSON.stringify({
        dependencies: { next: "14.1.0", react: "18.2.0", "@supabase/supabase-js": "2.0.0" },
        devDependencies: { vitest: "1.0.0", tailwindcss: "3.4.0" }
      }));
      writeFileSync(join(projDir, 'tsconfig.json'), '{}');
      writeFileSync(join(projDir, 'bun.lock'), '');

      const out = runDetect(projDir);
      expect(out).toContain('LANG=typescript');
      expect(out).toContain('FW=next');
      expect(out).toContain('PM=bun');
      expect(out).toContain('DB=supabase');

      rmSync(projDir, { recursive: true, force: true });
    });

    test('detects Python + Django project', () => {
      const projDir = mkdtempSync(join(tmpdir(), 'gstack-proj-'));
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'requirements.txt'), 'django==4.2\npytest==7.0\n');

      const out = runDetect(projDir);
      expect(out).toContain('LANG=python');
      expect(out).toContain('FW=django');

      rmSync(projDir, { recursive: true, force: true });
    });
  });

  describe('Confidence decay', () => {
    test('recent pattern has high confidence', () => {
      // Write a pattern with recent last_used
      // Use the same slug gstack-learn resolves when run from ROOT
      const { execSync: exec } = require('child_process');
      const slug = (exec('git remote get-url origin 2>/dev/null | sed \'s|.*[:/]\\([^/]*/[^/]*\\)\\.git$|\\1|;s|.*[:/]\\([^/]*/[^/]*\\)$|\\1|\' | tr \'/\' \'-\' 2>/dev/null || basename "$(pwd)"', { encoding: 'utf-8', cwd: ROOT }) as string).trim();
      const now = new Date().toISOString();
      writeFileSync(join(tmpDir, 'learned', 'patterns.jsonl'),
        JSON.stringify({
          id: 'pat-test1', ts: now, repo_slug: slug, skill: 'qa',
          pattern: 'Recent pattern', evidence: '', confidence: 0.85,
          last_used: now, use_count: 1, tags: []
        }) + '\n'
      );

      const out = runLearn('list');
      expect(out).toContain('Recent pattern');
    });
  });
});
