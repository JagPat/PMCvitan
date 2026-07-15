import { describe, it, expect } from 'vitest';
// The store's and gateway's own source text, read via Vite's `?raw` loader — the
// same source-scan technique snapshot-ordering.test.ts uses for its tripwire.
import storeSource from '@/store/store.ts?raw';
import apiGatewaySource from '@/data/apiGateway.ts?raw';

/**
 * Phase 2 Task 1 — CHARACTERIZATION of the frontend ↔ API snapshot contract.
 *
 * Today the client hydrates from ONE full-project snapshot: `ApiSnapshot`
 * (apps/web/src/data/apiGateway.ts) carries every collection, and
 * `applySnapshotCore` in the store REPLACES every project-scoped field from it in
 * a single pass. Phase 2 Task 9 replaces this with a project-shell summary +
 * per-module queries — but it "may not silently break" this contract.
 *
 * This test pins the EXACT top-level key set the client declares (`ApiSnapshot`)
 * and the EXACT set the copier consumes (`applySnapshotCore` reads `snap.<key>`),
 * rejecting BOTH a dropped/renamed key AND a newly-added one, and isolating the
 * copier body so an unrelated `snap.` reference elsewhere in the store cannot mask
 * a drift. The server-side per-role/author gating is characterized separately by
 * the live-PostgreSQL suite (apps/api/test/integration/phase2-snapshot-shape.test.ts).
 *
 * When a task adds/drops a snapshot key, update SNAPSHOT_KEYS here in the same PR.
 */

// The 16 top-level keys of the project snapshot at Task 1 (SnapshotDto,
// apps/api/src/snapshot/types.ts:291-318; ApiSnapshot, apiGateway.ts:40-77).
const SNAPSHOT_KEYS = [
  'project',
  'decisions',
  'activities',
  'placedInspections',
  'checklist',
  'reviews',
  'review',
  'reinspectionCreated',
  'drawings',
  'phases',
  'dailyLog',
  'notifications',
  'companies',
  'nodes',
  'photos',
  'materials',
].sort();

// The 16 sub-keys of the inline `project` object (ProjectMetaDto / ApiSnapshot.project).
const PROJECT_KEYS = [
  'id', 'name', 'short', 'descriptor', 'scheduleStartDate', 'scheduleEndDate',
  'timeZone', 'stage', 'siteCode', 'location', 'projStart', 'projEnd',
  'elapsedPct', 'todayDay', 'milestonePct',
].sort();

/** Strip line + block comments so identifiers inside them are not read as keys. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The depth-1 property keys of `export interface <name> { ... }`, by brace-depth
 * scan — nested object types (e.g. `project: { ... }`, inline `{ id; ... }[]`)
 * contribute NOTHING, so the result is exactly the top-level members.
 */
function interfaceKeys(src: string, name: string): string[] {
  const clean = stripComments(src);
  const open = clean.match(new RegExp(`export interface ${name}\\s*\\{`));
  if (!open) throw new Error(`interface ${name} not found`);
  const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
  const keys: string[] = [];
  let depth = 1;
  let i = open.index! + open[0].length;
  while (i < clean.length && depth > 0) {
    const c = clean[i];
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (depth === 1 && isIdent(c) && (i === 0 || !isIdent(clean[i - 1]))) {
      let j = i;
      while (j < clean.length && isIdent(clean[j])) j++;
      const word = clean.slice(i, j);
      let k = j;
      while (k < clean.length && /\s/.test(clean[k])) k++;
      if (clean[k] === '?') { k++; while (/\s/.test(clean[k])) k++; }
      if (clean[k] === ':') keys.push(word);
      i = j;
      continue;
    }
    i++;
  }
  return keys;
}

/** The `{ ... }` body of `<name>`'s arrow function, isolated by brace-matching. */
function functionBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name}`);
  if (at < 0) throw new Error(`${name} not found`);
  const arrow = src.indexOf('=>', at);
  const open = src.indexOf('{', arrow);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name} body not closed`);
}

describe('Phase 2 Task 1 — snapshot shape (client contract)', () => {
  it('the ApiSnapshot interface declares EXACTLY the pinned top-level keys (no extra, none missing)', () => {
    expect(interfaceKeys(apiGatewaySource, 'ApiSnapshot').sort()).toEqual(SNAPSHOT_KEYS);
  });

  it('the inline project object declares EXACTLY the pinned project sub-keys', () => {
    const clean = stripComments(apiGatewaySource);
    const block = clean.match(/project:\s*\{([\s\S]*?)\n {2}\};/);
    expect(block, 'inline `project` object not found in ApiSnapshot').toBeTruthy();
    const keys = [...block![1].matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(PROJECT_KEYS);
  });

  it('applySnapshotCore consumes EXACTLY the pinned snapshot keys (isolated to the copier body)', () => {
    const body = functionBody(storeSource, 'applySnapshotCore');
    const consumed = [...new Set([...body.matchAll(/\bsnap\.(\w+)/g)].map((m) => m[1]))].sort();
    // Every top-level key is read (project via snap.project.*, review as the
    // reviews fallback); a new/dropped key must move this set in the same PR.
    expect(consumed, 'applySnapshotCore reads a different top-level key set than ApiSnapshot declares').toEqual(SNAPSHOT_KEYS);
  });

  it('applySnapshotCore remains the single snapshot copier the coordinator routes through', () => {
    const defs = storeSource.match(/const applySnapshotCore\b/g) ?? [];
    expect(defs.length, 'applySnapshotCore should be defined exactly once').toBe(1);
  });
});
