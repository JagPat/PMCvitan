import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMAIN_EVENT_TYPES } from '@vitan/shared';
import {
  dispatchActionFor, persistedRule, eventTypesUnder, DISPATCH_RULE_KINDS,
  type DispatchRule, type EmittedEventMeta, type OutboxConsumer,
} from './registry';
import { makeSocketConsumer, makePushConsumer } from './consumers';
import { makeDecisionsProjectionConsumer } from '../../decisions/decisions.projection';
import { makeDailyLogProjectionConsumer } from '../../daily-log/daily-log.projection';
import { makeDrawingsProjectionConsumer } from '../../drawings/drawings.projection';
import { makeInspectionsProjectionConsumer } from '../../inspections/inspections.projection';
import { makeActivitiesProjectionConsumer } from '../../activities/activities.projection';
import { makeMaterialReadinessProjectionConsumer } from '../../activities/material-readiness.projection';
import { makeLabourReadinessProjectionConsumer } from '../../labour/labour-readiness.projection';
import { makeCashForecastProjectionConsumer } from '../../commercial/cash-forecast.projection';

/**
 * Phase 6 task 4d-ii-a / A6c — the persisted dispatch rules are TWO COPIES OF ONE TRUTH, three
 * times over, and each pair is pinned here:
 *
 *   1. the compiled consumer's DECLARED rule (`dispatchRule`) against its delivered `deliveryFor`,
 *      over the closed event-type list and every intent shape — until A6d derives the rows from the
 *      persisted rule, `deliveryFor` still decides, and a declaration that disagreed with it would
 *      persist a rule the seals later judge by while the relay wrote something else;
 *   2. the MIGRATION LITERAL (the rule the catalog-data migration writes for every row that already
 *      exists) against the compiled consumers — read from the migration TEXT, as 4d-i's catalog seed
 *      is, because the migration is the artifact that ships and a database can be repaired by hand;
 *   3. the set of consumers the bootstrap registers against the set pinned here, so a consumer added
 *      to the bootstrap without its rule literal (or a literal outliving its consumer) fails HERE
 *      rather than as a startup drift refusal in production.
 */

const MIGRATION = join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20271230000000_phase6_t4d_ii_a6c_catalog_rules', 'migration.sql');
const BOOTSTRAP = join(__dirname, 'outbox.bootstrap.ts');

/** The compiled consumers the bootstrap registers, built over inert deps (`deliveryFor` and
 *  `dispatchRule` read nothing but the event). */
const compiled = (): OutboxConsumer[] => [
  makeSocketConsumer({} as never),
  makePushConsumer({} as never),
  makeDecisionsProjectionConsumer(),
  makeDailyLogProjectionConsumer(),
  makeDrawingsProjectionConsumer(),
  makeInspectionsProjectionConsumer(),
  makeActivitiesProjectionConsumer(),
  makeMaterialReadinessProjectionConsumer(),
  makeLabourReadinessProjectionConsumer(),
  makeCashForecastProjectionConsumer(),
];

const meta = (eventType: string, dispatchIntent: EmittedEventMeta['dispatchIntent']): EmittedEventMeta => ({
  eventId: 'e', eventType, projectId: 'p', organizationId: 'o', streamPosition: 0n,
  entityType: 'X', entityId: 'x', payload: null, dispatchIntent,
});

/** Every intent shape a rule can distinguish: none (legacy), invalidating or not, with a push or not. */
const INTENTS: EmittedEventMeta['dispatchIntent'][] = [
  null,
  { effectKey: 'k', coverageVersion: 'v', invalidate: false },
  { effectKey: 'k', coverageVersion: 'v', invalidate: true },
  { effectKey: 'k', coverageVersion: 'v', invalidate: false, push: { body: 'hi' } },
  { effectKey: 'k', coverageVersion: 'v', invalidate: true, push: { body: 'hi', roles: ['client'] } },
];

describe('4d-ii-a / A6c — the persisted dispatch rule', () => {
  it('derives the four rules exactly as §A.3 states them', () => {
    const i = (invalidate: boolean, push?: boolean): EmittedEventMeta['dispatchIntent'] =>
      ({ effectKey: 'k', coverageVersion: 'v', invalidate, ...(push ? { push: { body: 'b' } } : {}) });
    expect(dispatchActionFor({ kind: 'all' }, meta('x.y', null))).toBe('dispatch');
    expect(dispatchActionFor({ kind: 'invalidate' }, meta('x.y', i(true)))).toBe('dispatch');
    expect(dispatchActionFor({ kind: 'invalidate' }, meta('x.y', i(false)))).toBe('noop');
    expect(dispatchActionFor({ kind: 'invalidate' }, meta('x.y', null))).toBe('noop');
    expect(dispatchActionFor({ kind: 'push' }, meta('x.y', i(true, true)))).toBe('dispatch');
    expect(dispatchActionFor({ kind: 'push' }, meta('x.y', i(true)))).toBe('noop');
    expect(dispatchActionFor({ kind: 'push' }, meta('x.y', null))).toBe('noop');
    expect(dispatchActionFor({ kind: 'types', eventTypes: ['a.b'] }, meta('a.b', null))).toBe('dispatch');
    expect(dispatchActionFor({ kind: 'types', eventTypes: ['a.b'] }, meta('a.c', i(true, true)))).toBe('noop');
    expect(dispatchActionFor({ kind: 'types', eventTypes: [] }, meta('a.b', i(true, true)))).toBe('noop');
  });

  it('persists a rule as its kind and a SORTED, deduplicated list under `types` alone', () => {
    expect(persistedRule({ kind: 'all' })).toEqual({ dispatchRule: 'all', subscribedEventTypes: [] });
    expect(persistedRule({ kind: 'push' })).toEqual({ dispatchRule: 'push', subscribedEventTypes: [] });
    expect(persistedRule({ kind: 'types', eventTypes: ['b.x', 'a.x', 'b.x'] })).toEqual({ dispatchRule: 'types', subscribedEventTypes: ['a.x', 'b.x'] });
    expect(DISPATCH_RULE_KINDS).toEqual(['all', 'invalidate', 'push', 'types']);
  });

  it('`eventTypesUnder` spells a family from the closed list — never a hand-typed name', () => {
    const decision = eventTypesUnder('decision.');
    expect(decision.length).toBeGreaterThan(0);
    for (const t of decision) expect(DOMAIN_EVENT_TYPES).toContain(t);
    expect(eventTypesUnder('activity.', 'phase.')).toEqual(DOMAIN_EVENT_TYPES.filter((t) => t.startsWith('activity.') || t.startsWith('phase.')));
    // the underscore family is NOT the dotted one: `activity_output.recorded` is not `activity.*`
    expect(eventTypesUnder('activity.')).not.toContain('activity_output.recorded');
  });

  it('every compiled consumer\'s declared rule agrees with its delivered `deliveryFor` over the closed event list and every intent shape', () => {
    for (const c of compiled()) {
      for (const t of DOMAIN_EVENT_TYPES) {
        for (const intent of INTENTS) {
          const m = meta(t, intent);
          expect(dispatchActionFor(c.dispatchRule, m), `${c.name}: ${t} under ${JSON.stringify(intent)}`).toBe(c.deliveryFor(m).action);
        }
      }
    }
  });

  it('the migration literal writes, for every compiled consumer, exactly the rule the code declares — and no other row', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const start = sql.indexOf('FROM (VALUES');
    const end = sql.indexOf(') AS r(consumer, rule, types)');
    expect(start, 'the migration carries the rule literal').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const literal = sql.slice(start, end);
    const rows = new Map<string, { dispatchRule: string; subscribedEventTypes: string[] }>();
    for (const m of literal.matchAll(/\('([^']+)', '([^']+)', ARRAY\[([^\]]*)\]::TEXT\[\]\)/g)) {
      const types = m[3].trim() === '' ? [] : m[3].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
      expect(rows.has(m[1]), `${m[1]} appears once in the literal`).toBe(false);
      rows.set(m[1], { dispatchRule: m[2], subscribedEventTypes: types });
    }
    const consumers = compiled();
    expect([...rows.keys()].sort()).toEqual(consumers.map((c) => c.name).sort());
    for (const c of consumers) {
      expect(rows.get(c.name), `${c.name}'s literal`).toEqual(persistedRule(c.dispatchRule));
    }
    // the literal's lists are SORTED, as `persistedRule` sorts them, so a diff reads as a set diff
    for (const [name, r] of rows) expect(r.subscribedEventTypes, `${name} sorted`).toEqual([...r.subscribedEventTypes].sort());
  });

  it('the bootstrap registers exactly the consumers pinned here', () => {
    const source = readFileSync(BOOTSTRAP, 'utf8');
    const registrations = source.match(/registerConsumer\(/g) ?? [];
    expect(registrations.length, 'a consumer added to the bootstrap must be added to `compiled()` above, with its rule literal in the migration')
      .toBe(compiled().length);
  });

  it('a rule declaration is a closed union', () => {
    // compile-time: an unknown kind cannot be written; runtime: the exhaustive switch returns for each
    const kinds: DispatchRule['kind'][] = ['all', 'invalidate', 'push', 'types'];
    expect(kinds).toEqual([...DISPATCH_RULE_KINDS]);
  });
});
