import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4b — the WRITER SWEEP §A.2 "The finality key, stated exactly"
 * requires: every INSERT site on the two requirement spec tables STATES `revisionFinalized`.
 *
 * The column is the finality carrier of a spec's decision provenance: the composite FK targets the
 * approval register's widened key `(…, finalized)`. 4d-i kept its default (`true`) for the drain, and
 * 4d-iii drops it. A writer that leaves it out keeps working today only because the Prisma client
 * fills in the schema's `@default(true)` on its own; the moment 4d-iii removes that default, the
 * writer fails — and a cancellation copy that dropped the value would silently re-assert `true`
 * rather than carry the head's. So each site is found here and must name the column.
 *
 * THE ENUMERATION IS PINNED, as `audit.test.ts` pins the audit writers: a new INSERT site on either
 * table is a visible diff here, whether or not it states the column.
 */
const API = join(__dirname, '..', '..');
const ROOTS = ['src', 'prisma'];

/** A write to one of the two spec delegates, or a raw INSERT into either table. */
const SITE = /\.(materialRequirementSpec|labourRequirementSpec)\.(create|createMany|upsert)\s*\(|INSERT\s+INTO\s+"(MaterialRequirementSpec|LabourRequirementSpec)"/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'migrations') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** The text of the call starting at `from`: up to its balanced closing parenthesis. */
function callText(src: string, from: number): string {
  const open = src.indexOf('(', from);
  if (open < 0) return src.slice(from, from + 400); // a raw INSERT string: judge its statement
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}

const sites = ROOTS.flatMap((r) => walk(join(API, r))).flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(SITE)].map((m) => ({
    file: relative(API, file).split('\\').join('/'),
    call: m[0],
    text: callText(src, m.index!),
  }));
});

describe('4d-ii-a / A4b — every requirement spec writer states the finality carrier', () => {
  it('the INSERT sites on the two spec tables are exactly the four reviewed writers', () => {
    expect(sites.map((s) => `${s.file} ${s.call.replace(/\s+/g, ' ').replace(/\s*\($/, '')}`).sort()).toEqual([
      // create/revise (the widened approvedRef spread) and the cancellation copy
      'src/activities/requirements.service.ts .materialRequirementSpec.create',
      'src/activities/requirements.service.ts .materialRequirementSpec.create',
      // `writeRequirementSpec` (create/revise) and `copyRequirementSpecForCancel`
      'src/labour/labour.participant.ts .labourRequirementSpec.create',
      'src/labour/labour.participant.ts .labourRequirementSpec.create',
    ]);
  });

  it('each of them names `revisionFinalized` — never left to the column default 4d-iii drops', () => {
    const silent = sites.filter((s) => !/revisionFinalized/.test(s.text)).map((s) => `${s.file}: ${s.text.slice(0, 120)}`);
    expect(silent).toEqual([]);
  });
});
