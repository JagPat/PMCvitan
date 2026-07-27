#!/usr/bin/env node
// Regenerates src/labour/t3c/t3c-canonical-fn-bodies.generated.ts from the migration files.
//
// Round 3i (finding 1): a trigger seal must verify the bound function's BODY, because
// `CREATE OR REPLACE FUNCTION` preserves the function's identity — an exact-name/exact-tgtype
// trigger still bound to a PRE-correction body satisfies every catalog test while enforcing the
// old rule. `pg_proc.prosrc` stores the dollar-quoted body VERBATIM, so the canonical body for a
// seal is exactly the text between the dollar-quote tags in the migration that (last) defined it —
// and extracting it MECHANICALLY from those files removes hand-transcription as a failure mode.
// The deployed migrations are byte-frozen, so this extraction is stable; re-run this script only
// when the one editable migration (20270225000000) changes a function body.
//
//   node scripts/generate-t3c-fn-bodies.mjs
//
// The focused suite proves fidelity: `correctionSeals()` must answer `installed: true` on a fully
// migrated database, which fails if any pinned body differs from what `prisma migrate deploy`
// actually produces.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(API_DIR, 'prisma', 'migrations');

/** Migrations that define (or redefine) a sealed trigger function, in LAYER ORDER. */
const LAYERS = [
  '20261230000000_phase3_t5_stock_flows', // phase3_immutable_row (shared with Phase 3 tables)
  '20270210000000_phase4_t3_time_capacity',
  '20270215000000_phase4_t3_correction',
  '20270220000000_phase4_t3_correction2',
  '20270225000000_phase4_t3_correction3',
];

/** Only the functions bound to SEALED triggers / event triggers are pinned. */
const SEALED_FNS = new Set([
  'phase3_immutable_row',
  'phase4_t3_allocation_frozen',
  'phase4_t3_attendance_append_only',
  'phase4_t3_skill_substitution_append_only',
  'phase4_t3_work_matches_allocation',
  'phase4_t3_allocation_worker_active',
  'phase4_t3_attendance_device_bound',
  'phase4_t3_allocation_within_commitment',
  'phase4_t3c_allocation_head_live',
  'phase4_t3c3_attendance_reserved_marker',
  'phase4_t3c3_allocation_project_lock',
  'phase4_t3c_repair_action_append_only',
  'phase4_t3c_repair_action_no_truncate',
  'phase4_t3c_repair_action_path',
  'phase4_t3c_evidence_drop_guard',
  'phase4_t3c_evidence_alter_guard',
]);

const RX = /CREATE OR REPLACE FUNCTION (\w+)\(\) RETURNS (?:event_)?trigger AS (\$\w*\$)/g;

/** fn -> [{ layer, body }] in layer order */
const versions = new Map();

for (const layer of LAYERS) {
  const sql = readFileSync(join(MIG_DIR, layer, 'migration.sql'), 'utf8');
  RX.lastIndex = 0;
  let m;
  while ((m = RX.exec(sql)) !== null) {
    const [, fn, tag] = m;
    if (!SEALED_FNS.has(fn)) continue;
    const start = m.index + m[0].length;
    const end = sql.indexOf(tag, start);
    if (end < 0) throw new Error(`${layer}: unterminated ${tag} body for ${fn}`);
    const body = sql.slice(start, end);
    if (!versions.has(fn)) versions.set(fn, []);
    const list = versions.get(fn);
    // A migration may define the same fn once only; later layers append a new version.
    if (list.some((v) => v.layer === layer)) throw new Error(`${layer} defines ${fn} twice`);
    list.push({ layer, body });
  }
}

for (const fn of SEALED_FNS) {
  if (!versions.has(fn)) throw new Error(`no migration defines sealed function ${fn}`);
}

const entries = [...versions.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([fn, list]) => {
    const versionLines = list
      .map((v) => `    { layer: '${v.layer}', body: ${JSON.stringify(v.body)} },`)
      .join('\n');
    return `  ${fn}: [\n${versionLines}\n  ],`;
  })
  .join('\n');

const out = `// GENERATED FILE — do not edit by hand. Regenerate with:
//   node scripts/generate-t3c-fn-bodies.mjs
//
// The canonical \`pg_proc.prosrc\` body of every sealed trigger / event-trigger function, per
// DEFINING MIGRATION in layer order (oldest first). \`CREATE OR REPLACE FUNCTION\` preserves a
// function's identity, so a seal that stops at the bound function's NAME accepts a trigger still
// enforcing a PRE-correction body; the seal therefore compares \`prosrc\` against these pinned
// texts. Multiple versions exist exactly where a later re-runnable correction replaced a body —
// which version a given LAYER requires is decided by the seal specification in
// \`t3c-diagnostics.ts\`, not here.
//
// prosrc stores the dollar-quoted body VERBATIM (no normalization), so byte equality with the
// migration text is exact. Fidelity is proven by the focused suite: \`correctionSeals()\` must
// answer installed on a fully migrated database.

export interface T3CFnBodyVersion {
  /** The migration directory that wrote this body. */
  readonly layer: string;
  /** The exact text between the dollar-quote tags — byte-for-byte \`pg_proc.prosrc\`. */
  readonly body: string;
}

export const T3C_CANONICAL_FN_BODIES: Readonly<Record<string, readonly T3CFnBodyVersion[]>> = {
${entries}
};

/** Every pinned body of one function (any layer). */
export function t3cFnBodies(fn: string): readonly string[] {
  const versions = T3C_CANONICAL_FN_BODIES[fn];
  if (!versions?.length) throw new Error(\`no canonical body pinned for function \${fn}\`);
  return versions.map((v) => v.body);
}

/** The body one specific migration wrote for one function. */
export function t3cFnBodyAt(fn: string, layer: string): string {
  const hit = T3C_CANONICAL_FN_BODIES[fn]?.find((v) => v.layer === layer);
  if (!hit) throw new Error(\`no canonical body pinned for \${fn} at \${layer}\`);
  return hit.body;
}
`;

const target = join(API_DIR, 'src', 'labour', 't3c', 't3c-canonical-fn-bodies.generated.ts');
writeFileSync(target, out);
const summary = [...versions.entries()]
  .map(([fn, list]) => `${fn}: ${list.map((v) => v.layer.slice(0, 8)).join(' -> ')}`)
  .join('\n');
console.log(`wrote ${target}\n${summary}`);
