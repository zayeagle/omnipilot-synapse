#!/usr/bin/env node
/**
 * Build assertion: the content-script bundle must not be able to read a credential.
 *
 * Why a build gate instead of a code review: the extension's whole security model rests on the page
 * context never importing `settings-store`, `crypto-key`, `ai-client` or `github-api`. A single
 * careless import would pull the vault into every web page the user visits, and nothing else in the
 * toolchain would notice. This script follows the content script's real import graph and fails the
 * build if a forbidden marker appears — or if the expected safe marker disappears.
 *
 * Exports its pure parts so `lib/tooling/secret-scan.test.ts` can exercise them.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BUNDLE_DIR = resolve(process.cwd(), '.output', 'chrome-mv3');
export const CONTENT_SCRIPT_DIR = 'content-scripts';

/**
 * Strings that may only exist in the background worker. Each one is a module or symbol that has no
 * business being reachable from a page context.
 */
export const FORBIDDEN_MARKERS = [
  'local:secretVault',
  'secretVault',
  'githubPat',
  'providerKey',
  'x-api-key',
  'anthropic-version',
  'PBKDF2',
  'AES-GCM',
  'githubApiVersion',
  // F2/T3.4: the native-messaging surface is background-only. If any of these reach a page context,
  // a compromised page could drive the companion (the only path to the user's SSH key).
  'connectNative',
  'com.omnipilot.synapse.git_bridge',
];

/**
 * Markers that MUST be present. They prove the assertion is actually looking at a built content
 * script rather than an empty or unrelated file — a check that cannot silently pass.
 */
export const REQUIRED_MARKERS = ['publicPrefs', 'capture.request'];

/**
 * @param {string} name file label used in problem messages
 * @param {string} source file contents
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function scanSource(name, source) {
  /** @type {string[]} */
  const problems = [];
  for (const marker of FORBIDDEN_MARKERS) {
    if (source.includes(marker)) problems.push(`${name}: contains forbidden marker "${marker}"`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Required markers are a property of the WHOLE bundle, not of each file: a shared chunk legitimately
 * carries only part of the code. Checking them per file would fail on any split bundle, and skipping
 * the check entirely would let an empty bundle pass.
 *
 * @param {Array<{ name: string, source: string }>} sources
 * @returns {string[]}
 */
export function checkRequiredMarkers(sources) {
  const combined = sources.map((entry) => entry.source).join('\n');
  const missing = REQUIRED_MARKERS.filter((marker) => !combined.includes(marker));
  if (missing.length === 0) return [];
  return [`bundle is missing expected marker(s) ${missing.join(', ')} — is this really a content script?`];
}

/**
 * @param {string} name
 * @param {string} source
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function scanBundle(name, source) {
  const scanned = scanSource(name, source);
  const problems = [...scanned.problems, ...checkRequiredMarkers([{ name, source }])];
  return { ok: problems.length === 0, problems };
}

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/gu;

/** Resolve the relative import specifiers of a bundled ES module. */
export function relativeImports(source) {
  /** @type {string[]} */
  const specifiers = [];
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Walk the content script and every chunk it can reach, transitively.
 *
 * @param {string} bundleDir absolute path to the built extension
 * @returns {{ files: string[], problems: string[] }}
 */
export function collectContentBundle(bundleDir) {
  const root = join(bundleDir, CONTENT_SCRIPT_DIR);
  if (!existsSync(root)) {
    return {
      files: [],
      problems: [
        `no content script bundle at ${relative(process.cwd(), root)} — run "npm run build" first`,
      ],
    };
  }

  /** @type {string[]} */
  const files = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const queue = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) queue.push(join(root, entry.name));
  }
  if (queue.length === 0) {
    return { files: [], problems: [`no .js files found in ${relative(process.cwd(), root)}`] };
  }

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) break;
    const absolute = resolve(file);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!existsSync(absolute)) {
      return { files, problems: [`imported chunk is missing on disk: ${absolute}`] };
    }
    files.push(absolute);
    const source = readFileSync(absolute, 'utf8');
    for (const specifier of relativeImports(source)) {
      queue.push(resolve(dirname(absolute), specifier));
    }
  }

  return { files, problems: [] };
}

/**
 * @param {{ bundleDir?: string }} [options]
 * @returns {{ ok: boolean, problems: string[], scanned: string[] }}
 */
export function runAssertion(options = {}) {
  const bundleDir = options.bundleDir ?? DEFAULT_BUNDLE_DIR;
  const collected = collectContentBundle(bundleDir);
  if (collected.problems.length > 0) {
    return { ok: false, problems: collected.problems, scanned: collected.files };
  }
  /** @type {string[]} */
  const problems = [];
  /** @type {Array<{ name: string, source: string }>} */
  const sources = [];
  for (const file of collected.files) {
    const name = relative(bundleDir, file);
    const source = readFileSync(file, 'utf8');
    sources.push({ name, source });
    problems.push(...scanSource(name, source).problems);
  }
  problems.push(...checkRequiredMarkers(sources));
  return {
    ok: problems.length === 0,
    problems,
    scanned: collected.files.map((file) => relative(bundleDir, file)),
  };
}

function main() {
  const result = runAssertion({});
  if (result.ok) {
    console.log(`assert:content OK — scanned ${result.scanned.length} content-script file(s)`);
    for (const file of result.scanned) console.log(`  · ${file}`);
    return;
  }
  console.error('assert:content FAILED');
  for (const problem of result.problems) console.error(`  ✗ ${problem}`);
  console.error(
    '\nThe content script must not reach settings-store, crypto-key, ai-client or github-api.',
  );
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
