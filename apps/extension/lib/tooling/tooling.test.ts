import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_MARKERS,
  REQUIRED_MARKERS,
  collectContentBundle,
  relativeImports,
  runAssertion,
  scanBundle,
  scanSource,
} from '../../scripts/assert-content-no-secrets.mjs';
import { PACK_USAGE, packPlan, parsePackArgs } from '../../scripts/pack.mjs';

function makeBundle(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-bundle-'));
  mkdirSync(join(dir, 'content-scripts'), { recursive: true });
  mkdirSync(join(dir, 'chunks'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

const SAFE_BUNDLE = `import { PUBLIC_PREFS_KEY } from "../chunks/prefs.js";
chrome.runtime.sendMessage({ type: "capture.request" });
console.log(PUBLIC_PREFS_KEY, "local:publicPrefs");`;

describe('content bundle assertion (F9 UNIT)', () => {
  it('TC-F9-U01 fails when a forbidden marker reaches the content bundle', () => {
    const result = scanSource('content.js', 'const key = "local:secretVault";');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('secretVault');

    for (const marker of FORBIDDEN_MARKERS) {
      expect(scanSource('content.js', `x = "${marker}"`).ok).toBe(false);
    }
  });

  it('TC-F9-U01 passes only when the expected safe markers are present', () => {
    expect(scanSource('content.js', 'const k = "publicPrefs";').ok).toBe(true);
    // A clean file that lacks the safe markers must NOT pass — otherwise an empty or unrelated
    // bundle would satisfy the assertion vacuously.
    const vacuous = scanBundle('content.js', 'console.log(1);');
    expect(vacuous.ok).toBe(false);
    expect(vacuous.problems.join(' ')).toContain('publicPrefs');
    expect(vacuous.problems.join(' ')).toContain('capture.request');
  });

  it('TC-F9-U01 accepts a realistic safe content bundle', () => {
    expect(scanBundle('content.js', SAFE_BUNDLE).ok).toBe(true);
    expect(REQUIRED_MARKERS).toContain('publicPrefs');
  });

  it('TC-F9-U01 finds relative imports so shared chunks are scanned too', () => {
    expect(relativeImports(SAFE_BUNDLE)).toEqual(['../chunks/prefs.js']);
    expect(relativeImports('import("./a.js"); import x from "./b.js";')).toEqual(['./a.js', './b.js']);
    expect(relativeImports('no imports here')).toEqual([]);
  });

  it('TC-F9-U01 scans a chunk reachable from the content script', () => {
    const dir = makeBundle({
      'content-scripts/content.js': SAFE_BUNDLE,
      'chunks/prefs.js': 'export const PUBLIC_PREFS_KEY = "local:publicPrefs";',
    });
    try {
      const result = runAssertion({ bundleDir: dir });
      expect(result.ok).toBe(true);
      expect(result.scanned).toEqual([
        join('content-scripts', 'content.js'),
        join('chunks', 'prefs.js'),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TC-F9-U01 fails when the leak is only in a transitively imported chunk', () => {
    const dir = makeBundle({
      'content-scripts/content.js': SAFE_BUNDLE,
      'chunks/prefs.js': 'export const leaked = "githubPat";',
    });
    try {
      const result = runAssertion({ bundleDir: dir });
      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toContain('githubPat');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TC-F9-U02 reports a clear failure when the bundle was never built', () => {
    const missing = join(tmpdir(), 'synapse-bundle-does-not-exist');
    const collected = collectContentBundle(missing);
    expect(collected.files).toEqual([]);
    expect(collected.problems[0]).toContain('npm run build');

    const result = runAssertion({ bundleDir: missing });
    expect(result.ok).toBe(false);

    // An empty directory is a different mistake and must also fail loudly.
    const empty = mkdtempSync(join(tmpdir(), 'synapse-bundle-empty-'));
    try {
      mkdirSync(join(empty, 'content-scripts'), { recursive: true });
      const emptyResult = runAssertion({ bundleDir: empty });
      expect(emptyResult.ok).toBe(false);
      expect(emptyResult.problems.join(' ')).toContain('no .js files');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('TC-F9-U02 reports a dangling relative import instead of passing', () => {
    const dir = makeBundle({ 'content-scripts/content.js': 'import x from "../chunks/missing.js";' });
    try {
      const result = runAssertion({ bundleDir: dir });
      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toContain('missing on disk');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pack argument parsing (F9 UNIT)', () => {
  it('TC-F9-U03 defaults to a full pack', () => {
    expect(parsePackArgs([])).toEqual({
      skipTest: false,
      firefox: false,
      zip: true,
      dryRun: false,
      help: false,
    });
  });

  it('TC-F9-U03 parses the supported flags in any order', () => {
    expect(parsePackArgs(['--skip-test'])).toMatchObject({ skipTest: true });
    expect(parsePackArgs(['--firefox', '--no-zip'])).toMatchObject({ firefox: true, zip: false });
    expect(parsePackArgs(['--dry-run', '--skip-test', '--firefox'])).toMatchObject({
      dryRun: true,
      skipTest: true,
      firefox: true,
    });
    expect(parsePackArgs(['-h']).help).toBe(true);
    expect(parsePackArgs(['--help']).help).toBe(true);
  });

  it('TC-F9-U03 rejects an unknown flag with the usage text', () => {
    expect(() => parsePackArgs(['--turbo'])).toThrow(/unknown option/u);
    expect(() => parsePackArgs(['--turbo'])).toThrow(/Usage:/u);
    expect(PACK_USAGE).toContain('--skip-test');
  });

  it('TC-F9-U03 builds the right command plan for each mode', () => {
    const labels = (options: Parameters<typeof packPlan>[0]) => packPlan(options).map((step) => step.label);

    expect(labels({})).toEqual([
      'unit tests',
      'integration tests',
      'icons',
      'build (chrome)',
      'secret assertion',
      'zip (chrome)',
    ]);
    expect(labels({ skipTest: true })).not.toContain('unit tests');
    expect(labels({ skipTest: true })).not.toContain('integration tests');
    expect(labels({ firefox: true, zip: false })).toEqual([
      'unit tests',
      'integration tests',
      'icons',
      'build (chrome)',
      'build (firefox)',
      'secret assertion',
    ]);
    expect(labels({ firefox: true })).toContain('zip (firefox)');

    for (const step of packPlan({})) {
      expect(step.command).toBe('npm');
      expect(step.args.length).toBeGreaterThan(0);
    }
  });
});
