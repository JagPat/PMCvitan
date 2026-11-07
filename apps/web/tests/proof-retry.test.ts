import { describe, it, expect, afterEach } from 'vitest';
import { dropProofKey, keepProofKey, photoDigest, proofRetrySlot, readProofKey } from '@/lib/proofRetry';

/** #482 "Your open items" (Codex #1408 4500685646) — a proof's upload key kept across a reload: bounded, per slot. */

const SRC = { original: 'o1', sent: 's1' };
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => { globalThis.sessionStorage.clear(); });

describe('proof upload keys kept across a reload', () => {
  it('a slot is the person, the project and the item', () => {
    expect(proofRetrySlot('u1', 'qa', 'it-1')).toBe('u1|qa|it-1');
    expect(proofRetrySlot(null, 'qa', 'it-1')).toBe('|qa|it-1');
  });

  it('keeps one key per slot, read back until it is a day old', () => {
    keepProofKey('a', SRC, 'k1', T0);
    keepProofKey('a', { original: 'o2', sent: 's2' }, 'k2', T0 + 1);
    expect(readProofKey('a', T0 + DAY)).toEqual({ original: 'o2', sent: 's2', key: 'k2', at: T0 + 1 });
    expect(readProofKey('a', T0 + DAY + 2)).toBeNull();
    expect(readProofKey('b', T0)).toBeNull();
  });

  it('keeps only the 20 newest', () => {
    for (let i = 0; i < 25; i += 1) keepProofKey(`s${i}`, SRC, `k${i}`, T0 + i);
    expect(readProofKey('s4', T0 + 30)).toBeNull();
    expect(readProofKey('s5', T0 + 30)?.key).toBe('k5');
    expect(readProofKey('s24', T0 + 30)?.key).toBe('k24');
  });

  it('an answer drops only its own key', () => {
    keepProofKey('a', SRC, 'k1', T0);
    dropProofKey('a', 'k-other', T0);
    expect(readProofKey('a', T0)?.key).toBe('k1');
    dropProofKey('a', 'k1', T0);
    expect(readProofKey('a', T0)).toBeNull();
  });

  it('an unreadable store, or an entry of another shape, reads as nothing', () => {
    globalThis.sessionStorage.setItem('vitan.proofRetry.v1', '{not json');
    expect(readProofKey('a', T0)).toBeNull();
    globalThis.sessionStorage.setItem('vitan.proofRetry.v1', JSON.stringify({ a: { key: 'k1' }, b: [1] }));
    expect(readProofKey('a', T0)).toBeNull();
    expect(readProofKey('b', T0)).toBeNull();
  });

  it('a photo digest is the SHA-256 of its bytes, and null for what is not a photo', async () => {
    // the bytes "abc"
    expect(await photoDigest('data:image/png;base64,YWJj')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await photoDigest('data:image/jpeg;base64,YWJj')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await photoDigest('not a photo')).toBeNull();
  });
});
