import { describe, expect, it } from 'vitest';

import { NOTE_URL, noteCapturePayload } from './format';

/**
 * Manual entry (F11).
 *
 * The protocol has carried `mode: 'note'` from the start; what was missing was a surface, and a surface
 * needs a payload builder that refuses an empty note BEFORE a round trip. These pin that boundary.
 */
describe('note payload (F11 UNIT)', () => {
  it('TC-F11-U01 builds a note from a title and a body, and keeps the page it was written next to', () => {
    const payload = noteCapturePayload('  My title  ', '  the note body  ', 'https://example.com/a');
    expect(payload).toMatchObject({
      mode: 'note',
      url: 'https://example.com/a',
      title: 'My title',
      selection: 'the note body',
    });
  });

  it('TC-F11-U02 refuses an empty body locally, and falls back to the first line for a title', () => {
    expect(noteCapturePayload('t', '   ', 'https://example.com/a')).toBeNull();
    expect(noteCapturePayload('t', '', undefined)).toBeNull();

    const untitled = noteCapturePayload('', 'first line\nsecond line');
    expect(untitled?.title).toBe('first line');
    // A note has no page, so it carries a stable synthetic URL rather than an empty one.
    expect(untitled?.url).toBe(NOTE_URL);
  });

  it('TC-F11-U03 caps the body at the protocol limit instead of sending something the worker refuses', () => {
    const payload = noteCapturePayload('', 'x'.repeat(250_000));
    expect(payload?.selection).toHaveLength(200_000);
  });
});
