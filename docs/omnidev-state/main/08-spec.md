# Spec delta - req-2026-09-30-synapse-manual-entry

## ADDED

### R11 手工录入 (manual entry)
The extension SHALL let the user write a note by hand and store it as an ordinary source record in the
Inbox, with the same commit, index, search-shard and vault behaviour as a web capture.

- SHALL accept an optional title and a required non-empty body from a surface inside the popup.
- WHEN the title is left empty THEN the first non-empty line of the body SHALL become the title.
- WHEN the store is configured and writable THEN the note SHALL be committed as a source record whose body
  is the note text, and the Inbox SHALL list it.
- WHEN the note is not about a page THEN the record SHALL NOT be marked as an excerpt of that URL.
- SHALL NOT require tags, a category or a second confirmation step (零压力).

### R11b 落盘位置
A note SHALL land under the same inbox path rules as a capture, so sync, search and review treat it like any
other source.

## MODIFIED

- CaptureService.buildItem: mode note SHALL NOT set excerptOf; the title SHALL fall back to the first line of
  the text rather than to the URL.

## Scenario IDs
| SC | Scenario |
|----|----------|
| SC-F11-01 | Compose a note with title and text -> committed, listed in the Inbox |
| SC-F11-02 | Compose a note without a title -> the title is the body's first line |
| SC-F11-03 | Empty body -> the surface refuses locally and sends nothing |
| SC-F11-04 | Note while the store is unreachable -> queued (稍后处理), not lost |
