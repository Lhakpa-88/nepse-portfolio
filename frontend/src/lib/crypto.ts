/**
 * Passphrase encryption for the portfolio sync file (WebCrypto).
 * AES-256-GCM, key derived with PBKDF2-SHA256 (600k iterations, random salt).
 * backend/secure_store.py decrypts the same format inside GitHub Actions.
 */
const ITER = 600000;
const b64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i += 1) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pass: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedBlob { v: number; kdf: string; iter: number; cipher: string; salt: string; iv: string; ct: string; updatedAt: string }

export async function encryptJson(obj: unknown, pass: string): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await deriveKey(pass, salt, ITER),
    new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), ct: b64(ct), updatedAt: new Date().toISOString() };
}

export async function decryptJson(blob: Pick<EncryptedBlob, 'iter' | 'salt' | 'iv' | 'ct'>, pass: string) {
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource },
      await deriveKey(pass, unb64(blob.salt), blob.iter), unb64(blob.ct) as BufferSource);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error('Wrong passphrase or corrupted file');
  }
}
