import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OVERLAY_CSS, OVERLAY_STYLE_ID, createBubble, el, injectOverlayStyles } from './bubble';
import { createToast } from './toast';

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    top: 100,
    left: 200,
    bottom: 120,
    right: 260,
    width: 60,
    height: 20,
    x: 200,
    y: 100,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('overlay host (F1 UNIT)', () => {
  it('TC-F1-U04 injects the stylesheet exactly once', () => {
    injectOverlayStyles(document, OVERLAY_CSS);
    injectOverlayStyles(document, OVERLAY_CSS);
    expect(document.querySelectorAll(`#${OVERLAY_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(OVERLAY_STYLE_ID)?.textContent).toContain('.omnipilot-bubble');
  });

  it('TC-F1-U04 sets text through textContent, never innerHTML', () => {
    const node = el(document, 'div', 'x', '<img src=x onerror=alert(1)>');
    expect(node.innerHTML).not.toContain('<img');
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('selection bubble (F1 UNIT)', () => {
  function makeBubble() {
    const actions = { onClip: vi.fn(), onDistill: vi.fn(), onClose: vi.fn() };
    const bubble = createBubble({ doc: document, actions });
    return { actions, bubble };
  }

  it('TC-F1-U04 renders translated actions and starts hidden', () => {
    const { bubble } = makeBubble();
    expect(bubble.isVisible()).toBe(false);
    const labels = Array.from(bubble.element.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['剪藏', '提炼', '×']);
    expect(bubble.element.getAttribute('role')).toBe('toolbar');
  });

  it('TC-F1-U04 shows below the selection and hides again', () => {
    const { bubble } = makeBubble();
    bubble.showAt(rect({ top: 100, bottom: 120, left: 200 }));
    expect(bubble.isVisible()).toBe(true);
    expect(bubble.element.style.top).toBe('128px');
    expect(bubble.element.style.left).toBe('200px');

    bubble.hide();
    expect(bubble.isVisible()).toBe(false);
  });

  it('TC-F1-U04 flips above the selection near the bottom of the viewport', () => {
    const { bubble } = makeBubble();
    const innerHeight = document.defaultView?.innerHeight ?? 768;
    bubble.showAt(rect({ top: innerHeight - 20, bottom: innerHeight - 4, left: 50 }));
    const top = Number.parseInt(bubble.element.style.top, 10);
    expect(top).toBeLessThan(innerHeight - 20);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('TC-F1-U04 clamps the bubble inside the viewport on the right edge', () => {
    const { bubble } = makeBubble();
    const innerWidth = document.defaultView?.innerWidth ?? 1024;
    bubble.showAt(rect({ left: innerWidth - 4, right: innerWidth }));
    const left = Number.parseInt(bubble.element.style.left, 10);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left).toBeLessThan(innerWidth);
  });

  it('TC-F1-U04 dispatches the three actions', () => {
    const { actions, bubble } = makeBubble();
    bubble.showAt(rect());

    (bubble.element.querySelector('[data-action="clip"]') as HTMLElement).click();
    expect(actions.onClip).toHaveBeenCalledTimes(1);

    (bubble.element.querySelector('[data-action="distill"]') as HTMLElement).click();
    expect(actions.onDistill).toHaveBeenCalledTimes(1);

    (bubble.element.querySelector('[data-action="close"]') as HTMLElement).click();
    expect(actions.onClose).toHaveBeenCalledTimes(1);
    expect(bubble.isVisible()).toBe(false);
  });

  it('TC-F1-U04 prevents mousedown so the page selection is not lost', () => {
    const { bubble } = makeBubble();
    const event = new Event('mousedown', { bubbles: true, cancelable: true });
    bubble.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('TC-F1-U04 destroys cleanly and detaches its listeners', () => {
    const { actions, bubble } = makeBubble();
    expect(document.querySelectorAll('.omnipilot-bubble')).toHaveLength(1);
    const clipButton = bubble.element.querySelector('[data-action="clip"]') as HTMLElement;
    bubble.destroy();
    expect(document.querySelectorAll('.omnipilot-bubble')).toHaveLength(0);
    clipButton.click();
    expect(actions.onClip).not.toHaveBeenCalled();
  });
});

describe('capture toast (F1 UNIT)', () => {
  it('TC-F1-U04 shows a message with a kind and hides itself on a timer', () => {
    const scheduled: Array<() => void> = [];
    const toast = createToast({
      doc: document,
      setTimeoutImpl: (handler) => {
        scheduled.push(handler);
        return scheduled.length;
      },
      clearTimeoutImpl: () => undefined,
    });

    expect(toast.isVisible()).toBe(false);
    toast.show('已入收件箱', 'success');
    expect(toast.isVisible()).toBe(true);
    expect(toast.element.textContent).toBe('已入收件箱');
    expect(toast.element.dataset['kind']).toBe('success');

    scheduled[0]?.();
    expect(toast.isVisible()).toBe(false);
  });

  it('TC-F1-U04 only renders an https commit link', () => {
    const toast = createToast({ doc: document });
    toast.show('已入收件箱', 'success', { href: 'https://github.com/o/r/commit/abc', label: '打开' });
    expect(toast.element.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/o/r/commit/abc',
    );
    expect(toast.element.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');

    toast.show('已入收件箱', 'success', { href: 'javascript:alert(1)', label: '打开' });
    expect(toast.element.querySelector('a')).toBeNull();
    expect(toast.element.textContent).toBe('已入收件箱');
  });

  it('TC-F1-U04 clears previous content and can be destroyed', () => {
    const toast = createToast({ doc: document });
    toast.show('first');
    toast.show('second', 'error');
    expect(document.querySelectorAll('.omnipilot-toast')).toHaveLength(1);
    expect(toast.element.textContent).toBe('second');
    expect(toast.element.dataset['kind']).toBe('error');

    toast.destroy();
    expect(document.querySelectorAll('.omnipilot-toast')).toHaveLength(0);
  });
});
