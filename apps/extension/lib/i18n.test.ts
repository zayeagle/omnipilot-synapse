import { describe, expect, it } from 'vitest';

import { DEFAULT_LANG, MESSAGES, detectLang, dictKeys, t } from './i18n';

describe('i18n (F8 UNIT)', () => {
  it('TC-F8-U05 translates a known key in both languages', () => {
    expect(t('popup.clipPage', null, 'zh_CN')).toBe('剪藏本页');
    expect(t('popup.clipPage', null, 'en')).toBe('Clip this page');
  });

  it('TC-F8-U05 falls back to the key itself instead of throwing', () => {
    expect(t('does.not.exist', null, 'zh_CN')).toBe('does.not.exist');
    expect(t('does.not.exist')).toBe('does.not.exist');
  });

  it('TC-F8-U05 interpolates named vars and leaves unknown placeholders intact', () => {
    expect(t('status.repo', null, 'en')).toBe('Repository');
    // Interpolation is exercised through a synthetic dictionary entry.
    MESSAGES.en['test.greeting'] = 'Hello {name}, {missing}';
    MESSAGES.zh_CN['test.greeting'] = '你好 {name}，{missing}';
    try {
      expect(t('test.greeting', { name: 'Ada' }, 'en')).toBe('Hello Ada, {missing}');
      expect(t('test.greeting', { name: 'Ada' }, 'zh_CN')).toBe('你好 Ada，{missing}');
    } finally {
      delete MESSAGES.en['test.greeting'];
      delete MESSAGES.zh_CN['test.greeting'];
    }
  });

  it('TC-F8-U05 detects the UI language from a locale tag', () => {
    expect(detectLang('zh-CN')).toBe('zh_CN');
    expect(detectLang('zh_TW')).toBe('zh_CN');
    expect(detectLang('en-US')).toBe('en');
    expect(detectLang('fr-FR')).toBe(DEFAULT_LANG);
    expect(detectLang(null)).toBe(DEFAULT_LANG);
    expect(detectLang(undefined)).toBe(DEFAULT_LANG);
  });

  it('TC-F8-U05 keeps both dictionaries complete and in sync', () => {
    const enKeys = dictKeys('en');
    const zhKeys = dictKeys('zh_CN');
    expect(zhKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(50);
    for (const key of enKeys) {
      expect(MESSAGES.en[key]?.trim().length ?? 0).toBeGreaterThan(0);
      expect(MESSAGES.zh_CN[key]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('TC-F8-U05 never emits an empty translation for a supported language', () => {
    for (const key of dictKeys('zh_CN')) {
      expect(t(key, null, 'zh_CN').length).toBeGreaterThan(0);
    }
  });
});
