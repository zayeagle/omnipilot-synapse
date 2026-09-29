import { describe, expect, it } from 'vitest';

import { LIMITS } from './messages';
import {
  CATALOG_HOSTS,
  PROVIDERS,
  inferProviderId,
  isCatalogHost,
  isValidBaseUrl,
  providerById,
  requiresTrustAck,
  resolveProvider,
} from './providers';

describe('provider endpoint rules (F5 UNIT)', () => {
  it('TC-F5-U08 rejects http on a public host, other schemes and unparseable URLs', () => {
    const rejected = [
      'http://api.x.com/v1',
      'http://api.openai.com/v1',
      'http://example.com:8080/v1',
      'ftp://api.x.com/v1',
      'ws://api.x.com/v1',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://',
      'not a url',
      '',
      '   ',
    ];
    for (const url of rejected) {
      expect(isValidBaseUrl(url), url).toBe(false);
    }
  });

  it('TC-F5-U08 accepts https anywhere and http only on loopback', () => {
    const accepted = [
      'https://api.openai.com/v1',
      'https://example.com/v1/',
      'https://api.x.com/v1',
      'https://my-proxy.example.com/openai/v1',
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080',
      'http://[::1]:8080/v1',
    ];
    for (const url of accepted) {
      expect(isValidBaseUrl(url), url).toBe(true);
    }
  });

  it('TC-F5-U08 rejects non-strings and URLs past the stored length limit', () => {
    expect(isValidBaseUrl(undefined)).toBe(false);
    expect(isValidBaseUrl(null)).toBe(false);
    expect(isValidBaseUrl(42)).toBe(false);
    expect(isValidBaseUrl({ url: 'https://api.x.com' })).toBe(false);
    // Padded input is trimmed first, so a copy/paste artefact is not a rejection.
    expect(isValidBaseUrl('  https://api.x.com/v1  ')).toBe(true);

    const tooLong = `https://api.x.com/${'a'.repeat(LIMITS.baseUrlChars)}`;
    expect(tooLong.length).toBeGreaterThan(LIMITS.baseUrlChars);
    expect(isValidBaseUrl(tooLong)).toBe(false);
  });
});

describe('provider trust rule (F5 UNIT)', () => {
  it('TC-F5-U09 does not require a trust ack for any catalog default host', () => {
    for (const spec of PROVIDERS) {
      if (spec.baseUrl.length === 0) continue;
      expect(requiresTrustAck(spec.baseUrl), spec.id).toBe(false);
      expect(requiresTrustAck(`${spec.baseUrl}/chat/completions`), spec.id).toBe(false);
      expect(isCatalogHost(new URL(spec.baseUrl).hostname), spec.id).toBe(true);
    }
    expect(CATALOG_HOSTS).toHaveLength(5);
  });

  it('TC-F5-U09 requires a trust ack for every host outside the catalog', () => {
    const untrusted = [
      'https://my-proxy.example.com/v1',
      'https://api.openai.com.evil.test/v1',
      'https://openai-compatible.corp.internal/v1',
      'http://localhost:11434/v1',
      'not a url',
    ];
    for (const url of untrusted) {
      expect(requiresTrustAck(url), url).toBe(true);
    }
    expect(requiresTrustAck('')).toBe(false);
    expect(requiresTrustAck('   ')).toBe(false);
    expect(requiresTrustAck(null)).toBe(false);
    expect(requiresTrustAck(undefined)).toBe(false);
  });

  it('TC-F5-U09 marks only the custom provider kind as trust-requiring', () => {
    expect(providerById.custom.requiresTrustAck).toBe(true);
    expect(providerById.custom.baseUrl).toBe('');
    for (const spec of PROVIDERS) {
      if (spec.id === 'custom') continue;
      expect(spec.requiresTrustAck, spec.id).toBe(false);
    }
  });

  it('TC-F5-U09 maps a base URL back onto a catalog id and falls back to custom', () => {
    expect(inferProviderId('https://api.openai.com/v1')).toBe('openai');
    expect(inferProviderId('https://api.deepseek.com/v1/')).toBe('deepseek');
    expect(inferProviderId('https://api.anthropic.com/v1')).toBe('anthropic');
    expect(inferProviderId('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(inferProviderId('https://spark-api-open.xf-yun.com/v1')).toBe('iflytek');
    expect(inferProviderId('https://api.openai.com/v1/chat/completions')).toBe('openai');

    expect(inferProviderId('https://my-proxy.example.com/v1')).toBe('custom');
    expect(inferProviderId('http://localhost:11434/v1')).toBe('custom');
    expect(inferProviderId('')).toBe('custom');
    expect(inferProviderId(null)).toBe('custom');
    expect(inferProviderId('not a url')).toBe('custom');
  });

  it('TC-F5-U09 resolves a stored provider id and fails closed for unknown ids', () => {
    expect(resolveProvider('openai').id).toBe('openai');
    expect(resolveProvider('deepseek').defaultModel).toBe('deepseek-chat');
    expect(resolveProvider('anthropic').authStyle).toBe('anthropic');
    expect(resolveProvider('iflytek').authStyle).toBe('bearer');

    expect(resolveProvider('mystery').id).toBe('custom');
    expect(resolveProvider('').id).toBe('custom');
    expect(resolveProvider(undefined).id).toBe('custom');
    expect(resolveProvider(null).id).toBe('custom');
    // Prototype members must not be mistaken for catalog entries.
    expect(resolveProvider('toString').id).toBe('custom');
    expect(resolveProvider('constructor').id).toBe('custom');
  });
});
