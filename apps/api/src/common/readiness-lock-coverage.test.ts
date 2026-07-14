import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Gate round-2 finding 1 — THE EXPLICIT COVERAGE LIST of readiness-input writers.
 *
 * The readiness derivation reads: Activity.gateMaterial / gateTeam / decisionId,
 * the linked Decision's status, linked Inspection rows (+ items), linked Drawing /
 * DrawingRevision / DrawingRecipient / DrawingAck rows, active Membership rows and
 * GateOverride rows. EVERY service that writes one of these inputs must either
 * take lockProjectReadiness inside its transaction, or be exempted HERE with a
 * reason a reviewer can check. A new writer that is not classified fails this
 * test — the protocol can no longer be extended silently (that is exactly how
 * flagMismatch was missed).
 */

const SRC = join(__dirname, '..');

/** Signatures that mean "this file writes a readiness input (or names one)". */
const WRITE_SIGNATURES: RegExp[] = [
  /gateMaterial|gateTeam/,
  /\.gateOverride\.(create|delete)/,
  /\.membership\.(create|update|upsert|delete)/,
  /\.drawingAck\.create/,
  /\.drawingRevision\.(create|update)/,
  /\.drawing\.(create|update|delete)/,
  /\.inspection\.(create|update)/,
  /\.inspectionItem\.(create|update)/,
  /\.decision\.update/,
];

/** file (relative to src) → 'locked' or the exemption reason. */
const COVERAGE: Record<string, 'locked' | string> = {
  'activities/activities.service.ts': 'locked',
  'daily-log/daily-log.service.ts': 'locked',
  'decisions/decisions.service.ts': 'locked',
  'drawings/drawings.service.ts': 'locked',
  'inspections/inspections.service.ts': 'locked',
  'orgs/members.service.ts': 'locked',
  'auth/auth.service.ts':
    'exempt: membership.create provisions a BRAND-NEW user, who cannot appear in any frozen recipient set or claim',
  'orgs/orgs.service.ts':
    'exempt: writes rows only inside a project being CREATED in the same transaction (creator membership, template copies) — no start can race rows that commit with the project',
  'nodes/nodes.service.ts':
    'exempt: unfiles inspection/decision nodeId on node deletion — location is not a readiness input',
  'snapshot/snapshot.service.ts': 'exempt: read-only serialization — names the gates, writes nothing',
};

function serviceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serviceFiles(p));
    else if (entry.name.endsWith('.service.ts') && !entry.name.includes('.test.')) out.push(p);
  }
  return out;
}

describe('readiness-lock coverage (gate round-2 finding 1)', () => {
  const files = serviceFiles(SRC);
  const writers = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return WRITE_SIGNATURES.some((re) => re.test(src));
  });

  it('every readiness-input writer is explicitly classified', () => {
    const unclassified = writers.map((f) => relative(SRC, f)).filter((rel) => !(rel in COVERAGE));
    expect(unclassified, `classify these writers in COVERAGE (locked or exempt-with-reason): ${unclassified.join(', ')}`).toEqual([]);
  });

  it('every LOCKED writer actually takes lockProjectReadiness', () => {
    const missing = Object.entries(COVERAGE)
      .filter(([, v]) => v === 'locked')
      .map(([rel]) => rel)
      .filter((rel) => !readFileSync(join(SRC, rel), 'utf8').includes('lockProjectReadiness'));
    expect(missing, `these files claim 'locked' but never call lockProjectReadiness: ${missing.join(', ')}`).toEqual([]);
  });

  it('no COVERAGE entry is stale (its file still exists and still writes)', () => {
    const stale = Object.keys(COVERAGE).filter((rel) => {
      try {
        const src = readFileSync(join(SRC, rel), 'utf8');
        return !WRITE_SIGNATURES.some((re) => re.test(src));
      } catch {
        return true; // file gone
      }
    });
    expect(stale, `remove or update stale COVERAGE entries: ${stale.join(', ')}`).toEqual([]);
  });
});
