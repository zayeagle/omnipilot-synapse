/**
 * Sealing at rest, with the key the vault already holds.
 *
 * Two stores keep CONTENT outside the repository: the offline capture queue (a payload waiting to be
 * written) and the decoded sync cache (what the engine last read). Both used to keep that content as
 * plaintext in browser storage, so a locked vault still left note text on disk — while the one promise
 * vault mode makes is that a locked vault leaves nothing readable behind.
 *
 * The key is fetched per call rather than held: `requireKey` throws once the session locks or expires,
 * which is the behaviour wanted — sealing fails closed, and a sealed entry simply cannot be opened
 * until the vault is unlocked again. No new secret is introduced: it is the same derived key the
 * credential envelope uses, and it is never written anywhere.
 */

import { decryptText, encryptText, type CipherText, type CryptoProvider } from './crypto-key';
import type { KeySession } from './key-session';

export interface Sealer {
  seal(plaintext: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

export interface SessionSealerOptions {
  crypto?: CryptoProvider;
  /** Injected clock, so the session TTL is judged by the same clock everything else uses. */
  now?: () => number;
}

export function createSessionSealer(
  session: KeySession,
  options: SessionSealerOptions = {},
): Sealer {
  const now = options.now ?? Date.now;
  return {
    async seal(plaintext: string): Promise<string> {
      const key = session.requireKey(now());
      const cipher = await encryptText(key, plaintext, options.crypto);
      return JSON.stringify(cipher);
    },
    async open(sealed: string): Promise<string> {
      const key = session.requireKey(now());
      return decryptText(key, JSON.parse(sealed) as CipherText, options.crypto);
    },
  };
}
