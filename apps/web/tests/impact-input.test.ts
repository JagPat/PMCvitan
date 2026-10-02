import { describe, it, expect } from 'vitest';
import { readImpact } from '../src/lib/impactInput';

// #482 comment 5923291892 — the countersign impact inputs must never silently change an amount's sign or
// magnitude: an unsupported entry is refused with a reason, an accepted one is exactly what was typed.

const ok = (raw: string, kind: 'cost' | 'days') => {
  const r = readImpact(raw, kind);
  if (!r.ok) throw new Error(`${JSON.stringify(raw)} (${kind}) was refused: ${r.reason}`);
  return r.value;
};
const refused = (raw: string, kind: 'cost' | 'days') => {
  const r = readImpact(raw, kind);
  expect(r.ok, `${JSON.stringify(raw)} (${kind}) must be refused`).toBe(false);
  return r.ok ? '' : r.reason;
};

describe('readImpact — the reported transformations are refused or kept exact', () => {
  it('a decimal amount or duration is refused, never scaled', () => {
    expect(refused('12.50', 'cost')).toMatch(/whole rupees only/i); // was 1250
    expect(refused('1.5', 'days')).toMatch(/whole days only/i); // was 15
    expect(refused('₹ 1,234.50', 'cost')).toMatch(/whole rupees only/i);
  });
  it('text is refused, never read as zero', () => {
    expect(refused('abc', 'cost')).toMatch(/enter whole rupees/i); // was 0
    expect(refused('two', 'days')).toMatch(/enter whole days/i);
  });
  it('a Unicode minus keeps its sign', () => {
    expect(ok('−5', 'cost')).toBe(-5); // was +5
    expect(ok('−5', 'days')).toBe(-5);
    expect(ok('−₹ 5,000', 'cost')).toBe(-5000);
  });
});

describe('readImpact — the supported whole-number forms', () => {
  it('blank is the agreed zero default', () => {
    expect(ok('', 'cost')).toBe(0);
    expect(ok('   ', 'days')).toBe(0);
  });
  it('plain, Western-grouped and Indian-grouped rupees, with an optional currency mark', () => {
    expect(ok('5000', 'cost')).toBe(5000);
    expect(ok('5,000', 'cost')).toBe(5000);
    expect(ok('₹ 5,000', 'cost')).toBe(5000); // the case the existing component test pins
    expect(ok('₹5000', 'cost')).toBe(5000);
    expect(ok('Rs. 500/-', 'cost')).toBe(500);
    expect(ok('rs 500', 'cost')).toBe(500);
    expect(ok('INR 1,00,000', 'cost')).toBe(100000);
    expect(ok('1,00,00,000', 'cost')).toBe(10000000);
    expect(ok('1,000,000', 'cost')).toBe(1000000);
  });
  it('a sign before or after the currency mark, but only one', () => {
    expect(ok('-500', 'cost')).toBe(-500);
    expect(ok('-₹500', 'cost')).toBe(-500);
    expect(ok('₹-500', 'cost')).toBe(-500);
    expect(ok('+500', 'cost')).toBe(500);
    refused('-₹-500', 'cost');
    refused('--500', 'cost');
  });
  it('whole days with an optional unit', () => {
    expect(ok('2', 'days')).toBe(2);
    expect(ok('2 days', 'days')).toBe(2); // the case the existing component test pins
    expect(ok('1 day', 'days')).toBe(1);
    expect(ok('3d', 'days')).toBe(3);
    expect(ok('-2 days', 'days')).toBe(-2);
  });
  it('zero is zero, never negative zero', () => {
    expect(Object.is(ok('-0', 'cost'), 0)).toBe(true);
    expect(Object.is(ok('−0', 'days'), 0)).toBe(true);
  });
});

describe('readImpact — anything ambiguous is refused, never guessed', () => {
  it('a comma that is not a thousands or lakh separator', () => {
    refused('12,50', 'cost'); // a decimal comma would otherwise read as 1250
    refused('1,2', 'cost');
    refused('5,0000', 'cost');
    refused(',500', 'cost');
  });
  it('spaces inside the number, a second number, or other units', () => {
    refused('5 000', 'cost');
    refused('5-3', 'cost');
    refused('5000 USD', 'cost');
    refused('$500', 'cost');
    refused('2 weeks', 'days');
    refused('₹ 2', 'days'); // a currency mark is not a duration
    refused('2 days', 'cost'); // a duration is not an amount
  });
  it('non-ASCII digits are not silently converted', () => {
    refused('५००', 'cost'); // Devanagari digits
    refused('５００', 'cost'); // full-width digits
  });
  it('a value outside the Postgres integer column is refused', () => {
    expect(ok('2147483647', 'cost')).toBe(2147483647);
    expect(ok('-2147483648', 'cost')).toBe(-2147483648);
    expect(refused('2147483648', 'cost')).toMatch(/too large/i);
    expect(refused('99999999999999999999', 'days')).toMatch(/too large/i);
  });
});
