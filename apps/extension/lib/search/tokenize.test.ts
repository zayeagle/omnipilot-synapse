import { describe, expect, it } from 'vitest';

import {
  EMPTY_TERM_SHARD_KEY,
  SHARD_KEY_LENGTH,
  compareText,
  isCjkToken,
  shardKey,
  tokenizeForSearch,
} from './tokenize';

describe('shardKey (F4 UNIT)', () => {
  it('TC-F4-U03 uses the first two characters of a latin term', () => {
    expect(shardKey('alpha')).toBe('al');
    expect(shardKey('retrieval')).toBe('re');
    expect(SHARD_KEY_LENGTH).toBe(2);
  });

  it('TC-F4-U03 splits a CJK term into its first two characters', () => {
    expect(shardKey('间隔重复')).toBe('间隔');
    expect(shardKey('重复')).toBe('重复');
  });

  it('TC-F4-U03 falls back to the single character for a 1-character term', () => {
    // A 1-character term cannot fill two code points: the character itself is the key, and it still
    // buckets every term that starts with it (`间` and `间隔` land in different files, by design).
    expect(shardKey('间')).toBe('间');
    expect(shardKey('a')).toBe('a');
    expect(shardKey('间')).not.toBe(shardKey('间隔'));
  });

  it('TC-F4-U03 falls back to the sentinel when the term has no characters at all', () => {
    expect(shardKey('')).toBe(EMPTY_TERM_SHARD_KEY);
    expect(shardKey('   ')).toBe(EMPTY_TERM_SHARD_KEY);
    // The sentinel can never collide with a real key: tokenize() emits no underscores.
    expect(EMPTY_TERM_SHARD_KEY).toBe('_');
  });

  it('TC-F4-U03 is unicode-safe for astral code points', () => {
    // `slice(0, 2)` would return a single astral character here (it counts UTF-16 units); `Array.from`
    // counts code points, so the key is two characters long either way.
    const key = shardKey('𠀀abcdef');
    expect(Array.from(key)).toHaveLength(2);
    expect(key).toBe('𠀀a');
  });

  it('TC-F4-U03 trims and lowercases before bucketing', () => {
    expect(shardKey('  Alpha ')).toBe('al');
    expect(shardKey('INTERVAL')).toBe('in');
  });
});

describe('tokenizeForSearch (F4 UNIT)', () => {
  it('TC-F4-U03 reuses the core/dedup rules for latin text', () => {
    // Same rules as dedup.tokenize: NFKC, lowercase, latin per word, CJK per character.
    expect(tokenizeForSearch('Machine Learning')).toEqual(['machine', 'learning']);
    expect(tokenizeForSearch('Full-width ＡＢＣ')).toEqual(['full', 'width', 'abc']);
  });

  it('TC-F4-U03 adds CJK bigrams on top of the single characters', () => {
    // 04-design F4 step 1: `间隔重复` must yield 间隔, 隔重, 重复 as well as 间, 隔, 重, 复.
    expect(tokenizeForSearch('间隔重复')).toEqual(['间', '隔', '重', '复', '间隔', '隔重', '重复']);
    expect(tokenizeForSearch('间隔重复')).toContain('间隔');
    expect(isCjkToken('间')).toBe(true);
    expect(isCjkToken('machine')).toBe(false);
  });

  it('TC-F4-U03 de-duplicates per document and lowercases every token', () => {
    expect(tokenizeForSearch('alpha alpha ALPHA')).toEqual(['alpha']);
    // The single characters are de-duplicated, the bigrams follow them.
    expect(tokenizeForSearch('间隔 间隔')).toEqual(['间', '隔', '间隔', '隔间']);
  });

  it('TC-F4-U03 does not bridge bigrams across a non-CJK token', () => {
    const tokens = tokenizeForSearch('间 abc 隔');
    expect(tokens).toEqual(['间', 'abc', '隔']);
    expect(tokens).not.toContain('间隔');
  });

  it('TC-F4-U03 returns nothing for punctuation-only text', () => {
    expect(tokenizeForSearch('!!! … —')).toEqual([]);
    expect(tokenizeForSearch('')).toEqual([]);
  });

  it('TC-F4-U03 orders terms by code point, not by locale', () => {
    expect(['b', 'a', '间'].sort(compareText)).toEqual(['a', 'b', '间']);
    expect(compareText('a', 'a')).toBe(0);
  });
});
