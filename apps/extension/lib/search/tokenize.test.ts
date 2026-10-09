import { describe, expect, it } from 'vitest';

import {
  EMPTY_TERM_SHARD_KEY,
  SHARD_BUCKETS,
  compareText,
  isCjkToken,
  isShardKey,
  shardKey,
  tokenizeForSearch,
} from './tokenize';

describe('shardKey (F4 UNIT)', () => {
  it('TC-F4-U03 buckets a term by its whole text, not by a prefix', () => {
    // The key is no longer derived from the first characters, which is the whole point: a term's key
    // stops growing with the vocabulary, and two terms sharing a prefix no longer share a file.
    expect(shardKey('alpha')).toMatch(/^b[0-9a-f]{2}$/u);
    expect(shardKey('间隔重复')).toMatch(/^b[0-9a-f]{2}$/u);
    // The prefix scheme's keys are gone: these are not what a two-character prefix would produce.
    expect(shardKey('间隔重复')).not.toBe('间隔');
    expect(shardKey('alpha')).not.toBe('al');
  });

  it('TC-F4-U03 keeps every key inside the bucket space', () => {
    for (const term of ['alpha', 'retrieval', '间隔重复', '重复', '间', 'a', '𠀀abcdef', '12345']) {
      const key = shardKey(term);
      expect(isShardKey(key)).toBe(true);
      expect(key).toHaveLength(3);
      const bucket = Number.parseInt(key.slice(1), 16);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(SHARD_BUCKETS);
    }
  });

  it('TC-F4-U03 is stable: one term, one bucket, on every call', () => {
    for (const term of ['alpha', '间隔重复', '𠀀abcdef']) {
      expect(shardKey(term)).toBe(shardKey(term));
      // Case and surrounding whitespace are folded before hashing, so neither can split a term across
      // two files — the write path and the query path must derive the same key from the same word.
      expect(shardKey('  ' + term.toUpperCase() + ' ')).toBe(shardKey(term));
    }
  });

  it('TC-F4-U03 bounds the files one page can touch', () => {
    // What the prefix scheme could not promise: however wide the vocabulary, the number of distinct
    // shard keys stays inside the bucket count. This is the property the capture latency rests on.
    const terms = tokenizeForSearch(
      '间隔重复 spaced repetition 记忆 复习 遗忘 曲线 检索 索引 治理 观测 部署 权限'.repeat(6),
    );
    const keys = new Set(terms.map((term) => shardKey(term)));
    expect(terms.length).toBeGreaterThan(20);
    expect(keys.size).toBeLessThanOrEqual(SHARD_BUCKETS);
    for (const key of keys) expect(isShardKey(key)).toBe(true);
  });

  it('TC-F4-U03 falls back to the sentinel when the term has no characters at all', () => {
    expect(shardKey('')).toBe(EMPTY_TERM_SHARD_KEY);
    expect(shardKey('   ')).toBe(EMPTY_TERM_SHARD_KEY);
    // The sentinel can never collide with a bucket: tokenize() emits no underscores.
    expect(EMPTY_TERM_SHARD_KEY).toBe('_');
    expect(isShardKey(EMPTY_TERM_SHARD_KEY)).toBe(true);
  });

  it('TC-F4-U03 recognises a shard from the old prefix scheme as stale', () => {
    // Those files are valid JSON at valid paths, so nothing else would notice them — and a query
    // answered from them would silently drop postings. The key space is what tells them apart.
    expect(isShardKey('al')).toBe(false);
    expect(isShardKey('间隔')).toBe(false);
    expect(isShardKey('a')).toBe(false);
    expect(isShardKey('b0')).toBe(false);
    expect(isShardKey('bb')).toBe(false);
    expect(isShardKey('b00')).toBe(true);
    expect(isShardKey('bff')).toBe(true);
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
