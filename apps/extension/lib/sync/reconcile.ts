/**
 * Merge planning — the pure decision layer of the sync engine.
 *
 * The sync engine's job is to answer one question per path: *who changed it, and what do we do?*
 * Getting that wrong loses a user's note, so the decision is deliberately extracted into a pure
 * function with no I/O, no clock of its own and no knowledge of GitHub, git or the codecs.
 *
 * Conflict policy (requirements §5B "最后写入 + 冲突副本保留"): the remote wins at the original path
 * because it may already be visible to other clients, and the local version is preserved beside it as
 * a `.conflict-<stamp>` sibling. **Both versions always survive** — nothing is dropped, ever.
 */

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface PathChange {
  path: string;
  kind: ChangeKind;
  /** Content fingerprint (local) or blob sha (remote), when the caller knows one. */
  key?: string;
}

export interface MergeInputs {
  /** Paths changed locally since the last successfully synced head. */
  local: readonly PathChange[];
  /** Paths that changed remotely since that same head. */
  remote: readonly PathChange[];
  /** Injected clock, used only for conflict-copy names. */
  now?: () => number;
}

export interface ConflictPlan {
  /** The path where both sides changed; the remote version keeps it. */
  path: string;
  /** Where our version is written instead, then pushed. */
  conflictPath: string;
}

export interface MergePlan {
  /** Fetch these paths from the remote (they are new or newer there). */
  pull: string[];
  /**
   * **The complete set of local paths to write/push.** `resurrect` and conflict copies are included
   * here as well, so a caller can act on `push` alone and still be correct — the subsets below are
   * informational (for the cache, the UI and the logs).
   */
  push: string[];
  /** The remote deleted these and we did not touch them — drop them locally. */
  removeLocal: string[];
  /** Subset of `push`: notes the remote deleted that we had changed, so ours is restored. */
  resurrect: string[];
  /** Paths where both sides changed; both versions are preserved. */
  conflicts: ConflictPlan[];
}

export const CONFLICT_INFIX = '.conflict-';

/** `inbox/2026/07/note-abc.md` → `inbox/2026/07/note-abc.conflict-202607091430.md` */
export function conflictPathFor(path: string, stamp: string): string {
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash + 1);
  const name = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${dir}${stem}${CONFLICT_INFIX}${stamp}${ext}`;
}

/** `2026-07-09T14:30:00Z` → `202607091430` (minute resolution keeps names readable). */
export function conflictStamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
  ].join('');
}

function uniqueSorted(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort();
}

function byPath(changes: readonly PathChange[]): Map<string, PathChange> {
  const map = new Map<string, PathChange>();
  for (const change of changes) {
    // Last write wins within a single side — the caller passes one change per path.
    map.set(change.path, change);
  }
  return map;
}

/**
 * Decide what to pull, what to push, what to drop and what conflicts.
 *
 * Pure and total: every input path appears in exactly one output bucket (a conflict appears in three:
 * `pull` for the remote version, `push` for the conflict copy, and `conflicts` for the UI).
 */
export function planMerge(inputs: MergeInputs): MergePlan {
  const local = byPath(inputs.local);
  const remote = byPath(inputs.remote);
  const at = (inputs.now ?? Date.now)();
  const stamp = conflictStamp(at);

  const pull: string[] = [];
  const push: string[] = [];
  const removeLocal: string[] = [];
  const resurrect: string[] = [];
  const conflicts: ConflictPlan[] = [];

  // Reserved names so two conflicts in the same minute never collide. Seeded with every path the
  // caller already knows about, so we never write over a real note.
  const taken = new Set<string>([...local.keys(), ...remote.keys()]);
  const reserveConflictPath = (path: string): string => {
    let candidate = conflictPathFor(path, stamp);
    let counter = 2;
    while (taken.has(candidate)) {
      candidate = conflictPathFor(path, `${stamp}-${counter}`);
      counter += 1;
    }
    taken.add(candidate);
    return candidate;
  };

  for (const [path, remoteChange] of remote) {
    const localChange = local.get(path);

    if (remoteChange.kind === 'deleted') {
      if (localChange) {
        // We changed it, they removed it. Keep ours: losing a note because a file disappeared from
        // the repository would be the worst possible failure mode.
        resurrect.push(path);
        push.push(path);
      } else {
        removeLocal.push(path);
      }
      continue;
    }

    // The remote has a new or newer version: always pull it.
    pull.push(path);

    if (localChange) {
      // Both sides touched the same path — preserve both.
      conflicts.push({ path, conflictPath: reserveConflictPath(path) });
    }
  }

  for (const [path, localChange] of local) {
    const remoteChange = remote.get(path);
    if (remoteChange) {
      // Already handled above: the conflict copy is what we push.
      continue;
    }
    if (localChange.kind === 'deleted') {
      // A local deletion is not implemented as a repository delete in this MVP — notes are archived,
      // not destroyed — so it is not pushed. (Documented in 04-design F3.)
      continue;
    }
    push.push(path);
  }

  const conflictCopies = conflicts.map((conflict) => conflict.conflictPath);

  return {
    pull: uniqueSorted(pull),
    push: uniqueSorted([...push, ...conflictCopies]),
    removeLocal: uniqueSorted(removeLocal),
    resurrect: uniqueSorted(resurrect),
    conflicts: [...conflicts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** True when a plan does no work at all — used to short-circuit a sync cheaply. */
export function isNoopPlan(plan: MergePlan): boolean {
  return (
    plan.pull.length === 0 &&
    plan.push.length === 0 &&
    plan.removeLocal.length === 0 &&
    plan.resurrect.length === 0 &&
    plan.conflicts.length === 0
  );
}

/** A one-line summary for the UI and the logs. Never contains note content. */
export function describePlan(plan: MergePlan): string {
  return [
    `pull=${plan.pull.length}`,
    `push=${plan.push.length}`,
    `drop=${plan.removeLocal.length}`,
    `resurrect=${plan.resurrect.length}`,
    `conflicts=${plan.conflicts.length}`,
  ].join(' ');
}
