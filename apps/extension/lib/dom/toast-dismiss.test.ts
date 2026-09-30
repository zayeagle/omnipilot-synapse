// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { createToast } from './toast';

/**
 * The capture toast must dismiss itself in PRODUCTION, not only under test.
 *
 * The bug this pins: the auto-hide only ran when a fake timer was injected, so the real content-script
 * toast never went away — it sat on the page covering what the user was reading, and only a reload
 * removed it.
 */
describe('capture toast lifecycle', () => {
  it('TC-TOAST-U01 dismisses itself with no injected timer', () => {
    vi.useFakeTimers();
    try {
      const toast = createToast({ doc: document });
      toast.show('boom', 'error');
      expect(toast.isVisible()).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(toast.isVisible()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TC-TOAST-U02 hides when the user clicks it, and clears the message', () => {
    const toast = createToast({ doc: document, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} });
    toast.show('boom', 'error');
    toast.element.click();
    expect(toast.isVisible()).toBe(false);
    expect(toast.element.textContent).toBe('');
  });
});
