import { describe, it, expect } from 'vitest';
import { diffSnapshots, type TableSnapshot } from './db-snapshot';

const t = (keys: string[], key: string[] | null = ['id']): TableSnapshot => ({ rows: keys.length, key, keys });

/** #482 — the comparison of two snapshots is the deletion record: it must name every changed key. */
describe('diffSnapshots', () => {
  it('lists exactly the keys removed and added, and skips unchanged tables', () => {
    const before = { tables: { A: t(['["1"]', '["2"]', '["3"]']), B: t(['["x"]']) } };
    const after = { tables: { A: t(['["1"]', '["4"]']), B: t(['["x"]']) } };
    expect(diffSnapshots(before, after)).toEqual([{ table: 'A', removed: ['["2"]', '["3"]'], added: ['["4"]'] }]);
  });

  it('counts repeats, so one of two identical rows without a primary key going is seen', () => {
    const before = { tables: { N: t(['h1', 'h1', 'h2'], null) } };
    const after = { tables: { N: t(['h1', 'h2'], null) } };
    expect(diffSnapshots(before, after)).toEqual([{ table: 'N', removed: ['h1'], added: [] }]);
  });

  it('names a table present in only one snapshot, even an empty one', () => {
    const before = { tables: { Gone: t([]), Kept: t(['["1"]']) } };
    const after = { tables: { Kept: t(['["1"]']), New: t(['["9"]']) } };
    expect(diffSnapshots(before, after)).toEqual([
      { table: 'Gone', removed: [], added: [], onlyIn: 'before' },
      { table: 'New', removed: [], added: ['["9"]'], onlyIn: 'after' },
    ]);
  });

  it('treats a table named like an inherited property as a table', () => {
    const before = { tables: Object.assign(Object.create(null), { ['__proto__']: t(['["1"]']), constructor: t(['["1"]']) }) };
    const after = { tables: Object.assign(Object.create(null), { constructor: t([]) }) };
    expect(diffSnapshots(before, after)).toEqual([
      { table: '__proto__', removed: ['["1"]'], added: [], onlyIn: 'before' },
      { table: 'constructor', removed: ['["1"]'], added: [] },
    ]);
  });
});
