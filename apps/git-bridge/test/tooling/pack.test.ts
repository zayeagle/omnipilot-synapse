import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_TARGETS,
  bundleModules,
  bundleOutputs,
  collectModules,
  loadDistModules,
  packPlan,
  parsePackArgs,
  stripModuleSyntax,
  targetId,
} from '../../scripts/pack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..', '..');
const distEntry = join(packageDir, 'dist', 'main.js');

describe('parsePackArgs', () => {
  it('defaults to the host target, a build and a bundle', () => {
    expect(parsePackArgs([])).toEqual({
      skipTest: false,
      build: true,
      bundle: true,
      dryRun: false,
      help: false,
      targets: [targetId()],
    });
  });

  it('honours every flag and de-duplicates repeated targets', () => {
    expect(
      parsePackArgs(['--dry-run', '--skip-test', '--no-build', '--no-bundle']),
    ).toMatchObject({ dryRun: true, skipTest: true, build: false, bundle: false, targets: [targetId()] });
    expect(parsePackArgs(['--target', 'linux-x64', '--target', 'linux-x64']).targets).toEqual([
      'linux-x64',
    ]);
    expect(parsePackArgs(['--all-targets']).targets).toEqual(ALL_TARGETS);
  });

  it('rejects unknown options and targets', () => {
    expect(() => parsePackArgs(['--nope'])).toThrow(/unknown option/);
    expect(() => parsePackArgs(['--target', 'plan9-x64'])).toThrow(/unknown target/);
    expect(() => parsePackArgs(['--target'])).toThrow(/--target needs a value/);
  });
});

describe('packPlan', () => {
  it('skips the suites with --skip-test and the build with --no-build', () => {
    expect(packPlan({}).map((step: { label: string }) => step.label)).toEqual([
      'unit tests',
      'system tests',
      'build (tsc)',
    ]);
    expect(packPlan({ skipTest: true, build: false })).toEqual([]);
  });
});

describe('bundleOutputs', () => {
  it('names one single-file bundle per target', () => {
    const outputs = bundleOutputs(['linux-x64', 'win32-x64']);
    expect(outputs.map((entry: { output: string }) => entry.output)).toEqual([
      join(packageDir, '.output', 'git-bridge-linux-x64.mjs'),
      join(packageDir, '.output', 'git-bridge-win32-x64.mjs'),
    ]);
  });
});

describe('stripModuleSyntax', () => {
  it('drops relative imports and reports them, hoists builtins, removes export syntax', () => {
    const stripped = stripModuleSyntax(
      "import { a } from './a.js';\nimport { join } from 'node:path';\nexport function f() { return a(); }\n",
    );
    expect(stripped.specifiers).toEqual(['./a.js']);
    expect(stripped.imports).toEqual(["import { join } from 'node:path';"]);
    expect(stripped.names).toEqual(['f']);
    expect(stripped.body).toContain('function f()');
    expect(stripped.body).not.toMatch(/^export /m);
  });

  it('handles a multi-line import as one statement', () => {
    const stripped = stripModuleSyntax(
      "import {\n  one,\n  two,\n} from './pair.js';\nexport const three = one + two;\n",
    );
    expect(stripped.specifiers).toEqual(['./pair.js']);
    expect(stripped.body).not.toContain('pair.js');
  });

  it('rejects the export forms concatenation cannot express', () => {
    expect(() => stripModuleSyntax('export default function f() {}\n')).toThrow(/export default/);
    expect(() => stripModuleSyntax("export * from './x.js';\n")).toThrow(/export \*/);
    expect(() => stripModuleSyntax("export { a } from './x.js';\n")).toThrow(/re-export/);
  });
});

describe('bundleModules', () => {
  const modules = {
    './main.js': [
      "import { join } from 'node:path';",
      "import { a } from './a.js';",
      "import { b, helper } from './b.js';",
      'export function run() { return a() + b() + join(helper, "x"); }',
      '',
    ].join('\n'),
    './a.js': [
      "import { mkdir } from 'node:fs/promises';",
      'const local = 1;',
      'export const a = () => local;',
      '',
    ].join('\n'),
    './b.js': ["export const helper = 'h';", 'export const b = () => 2;', ''].join('\n'),
  };

  it('emits one self-contained source with dependencies before their users', () => {
    const source = bundleModules(modules, './main.js', { banner: ['#!/usr/bin/env node', '// banner'] });
    expect(source.split('\n')[0]).toBe('#!/usr/bin/env node');
    expect(source).not.toMatch(/^import .*'\.\//m);
    expect(source).not.toMatch(/^export /m);
    expect(source).toContain('function run()');
    // A builtin import appears exactly once even though two modules import it.
    expect(source.match(/import \{ join \} from 'node:path';/g)).toHaveLength(1);
    expect(source).toContain("import { mkdir } from 'node:fs/promises';");
    expect(source.indexOf('./a.js')).toBeLessThan(source.indexOf('./main.js'));
  });

  it('orders the whole graph, entry last', () => {
    expect(collectModules(modules, './main.js')).toEqual(['./a.js', './b.js', './main.js']);
  });

  it('refuses a duplicate top-level name rather than silently shadowing', () => {
    expect(() =>
      bundleModules(
        { './main.js': "import './a.js';\nconst shared = 1;\n", './a.js': 'const shared = 2;\n' },
        './main.js',
      ),
    ).toThrow(/duplicate top-level name "shared"/);
  });

  it('refuses a circular import and an unresolved module', () => {
    expect(() =>
      bundleModules(
        { './main.js': "import './a.js';\n", './a.js': "import './main.js';\n" },
        './main.js',
      ),
    ).toThrow(/circular import/);
    expect(() => bundleModules({ './main.js': "import './gone.js';\n" }, './main.js')).toThrow(
      /unresolved module "\.\/gone\.js"/,
    );
  });
});

describe('bundling the compiled companion', () => {
  it.skipIf(!existsSync(distEntry))('produces a runnable single file', () => {
    const source = bundleModules(loadDistModules(), './main.js', {
      banner: ['#!/usr/bin/env node', '// integration bundle'],
    });
    const dir = mkdtempSync(join(tmpdir(), 'git-bridge-bundle-'));
    try {
      const file = join(dir, 'bundle.mjs');
      writeFileSync(file, source, 'utf8');
      const run = spawnSync(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
      expect(run.status).toBe(0);
      // stdout carries protocol frames only, so a quiet stdin must produce no bytes there.
      expect(run.stdout.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
