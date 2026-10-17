import { describe, it, expect } from 'vitest';
import { checkRemoval, deleteOrder, QA_EMAIL, type RemovalCheckInput, type TriggerState } from './project-remove';
import type { ProjectInventory } from './project-inventory';

/**
 * #482 — the checks a removal must pass before it may commit: anything the reviewed list does not
 * allow, in any table, is a failure that rolls the run back.
 */
const inv = (projectId: string, keys: Record<string, string[]>): ProjectInventory => ({ projectId, project: { id: projectId, name: projectId, orgId: 'o', archivedAt: null }, keys } as unknown as ProjectInventory);
const trig: TriggerState = { table: 'DomainEvent', name: 'DomainEvent_append_only', enabled: 'O', definition: 'CREATE TRIGGER ...', onDelete: true };

function base(over: Partial<RemovalCheckInput> = {}): RemovalCheckInput {
  return {
    changes: [
      { table: 'DomainEvent', removed: ['["e1"]'], added: [], changed: [] },
      { table: 'Project', removed: ['["t"]'], added: [], changed: [] },
      { table: 'User', removed: [], added: [], changed: ['["u1"]'] },
    ],
    listed: { DomainEvent: ['["e1"]'], Project: ['["t"]'] },
    updatedUsers: ['["u1"]'],
    rehomedUsers: ['["u1"]'],
    rehomeTo: 'd135',
    protectedBefore: [inv('d135', { Project: ['["d135"]'], User: ['["u2"]'] })],
    protectedAfter: [inv('d135', { Project: ['["d135"]'], User: ['["u1"]', '["u2"]'] })],
    triggersBefore: [trig],
    triggersAfter: [trig],
    ...over,
  };
}

describe('checkRemoval', () => {
  it('passes exactly the listed removal and the moved user', () => {
    expect(checkRemoval(base())).toEqual([]);
  });

  it('fails a removed row that is not on the list, and a listed row left behind', () => {
    const f = checkRemoval(base({ changes: [
      { table: 'DomainEvent', removed: ['["e1"]', '["e9"]'], added: [], changed: [] },
      { table: 'Notification', removed: ['["n1"]'], added: [], changed: [] },
      { table: 'User', removed: [], added: [], changed: ['["u1"]'] },
    ] }));
    expect(f).toEqual(expect.arrayContaining([
      expect.stringMatching(/^DomainEvent: 1 removed row\(s\) are not on the list/),
      expect.stringMatching(/^Notification: 1 removed row\(s\) are not on the list/),
      expect.stringMatching(/^Project: 1 listed row\(s\) were not removed/),
    ]));
  });

  it('fails identical rows removed beyond the list, an added row, and a table that appears', () => {
    const f = checkRemoval(base({ changes: [
      ...base().changes.filter((c) => c.table !== 'DomainEvent'),
      { table: 'DomainEvent', removed: ['["e1"]', '["e1"]'], added: ['["e2"]'], changed: [] },
      { table: 'Extra', removed: [], added: [], changed: [], onlyIn: 'after' },
    ] }));
    expect(f).toEqual(expect.arrayContaining([
      'DomainEvent: 1 identical row(s) removed beyond the list',
      'DomainEvent: 1 row(s) added',
      'Extra: the table exists only after the run',
    ]));
  });

  it('fails any changed row other than the users the run updated, and an update that did not land', () => {
    const f = checkRemoval(base({ changes: [
      ...base().changes.filter((c) => c.table !== 'User'),
      { table: 'User', removed: [], added: [], changed: ['["u3"]'] },
      { table: 'Membership', removed: [], added: [], changed: ['["m1"]'] },
    ] }));
    expect(f).toEqual(expect.arrayContaining([
      expect.stringMatching(/^User: 1 row\(s\) changed that the run may not change/),
      expect.stringMatching(/^Membership: 1 row\(s\) changed/),
      'User: 1 updated user row(s) show no change',
    ]));
  });

  it("fails a protected project that loses, changes or gains a row", () => {
    const f = checkRemoval(base({
      protectedBefore: [inv('d135', { Project: ['["d135"]'], DomainEvent: ['["e1"]'], Membership: ['["m1"]'] })],
      protectedAfter: [inv('d135', { Project: ['["d135"]'], Membership: ['["m1"]', '["m2"]'], User: ['["u1"]'] })],
      changes: [...base().changes, { table: 'Membership', removed: [], added: [], changed: ['["m1"]'] }],
    }));
    expect(f).toEqual(expect.arrayContaining([
      'protected d135: DomainEvent lost 1 row(s)',
      'protected d135: Membership has 1 changed row(s)',
      expect.stringMatching(/^protected d135: keys differ, DomainEvent/),
      expect.stringMatching(/^protected d135: keys differ, Membership/),
    ]));
  });

  it('fails a trigger that is not restored exactly, is gone, or is new', () => {
    const f = checkRemoval(base({
      triggersBefore: [trig, { ...trig, name: 'B' }, { ...trig, name: 'C' }],
      triggersAfter: [{ ...trig, enabled: 'D' }, { ...trig, name: 'C', definition: 'other' }, { ...trig, name: 'N' }],
    }));
    expect(f).toEqual([
      'trigger DomainEvent.DomainEvent_append_only: enabled O before, D after',
      'trigger DomainEvent.B: missing after the run',
      'trigger DomainEvent.C: definition changed',
      'trigger DomainEvent.N: new after the run',
    ]);
  });
});

describe('deleteOrder', () => {
  it('empties children before parents, however deep, and still lists every table of a cycle', () => {
    const edges = [
      { child: 'CrewRow', parent: 'DailyLog' }, { child: 'DailyLog', parent: 'Project' },
      { child: 'OutboxDelivery', parent: 'DomainEvent' }, { child: 'DomainEvent', parent: 'Project' },
      { child: 'A', parent: 'B' }, { child: 'B', parent: 'A' }, { child: 'Node', parent: 'Node' },
    ];
    const order = deleteOrder(['Project', 'DailyLog', 'CrewRow', 'DomainEvent', 'OutboxDelivery', 'A', 'B', 'Node'], edges);
    const at = (t: string): number => order.indexOf(t);
    expect(order).toHaveLength(8);
    expect(at('CrewRow')).toBeLessThan(at('DailyLog'));
    expect(at('DailyLog')).toBeLessThan(at('Project'));
    expect(at('OutboxDelivery')).toBeLessThan(at('DomainEvent'));
    expect(at('DomainEvent')).toBeLessThan(at('Project'));
  });
});

describe('QA_EMAIL', () => {
  it('admits only qa.<letters>@vitan.in', () => {
    for (const ok of ['qa.pmc@vitan.in', 'qa.consultant@vitan.in']) expect(QA_EMAIL.test(ok), ok).toBe(true);
    for (const no of ['jp@vitan.in', 'qa.pmc@vitan.in.evil', 'qa.pmc2@vitan.in', 'xqa.pmc@vitan.in', 'qa.@vitan.in', 'QA.pmc@vitan.in', 'qa.pmc@test.local'])
      expect(QA_EMAIL.test(no), no).toBe(false);
  });
});
