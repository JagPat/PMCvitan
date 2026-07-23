import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Gate round-2 finding 1 — FILE-LEVEL coverage tripwire for readiness-input writers.
 *
 * The readiness derivation reads: Activity.gateMaterial / gateTeam / decisionId,
 * the linked Decision's status, linked Inspection rows (+ items), linked Drawing /
 * DrawingRevision / DrawingRecipient / DrawingAck rows, active Membership rows and
 * GateOverride rows. EVERY service FILE that writes one of these inputs must either
 * take lockProjectReadiness, or be exempted HERE with a reason a reviewer can check.
 * A new writer file that is not classified fails this test — a whole service can no
 * longer skip the protocol silently (that is exactly how flagMismatch was missed).
 *
 * Honest scope (round-2 re-review note): this is a FILE-level check. It cannot
 * catch a new unlocked METHOD added to a file that already locks elsewhere —
 * per-writer correctness remains the job of the live-PostgreSQL race probes
 * (start-readiness-race and friends) and code review.
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
  // (snapshot/snapshot.service.ts no longer names a gate: Task 10 Module 4 moved the activity-spine
  // serialization into the activities module — activities-serialize.ts is read-only bake code outside
  // this tripwire's writer scan, and the query service reads under no lock by design.)
  // Task 7 — the workflow participants are LEAF providers with no lock of their own:
  // they write a readiness input on the CALLER'S transaction, and every readiness-
  // affecting caller takes lockProjectReadiness before invoking them.
  'activities/activity.participant.ts':
    'exempt: writes gateMaterial/status on the CALLER\'s transaction — the readiness-affecting callers (inspections.decide sign-off/revert, daily-log.flagMismatch block, daily-log.resolveMismatch unblock) hold lockProjectReadiness first',
  'inspections/inspection.participant.ts':
    'exempt: createClosingInspection runs in activities.complete\'s transaction (unlocked, exactly as that closing-inspection create always was — the file-level tolerance below); createForInit runs during project creation (see the orgs exemption)',
  // Module 4 correction — the SET NULL owner-signal participant.
  'drawings/drawing.participant.ts':
    'exempt: unlinkFromDeletedActivity clears Drawing.activityId ONLY for drawings linked to the activity DELETED in the same transaction (no surviving activity\'s drawing gate can observe the unlink); unfileForDeletedNodes writes Drawing.nodeId, which is not a readiness input (the gate reads the activityId link + revisions/recipients/acks)',
};

/** service + Task-7 workflow-participant files (both can persist a readiness input). */
function serviceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serviceFiles(p));
    else if ((entry.name.endsWith('.service.ts') || entry.name.endsWith('.participant.ts')) && !entry.name.includes('.test.')) out.push(p);
  }
  return out;
}

describe('readiness-lock FILE-LEVEL coverage tripwire (gate round-2 finding 1)', () => {
  const files = serviceFiles(SRC);
  const writers = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return WRITE_SIGNATURES.some((re) => re.test(src));
  });

  it('every readiness-input writer is explicitly classified', () => {
    const unclassified = writers.map((f) => relative(SRC, f)).filter((rel) => !(rel in COVERAGE));
    expect(unclassified, `classify these writers in COVERAGE (locked or exempt-with-reason): ${unclassified.join(', ')}`).toEqual([]);
  });

  it('every LOCKED writer file calls lockProjectReadiness somewhere in the file', () => {
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

/**
 * Phase 3 Task 6 — the §A COMMAND-LEVEL lock-coverage enumeration.
 *
 * The plan's §A lock-coverage table names EXACTLY the commands whose transaction must take
 * `lockProjectReadiness` (they change what `coverageFor` returns, so they serialize against
 * `activities.start`). This closes the file-level tripwire's honest gap: an uncovered NEW command
 * added to a file that locks ELSEWHERE is now a failing test, not a review finding. Each entry is
 * verified by extracting the METHOD body and asserting it takes the lock.
 */
const SECTION_A_COMMANDS: Array<{ label: string; file: string; method: string }> = [
  { label: 'activities.start', file: 'activities/activities.service.ts', method: 'start' },
  { label: 'requirement.create', file: 'activities/requirements.service.ts', method: 'create' },
  { label: 'requirement.revise', file: 'activities/requirements.service.ts', method: 'revise' },
  { label: 'requirement.cancel', file: 'activities/requirements.service.ts', method: 'cancel' },
  { label: 'substitution.approve', file: 'activities/substitutions.service.ts', method: 'approve' },
  { label: 'substitution.revoke', file: 'activities/substitutions.service.ts', method: 'revoke' },
  { label: 'delivery.commit', file: 'procurement/purchase-orders.service.ts', method: 'commitDelivery' },
  { label: 'delivery.revise', file: 'procurement/purchase-orders.service.ts', method: 'reviseDelivery' },
  { label: 'delivery.default', file: 'procurement/purchase-orders.service.ts', method: 'defaultDelivery' },
  { label: 'receipt.acceptance', file: 'inventory/inventory.service.ts', method: 'accept' },
  { label: 'receipt.rejection', file: 'inventory/inventory.service.ts', method: 'reject' },
  { label: 'transfer', file: 'inventory/inventory.service.ts', method: 'transfer' },
  { label: 'reservation.create', file: 'inventory/inventory.service.ts', method: 'reserve' },
  { label: 'reservation.release', file: 'inventory/inventory.service.ts', method: 'release' },
  { label: 'issue', file: 'inventory/inventory.service.ts', method: 'issue' },
  { label: 'site-return', file: 'inventory/inventory.service.ts', method: 'siteReturn' },
  { label: 'consumption', file: 'inventory/inventory.service.ts', method: 'consume' },
  { label: 'wastage', file: 'inventory/inventory.service.ts', method: 'wastage' },
  { label: 'adjustment', file: 'inventory/inventory.service.ts', method: 'adjust' },
  { label: 'mismatch.resolution', file: 'daily-log/daily-log.service.ts', method: 'resolveMismatch' },
  // Phase 3 Task 6 correction (F4): close-short and fulfil REMOVE a PO line's inbound coverage
  // (the at-risk determination reads it), so both join the §A readiness-lock protocol.
  { label: 'delivery.fulfill', file: 'procurement/purchase-orders.service.ts', method: 'fulfillDelivery' },
  { label: 'po.close-short', file: 'procurement/purchase-orders.service.ts', method: 'closeShort' },
];

/** The body of `async <method>(` up to the next same-indent `async ` (or end of file). */
function methodBody(src: string, method: string): string | null {
  const start = src.indexOf(`async ${method}(`);
  if (start === -1) return null;
  const next = src.indexOf('\n  async ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('readiness-lock §A COMMAND-LEVEL coverage (Phase 3 Task 6)', () => {
  for (const cmd of SECTION_A_COMMANDS) {
    it(`${cmd.label} takes lockProjectReadiness in its command transaction`, () => {
      const src = readFileSync(join(SRC, cmd.file), 'utf8');
      const body = methodBody(src, cmd.method);
      expect(body, `${cmd.file}#${cmd.method} not found — the §A command enumeration drifted from the code`).not.toBeNull();
      expect(
        body!.includes('lockProjectReadiness'),
        `${cmd.label} (${cmd.file}#${cmd.method}) must take lockProjectReadiness (§A lock-coverage table)`,
      ).toBe(true);
    });
  }

  it('enumerates every command in the §A lock-coverage table (22 commands)', () => {
    // A mechanical guard on completeness: the table has 22 rows across activities/procurement/
    // inventory/daily-log (Task 6 correction added delivery.fulfill + po.close-short — both remove
    // inbound coverage). Adding a §A command without listing it here is a visible, reviewed change.
    expect(SECTION_A_COMMANDS).toHaveLength(22);
  });
});
