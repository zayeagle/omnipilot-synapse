#!/usr/bin/env node
/**
 * Companion packaging: typecheck → test → single-file bundle.
 *
 * The companion has no runtime dependencies, so "packaging" is not a native toolchain: it is the
 * TypeScript build plus a deliberately small ESM concatenator that folds `dist/*.js` into one file
 * per OS. Bundling here (rather than pulling in a bundler) keeps the shipped bytes auditable — the
 * bundle is exactly the code in `src/`, in dependency order, with the module boundaries removed.
 *
 * The concatenator is only safe because the companion is small and dependency-free, so it refuses to
 * emit anything it cannot prove correct: a duplicate top-level name, a circular import or an
 * unresolved module is a hard error rather than a silently broken bundle.
 *
 * The steps are exposed as data (`packPlan`, `bundleOutputs`) so `--dry-run` is trivial and the plan
 * is testable without running a single command.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIST_DIR = join(PACKAGE_DIR, 'dist');
export const OUTPUT_DIR = join(PACKAGE_DIR, '.output');
export const DIST_ENTRY = join(DIST_DIR, 'main.js');

/** Targets a release bundle is named for. The code is pure Node everywhere; the name is the OS. */
export const ALL_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];

export const PACK_USAGE = [
  'Usage: node scripts/pack.mjs [options]',
  '',
  'Options:',
  '  --skip-test        skip the UNIT + SYS suites (faster local iteration)',
  '  --no-build         reuse the existing dist/ instead of running tsc',
  '  --no-bundle        build only; do not emit the single-file bundle',
  '  --target <id>      bundle for one platform-arch (default: this host, e.g. win32-x64)',
  '  --all-targets      bundle for every OS/arch in ALL_TARGETS',
  '  --dry-run          print the plan and the bundle targets without writing anything',
  '  -h, --help         show this message',
].join('\n');

export function targetId(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function parsePackArgs(argv) {
  const options = { skipTest: false, build: true, bundle: true, dryRun: false, help: false, targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--skip-test':
        options.skipTest = true;
        break;
      case '--no-build':
        options.build = false;
        break;
      case '--no-bundle':
        options.bundle = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--target': {
        const value = argv[++index];
        if (value === undefined) throw new Error(`--target needs a value\n\n${PACK_USAGE}`);
        if (!ALL_TARGETS.includes(value)) {
          throw new Error(`unknown target "${value}" (expected ${ALL_TARGETS.join(' | ')})\n\n${PACK_USAGE}`);
        }
        options.targets.push(value);
        break;
      }
      case '--all-targets':
        options.targets.push(...ALL_TARGETS);
        break;
      case '-h':
      case '--help':
      case 'help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option "${arg}"\n\n${PACK_USAGE}`);
    }
  }
  if (options.targets.length === 0) options.targets.push(targetId());
  options.targets = [...new Set(options.targets)];
  return options;
}

/** The ordered shell steps. Data, not control flow. */
export function packPlan(options = {}) {
  const plan = [];
  if (!options.skipTest) {
    plan.push({ label: 'unit tests', command: 'npm', args: ['test'] });
    plan.push({ label: 'system tests', command: 'npm', args: ['run', 'test:sys'] });
  }
  if (options.build !== false) {
    plan.push({ label: 'build (tsc)', command: 'npm', args: ['run', 'build'] });
  }
  return plan;
}

export function bundleOutputs(targets) {
  return targets.map((target) => ({ target, output: join(OUTPUT_DIR, `git-bridge-${target}.mjs`) }));
}

/**
 * tsc normalizes import declarations but keeps a multi-line one multi-line, so imports are matched as
 * whole statements (they are the only statements a compiled module starts with `import`), not per line.
 */
const IMPORT_RE = /^import\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT_BRACES_RE = /^export\s*\{[^}]*\}\s*(?:from\s+['"][^'"]+['"])?\s*;?[ \t]*$/gm;
const EXPORT_KEYWORD_RE = /^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm;
const UNSUPPORTED_EXPORT_RE = /^export\s+(?:default|\*)/m;
const TOP_LEVEL_DECL_RE = /^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Turn one module into a body that can live in a shared scope: relative imports are dropped (their
 * names resolve to a sibling body), `node:` imports are hoisted once, and export syntax is removed.
 */
export function stripModuleSyntax(source) {
  if (UNSUPPORTED_EXPORT_RE.test(source)) {
    throw new Error('unsupported `export default` / `export *` — the bundler only concatenates named exports');
  }
  const specifiers = [];
  const imports = [];
  let body = source.replace(IMPORT_RE, (statement, specifier) => {
    if (specifier.startsWith('.')) {
      specifiers.push(specifier);
      return '';
    }
    imports.push(statement.trim());
    return '';
  });

  let reExport = false;
  body = body.replace(EXPORT_BRACES_RE, (statement) => {
    if (/\sfrom\s/.test(statement)) reExport = true;
    return '';
  });
  if (reExport) {
    throw new Error('unsupported `export ... from` re-export — the bundler only concatenates local modules');
  }
  body = body.replace(EXPORT_KEYWORD_RE, '');

  for (const line of body.split('\n')) {
    if (/^import\b|^export\b/.test(line)) {
      throw new Error(`module syntax survived stripping: ${line.trim().slice(0, 80)}`);
    }
  }

  const names = [];
  for (const match of body.matchAll(TOP_LEVEL_DECL_RE)) names.push(match[1]);
  return { body, imports, specifiers, names };
}

/** Resolve an import specifier relative to the importing module's key (e.g. `./main.js`). */
export function resolveModuleKey(importerKey, specifier) {
  const directory = importerKey.includes('/') ? importerKey.slice(0, importerKey.lastIndexOf('/')) : '.';
  const normalized = join(directory, specifier).replace(/\\/g, '/');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

function analyze(modules, entryKey) {
  const stripped = new Map();
  const order = [];
  const state = new Map();
  const visit = (key, chain) => {
    const seen = state.get(key);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`circular import: ${[...chain, key].join(' -> ')}`);
    const source = modules[key];
    if (typeof source !== 'string') {
      const importer = chain[chain.length - 1];
      throw new Error(`unresolved module "${key}"${importer === undefined ? '' : ` (imported by ${importer})`}`);
    }
    const strippedModule = stripModuleSyntax(source);
    stripped.set(key, strippedModule);
    state.set(key, 'visiting');
    for (const specifier of strippedModule.specifiers) {
      visit(resolveModuleKey(key, specifier), [...chain, key]);
    }
    state.set(key, 'done');
    order.push(key);
  };
  visit(entryKey, []);
  return { order, stripped };
}

export function collectModules(modules, entryKey) {
  return analyze(modules, entryKey).order;
}

/**
 * Concatenate `modules` (keyed by specifier, e.g. `./protocol.js`) into one ESM source.
 *
 * @param {Record<string, string>} modules
 * @param {string} entryKey
 * @param {{ banner?: string[] }} [options] first lines of the output — the shebang must be banner[0]
 */
export function bundleModules(modules, entryKey, options = {}) {
  const { order, stripped } = analyze(modules, entryKey);
  const builtinImports = new Set();
  const owner = new Map();
  const bodies = [];
  for (const key of order) {
    const module = stripped.get(key);
    for (const statement of module.imports) builtinImports.add(statement);
    for (const name of module.names) {
      const previous = owner.get(name);
      if (previous !== undefined) {
        throw new Error(`duplicate top-level name "${name}" in ${previous} and ${key} — the bundle needs scoping, not concatenation`);
      }
      owner.set(name, key);
    }
    bodies.push(`// ── ${key} ${'─'.repeat(Math.max(0, 68 - key.length))}`, module.body.trim(), '');
  }
  const lines = [...(options.banner ?? []), ...builtinImports, '', ...bodies];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Every module of the compiled output, keyed the way the bundle's own imports refer to them. */
export function loadDistModules(directory = DIST_DIR) {
  const modules = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    modules[`./${entry.name}`] = readFileSync(join(directory, entry.name), 'utf8');
  }
  if (modules['./main.js'] === undefined) throw new Error(`no main.js in ${directory} — run the build first`);
  return modules;
}

export function bundleBanner(target, protocolVersion = 1) {
  return [
    '#!/usr/bin/env node',
    `// OmniPilot Synapse git companion — single-file bundle (target: ${target}, protocol: ${protocolVersion}).`,
    '// Generated by apps/git-bridge/scripts/pack.mjs from src/ via tsc. Do not edit.',
  ];
}

function runStep(step) {
  console.log(`\n▶ ${step.label}: ${step.command} ${step.args.join(' ')}`);
  // `npm` on Windows is `npm.cmd`, which is not an executable image, so cmd.exe must launch it.
  // Doing that explicitly (instead of `shell: true`) keeps the argument string a literal this
  // file controls — every command in `packPlan` is space-free — and avoids the Node 22
  // deprecation warning for passing args through a shell.
  const viaCmd = process.platform === 'win32';
  const command = viaCmd ? (process.env['ComSpec'] ?? 'cmd.exe') : step.command;
  const args = viaCmd ? ['/d', '/s', '/c', [step.command, ...step.args].join(' ')] : step.args;
  return spawnSync(command, args, { stdio: 'inherit', cwd: PACKAGE_DIR });
}

function main() {
  let options;
  try {
    options = parsePackArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(PACK_USAGE);
    return;
  }

  const steps = packPlan(options);
  const outputs = options.bundle ? bundleOutputs(options.targets) : [];

  if (options.dryRun) {
    console.log('OmniPilot Synapse — companion packaging (dry run)');
    for (const step of steps) console.log(`${step.command} ${step.args.join(' ')}  # ${step.label}`);
    for (const entry of outputs) {
      console.log(`bundle dist/main.js → .output/${entry.output.split(/[\\/]/).pop()}  # single-file bundle (${entry.target})`);
    }
    if (outputs.length === 0) console.log('build only — no bundle will be emitted');
    return;
  }

  try {
    for (const step of steps) {
      const result = runStep(step);
      if (result.status !== 0) throw new Error(`pack step failed: ${step.label} (exit ${result.status ?? 'unknown'})`);
    }
    if (outputs.length === 0) {
      console.log('\n✅ build complete (bundle skipped)');
      return;
    }
    const modules = loadDistModules();
    mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const entry of outputs) {
      const source = bundleModules(modules, './main.js', { banner: bundleBanner(entry.target) });
      writeFileSync(entry.output, source, 'utf8');
      // A POSIX user can point a native-host manifest straight at the file and run it.
      if (process.platform !== 'win32') chmodSync(entry.output, 0o755);
      console.log(`✅ ${relative(PACKAGE_DIR, entry.output)} (${Buffer.byteLength(source)} bytes)`);
    }
  } catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
