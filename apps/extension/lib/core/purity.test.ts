import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * TC-F2-U08 — the core layer must stay free of browser, DOM and network APIs.
 *
 * This is the guard rail behind blueprint assumption A10: the moment `lib/core` imports `chrome.*`
 * or `fetch`, the future extraction into `packages/core` (shared with the WeChat Mini Program)
 * stops being a mechanical move. Cheaper to enforce with a test than with review discipline.
 */

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

/** Full-line and block comments are stripped so prose may mention the forbidden names. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '');
}

const FORBIDDEN_GLOBALS = [
  'chrome',
  'browser',
  'document',
  'window',
  'fetch',
  'XMLHttpRequest',
  'localStorage',
  'sessionStorage',
  'navigator',
] as const;

function coreSources(): Array<{ name: string; code: string }> {
  return readdirSync(CORE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => ({ name, code: stripComments(readFileSync(join(CORE_DIR, name), 'utf8')) }));
}

/** Matches an identifier use, ignoring property access such as `obj.fetchHandler`. */
function usesIdentifier(code: string, identifier: string): boolean {
  const pattern = new RegExp(`(?<![.\\w$])${identifier}\\b`, 'u');
  return pattern.test(code);
}

describe('core purity (F2 UNIT)', () => {
  it('TC-F2-U08 ships the expected core modules', () => {
    const names = coreSources().map((entry) => entry.name);
    // `tombstone.ts` joined the layer with F3/F4: it renders the Markdown signposts left where content moved,
    // so it belongs with the other pure renderers (`document.ts`, `markdown.ts`) and carries no imports at all.
    expect(names).toEqual([
      'ckf.ts',
      'dedup.ts',
      'document.ts',
      'markdown.ts',
      'paths.ts',
      'tombstone.ts',
    ]);
  });

  it('TC-F2-U08 never touches a browser, DOM or network global', () => {
    const offenders: string[] = [];
    for (const { name, code } of coreSources()) {
      for (const identifier of FORBIDDEN_GLOBALS) {
        if (usesIdentifier(code, identifier)) offenders.push(`${name}: ${identifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('TC-F2-U08 only imports its own siblings', () => {
    const offenders: string[] = [];
    for (const { name, code } of coreSources()) {
      for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/gu)) {
        const specifier = match[1] ?? '';
        if (!specifier.startsWith('./')) offenders.push(`${name} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('TC-F2-U08 does not import the extension runtime or node built-ins', () => {
    const offenders: string[] = [];
    for (const { name, code } of coreSources()) {
      if (/from\s+['"](wxt|node:|@\/|~\/)/u.test(code)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
