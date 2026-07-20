import { describe, it, expect } from 'vitest';
import {
  BASE_UOMS, ROLE_POLICY, canonicalSpecString, computeSpecFingerprint, isBaseUom, normalizeSpecText, parseQuantity,
} from '@vitan/shared';

/**
 * Phase 3 Task 1 — the shared material-specification identity (plan §B).
 * These pins are the API-side identity test for the ONE shared implementation the web
 * imports too (the Phase-2 shared-package discipline): fingerprints hash ONLY technical
 * identity, normalization is deterministic, and quantities round-trip as decimal strings.
 */
describe('material specification identity (shared)', () => {
  const identity = { materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', normalizedAttributes: 'grey, 50kg bags', baseUom: 'bag' };

  it('is deterministic and case/whitespace-insensitive', async () => {
    const a = await computeSpecFingerprint(identity);
    const b = await computeSpecFingerprint({ ...identity, materialCategory: '  cement ', make: 'ULTRATECH', normalizedAttributes: 'grey,  50kg   bags' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('changes when ANY technical field changes', async () => {
    const base = await computeSpecFingerprint(identity);
    for (const variant of [
      { ...identity, grade: 'OPC 43' },
      { ...identity, make: 'ACC' },
      { ...identity, materialCategory: 'steel' },
      { ...identity, normalizedAttributes: 'white' },
      { ...identity, baseUom: 'kg' },
    ]) {
      expect(await computeSpecFingerprint(variant)).not.toBe(base);
    }
  });

  it('EXCLUDES decision provenance by construction — the canonical string has no provenance slot', () => {
    const s = canonicalSpecString(identity);
    expect(s.startsWith('msf.v1')).toBe(true);
    expect(s).toBe(['msf.v1', 'cat:cement', 'make:ultratech', 'grade:opc 53', 'attrs:grey, 50kg bags', 'uom:bag'].join('\u001f'));
  });

  it('normalizeSpecText trims, collapses and lower-cases', () => {
    expect(normalizeSpecText('  OPC   53  Grade ')).toBe('opc 53 grade');
  });

  it('parseQuantity canonicalizes valid decimals and refuses the rest', () => {
    expect(parseQuantity('12.345678')).toBe('12.345678');
    expect(parseQuantity('007.10')).toBe('7.1');
    expect(parseQuantity('5.000000')).toBe('5');
    expect(parseQuantity('0.5')).toBe('0.5');
    for (const bad of ['0', '0.000000', '-3', '1.2345678', '1e5', '12,5', '', ' ', 'abc', '1234567890123']) {
      expect(parseQuantity(bad), bad).toBeNull();
    }
  });

  it('the UOM catalog is closed and checked', () => {
    expect(isBaseUom('bag')).toBe(true);
    expect(isBaseUom('BAG')).toBe(false);
    expect(isBaseUom('bags')).toBe(false);
    expect(BASE_UOMS.length).toBeGreaterThan(5);
  });

  it('requirement authoring is pmc-only in the shared policy (plan §H matrix)', () => {
    expect(ROLE_POLICY['requirement.manage']).toEqual(['pmc']);
  });
});
