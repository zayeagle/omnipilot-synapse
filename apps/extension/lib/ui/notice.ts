/**
 * The one line under the action row that answers "can I clip?".
 *
 * It is the only place a transient state is allowed to appear. An action button keeps its own caption
 * while it is disabled: a caption that turns into "Working…" reads as a different button, hides which
 * action is unavailable, and — because the status line underneath never heard about it — leaves the
 * popup claiming "Ready to clip" and "Working…" at the same time.
 */

export type NoticeKind = 'ok' | 'blocked' | 'working';

export interface NoticeState {
  text: string;
  kind: NoticeKind;
}

/**
 * What the status line shows: the in-flight line while `busy`, the readiness line otherwise.
 *
 * The readiness state is returned by identity when idle, so a caller that kept the same object keeps
 * its own kind (a blocked reason is never silently downgraded to "ok").
 */
export function noticeFor(readiness: NoticeState, busy: boolean, working: string): NoticeState {
  return busy ? { text: working, kind: 'working' } : readiness;
}
