/**
 * The dashboard encrypts the portfolio in the browser; the pipeline decrypts it in Python.
 * These tests pin that contract with a committed DEMO fixture that BOTH test suites decrypt
 * (see tests/test_pipeline.py::EncryptionTest), so a change on either side cannot silently break sync.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from './crypto';

const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/encrypted_demo.json', import.meta.url));
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const REGENERATE = process.env.WRITE_ENC_FIXTURE === '1';

describe('portfolio encryption (browser side)', () => {
  // Maintenance only: WRITE_ENC_FIXTURE=1 npx vitest run src/lib/crypto.test.ts
  it.runIf(REGENERATE)('regenerates the browser-encrypted fixture', async () => {
    fx.fromBrowser = await encryptJson(fx.plain, fx.passphrase);
    writeFileSync(FIXTURE, `${JSON.stringify(fx, null, 2)}\n`);
  });

  it('round-trips, uses a strong key derivation, and hides the content', async () => {
    const blob = await encryptJson(fx.plain, fx.passphrase);
    expect(blob.iter).toBeGreaterThanOrEqual(600000);
    expect(blob.cipher).toBe('AES-256-GCM');
    expect(JSON.stringify(blob)).not.toContain('transactions');
    expect(await decryptJson(blob, fx.passphrase)).toEqual(fx.plain);
  });

  it('gives a clear error for a wrong passphrase or a tampered file', async () => {
    const blob = await encryptJson(fx.plain, fx.passphrase);
    await expect(decryptJson(blob, 'not the passphrase')).rejects.toThrow('Wrong passphrase or corrupted file');
    const tampered = { ...blob, ct: blob.ct.slice(0, -4) + (blob.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(decryptJson(tampered, fx.passphrase)).rejects.toThrow('Wrong passphrase or corrupted file');
  });

  it('two encryptions of the same data differ (fresh salt and nonce each time)', async () => {
    const [a, b] = await Promise.all([encryptJson(fx.plain, fx.passphrase), encryptJson(fx.plain, fx.passphrase)]);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('decrypts a file that the pipeline code (Python) encrypted', async () => {
    expect(await decryptJson(fx.fromPipeline, fx.passphrase)).toEqual(fx.plain);
  });

  it('decrypts the committed file that this browser code encrypted', async () => {
    expect(fx.fromBrowser, 'fixture is missing fromBrowser: run with WRITE_ENC_FIXTURE=1 once').toBeTruthy();
    expect(await decryptJson(fx.fromBrowser, fx.passphrase)).toEqual(fx.plain);
  });
});
