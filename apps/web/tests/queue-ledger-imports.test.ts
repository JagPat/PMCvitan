import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #1109 r2 (Codex 4366140122): the occurrence ledger is a leaf. L2 makes the queue key guard (and through it store.ts)
 * import the ledger, so the ledger, and every module it reaches at run time, must import neither of them nor anything
 * that does. Pinned as an allow-list over the source: any import not on it fails, whatever it is.
 */

type Edge = { from: string; to: string; typeOnly: boolean };

/** a module's imports, read from its source with comments taken out: static, re-exports, side-effect, dynamic, require, and
 * any `import.meta` (Vite's `import.meta.glob` loads modules no import names) */
function importsOf(file: string): Edge[] | { unparsed: string } {
  const src = readFileSync(resolve(__dirname, '..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const edges: Edge[] = [];
  for (const m of src.matchAll(/\b(import|export)\s+(type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g)) edges.push({ from: file, to: m[3], typeOnly: Boolean(m[2]) });
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) edges.push({ from: file, to: m[1], typeOnly: false });
  const dynamic = src.match(/\bimport\s*\(|\brequire\s*\(|\bimport\s*\.\s*meta\b/);
  return dynamic ? { unparsed: dynamic[0] } : edges;
}

const file = (spec: string) => (spec.startsWith('@/') ? `src/${spec.slice(2)}.ts` : spec);

/** the leaf's allow-list: what it may import, and whether only types */
const ALLOWED: Record<string, { to: string; typeOnly: boolean }[]> = {
  'src/store/queueLedger.ts': [
    { to: '@/data/apiGateway', typeOnly: true },
    { to: '@/store/queueActIdent', typeOnly: false },
  ],
  'src/store/queueActIdent.ts': [{ to: '@/data/apiGateway', typeOnly: true }],
};
/** the modules L2's wiring makes import the ledger: an edge into any of them would be a cycle */
const ORCHESTRATORS = ['src/store/queueKeyGuard.ts', 'src/store/store.ts'];

describe('the ledger is a leaf (#1109 r2, Codex 4366140122)', () => {
  it('imports only what its allow-list names, and every module it reaches at run time does too', () => {
    const seen = new Set<string>();
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      expect(ORCHESTRATORS, `${f} is reached from the ledger`).not.toContain(f);
      const got = importsOf(f);
      expect(got, `${f}: no dynamic import, require or import.meta`).not.toHaveProperty('unparsed');
      const edges = got as Edge[];
      expect(edges.map(({ to, typeOnly }) => ({ to, typeOnly })), `${f}: its imports`).toEqual(ALLOWED[f] ?? []);
      // a type-only import is erased at build: no run-time edge to follow
      for (const e of edges) if (!e.typeOnly) walk(file(e.to));
    };
    walk('src/store/queueLedger.ts');
    expect([...seen]).toEqual(['src/store/queueLedger.ts', 'src/store/queueActIdent.ts']);
  });
});
