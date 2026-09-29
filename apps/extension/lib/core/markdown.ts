/**
 * Markdown document codec: YAML-subset frontmatter + verbatim body.
 *
 * PURE MODULE. Deliberately tiny — a hand-written writer and reader for exactly the subset the CKF
 * needs, so there is no YAML dependency in an extension bundle and the on-disk format stays
 * predictable for humans reading a transparent repository.
 *
 * Fidelity contract: `decodeDoc(encodeDoc(fm, body)).body === body`, byte for byte. No blank line
 * is inserted between the frontmatter and the body, because that would make the body ambiguous.
 */

export type Scalar = string | number | boolean | null;
export type FrontmatterValue =
  | Scalar
  | undefined
  | ReadonlyArray<Scalar>
  | Readonly<Record<string, Scalar | undefined>>;

export type Frontmatter = Record<string, FrontmatterValue>;
export type DecodedFrontmatter = Record<string, unknown>;

export const FRONTMATTER_DELIMITER = '---';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeScalar(value: Scalar): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      // JSON double-quoted strings are a valid YAML scalar and escape anything safely.
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      return 'null';
  }
}

function encodeValue(value: FrontmatterValue): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    return `[${value.map((entry) => encodeScalar(entry)).join(', ')}]`;
  }
  if (isPlainObject(value)) return null; // handled as a nested block
  return encodeScalar(value as Scalar);
}

function encodeNested(value: Record<string, Scalar | undefined>, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    lines.push(`${indent}${key}: ${encodeScalar(entry)}`);
  }
  return lines;
}

/** Serialize a record into a Markdown document. `body` is appended verbatim. */
export function encodeDoc(frontmatter: Frontmatter, body: string): string {
  const lines: string[] = [FRONTMATTER_DELIMITER];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      const nested = encodeNested(value as Record<string, Scalar | undefined>, '  ');
      if (nested.length === 0) continue;
      lines.push(`${key}:`);
      lines.push(...nested);
      continue;
    }
    const encoded = encodeValue(value);
    if (encoded === null) continue;
    lines.push(`${key}: ${encoded}`);
  }
  lines.push(FRONTMATTER_DELIMITER);
  return `${lines.join('\n')}\n${body}`;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === '') return undefined;
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('"')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

export interface DecodedDoc {
  frontmatter: DecodedFrontmatter;
  body: string;
}

/** Parse a document produced by `encodeDoc`, tolerating hand edits within the same subset. */
export function decodeDoc(text: string): DecodedDoc {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = source.split('\n');
  const first = lines[0]?.replace(/\r$/u, '');
  if (first !== FRONTMATTER_DELIMITER) {
    return { frontmatter: {}, body: source };
  }

  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.replace(/\r$/u, '') === FRONTMATTER_DELIMITER) {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    return { frontmatter: {}, body: source };
  }

  const frontmatter: DecodedFrontmatter = {};
  let nestedKey: string | null = null;

  for (let i = 1; i < closing; i += 1) {
    const line = (lines[i] ?? '').replace(/\r$/u, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const match = /^(\s*)([A-Za-z_][\w-]*):(.*)$/u.exec(line);
    if (!match) continue;

    const [, indent = '', key = '', rest = ''] = match;
    if (indent.length === 0) {
      nestedKey = null;
      if (rest.trim() === '') {
        nestedKey = key;
        frontmatter[key] = {};
        continue;
      }
      frontmatter[key] = parseScalar(rest);
      continue;
    }

    if (nestedKey === null) continue;
    const bucket = frontmatter[nestedKey];
    if (!isPlainObject(bucket)) continue;
    bucket[key] = parseScalar(rest);
  }

  const body = lines.slice(closing + 1).join('\n');
  return { frontmatter, body };
}
