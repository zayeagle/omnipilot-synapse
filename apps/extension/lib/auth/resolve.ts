/**
 * Mode resolution — the single place that decides which `GitAuth` an operation uses.
 *
 * The important behaviour here is that a mode which cannot run is reported as **data**, with a
 * reason, and never by throwing: "SSH needs the companion" is an expected state for most users, and
 * the UI has to be able to say so while token mode carries on working. Anything that throws here is a
 * genuine programming error (an unknown mode), not a user situation.
 */

import { NativeError, type NativeClient } from '../native/client';
import { NotConfiguredError } from '../store/errors';
import { VaultLockedError } from '../security/key-session';
import { SshAuth } from './ssh-auth';
import { TokenAuth } from './token-auth';
import type { AuthContext, AuthResolution, AuthUnavailableReason } from './types';

/**
 * Classify a failure from a mode's `assertReady()` into the reason the UI needs.
 *
 * Unrecognised errors are deliberately *not* swallowed: they propagate, because a bug in a mode must
 * not be reported to the user as "install the companion".
 */
export function reasonFor(error: unknown): AuthUnavailableReason | null {
  if (error instanceof NativeError) {
    if (error.code === 'nativeUnavailable') return 'native-missing';
    if (error.code === 'protocolMismatch') return 'protocol-mismatch';
    if (error.code === 'gitMissing') return 'git-missing';
    return 'not-configured';
  }
  if (error instanceof VaultLockedError) return 'vault-locked';
  if (error instanceof NotConfiguredError) return 'not-configured';
  return null;
}

const REASON_MESSAGES: Record<AuthUnavailableReason, string> = {
  'not-configured': 'auth: this mode is not configured yet',
  'native-missing': 'auth: the companion process is required for SSH and is not installed',
  'protocol-mismatch': 'auth: the companion process needs an upgrade',
  'git-missing': 'auth: the companion could not find git on this machine',
  'vault-locked': 'auth: unlock the vault first',
};

/**
 * Build the auth object for the configured mode and check it can run.
 *
 * `mode` defaults to the stored `authMode`, but a caller may force one (the options page testing the
 * other mode, or a sync that must use a specific transport).
 */
export async function resolveAuth(
  context: AuthContext,
  mode: AuthContext['snapshot']['authMode'] = context.snapshot.authMode,
): Promise<AuthResolution> {
  if (mode === 'ssh') {
    if (!context.native) {
      return { ok: false, reason: 'native-missing', message: REASON_MESSAGES['native-missing'] };
    }
    const auth = new SshAuth(context, context.native);
    try {
      await auth.assertReady();
      return { ok: true, auth };
    } catch (error) {
      const reason = reasonFor(error);
      if (reason === null) throw error;
      return {
        ok: false,
        reason,
        message: error instanceof Error ? error.message : REASON_MESSAGES[reason],
      };
    }
  }

  const auth = new TokenAuth(context);
  try {
    await auth.assertReady();
    return { ok: true, auth };
  } catch (error) {
    const reason = reasonFor(error);
    if (reason === null) throw error;
    return {
      ok: false,
      reason,
      message: error instanceof Error ? error.message : REASON_MESSAGES[reason],
    };
  }
}

/** A short, translatable-ready label for a reason — the UI maps it through i18n. */
export function reasonKey(reason: AuthUnavailableReason): string {
  return `auth.unavailable.${reason}`;
}

/**
 * Probe availability of *both* modes without changing the configuration.
 *
 * Used by the options page to render the mode picker with an accurate state (and to enable/disable
 * the SSH option before the user commits to it).
 */
export async function probeAvailability(
  context: AuthContext,
  native: NativeClient | null,
): Promise<{ token: AuthUnavailableReason | null; ssh: AuthUnavailableReason | null; companion: 'ok' | 'missing' | 'mismatch' }> {
  const [token, ssh] = await Promise.all([
    resolveAuth(context, 'token').then((resolution) => (resolution.ok ? null : resolution.reason)),
    resolveAuth(context, 'ssh').then((resolution) => (resolution.ok ? null : resolution.reason)),
  ]);
  const availability = native ? await native.availability() : 'missing';
  return { token, ssh, companion: availability };
}
