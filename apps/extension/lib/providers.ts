/**
 * The model-provider catalog — "support mainstream models" expressed as data, not code.
 *
 * Adding a provider is a row in `PROVIDERS`, never a branch in the client: every entry declares its
 * endpoint, its one of two auth styles and its curated model ids, and `lib/ai-client.ts` reads
 * nothing else. Pure module (no browser, DOM or network APIs) so the options UI, the background
 * worker and the tests all share the same table.
 *
 * Trust is a *separate* question from validity: `isValidBaseUrl` only enforces the transport
 * (https, or http on loopback), while `requiresTrustAck` answers "does this host receive the user's
 * content without being one of the endpoints this extension ships with?" — the answer drives the
 * explicit acknowledgement in the options page (SC-F5-02).
 */

import { LIMITS, isAcceptableEndpoint } from './messages';

export type ProviderId = 'openai' | 'deepseek' | 'anthropic' | 'openrouter' | 'iflytek' | 'custom';

/** The only two auth styles this extension speaks. Everything else was dropped to keep one transport. */
export type AuthStyle = 'bearer' | 'anthropic';

export interface ProviderSpec {
  id: ProviderId;
  /** Brand name — not localized, rendered as-is in the options `<select>`. */
  label: string;
  /** Empty only for `custom`, where the user must supply one. */
  baseUrl: string;
  authStyle: AuthStyle;
  /** Empty only for `custom`, where the user must supply one. */
  defaultModel: string;
  /** Curated ids for the options `<datalist>`; the field stays free-text (no `listModels()` in MVP). */
  models: string[];
  /** True for a provider *kind* whose endpoints are user-supplied; see `requiresTrustAck(url)`. */
  requiresTrustAck: boolean;
}

/** Hosts this extension ships with. Any other host is "custom" and needs an explicit trust ack. */
export const CATALOG_HOSTS: readonly string[] = [
  'api.openai.com',
  'api.deepseek.com',
  'api.anthropic.com',
  'openrouter.ai',
  'spark-api-open.xf-yun.com',
];

const OPENAI: ProviderSpec = {
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  authStyle: 'bearer',
  defaultModel: 'gpt-4o-mini',
  models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
  requiresTrustAck: false,
};

const DEEPSEEK: ProviderSpec = {
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  authStyle: 'bearer',
  defaultModel: 'deepseek-chat',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  requiresTrustAck: false,
};

const ANTHROPIC: ProviderSpec = {
  id: 'anthropic',
  label: 'Anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  authStyle: 'anthropic',
  defaultModel: 'claude-3-5-haiku-latest',
  models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest', 'claude-3-7-sonnet-latest'],
  requiresTrustAck: false,
};

const OPENROUTER: ProviderSpec = {
  id: 'openrouter',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  authStyle: 'bearer',
  defaultModel: 'openai/gpt-4o-mini',
  models: [
    'openai/gpt-4o-mini',
    'openai/gpt-4o',
    'anthropic/claude-3.5-haiku',
    'deepseek/deepseek-chat',
  ],
  requiresTrustAck: false,
};

const IFLYTEK: ProviderSpec = {
  id: 'iflytek',
  label: 'iFlytek Spark',
  // Spark's OpenAI-compatible HTTP endpoint — not the HMAC-signed native protocol.
  baseUrl: 'https://spark-api-open.xf-yun.com/v1',
  authStyle: 'bearer',
  defaultModel: 'generalv3.5',
  models: ['generalv3.5', '4.0Ultra', 'lite', 'max-32k'],
  requiresTrustAck: false,
};

const CUSTOM: ProviderSpec = {
  id: 'custom',
  label: 'Custom (OpenAI-compatible)',
  baseUrl: '',
  authStyle: 'bearer',
  defaultModel: '',
  models: [],
  // The kind itself is user-supplied, so the ack is required even before a URL exists.
  requiresTrustAck: true,
};

/** Display order for the options page. Exactly the six providers in blueprint §5. */
export const PROVIDERS: readonly ProviderSpec[] = [
  OPENAI,
  DEEPSEEK,
  ANTHROPIC,
  OPENROUTER,
  IFLYTEK,
  CUSTOM,
];

/** Indexed view of the same table, for lookups by stored settings. */
export const providerById: Readonly<Record<ProviderId, ProviderSpec>> = {
  openai: OPENAI,
  deepseek: DEEPSEEK,
  anthropic: ANTHROPIC,
  openrouter: OPENROUTER,
  iflytek: IFLYTEK,
  custom: CUSTOM,
};

/** Unknown or missing ids fall back to `custom` — never throws on stored settings. */
export function resolveProvider(id: string | null | undefined): ProviderSpec {
  if (typeof id !== 'string') return CUSTOM;
  // Own-property check: `providerById['toString']` must not resolve to a prototype member.
  if (!Object.prototype.hasOwnProperty.call(providerById, id)) return CUSTOM;
  return providerById[id as ProviderId] ?? CUSTOM;
}

/** `hostname` of a URL, or null when it does not parse. Lower-cased by `URL` itself. */
function hostOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  try {
    const host = new URL(trimmed).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

export function isCatalogHost(host: string | null | undefined): boolean {
  if (typeof host !== 'string') return false;
  return CATALOG_HOSTS.includes(host.toLowerCase());
}

/** Best-effort mapping from a configured base URL back onto a catalog id (`custom` when unknown). */
export function inferProviderId(baseUrl: string | null | undefined): ProviderId {
  const host = hostOf(baseUrl);
  if (host === null) return 'custom';
  for (const spec of PROVIDERS) {
    if (spec.baseUrl.length === 0) continue;
    if (hostOf(spec.baseUrl) === host) return spec.id;
  }
  return 'custom';
}

/**
 * Transport rule, not a trust rule: https anywhere, http only for loopback (local stubs/bridges).
 * Length-capped with the same limit the settings payload validator uses, so a value that passes
 * here can always be persisted.
 */
export function isValidBaseUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > LIMITS.baseUrlChars) return false;
  return isAcceptableEndpoint(trimmed);
}

/**
 * True when this endpoint is outside the shipped catalog, i.e. the user must acknowledge that their
 * content will be sent to a host this extension cannot vouch for.
 *
 * An empty/absent URL is not an endpoint yet (nothing will be sent), so it does not need an ack; a
 * non-empty URL that cannot even be parsed fails closed and does.
 */
export function requiresTrustAck(baseUrl: string | null | undefined): boolean {
  if (typeof baseUrl !== 'string') return false;
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return false;
  const host = hostOf(trimmed);
  if (host === null) return true;
  return !isCatalogHost(host);
}
