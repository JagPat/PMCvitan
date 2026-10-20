import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A test file that resets modules and imports the app anew warms every app module it imports (`warm-imports.ts`), so no
 * test's 5 s is spent on the worker's first import of it. Read from the files themselves: no clock, no load.
 */
const RESET = 'vi.resetModules' + '(';
const imported = (src: string) => new Set([...src.matchAll(/(?<!typeof )import\(\s*'(@\/[^']+)'\s*\)/g)].map((m) => m[1]!));
const warmed = (src: string) => {
  const call = /^await warmImports\(([^\n]*)\);$/m.exec(src)?.[1] ?? '';
  return new Set([...call.matchAll(/import\('(@\/[^']+)'\)/g)].map((m) => m[1]!));
};

/** `file: module` pairs a file may import without warming, each with its reason. None today. */
const UNWARMED: Record<string, string> = {};

describe('every test file that resets modules warms what it imports (#792)', () => {
  const files = readdirSync(__dirname).filter((n) => /\.test\.tsx?$/.test(n));

  it('finds the files it checks', () => {
    expect(files.filter((n) => readFileSync(resolve(__dirname, n), 'utf8').includes(RESET)).length).toBeGreaterThan(0);
  });

  it('each one calls warmImports with every app module it imports', () => {
    const gaps = files.flatMap((n) => {
      const src = readFileSync(resolve(__dirname, n), 'utf8');
      if (!src.includes(RESET)) return [];
      const have = warmed(src);
      return [...imported(src)].filter((m) => !have.has(m)).map((m) => `${n}: ${m}`).filter((gap) => !(gap in UNWARMED));
    });
    expect(gaps).toEqual([]);
  });

  it('each allowed exception names a reason and is still needed', () => {
    for (const [gap, reason] of Object.entries(UNWARMED)) {
      expect(reason.trim(), gap).not.toBe('');
      const [n, m] = gap.split(': ');
      const src = readFileSync(resolve(__dirname, n!), 'utf8');
      expect(imported(src).has(m!) && !warmed(src).has(m!), gap).toBe(true);
    }
  });
});
