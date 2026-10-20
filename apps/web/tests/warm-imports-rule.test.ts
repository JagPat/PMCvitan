import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A test file that resets modules and imports the app anew warms every app module it imports (`warm-imports.ts`), so no
 * test's 5 s is spent on the worker's first import of it. Read from the files themselves: no clock, no load.
 */
const RESET = 'vi.resetModules' + '(';
/** Every `@/` module a dynamic `import(...)` in `src` names, whichever quote it is written with (', " or `). A template
 *  that substitutes (`${`) cannot be warmed by name, so it is kept as written, quotes and all: it is a gap unless
 *  `UNWARMED` allows it with a reason. */
const imported = (src: string) => new Set([...src.matchAll(/(typeof\s+)?import\(\s*(['"`])(@\/(?:(?!\2)[^\\])*)\2\s*\)/g)]
  .filter((m) => !m[1])
  .map((m) => (m[2] === '`' && m[3]!.includes('${') ? `\`${m[3]}\`` : m[3]!)));
const warmed = (src: string) => imported(/^await warmImports\(([^\n]*)\);$/m.exec(src)?.[1] ?? '');
/** Every other `import(` (not `typeof`) whose argument is not one lone string literal, as written: a concatenation, a
 *  variable, a comment or a second argument. None can be warmed by name, so each is a gap unless `UNWARMED` allows it. */
const unread = (src: string) => [...src.matchAll(/(typeof\s+)?\bimport\((?!\s*(['"`])(?:(?!\2)[^\\])*\2\s*\))[^)\n]*\)?/g)]
  .filter((m) => !m[1]).map((m) => m[0]);
/** A file's gaps: what it imports and does not warm, and every import the rule cannot read. */
const gapsOf = (src: string) => [...[...imported(src)].filter((m) => !warmed(src).has(m)), ...unread(src)];

/** `file: module` pairs a file may import without warming, each with its reason. None today. */
const UNWARMED: Record<string, string> = {};

describe('the rule reads a dynamic import whichever way it is written (#792, Codex 4331287109)', () => {
  it.each([
    ['single quotes', "await import('@/store/store');"],
    ['double quotes', 'await import("@/store/store");'],
    ['a template with no substitution', 'await import(`@/store/store`);'],
  ])('finds an import in %s, and a warm-up written the same way covers it', (_form, line) => {
    expect([...imported(line)]).toEqual(['@/store/store']);
    expect([...warmed(`await warmImports(() => ${line.slice('await '.length, -1)});`)]).toEqual(['@/store/store']);
  });

  it('keeps a template that substitutes as written, so it is a gap no warm-up can name', () => {
    const line = 'await import(`@/screens/${name}`);';
    expect([...imported(line)]).toEqual(['`@/screens/${name}`']);
    expect(warmed(`await warmImports(() => import('@/screens/SiteVisitsScreen'));`).has('`@/screens/${name}`')).toBe(false);
  });

  it('reports an import it cannot read by name, such as a concatenation, as a gap no warm-up can name', () => {
    const src = "await warmImports(() => import('@/screens/SiteVisitsScreen'));\nawait import('@/screens/' + name);";
    expect(gapsOf(src)).toEqual(["import('@/screens/' + name)"]);
  });

  it('leaves type-only imports alone', () => {
    expect([...imported("type S = typeof import('@/store/store');")]).toEqual([]);
  });
});

describe('every test file that resets modules warms what it imports (#792)', () => {
  const files = readdirSync(__dirname).filter((n) => /\.test\.tsx?$/.test(n));

  it('finds the files it checks', () => {
    expect(files.filter((n) => readFileSync(resolve(__dirname, n), 'utf8').includes(RESET)).length).toBeGreaterThan(0);
  });

  it('each one calls warmImports with every app module it imports', () => {
    const gaps = files.flatMap((n) => {
      const src = readFileSync(resolve(__dirname, n), 'utf8');
      if (!src.includes(RESET)) return [];
      return gapsOf(src).map((m) => `${n}: ${m}`).filter((gap) => !(gap in UNWARMED));
    });
    expect(gaps).toEqual([]);
  });

  it('each allowed exception names a reason and is still needed', () => {
    for (const [gap, reason] of Object.entries(UNWARMED)) {
      expect(reason.trim(), gap).not.toBe('');
      // the file name ends at the first ': '; the module may hold more (a template with a ternary)
      const i = gap.indexOf(': ');
      const n = gap.slice(0, i);
      const m = gap.slice(i + 2);
      const src = readFileSync(resolve(__dirname, n), 'utf8');
      expect(src.includes(RESET) && gapsOf(src).includes(m), gap).toBe(true);
    }
  });
});
