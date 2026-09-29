#!/usr/bin/env node
/**
 * Register the git companion as a browser native-messaging host.
 *
 * WHY this is not part of `pack.mjs`: packaging produces bytes, registration mutates the user's
 * browser configuration. Keeping the two apart lets CI build a bundle without ever touching a config
 * directory, and makes `--dry-run` the natural first step for a user who wants to see exactly which
 * file would appear before it appears.
 *
 * Safety contract: a real install writes exactly one JSON file per selected browser, inside that
 * browser's own native-messaging directory, and nothing else. Windows resolves hosts through the
 * registry, which is not a config directory, so the exact `reg add` command is printed for the user
 * to run instead of being executed here.
 *
 * The pure parts are exported so `test/tooling/native-host.test.ts` can drive them without writing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Must stay identical to `DEFAULT_HOST_NAME` in apps/extension/lib/native/client.ts. */
export const HOST_NAME = 'com.omnipilot.synapse.git_bridge';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.join(HERE, 'manifest.template.json');
/** `apps/git-bridge`; the bundle and `dist/` both live under it. */
export const PACKAGE_DIR = path.resolve(HERE, '..');

/** Chromium browsers share one manifest shape; only the directory and Windows registry key differ. */
export const BROWSER_TARGET = { chrome: 'chrome', edge: 'chrome', firefox: 'firefox' };
export const ALL_BROWSERS = ['chrome', 'edge', 'firefox'];

export const INSTALL_USAGE = [
  'Usage: node native-host/install.mjs [options]',
  '',
  'Options:',
  '  --browser <chrome|edge|firefox|all>  browser family to register (default: chrome)',
  '  --extension-id <id>                  Chrome/Edge extension ID (chrome://extensions → Details)',
  '  --firefox-id <id>                    Firefox add-on ID (about:debugging → This Firefox)',
  '  --companion <path>                   companion entry point (default: the packed .output bundle)',
  '  --dry-run                            print the manifests without writing anything',
  '  -h, --help                           show this message',
  '',
  'A real install requires --extension-id (and --firefox-id with --browser firefox/all); the',
  'extension does not pin an ID yet, so guessing one would register a host nothing can reach.',
].join('\n');

/**
 * Split a platform name into the joiner for THAT platform, so a Linux layout can be asserted from a
 * Windows test host (and vice versa) without the host OS leaking into the result.
 */
function joiner(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function joinFor(platform, ...parts) {
  return joiner(platform).join(...parts);
}

/**
 * The native-messaging directory the *browser* reads. Every one of these is browser-owned config;
 * nothing here is a shared or machine-level location.
 */
export function nativeMessagingDir(browser, context = {}) {
  const platform = context.platform ?? process.platform;
  const home = context.home ?? os.homedir();
  const env = context.env ?? process.env;
  const join = (...parts) => joinFor(platform, ...parts);
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    const roaming = env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    if (browser === 'chrome') return join(local, 'Google', 'Chrome', 'NativeMessagingHosts');
    if (browser === 'edge') return join(local, 'Microsoft', 'Edge', 'NativeMessagingHosts');
    return join(roaming, 'Mozilla', 'NativeMessagingHosts');
  }
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    if (browser === 'chrome') return join(support, 'Google', 'Chrome', 'NativeMessagingHosts');
    if (browser === 'edge') return join(support, 'Microsoft Edge', 'NativeMessagingHosts');
    return join(support, 'Mozilla', 'NativeMessagingHosts');
  }
  if (browser === 'chrome') return join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
  if (browser === 'edge') return join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts');
  return join(home, '.mozilla', 'native-messaging-hosts');
}

/**
 * Windows-only follow-up. Chrome/Edge/Firefox locate the manifest through this key, so the user must
 * run the command themselves — `install.mjs` deliberately does not write to the registry.
 */
export function registryCommand(browser, platform, manifestPath) {
  if (platform !== 'win32') return null;
  const root =
    browser === 'chrome'
      ? 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts'
      : browser === 'edge'
        ? 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts'
        : 'HKCU\\Software\\Mozilla\\NativeMessagingHosts';
  return `reg add "${root}\\${HOST_NAME}" /ve /t REG_SZ /d "${manifestPath}" /f`;
}

/** Refuse to write anywhere but inside the browser directory this call was given. */
export function assertInsideRoot(root, candidate, platform = process.platform) {
  const normalize = (value) => {
    const absolute = joiner(platform).resolve(value);
    return platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const inside = normalize(root);
  const target = normalize(candidate);
  const prefix = inside.endsWith(joiner(platform).sep) ? inside : inside + joiner(platform).sep;
  if (target !== inside && !target.startsWith(prefix)) {
    throw new Error(`refusing to write outside ${inside}: ${target}`);
  }
  return candidate;
}

const EXACT_PLACEHOLDER = /^\$\{([A-Z0-9_]+)\}$/;
const INLINE_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

function substitute(value, values) {
  if (typeof value === 'string') {
    const exact = EXACT_PLACEHOLDER.exec(value);
    if (exact) return Object.hasOwn(values, exact[1]) ? values[exact[1]] : value;
    return value.replace(INLINE_PLACEHOLDER, (match, key) =>
      Object.hasOwn(values, key) ? String(values[key]) : match,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, values));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, values)]),
    );
  }
  return value;
}

/**
 * Fill one browser target. An unresolved placeholder is an error rather than a literal: a manifest
 * that still says `${CHROME_EXTENSION_ID}` looks installed and silently never connects.
 */
export function renderManifest(template, target, values) {
  const skeleton = template?.targets?.[target];
  if (skeleton === undefined) throw new Error(`manifest template has no "${target}" target`);
  const rendered = substitute(
    { name: template.name, description: template.description, ...skeleton },
    values,
  );
  const leftover = [...new Set(JSON.stringify(rendered).match(/\$\{[^}]+\}/g) ?? [])];
  if (leftover.length > 0) throw new Error(`unfilled manifest placeholder(s): ${leftover.join(', ')}`);
  return rendered;
}

/** Where the packed bundle would be, then the plain `tsc` output as the fallback. */
export function companionPathCandidates(root, platform = process.platform, arch = process.arch) {
  return [
    path.join(root, '.output', `git-bridge-${platform}-${arch}.mjs`),
    path.join(root, 'dist', 'main.js'),
  ];
}

export function resolveCompanion(root, platform = process.platform, arch = process.arch) {
  const candidates = companionPathCandidates(root, platform, arch);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function parseInstallArgs(argv) {
  const options = {
    browsers: ['chrome'],
    extensionId: null,
    firefoxId: null,
    companion: null,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--browser': {
        const value = argv[++index];
        if (value === undefined) throw new Error(`--browser needs a value\n\n${INSTALL_USAGE}`);
        options.browsers = value === 'all' ? [...ALL_BROWSERS] : [value];
        break;
      }
      case '--extension-id':
        options.extensionId = argv[++index] ?? null;
        break;
      case '--firefox-id':
        options.firefoxId = argv[++index] ?? null;
        break;
      case '--companion':
        options.companion = argv[++index] ?? null;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '-h':
      case '--help':
      case 'help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option "${arg}"\n\n${INSTALL_USAGE}`);
    }
  }
  for (const browser of options.browsers) {
    if (!ALL_BROWSERS.includes(browser)) {
      throw new Error(`unknown browser "${browser}" (expected chrome | edge | firefox | all)`);
    }
  }
  return options;
}

/**
 * Every file a real install would create, as data — so the plan can be reviewed (and tested) without
 * the filesystem being touched at all.
 */
export function installPlan(options, template, context = {}) {
  const platform = context.platform ?? process.platform;
  const home = context.home ?? os.homedir();
  const env = context.env ?? process.env;
  const companion =
    options.companion ?? resolveCompanion(context.root ?? PACKAGE_DIR, platform, context.arch);
  const values = {
    COMPANION_PATH: companion,
    CHROME_EXTENSION_ID: options.extensionId ?? '<chrome-extension-id>',
    FIREFOX_EXTENSION_ID: options.firefoxId ?? '<firefox-addon-id>',
  };
  return options.browsers.map((browser) => {
    const dir = nativeMessagingDir(browser, { platform, home, env });
    const manifestPath = joinFor(platform, dir, `${HOST_NAME}.json`);
    assertInsideRoot(dir, manifestPath, platform);
    return {
      browser,
      dir,
      manifestPath,
      manifest: renderManifest(template, BROWSER_TARGET[browser], values),
      registry: registryCommand(browser, platform, manifestPath),
    };
  });
}

function main() {
  let options;
  try {
    options = parseInstallArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(INSTALL_USAGE);
    return;
  }
  // The browser launches the host with no working directory of its own, so the manifest must
  // carry an absolute path even when the user typed a relative one.
  if (options.companion !== null) options.companion = path.resolve(options.companion);

  let template;
  try {
    template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
  } catch (error) {
    console.error(`✗ cannot read ${TEMPLATE_PATH}: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  if (template.name !== HOST_NAME) {
    console.error(`✗ template name "${template.name}" must equal "${HOST_NAME}"`);
    process.exitCode = 1;
    return;
  }

  const needsExtension = options.browsers.some((browser) => browser !== 'firefox');
  const needsFirefox = options.browsers.includes('firefox');
  if (!options.dryRun) {
    if (needsExtension && options.extensionId === null) {
      console.error('✗ --extension-id is required (chrome://extensions → Details → ID)');
      process.exitCode = 1;
      return;
    }
    if (needsFirefox && options.firefoxId === null) {
      console.error('✗ --firefox-id is required (about:debugging → This Firefox → Extension ID)');
      process.exitCode = 1;
      return;
    }
  }

  let plan;
  try {
    plan = installPlan(options, template, {});
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }

  const companion = plan.length > 0 ? plan[0].manifest.path : '';
  console.log('OmniPilot Synapse — native messaging host');
  console.log(`  host:      ${HOST_NAME}`);
  console.log(`  companion: ${companion}`);
  console.log(`  browsers:  ${options.browsers.join(', ')}`);
  console.log(`  dry run:   ${options.dryRun ? 'yes (nothing will be written)' : 'no'}`);
  if (options.dryRun && (needsExtension && options.extensionId === null) || (needsFirefox && options.firefoxId === null)) {
    console.log('  note:      no --extension-id/--firefox-id given — the preview keeps the placeholder');
  }

  if (!options.dryRun && !existsSync(companion)) {
    console.error(`✗ companion entry point not found: ${companion} (run: npm --prefix apps/git-bridge run pack)`);
    process.exitCode = 1;
    return;
  }

  for (const entry of plan) {
    console.log('');
    console.log(`▶ ${entry.browser}`);
    console.log(`  manifest: ${entry.manifestPath}`);
    if (options.dryRun) {
      console.log(JSON.stringify(entry.manifest, null, 2).split('\n').map((line) => `  ${line}`).join('\n'));
      continue;
    }
    mkdirSync(entry.dir, { recursive: true });
    writeFileSync(entry.manifestPath, `${JSON.stringify(entry.manifest, null, 2)}\n`, 'utf8');
    console.log('  written');
  }

  console.log('');
  if (options.dryRun) {
    console.log('Dry run complete — no file was created.');
    return;
  }
  console.log('Next steps:');
  console.log('  1. Restart the browser so it re-reads the host list, then reload the extension.');
  const registries = plan.filter((entry) => entry.registry !== null);
  if (registries.length > 0) {
    console.log('  2. Windows finds hosts through the registry — run (this script never does):');
    for (const entry of registries) console.log(`     ${entry.registry}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
