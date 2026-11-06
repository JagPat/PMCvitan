import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { computeInspectionsBase } from './inspections-serialize';
import { NOT_PROJECTED, makeInspectionsProjectionConsumer } from './inspections.projection';

/**
 * #482 RM-e-c — the TRIPWIRE that gives `NOT_PROJECTED` its end.
 *
 * `inspections.inbox` leaves `inspection.responsible_set` out of its persisted rule because the stored base
 * holds nothing `setResponsible` writes. That is only true while the base stays that way. The day a unit puts
 * `responsibleMemberId` or `responsibleStandingMark` (or anything derived from them) into the base, the
 * projection would go stale on every naming, with no event to refresh it. This suite fails at that moment.
 *
 * The order such a unit must follow: first a catalog-rule migration that adds `inspection.responsible_set` to
 * `inspections.inbox`'s persisted rule (the A6c / A7d pattern), then drop the type from `NOT_PROJECTED`, then put
 * the field in the base. Removing the type from `NOT_PROJECTED` alone fails startup's contract-drift check;
 * putting the field in the base alone fails here.
 */
const MEMBER = 'rmec-tripwire-member-id';
const MARK = 987_654_321;

/** A fake client over one inspection row that carries every column, the two responsible ones set to sentinels. */
function clientWithResponsibleRow(): Prisma.TransactionClient {
  const row = {
    id: 'INSP-1', projectId: 'p', kind: 'checklist', title: 'Slab', zone: 'Z', nodeId: null, by: null, date: '2 Nov',
    submitted: true, decided: false, closing: false, activityId: null, activityName: null, reinspectionOfId: null,
    assigneeId: null, dueDate: null, createdAt: new Date(0), updatedAt: new Date(0),
    submittedById: null, submittedByName: null,
    responsibleMemberId: MEMBER, responsibleStandingMark: MARK,
    items: [{ id: 'I-1', inspectionId: 'INSP-1', name: 'Rebar', order: 0, state: 'fail', photos: 0, note: '', result: null, swatch: null, rejected: false }],
  };
  return {
    inspection: { findMany: async () => [row] },
    inspectionEvidence: { findMany: async () => [] },
  } as unknown as Prisma.TransactionClient;
}

describe('RM-e-c — the inspections base holds nothing setResponsible writes while NOT_PROJECTED holds its event', () => {
  it('NOT_PROJECTED holds exactly `inspection.responsible_set`, and the projection rule leaves it out', () => {
    expect([...NOT_PROJECTED]).toEqual(['inspection.responsible_set']);
    const rule = makeInspectionsProjectionConsumer().dispatchRule;
    expect(rule.kind).toBe('types');
    expect(rule.kind === 'types' && rule.eventTypes.includes('inspection.responsible_set')).toBe(false);
  });

  it('a row naming someone serializes to a base with no trace of the name or the mark', async () => {
    const base = await computeInspectionsBase(clientWithResponsibleRow(), 'p');
    expect(base.inspections).toHaveLength(1);
    const text = JSON.stringify(base);
    expect(text, 'the base carries the responsible member: migrate the inbox rule first, then drop it from NOT_PROJECTED').not.toContain(MEMBER);
    expect(text, 'the base carries the standing mark: migrate the inbox rule first, then drop it from NOT_PROJECTED').not.toContain(String(MARK));
  });

  it('the serializer source never names a responsible column', () => {
    const src = readFileSync(join(__dirname, 'inspections-serialize.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function computeInspectionsBase'), src.indexOf('export function compareInspectionIds'));
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/responsible/i);
  });
});
