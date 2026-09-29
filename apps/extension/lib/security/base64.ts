/**
 * Base64 helpers that work in a service worker, in a page and in Node (tests).
 *
 * `btoa`/`atob` are available in all three, so no Buffer dependency is needed and the module stays
 * bundle-neutral. Encoding is chunked because `String.fromCharCode(...bytes)` overflows the call
 * stack for large bodies (512 KB captures are routine here).
 */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToUtf8(value: string): string {
  return new TextDecoder().decode(base64ToBytes(value));
}

export function isBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && value.length % 4 === 0;
}
