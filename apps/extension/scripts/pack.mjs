#!/usr/bin/env node
/**
 * One-command packaging: test → build → zip.
 *
 * Mirrors the sibling project's `pack.mjs` so both repositories behave the same way, but the steps
 * are exposed as data (`packPlan`) rather than being buried in the runner, which keeps them
 * testable and makes `--dry-run` trivial to add later.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_USAGE = [
  'Usage: node scripts/pack.mjs [options]',
  '',
  'Options:',
  '  --skip-test     skip the UNIT + INT suites (faster, for local iteration)',
  '  --firefox       also build the Firefox bundle',
  '  --no-zip        build only, do not produce zip archives',
  '  --dry-run       print the commands instead of running them',
  '  -h, --help      show this message',
].join('\n');

/**
 * @param {string[]} argv
 * @returns {{ skipTest: boolean, firefox: boolean, zip: boolean, dryRun: boolean, help: boolean }}
 */
export function parsePackArgs(argv) {
  const options = { skipTest: false, firefox: false, zip: true, dryRun: false, help: false };
  for (const arg of argv) {
    switch (arg) {
      case '--skip-test':
        options.skipTest = true;
        break;
      case '--firefox':
        options.firefox = true;
        break;
      case '--no-zip':
        options.zip = false;
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
        throw new Error(`unknown option "${arg}"\n\n${PACK_USAGE}`);
    }
  }
  return options;
}

/**
 * The ordered list of commands a pack performs. Data, not control flow.
 *
 * @param {{ skipTest?: boolean, firefox?: boolean, zip?: boolean }} options
 * @returns {Array<{ label: string, command: string, args: string[] }>}
 */
export function packPlan(options = {}) {
  const plan = [];
  if (!options.skipTest) {
    plan.push({ label: 'unit tests', command: 'npm', args: ['test'] });
    plan.push({ label: 'integration tests', command: 'npm', args: ['run', 'test:int'] });
  }
  plan.push({ label: 'icons', command: 'npm', args: ['run', 'icons'] });
  plan.push({ label: 'build (chrome)', command: 'npm', args: ['run', 'build'] });
  if (options.firefox) {
    plan.push({ label: 'build (firefox)', command: 'npm', args: ['run', 'build:firefox'] });
  }
  plan.push({ label: 'secret assertion', command: 'npm', args: ['run', 'assert:content'] });
  // Zipping is the default; only an explicit `--no-zip` (or `zip: false`) turns it off.
  if (options.zip !== false) {
    plan.push({ label: 'zip (chrome)', command: 'npm', args: ['run', 'zip'] });
    if (options.firefox) plan.push({ label: 'zip (firefox)', command: 'npm', args: ['run', 'zip:firefox'] });
  }
  return plan;
}

/** @param {{ label: string, command: string, args: string[] }} step */
function run(step) {
  console.log(`\n▶ ${step.label}: ${step.command} ${step.args.join(' ')}`);
  const result = spawnSync(step.command, step.args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw new Error(`pack step failed: ${step.label} (exit ${result.status ?? 'unknown'})`);
  }
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

  const plan = packPlan(options);
  if (options.dryRun) {
    for (const step of plan) console.log(`${step.command} ${step.args.join(' ')}  # ${step.label}`);
    return;
  }
  try {
    for (const step of plan) run(step);
    console.log('\n✅ pack complete — see .output/ for the bundles and zips');
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
