/**
 * Signposts for content that moved.
 *
 * The storage API can add and overwrite but **not delete**, and that is a feature: the same rule already governs
 * sync (a remote deletion resurrects a local change rather than dropping it). So when content stops living at a
 * path, the path gets a small Markdown signpost instead of a mystery file — the repository is a place people
 * browse, and a pointer is cheaper to understand than an absence.
 *
 * Shared by the card decision (F3) and conflict resolution (F4) so both speak the same language.
 */

export const TOMBSTONE_MARKER = '<!-- omnipilot:tombstone -->';

/** `<root>/<原路径>` — the archive mirrors the repository's own layout. */
export function archivePathFor(root: string, path: string): string {
  return path.length === 0 ? root : root + '/' + path;
}

/** What happened, where the content went, when, and that this file is now inert. */
export function tombstoneFor(target: string, reason: string, at: string): string {
  const tick = String.fromCharCode(96);
  return [
    TOMBSTONE_MARKER,
    '# 内容已移动（由 OmniPilot Synapse 自动生成）',
    '',
    '这个位置原来的内容已经不在这里。',
    '',
    '- **去哪了**：' + tick + target + tick,
    '- **为什么**：' + reason,
    '- **什么时候**：' + at,
    '',
    '扩展不再引用本文件，可以安全删除；正文仍在上面那个位置。',
    '',
  ].join('\n');
}

export function isTombstone(content: string): boolean {
  return content.startsWith(TOMBSTONE_MARKER);
}
