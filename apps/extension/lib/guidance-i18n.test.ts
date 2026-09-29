import { describe, expect, it } from 'vitest';
import { t } from './i18n';
import { ERROR_GUIDANCE } from './status';

/**
 * TC-P5-U01/U03 — the guidance table is only useful if it can actually be rendered.
 *
 * The table stores i18n **keys** (that is what keeps outside strings out of the UI), so a missing key would show
 * the user the literal key — `guidance.locked` instead of 保险库处于锁定状态. This closes that hole for every row in
 * both dictionaries; it is the counterpart of the table's compile-time completeness check.
 */
describe('failure guidance translations (F5 UNIT)', () => {
  it('TC-P5-U03 every guidance key resolves in both languages', () => {
    const missing: string[] = [];
    for (const [code, guidance] of Object.entries(ERROR_GUIDANCE)) {
      for (const key of [guidance.titleKey, guidance.actionKey]) {
        for (const lang of ['zh_CN', 'en'] as const) {
          const resolved = t(key, null, lang);
          // A missing key comes back as the key itself — exactly the failure this guards against.
          if (resolved === key || resolved.length === 0) missing.push(lang + ': ' + key + ' (' + code + ')');
        }
      }
    }
    expect(missing).toEqual([]);
  });
});