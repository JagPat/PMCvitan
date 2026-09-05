// Usage: node scripts/benchmark-location-navigation.mjs <base-commit>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = 'apps/web/src/lib/locationTree.ts';
const baseRef = process.argv[2];
if (!baseRef) throw new Error('Supply the base commit to compare with the working tree.');
const ts = createRequire(new URL('../apps/web/package.json', import.meta.url))('typescript');
const load = async (source) => {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
};
const base = await load(execFileSync('git', ['show', `${baseRef}:${sourcePath}`], { cwd: root, encoding: 'utf8' }));
const current = await load(readFileSync(new URL(`../${sourcePath}`, import.meta.url), 'utf8'));
const medianMs = (fn) => {
  fn(); fn();
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now(); fn(); return performance.now() - start;
  }).sort((a, b) => a - b);
  return Number(samples[3].toFixed(3));
};

const nodes = Array.from({ length: 1_000 }, (_, i) => ({
  id: `n${i}`, parentId: null, name: `Room ${i}`, kind: 'room', order: i,
}));
const decisions = nodes.map((n, i) => ({ id: `d${i}`, nodeId: n.id, status: 'pending', room: '' }));
const grouping = (impl, input = nodes) => impl.groupDecisions(decisions, input, 'room');
assert.deepEqual(grouping(current), grouping(base));
const idReads = (impl) => {
  let reads = 0;
  const measured = nodes.map((n) => ({ ...n, get id() { reads += 1; return n.id; } }));
  grouping(impl, measured);
  return reads;
};

const places = Array.from({ length: 40 }, (_, i) => [
  { id: `z${i}`, parentId: null }, { id: `r${i}`, parentId: `z${i}` },
]).flat();
const ids = places.filter((n) => n.parentId === null).map((n) => n.id);
const photos = places.map((n) => ({ nodeId: n.id }));
const baseCards = (input = photos) => new Map(ids.map((id) => {
  const sub = base.subtreeIds(places, id);
  return [id, input.filter((p) => p.nodeId && sub.has(p.nodeId)).length];
}));
const currentCards = (input = photos) => new Map([...current.countPlaceSubtrees(places, ids, {
  decisions: [], drawings: [], photos: input, activities: [], materials: [],
})].map(([id, counts]) => [id, counts.photos]));
assert.deepEqual(currentCards(), baseCards());
const photoReads = (fn) => {
  let reads = 0;
  fn(photos.map((p) => ({ get nodeId() { reads += 1; return p.nodeId; } })));
  return reads;
};

console.log(JSON.stringify({
  runtime: process.version, base: baseRef,
  note: 'Synthetic helper benchmark; timings are medians of seven runs, not production page-load measurements.',
  grouping: {
    nodes: nodes.length, decisions: decisions.length,
    base: { nodeIdReads: idReads(base), medianMs: medianMs(() => grouping(base)) },
    current: { nodeIdReads: idReads(current), medianMs: medianMs(() => grouping(current)) },
  },
  siteMapCards: {
    cards: ids.length, nodes: places.length, photos: photos.length,
    base: { photoNodeIdReads: photoReads(baseCards), medianMs: medianMs(() => baseCards()) },
    current: { photoNodeIdReads: photoReads(currentCards), medianMs: medianMs(() => currentCards()) },
  },
}, null, 2));
