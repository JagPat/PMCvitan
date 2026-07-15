import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import type { Role } from '../../src/common/auth';

/**
 * Phase 2 Task 1 — CHARACTERIZATION (live PostgreSQL) of the snapshot's top-level
 * shape, per-role gating, AUTHOR-PRIVATE draft delivery, and — the focus of the
 * Codex Task-1 re-review (finding 4) — the EXACT nested per-key shape + nullability
 * of ALL 16 top-level keys.
 *
 * Two layers, both exact:
 *   • a SOURCE SCAN of apps/api/src/snapshot/types.ts pins every DTO's declared
 *     key set, optional (`?`) keys, and nullable (`| null`) keys — a change to any
 *     DTO in types.ts fails here until this test is updated in the same PR;
 *   • a RUNTIME CONFORMANCE check builds a fully-populated snapshot and asserts each
 *     serialized object carries EXACTLY the declared keys (no extras, all required
 *     present) with nulls only where the type permits them.
 *
 * Phase 2 Task 9 replaces the full snapshot with a shell summary + per-module
 * queries + projections; it must reproduce every line pinned here.
 */

const TYPES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/snapshot/types.ts'), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

type Spec = { keys: string[]; optional: string[]; nullable: string[] };

/** Depth-1 members of `export interface <name>` → sorted keys / optional / nullable. */
function interfaceSpec(name: string): Spec {
  const src = stripComments(TYPES);
  const open = src.match(new RegExp(`export interface ${name}\\s*\\{`));
  if (!open) throw new Error(`interface ${name} not found`);
  let depth = 1;
  let i = open.index! + open[0].length;
  const start = i;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  const body = src.slice(start, i - 1);
  const keys: string[] = [];
  const optional: string[] = [];
  const nullable: string[] = [];
  let d = 0;
  let j = 0;
  const isId = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (j < body.length) {
    const c = body[j];
    if ('{(['.includes(c)) { d++; j++; continue; }
    if ('})]'.includes(c)) { d--; j++; continue; }
    if (d === 0 && /[A-Za-z_$]/.test(c) && (j === 0 || !isId(body[j - 1]))) {
      let e = j;
      while (e < body.length && isId(body[e])) e++;
      const key = body.slice(j, e);
      let k = e;
      while (k < body.length && /\s/.test(body[k])) k++;
      let opt = false;
      if (body[k] === '?') { opt = true; k++; while (/\s/.test(body[k])) k++; }
      if (body[k] === ':') {
        // read the member's type text up to the depth-0 terminator, keeping ONLY the
        // top-level (depth-0) characters — so a `| null` inside a nested object type
        // (e.g. checklist `items: { state: string | null }[]`) never marks the member nullable.
        let t = k + 1;
        let td = 0;
        let top = '';
        for (; t < body.length; t++) {
          const tc = body[t];
          if (td === 0 && (tc === ';' || tc === '\n')) break;
          if ('})]'.includes(tc)) { td--; continue; }
          if ('{(['.includes(tc)) { td++; continue; }
          if (td === 0) top += tc;
        }
        keys.push(key);
        if (opt) optional.push(key);
        if (/\bnull\b/.test(top)) nullable.push(key);
        j = t;
        continue;
      }
      j = e;
      continue;
    }
    j++;
  }
  return { keys: keys.sort(), optional: optional.sort(), nullable: nullable.sort() };
}

/** Assert a runtime object carries EXACTLY the declared keys, with nulls only where allowed. */
function assertRuntimeShape(obj: Record<string, unknown>, spec: Spec, label: string): void {
  const declared = new Set(spec.keys);
  const optional = new Set(spec.optional);
  const nullable = new Set(spec.nullable);
  for (const k of Object.keys(obj)) expect(declared.has(k), `${label}: runtime carries undeclared key "${k}"`).toBe(true);
  for (const k of spec.keys) if (!optional.has(k)) expect(k in obj, `${label}: required key "${k}" missing at runtime`).toBe(true);
  for (const [k, v] of Object.entries(obj)) {
    if (v === null) expect(nullable.has(k), `${label}: key "${k}" is null but the type forbids null`).toBe(true);
    else if (!nullable.has(k) && !optional.has(k)) expect(v, `${label}: required non-null key "${k}" is undefined`).toBeDefined();
  }
}

// ── The EXPECTED source shape of every DTO (a tripwire on types.ts) ──
const EXPECT: Record<string, Spec> = {
  ProjectMetaDto: {
    keys: ['id', 'name', 'short', 'descriptor', 'stage', 'siteCode', 'location', 'projStart', 'projEnd', 'scheduleStartDate', 'scheduleEndDate', 'timeZone', 'elapsedPct', 'todayDay', 'milestonePct'].sort(),
    optional: [], nullable: ['scheduleStartDate', 'scheduleEndDate'].sort(),
  },
  DecisionDto: {
    keys: ['id', 'title', 'room', 'nodeId', 'status', 'ageDays', 'photoSwatch', 'options', 'approvedOption', 'material', 'approver', 'date', 'cost', 'onBehalfOf', 'changeRequest', 'draft'].sort(),
    optional: ['nodeId', 'ageDays', 'approvedOption', 'material', 'approver', 'date', 'cost', 'onBehalfOf', 'changeRequest', 'draft'].sort(), nullable: [],
  },
  OptionDto: { keys: ['label', 'key', 'material', 'delta', 'swatch', 'photoUrl', 'recommended'].sort(), optional: ['photoUrl'], nullable: [] },
  ActivityDto: {
    keys: ['id', 'name', 'zone', 'decisionId', 'phaseId', 'nodeId', 'ps', 'pe', 'as', 'ae', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate', 'status', 'gm', 'gt', 'gi', 'block', 'readiness', 'overrides'].sort(),
    optional: ['nodeId', 'block'].sort(),
    nullable: ['decisionId', 'phaseId', 'as', 'ae', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate'].sort(),
  },
  GateReadingDto: { keys: ['v', 'source', 'reason'].sort(), optional: [], nullable: [] },
  ActivityReadinessDto: { keys: ['decision', 'material', 'team', 'inspection', 'drawing'].sort(), optional: [], nullable: [] },
  GateOverrideDto: { keys: ['id', 'gate', 'state', 'reason', 'actorName', 'expiresAt', 'evidenceMediaId'].sort(), optional: ['evidenceMediaId'], nullable: [] },
  PlacedInspectionDto: { keys: ['id', 'title', 'zone', 'nodeId', 'kind', 'submitted', 'decided', 'failedItems'].sort(), optional: ['nodeId'], nullable: [] },
  PhaseDto: {
    keys: ['id', 'name', 'order', 'plannedStart', 'plannedEnd', 'plannedStartDate', 'plannedEndDate', 'activityTotal', 'done', 'inProgress', 'blocked', 'notStarted', 'donePct'].sort(),
    optional: [], nullable: ['plannedStartDate', 'plannedEndDate'].sort(),
  },
  ChecklistDto: { keys: ['id', 'title', 'zone', 'nodeId', 'date', 'submitted', 'items'].sort(), optional: ['nodeId'], nullable: [] },
  ReviewDto: {
    keys: ['id', 'title', 'zone', 'nodeId', 'by', 'date', 'decided', 'reinspectionOfId', 'closing', 'activityId', 'activityName', 'items'].sort(),
    optional: ['nodeId', 'reinspectionOfId', 'closing', 'activityId', 'activityName'].sort(), nullable: [],
  },
  MaterialDto: { keys: ['id', 'name', 'qty', 'zone', 'matched', 'swatch', 'decisionId', 'nodeId'].sort(), optional: ['decisionId', 'nodeId'].sort(), nullable: [] },
  DrawingAckDto: { keys: ['userName', 'role', 'at'].sort(), optional: [], nullable: [] },
  DrawingRecipientDto: { keys: ['userName', 'role', 'acked'].sort(), optional: [], nullable: [] },
  DrawingRevisionDto: {
    keys: ['id', 'rev', 'status', 'mime', 'url', 'sizeBytes', 'note', 'issuedBy', 'issuedAt', 'acks', 'recipientsFrozenAt', 'recipients'].sort(),
    optional: [], nullable: ['recipientsFrozenAt'],
  },
  DrawingDto: {
    keys: ['id', 'number', 'title', 'discipline', 'zone', 'activityId', 'decisionId', 'nodeId', 'draft', 'current', 'ackedByMe', 'recipientOfCurrent', 'revisions'].sort(),
    optional: ['nodeId', 'draft', 'recipientOfCurrent'].sort(), nullable: ['zone', 'activityId', 'decisionId', 'current'].sort(),
  },
  PhotoDto: { keys: ['id', 'url', 'takenAt', 'nodeId', 'kind'].sort(), optional: ['takenAt', 'nodeId'].sort(), nullable: [] },
  DailyLogDto: { keys: ['date', 'logDate', 'checkedIn', 'checkinTime', 'submitted', 'crew', 'materials', 'progress', 'photos'].sort(), optional: [], nullable: ['logDate', 'checkinTime'].sort() },
  CompanyDto: { keys: ['id', 'name', 'kind', 'contactName', 'contactEmail', 'contactPhone', 'notes'].sort(), optional: [], nullable: [] },
  NodeDto: { keys: ['id', 'parentId', 'name', 'kind', 'order', 'draft'].sort(), optional: ['draft'], nullable: ['parentId'] },
  SnapshotDto: {
    keys: ['project', 'decisions', 'activities', 'placedInspections', 'checklist', 'reviews', 'review', 'reinspectionCreated', 'drawings', 'phases', 'dailyLog', 'notifications', 'companies', 'nodes', 'photos', 'materials'].sort(),
    optional: [], nullable: ['checklist', 'review', 'dailyLog'].sort(),
  },
};

// Inline (non-interface) element shapes — pinned literally + verified at runtime.
const INLINE = {
  notification: ['color', 'text', 'time'],
  checklistItem: ['evidence', 'id', 'name', 'note', 'photos', 'state'],
  reviewItem: ['evidence', 'id', 'name', 'note', 'rejected', 'result', 'swatch'],
  crew: ['count', 'trade'],
  dailyLogMaterial: ['decisionId', 'matched', 'name', 'photo', 'qty', 'swatch', 'zone'],
  dailyLogPhoto: ['id', 'takenAt', 'url'], // takenAt optional
};
const assertInline = (obj: Record<string, unknown>, expected: string[], label: string, optional: string[] = []) => {
  const exp = new Set(expected);
  const opt = new Set(optional);
  for (const k of Object.keys(obj)) expect(exp.has(k), `${label}: undeclared key "${k}"`).toBe(true);
  for (const k of expected) if (!opt.has(k)) expect(k in obj, `${label}: required key "${k}" missing`).toBe(true);
};

const ALL_ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant'];

describe('Phase 2 Task 1 — snapshot shape, gating, drafts & exact nested DTOs (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshots: SnapshotService;
  let s: (label: string) => string;
  let PENDING_ID: string, APPROVED_ID: string, NODE_ID: string, INSP_ID: string, ACT_ID: string, DWG_ID: string, REV_ID: string;
  let DRAFT_DEC: string, DRAFT_DWG: string, DRAFT_NODE: string;
  const STRANGER = 'p2-stranger-not-author';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshots = t.app.get(SnapshotService);
    const pid = f.projectA.id;
    const uid = f.memberUser.id;
    s = (label: string) => `${label}-${pid.slice(-8)}`;
    PENDING_ID = s('p2-dl-pending'); APPROVED_ID = s('p2-dl-approved'); NODE_ID = s('p2-zone');
    INSP_ID = s('p2-insp'); ACT_ID = s('p2-act'); DWG_ID = s('p2-dwg'); REV_ID = s('p2-rev');
    DRAFT_DEC = s('p2-draft-dec'); DRAFT_DWG = s('p2-draft-dwg'); DRAFT_NODE = s('p2-draft-node');

    await t.prisma.decision.create({ data: { id: PENDING_ID, projectId: pid, title: 'Flooring', room: 'Living', photoSwatch: 'marble', status: 'pending', publishedAt: new Date(), authorId: uid } });
    await t.prisma.decision.create({ data: { id: APPROVED_ID, projectId: pid, title: 'Veneer', room: 'Study', photoSwatch: 'teak', status: 'approved', publishedAt: new Date(), authorId: uid, approvedOption: 'Teak', material: 'Teak', approver: 'Client', date: '2026-06-01', cost: 0 } });
    await t.prisma.decisionOption.create({ data: { decisionId: APPROVED_ID, label: 'Teak', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'teak', order: 0, photoUrl: 'x' } });

    await t.prisma.projectNode.create({ data: { id: NODE_ID, projectId: pid, name: 'Ground Floor', kind: 'zone', order: 0, publishedAt: new Date() } });
    // a placed, submitted-but-undecided REVIEW → a pmc review + a pmc/engineer placed inspection
    await t.prisma.inspection.create({ data: { id: INSP_ID, projectId: pid, kind: 'review', title: 'Slab check', zone: 'Ground Floor', date: '', submitted: true, decided: false, closing: false, nodeId: NODE_ID } });
    await t.prisma.inspectionItem.create({ data: { inspectionId: INSP_ID, name: 'Level', state: 'pass', order: 0 } });
    // an open CHECKLIST (submitted:false) → snapshot.checklist non-null with items[]
    await t.prisma.inspection.create({ data: { id: s('p2-cl'), projectId: pid, kind: 'checklist', title: 'Rebar', zone: 'GF', date: '', submitted: false, decided: false, closing: false } });
    await t.prisma.inspectionItem.create({ data: { inspectionId: s('p2-cl'), name: 'Spacing', state: null, order: 0 } });
    // an activity (linked decision + node) → exercises the five-gate readiness DTO
    await t.prisma.activity.create({ data: { id: ACT_ID, projectId: pid, name: 'Slab', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 5, decisionId: APPROVED_ID, nodeId: NODE_ID } });
    // a project phase → PhaseDto rollup
    await t.prisma.phase.create({ data: { id: s('p2-phase'), projectId: pid, name: 'Foundation', order: 0 } });
    // a published drawing with a governing for_construction revision + a frozen recipient + an ack
    await t.prisma.drawing.create({ data: { id: DWG_ID, projectId: pid, number: 'A-100', title: 'GA', discipline: 'architectural', nodeId: NODE_ID, publishedAt: new Date(), authorId: uid } });
    await t.prisma.drawingRevision.create({ data: { id: REV_ID, projectId: pid, drawingId: DWG_ID, rev: 'A', status: 'for_construction', mime: 'application/pdf', issuedBy: 'PMC', issuedAt: '2026-06-01', recipientsFrozenAt: new Date() } });
    await t.prisma.drawingRecipient.create({ data: { projectId: pid, revisionId: REV_ID, userId: uid, roleAtIssue: 'engineer' } });
    await t.prisma.drawingAck.create({ data: { revisionId: REV_ID, userId: uid, userName: 'PMC', role: 'engineer' } });
    // a daily log with a crew row + a placed material → DailyLogDto crew[]/materials[], top-level materials[]
    await t.prisma.dailyLog.create({ data: { id: s('p2-log'), projectId: pid, date: '02 Jun', logDate: new Date('2026-06-02'), checkedIn: true, submitted: true, progress: 2, checkinTime: '09:00' } });
    await t.prisma.crewRow.create({ data: { dailyLogId: s('p2-log'), trade: 'Mason', count: 4, order: 0 } });
    await t.prisma.siteMaterial.create({ data: { id: s('p2-mat'), projectId: pid, dailyLogId: s('p2-log'), name: 'Tile', qty: '5', zone: 'GF', decisionId: APPROVED_ID, swatch: 'tile', matched: true, nodeId: NODE_ID } });
    // a placed PROGRESS photo → top-level photos[] (PhotoDto) AND dailyLog.photos[]
    await t.prisma.media.create({ data: { id: s('p2-photo'), projectId: pid, kind: 'progress', mime: 'image/png', uploadedBy: uid, nodeId: NODE_ID, takenAt: '2026-06-02' } });
    // a company → CompanyDto (all contact fields populated so every key serializes)
    await t.prisma.projectCompany.create({ data: { id: s('p2-co'), projectId: pid, name: 'ACME', kind: 'contractor', contactName: 'A Person', contactEmail: 'a@x.com', contactPhone: '123', notes: 'n' } });
    // a notification → notifications[]
    await t.prisma.notification.create({ data: { projectId: pid, text: 'hi', color: '#000', time: 'just now' } });

    // author-private DRAFTS (publishedAt null) — reach only their author (uid)
    await t.prisma.decision.create({ data: { id: DRAFT_DEC, projectId: pid, title: 'Draft dec', room: 'X', photoSwatch: 'marble', status: 'pending', publishedAt: null, authorId: uid } });
    await t.prisma.drawing.create({ data: { id: DRAFT_DWG, projectId: pid, number: 'A-900', title: 'Draft dwg', discipline: 'architectural', publishedAt: null, authorId: uid } });
    await t.prisma.projectNode.create({ data: { id: DRAFT_NODE, projectId: pid, name: 'Draft zone', kind: 'zone', order: 9, publishedAt: null, authorId: uid } });
  });

  afterAll(async () => {
    const pid = f.projectA.id;
    await t.prisma.drawingAck.deleteMany({ where: { revision: { projectId: pid } } });
    await t.prisma.drawingRecipient.deleteMany({ where: { projectId: pid } });
    await t.prisma.drawingRevision.deleteMany({ where: { projectId: pid } });
    await t.prisma.drawing.deleteMany({ where: { projectId: pid } });
    await t.prisma.media.deleteMany({ where: { projectId: pid } });
    await t.prisma.siteMaterial.deleteMany({ where: { projectId: pid } });
    await t.prisma.crewRow.deleteMany({ where: { dailyLog: { projectId: pid } } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: pid } });
    await t.prisma.notification.deleteMany({ where: { projectId: pid } });
    await t.prisma.projectCompany.deleteMany({ where: { projectId: pid } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: pid } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pid } });
    await t.prisma.phase.deleteMany({ where: { projectId: pid } });
    await t.prisma.activity.deleteMany({ where: { projectId: pid } });
    await t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: pid } } });
    await t.prisma.decision.deleteMany({ where: { projectId: pid } });
    await t.prisma.projectNode.deleteMany({ where: { projectId: pid } });
    await f.cleanup();
    await t.close();
  });

  // ── role & author gates (unchanged coverage) ──
  it('returns exactly the 16 top-level keys for every role, and the source declares the same set', () => {
    expect(interfaceSpec('SnapshotDto')).toEqual(EXPECT.SnapshotDto);
  });

  it('the live snapshot top-level keys equal the declared SnapshotDto keys, for every role', async () => {
    for (const role of ALL_ROLES) {
      const snap = await snapshots.build(f.projectA.id, role, f.memberUser.id);
      expect(Object.keys(snap).sort(), `role ${role} key set drifted`).toEqual(EXPECT.SnapshotDto.keys);
    }
  });

  it('hides published pending decisions from non-pmc/client roles', async () => {
    const idsFor = async (role: Role) => (await snapshots.build(f.projectA.id, role, f.memberUser.id)).decisions.map((d) => d.id);
    for (const role of ['pmc', 'client'] as Role[]) {
      const ids = await idsFor(role);
      expect(ids, `${role} should see the pending decision`).toContain(PENDING_ID);
      expect(ids).toContain(APPROVED_ID);
    }
    for (const role of ['engineer', 'contractor', 'consultant'] as Role[]) {
      const ids = await idsFor(role);
      expect(ids, `${role} must NOT see the pending decision`).not.toContain(PENDING_ID);
      expect(ids, `${role} should still see the approved decision`).toContain(APPROVED_ID);
    }
  });

  it('serializes the review queue only for pmc', async () => {
    for (const role of ALL_ROLES) {
      const snap = await snapshots.build(f.projectA.id, role, f.memberUser.id);
      if (role === 'pmc') {
        expect(snap.reviews.map((r) => r.id)).toContain(INSP_ID);
        expect(snap.review).not.toBeNull();
      } else {
        expect(snap.reviews, `${role} must get an empty review queue`).toEqual([]);
        expect(snap.review, `${role} must get a null singular review`).toBeNull();
        expect(snap.reinspectionCreated).toBe(false);
      }
    }
  });

  it('serializes placed inspections only for pmc and engineer', async () => {
    for (const role of ALL_ROLES) {
      const snap = await snapshots.build(f.projectA.id, role, f.memberUser.id);
      const ids = snap.placedInspections.map((p) => p.id);
      if (role === 'pmc' || role === 'engineer') expect(ids, `${role} should see placed inspections`).toContain(INSP_ID);
      else expect(snap.placedInspections, `${role} must get no placed inspections`).toEqual([]);
    }
  });

  it('delivers author-private drafts ONLY to their author (decision, drawing, node)', async () => {
    const mine = await snapshots.build(f.projectA.id, 'pmc', f.memberUser.id);
    expect(mine.decisions.find((d) => d.id === DRAFT_DEC)?.draft, 'author sees own draft decision').toBe(true);
    expect(mine.drawings.find((d) => d.id === DRAFT_DWG)?.draft, 'author sees own draft drawing').toBe(true);
    expect(mine.nodes.find((n) => n.id === DRAFT_NODE)?.draft, 'author sees own draft node').toBe(true);
    const theirs = await snapshots.build(f.projectA.id, 'pmc', STRANGER);
    expect(theirs.decisions.map((d) => d.id), 'a non-author must not receive the draft decision').not.toContain(DRAFT_DEC);
    expect(theirs.drawings.map((d) => d.id), 'a non-author must not receive the draft drawing').not.toContain(DRAFT_DWG);
    expect(theirs.nodes.map((n) => n.id), 'a non-author must not receive the draft node').not.toContain(DRAFT_NODE);
  });

  // ── the source shape of every DTO matches its EXPECTED pin (a tripwire on types.ts) ──
  describe('types.ts declares EXACTLY the pinned keys / optionality / nullability per DTO', () => {
    for (const [name, spec] of Object.entries(EXPECT)) {
      it(`${name}`, () => expect(interfaceSpec(name)).toEqual(spec));
    }
  });

  // ── the live snapshot conforms to those shapes for all 16 top-level keys ──
  it('pins the nested shape + nullability of ALL 16 top-level keys against a fully-populated snapshot', async () => {
    const snap = await snapshots.build(f.projectA.id, 'pmc', f.memberUser.id) as unknown as Record<string, unknown>;
    const rec = (v: unknown) => v as Record<string, unknown>;

    // 1. project → ProjectMetaDto
    assertRuntimeShape(rec(snap.project), EXPECT.ProjectMetaDto, 'project');

    // 2. decisions[] → DecisionDto, its options[] → OptionDto
    const dec = (snap.decisions as Record<string, unknown>[]).find((d) => d.id === APPROVED_ID)!;
    assertRuntimeShape(dec, EXPECT.DecisionDto, 'decisions[]');
    assertRuntimeShape((dec.options as Record<string, unknown>[])[0], EXPECT.OptionDto, 'decisions[].options[]');

    // 3. activities[] → ActivityDto, readiness → ActivityReadinessDto / GateReadingDto, overrides[] → GateOverrideDto
    const act = (snap.activities as Record<string, unknown>[]).find((a) => a.id === ACT_ID)!;
    assertRuntimeShape(act, EXPECT.ActivityDto, 'activities[]');
    assertRuntimeShape(rec(act.readiness), EXPECT.ActivityReadinessDto, 'activities[].readiness');
    for (const gate of EXPECT.ActivityReadinessDto.keys) assertRuntimeShape(rec(rec(act.readiness)[gate]), EXPECT.GateReadingDto, `readiness.${gate}`);
    expect(Array.isArray(act.overrides)).toBe(true);

    // 4. placedInspections[] → PlacedInspectionDto
    assertRuntimeShape((snap.placedInspections as Record<string, unknown>[]).find((p) => p.id === INSP_ID)!, EXPECT.PlacedInspectionDto, 'placedInspections[]');

    // 5. checklist → ChecklistDto, items[] inline
    const checklist = rec(snap.checklist);
    assertRuntimeShape(checklist, EXPECT.ChecklistDto, 'checklist');
    assertInline((checklist.items as Record<string, unknown>[])[0], INLINE.checklistItem, 'checklist.items[]');

    // 6. reviews[] / 7. review → ReviewDto, items[] inline
    const review = (snap.reviews as Record<string, unknown>[]).find((r) => r.id === INSP_ID)!;
    assertRuntimeShape(review, EXPECT.ReviewDto, 'reviews[]');
    assertInline((review.items as Record<string, unknown>[])[0], INLINE.reviewItem, 'reviews[].items[]');
    assertRuntimeShape(rec(snap.review), EXPECT.ReviewDto, 'review');

    // 8. reinspectionCreated is a boolean
    expect(typeof snap.reinspectionCreated).toBe('boolean');

    // 9. drawings[] → DrawingDto, current → DrawingRevisionDto, its acks[]/recipients[] → DrawingAckDto/DrawingRecipientDto
    const dwg = (snap.drawings as Record<string, unknown>[]).find((d) => d.id === DWG_ID)!;
    assertRuntimeShape(dwg, EXPECT.DrawingDto, 'drawings[]');
    const revsion = rec(dwg.current);
    assertRuntimeShape(revsion, EXPECT.DrawingRevisionDto, 'drawings[].current');
    assertRuntimeShape((revsion.acks as Record<string, unknown>[])[0], EXPECT.DrawingAckDto, 'drawings[].current.acks[]');
    assertRuntimeShape((revsion.recipients as Record<string, unknown>[])[0], EXPECT.DrawingRecipientDto, 'drawings[].current.recipients[]');
    assertRuntimeShape((dwg.revisions as Record<string, unknown>[])[0], EXPECT.DrawingRevisionDto, 'drawings[].revisions[]');

    // 10. phases[] → PhaseDto
    assertRuntimeShape((snap.phases as Record<string, unknown>[])[0], EXPECT.PhaseDto, 'phases[]');

    // 11. dailyLog → DailyLogDto, crew[]/materials[]/photos[] inline
    const log = rec(snap.dailyLog);
    assertRuntimeShape(log, EXPECT.DailyLogDto, 'dailyLog');
    assertInline((log.crew as Record<string, unknown>[])[0], INLINE.crew, 'dailyLog.crew[]');
    assertInline((log.materials as Record<string, unknown>[])[0], INLINE.dailyLogMaterial, 'dailyLog.materials[]');
    assertInline((log.photos as Record<string, unknown>[])[0], INLINE.dailyLogPhoto, 'dailyLog.photos[]', ['takenAt']);

    // 12. notifications[] inline
    assertInline((snap.notifications as Record<string, unknown>[])[0], INLINE.notification, 'notifications[]');

    // 13. companies[] → CompanyDto
    assertRuntimeShape((snap.companies as Record<string, unknown>[])[0], EXPECT.CompanyDto, 'companies[]');

    // 14. nodes[] → NodeDto
    assertRuntimeShape((snap.nodes as Record<string, unknown>[]).find((n) => n.id === NODE_ID)!, EXPECT.NodeDto, 'nodes[]');

    // 15. photos[] → PhotoDto
    assertRuntimeShape((snap.photos as Record<string, unknown>[])[0], EXPECT.PhotoDto, 'photos[]');

    // 16. materials[] → MaterialDto
    assertRuntimeShape((snap.materials as Record<string, unknown>[]).find((m) => m.id === s('p2-mat'))!, EXPECT.MaterialDto, 'materials[]');
  });
});
