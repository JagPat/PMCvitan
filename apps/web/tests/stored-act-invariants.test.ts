import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as contracts from '../../api/src/contracts';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { isKnownOutboxOp, SERVER_REFINES_MIRRORED, SERVER_SCHEMA_OF } from '@/data/storedActs';

/**
 * #1071 F4 (Codex 4341067934). Round 1 read a stored act through the type of each field its replay reads, but not
 * through the server's rules across fields: an `allocateLabour` naming both a worker and a crew loaded, was refused for
 * good, and was dropped by its flush, its bytes lost with no Set aside offered. Every `.refine` of the server contract
 * a queued kind is parsed by is now mirrored (`SERVER_REFINES_MIRRORED`), so such an act makes its key unreadable: it
 * is listed, set aside on the tap, and never sent or dropped.
 *
 * The guard reads the contract file: a `.refine` reachable from a queued kind's schema that the mirror does not name
 * fails it, so the mirror cannot drift. Each mirror is checked against the server's own schema, act by act, so it is
 * never stricter (an act the server takes, an earlier release's included, is never set aside) nor looser.
 *
 * The "is not read" and store tests fail at f6e063e; the guard and the "valid today" tests are guards, each failing
 * under its break.
 */

const contractsSource = readFileSync(resolve(__dirname, '../../api/src/contracts.ts'), 'utf8');

/** each top-level const of the contract file, with its source */
function constsOf(src: string): Map<string, string> {
  const at = [...src.matchAll(/^(?:export )?const (\w+)\s*=/gm)].map((m) => ({ name: m[1], start: m.index ?? 0 }));
  return new Map(at.map((d, i) => [d.name, src.slice(d.start, at[i + 1]?.start ?? src.length)]));
}
/** the message of each `.refine(` in a const's source: the string after `message:`, else the last string literal among
 *  its arguments (a template's `${x}` read as `{x}`) */
function refineMessages(body: string): string[] {
  const out: string[] = [];
  for (let i = body.indexOf('.refine('); i >= 0; i = body.indexOf('.refine(', i + 1)) {
    let depth = 0;
    let j = i + '.refine'.length;
    let last: string | null = null;
    let message: string | null = null;
    for (; j < body.length; j += 1) {
      const ch = body[j];
      if (ch === "'" || ch === '"' || ch === '`') {
        let k = j + 1;
        while (k < body.length && body[k] !== ch) k += body[k] === '\\' ? 2 : 1;
        last = body.slice(j + 1, k).replace(/\\(.)/g, '$1').replace(/\$\{(\w+)\}/g, '{$1}');
        if (/message:\s*$/.test(body.slice(i, j))) message = last;
        j = k;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') { depth -= 1; if (depth === 0) break; }
    }
    if (last === null) throw new Error(`a refine with no message: ${body.slice(i, i + 80)}`);
    out.push(message ?? last);
  }
  if (body.includes('superRefine(')) throw new Error('a superRefine: the mirror cannot name it by message');
  return out;
}
/** every refine message reachable from a schema through the consts it names */
function refinesReachable(consts: Map<string, string>, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const body = consts.get(name);
  if (body === undefined) throw new Error(`no const ${name} in contracts.ts`);
  const named = [...new Set(body.slice(name.length).match(/\b\w+\b/g) ?? [])].filter((w) => w !== name && consts.has(w));
  return [...refineMessages(body), ...named.flatMap((w) => refinesReachable(consts, w, seen))];
}

describe('#1071 F4 guard: every server refine a queued kind could break is mirrored', () => {
  const consts = constsOf(contractsSource);

  it('each queued kind names the schema its replay is parsed by, and every refine reachable from it is mirrored', () => {
    const missing: string[] = [];
    const stale: string[] = [];
    for (const [kind, schema] of Object.entries(SERVER_SCHEMA_OF) as [OutboxOp['t'], string | null][]) {
      const server = schema === null ? [] : [...new Set(refinesReachable(consts, schema))];
      const mirrored = SERVER_REFINES_MIRRORED[kind]?.refines ?? [];
      for (const m of server) if (!mirrored.includes(m)) missing.push(`${kind} (${schema}): ${m}`);
      for (const m of mirrored) if (!server.includes(m)) stale.push(`${kind}: ${m}`);
    }
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('each named schema is one a controller parses a request body with', () => {
    const root = resolve(__dirname, '../../api/src');
    const controllers = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.controller.ts'))
      .map((f) => readFileSync(resolve(root, f), 'utf8')).join('\n');
    const unparsed = [...new Set(Object.values(SERVER_SCHEMA_OF).filter((x): x is string => x !== null))]
      .filter((x) => !controllers.includes(`ZodPipe(${x})`));
    expect(unparsed).toEqual([]);
  });

  it('the guard sees a refine it is not told of: a schema gaining one fails it', () => {
    const grown = constsOf(contractsSource.replace(
      'export const recordLabourWorkSchema = z',
      'export const recordLabourWorkSchema = z.any().refine(() => true, \'a new rule\') && z',
    ));
    expect(refinesReachable(grown, 'recordLabourWorkSchema')).toContain('a new rule');
    expect(SERVER_REFINES_MIRRORED.recordLabourWork).toBeUndefined();
  });
});

const day = '2026-10-21';
const k = 'k-1';
const c = 'c-1';
type Variant = { label: string; input: Record<string, unknown> };
/** for each mirrored kind: its act around an input, the server schema, and inputs that hold or break each refine */
const VISIT = '6f1c2b0e-8a4d-4c5e-9b7a-1d2e3f4a5b6c';
const at = '2026-10-21T05:30:00.000Z';
const CASES: { kind: OutboxOp['t']; act: (input: Record<string, unknown>) => unknown; variants: Variant[] }[] = [
  {
    kind: 'siteVisitStart',
    act: (input) => ({ t: 'siteVisitStart', body: input, visitor: { name: 'n', role: 'pmc', placeName: null }, idempotencyKey: k }),
    variants: [
      { label: 'a start', input: { id: VISIT, claimedAt: at } },
      { label: 'a start with an offset and a location', input: { id: VISIT, claimedAt: '2026-10-21T11:00:00+05:30', location: { lat: 1, lng: 2, accuracyM: 3, at } } },
      { label: 'a start past the years ISO text has', input: { id: VISIT, claimedAt: '9999-12-31T23:00:00-05:00' } },
      { label: 'a location at an instant past them', input: { id: VISIT, claimedAt: at, location: { lat: 1, lng: 2, accuracyM: 3, at: '0000-01-01T00:30:00+01:00' } } },
    ],
  },
  {
    kind: 'siteVisitEnd',
    act: (input) => ({ t: 'siteVisitEnd', visitId: VISIT, ...input, idempotencyKey: k }),
    variants: [
      { label: 'an end', input: { claimedAt: at } },
      { label: 'an end past the years ISO text has', input: { claimedAt: '9999-12-31T23:30:00-01:00' } },
    ],
  },
  {
    kind: 'siteVisitAddPlace',
    act: (input) => ({ t: 'siteVisitAddPlace', visitId: VISIT, body: input, name: 'n', idempotencyKey: k }),
    variants: [
      { label: 'a place', input: { id: VISIT, nodeId: 'n-1', claimedAt: at } },
      { label: 'a place past the years ISO text has', input: { id: VISIT, nodeId: 'n-1', claimedAt: '0000-01-01T00:00:00+00:01' } },
    ],
  },
  {
    kind: 'forwardDecision',
    act: (input) => ({ t: 'forwardDecision', decisionId: 'd-1', input, idempotencyKey: k }),
    variants: [
      { label: 'a role target', input: { toDesignationKind: 'pmc', reason: 'r' } },
      { label: 'a member target naming its membership', input: { toDesignationKind: 'member', toDesignationMembershipId: 'm', reason: 'r' } },
      { label: 'a member target naming none', input: { toDesignationKind: 'member', reason: 'r' } },
      { label: 'a role target naming a membership', input: { toDesignationKind: 'client', toDesignationMembershipId: 'm', reason: 'r' } },
    ],
  },
  {
    kind: 'disagreeDecision',
    act: (input) => ({ t: 'disagreeDecision', decisionId: 'd-1', input, idempotencyKey: k }),
    variants: [
      { label: 'reject back', input: { path: 'reject_back', reason: 'r' } },
      { label: 'forward on to a role', input: { path: 'forward_on', reason: 'r', toDesignationKind: 'pmc' } },
      { label: 'forward on to a member', input: { path: 'forward_on', reason: 'r', toDesignationKind: 'member', toDesignationMembershipId: 'm' } },
      { label: 'forward on naming no target', input: { path: 'forward_on', reason: 'r' } },
      { label: 'reject back naming a target', input: { path: 'reject_back', reason: 'r', toDesignationKind: 'pmc' } },
      { label: 'forward on to a member naming none', input: { path: 'forward_on', reason: 'r', toDesignationKind: 'member' } },
    ],
  },
  {
    kind: 'resolveStrandedCountersign',
    act: (input) => ({ t: 'resolveStrandedCountersign', decisionId: 'd-1', input, idempotencyKey: k }),
    variants: [
      { label: 'completed', input: { outcome: 'completed', reason: 'r' } },
      { label: 'returned to a member', input: { outcome: 'returned', reason: 'r', toDesignationKind: 'member', toDesignationMembershipId: 'm' } },
      { label: 'returned with no target', input: { outcome: 'returned', reason: 'r' } },
      { label: 'completed naming a target', input: { outcome: 'completed', reason: 'r', toDesignationKind: 'pmc' } },
      { label: 'returned to a role naming a membership', input: { outcome: 'returned', reason: 'r', toDesignationKind: 'pmc', toDesignationMembershipId: 'm' } },
    ],
  },
  {
    kind: 'allocateLabour',
    act: (input) => ({ t: 'allocateLabour', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a worker', input: { activityId: 'a', requirementId: 'r', civilDate: day, workerId: 'w' } },
      { label: 'a crew', input: { activityId: 'a', requirementId: 'r', civilDate: day, crewId: 'c' } },
      { label: 'both a worker and a crew (Codex’s case)', input: { activityId: 'a', requirementId: 'r', civilDate: day, workerId: 'w', crewId: 'c' } },
      { label: 'neither', input: { activityId: 'a', requirementId: 'r', civilDate: day } },
      { label: 'a day that does not exist', input: { activityId: 'a', requirementId: 'r', civilDate: '2026-02-31', workerId: 'w' } },
    ],
  },
  {
    kind: 'recordAttendance',
    act: (input) => ({ t: 'recordAttendance', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a bound device', input: { workerId: 'w', civilDate: day, shift: 'day', deviceId: 'd' } },
      { label: 'a manual reason', input: { workerId: 'w', civilDate: day, shift: 'night', manualReason: 'gate' } },
      { label: 'both', input: { workerId: 'w', civilDate: day, shift: 'day', deviceId: 'd', manualReason: 'gate' } },
      { label: 'neither', input: { workerId: 'w', civilDate: day, shift: 'day' } },
      { label: 'a day that does not exist', input: { workerId: 'w', civilDate: '2026-13-01', shift: 'day', deviceId: 'd' } },
    ],
  },
  {
    kind: 'createLabourRequisition',
    act: (input) => ({ t: 'createLabourRequisition', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a real day', input: { title: 't', lines: [{ requirementId: 'r', revision: 1, civilDate: day, personShiftQty: 1 }] } },
      { label: 'a day that does not exist', input: { title: 't', lines: [{ requirementId: 'r', revision: 1, civilDate: '2026-02-30', personShiftQty: 1 }] } },
      { label: 'a second line on a day that does not exist', input: { title: 't', lines: [{ requirementId: 'r', revision: 1, civilDate: day, personShiftQty: 1 }, { requirementId: 'r', revision: 1, civilDate: '2026-13-01', personShiftQty: 1 }] } },
    ],
  },
  {
    kind: 'setCommercialBudget',
    act: (input) => ({ t: 'setCommercialBudget', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a budget', input: { costHeadCode: 'CIV', amount: '10.00', reason: 'r' } },
      { label: 'a blank head', input: { costHeadCode: ' \t', amount: '10.00', reason: 'r' } },
      { label: 'a blank reason', input: { costHeadCode: 'CIV', amount: '10.00', reason: '  ' } },
    ],
  },
  {
    kind: 'defineCostHead',
    act: (input) => ({ t: 'defineCostHead', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a head', input: { code: 'CIV', name: 'Civil' } },
      { label: 'a blank code', input: { code: ' ', name: 'Civil' } },
      { label: 'a blank name', input: { code: 'CIV', name: '\n' } },
    ],
  },
  {
    kind: 'reattributeCommitment',
    act: (input) => ({ t: 'reattributeCommitment', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a PO line', input: { poLineId: 'p', costHeadCode: 'CIV', reason: 'r' } },
      { label: 'a labour PO line', input: { labourPoLineId: 'l', costHeadCode: 'CIV', reason: 'r' } },
      { label: 'both lines', input: { poLineId: 'p', labourPoLineId: 'l', costHeadCode: 'CIV', reason: 'r' } },
      { label: 'neither line', input: { costHeadCode: 'CIV', reason: 'r' } },
      { label: 'a blank head', input: { poLineId: 'p', costHeadCode: ' ', reason: 'r' } },
    ],
  },
  {
    kind: 'takeMeasurement',
    act: (input) => ({ t: 'takeMeasurement', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a measurement', input: { labourPoLineId: 'l', activityId: 'a', quantity: '1.5', citedOutputId: 'o' } },
      { label: 'a measurement on a day', input: { labourPoLineId: 'l', activityId: 'a', quantity: '1', citedOutputId: 'o', measuredOn: day } },
      { label: 'zero', input: { labourPoLineId: 'l', activityId: 'a', quantity: '0', citedOutputId: 'o' } },
      { label: 'a day that does not exist', input: { labourPoLineId: 'l', activityId: 'a', quantity: '1', citedOutputId: 'o', measuredOn: '2026-02-30' } },
    ],
  },
  {
    kind: 'correctMeasurement',
    act: (input) => ({ t: 'correctMeasurement', input, labourPoLineId: 'l', idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a negative correction', input: { measurementId: 'm', quantity: '-1', reason: 'r' } },
      { label: 'a correction of zero', input: { measurementId: 'm', quantity: '-0.0', reason: 'r' } },
    ],
  },
  {
    kind: 'recordVendorBill',
    act: (input) => ({ t: 'recordVendorBill', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'a bill', input: { vendorId: 'v', vendorBillNumber: 'B-1', documentDate: day, lines: [{ poLineId: 'p', quantity: '1', rate: '10' }] } },
      { label: 'a blank number', input: { vendorId: 'v', vendorBillNumber: ' ', documentDate: day, lines: [{ poLineId: 'p', quantity: '1', rate: '10' }] } },
      { label: 'a day that does not exist', input: { vendorId: 'v', vendorBillNumber: 'B-1', documentDate: '2026-04-31', lines: [{ poLineId: 'p', quantity: '1', rate: '10' }] } },
      { label: 'a line of zero', input: { vendorId: 'v', vendorBillNumber: 'B-1', documentDate: day, lines: [{ poLineId: 'p', quantity: '0', rate: '10' }] } },
      { label: 'a line naming both PO lines', input: { vendorId: 'v', vendorBillNumber: 'B-1', documentDate: day, lines: [{ poLineId: 'p', labourPoLineId: 'l', quantity: '1', rate: '10' }] } },
      { label: 'a line naming neither', input: { vendorId: 'v', vendorBillNumber: 'B-1', documentDate: day, lines: [{ quantity: '1', rate: '10' }] } },
    ],
  },
  {
    kind: 'amendVendorBill',
    act: (input) => ({ t: 'amendVendorBill', input, idempotencyKey: k, coalesceKey: c }),
    variants: [
      { label: 'an amendment', input: { billId: 'b', reason: 'r', lines: [{ labourPoLineId: 'l', quantity: '2', rate: '1' }] } },
      { label: 'a line of zero', input: { billId: 'b', reason: 'r', lines: [{ labourPoLineId: 'l', quantity: '0.000', rate: '1' }] } },
      { label: 'a line naming neither', input: { billId: 'b', reason: 'r', lines: [{ quantity: '2', rate: '1' }] } },
    ],
  },
  {
    kind: 'uploadMedia',
    act: (input) => ({ t: 'uploadMedia', input }),
    variants: [
      { label: 'a progress photo', input: { kind: 'progress', mime: 'image/png', data: 'AA==' } },
      { label: 'a visit photo naming its visit', input: { kind: 'visit', mime: 'image/png', data: 'AA==', siteVisit: { visitId: VISIT } } },
      { label: 'a visit photo naming none', input: { kind: 'visit', mime: 'image/png', data: 'AA==' } },
      { label: 'a progress photo naming a visit', input: { kind: 'progress', mime: 'image/png', data: 'AA==', siteVisit: { visitId: VISIT } } },
    ],
  },
];
type Schema = { safeParse: (v: unknown) => { success: boolean } };
const schemaOf = (kind: OutboxOp['t']): Schema => (contracts as unknown as Record<string, Schema>)[SERVER_SCHEMA_OF[kind]!];

describe('#1071 F4: a stored act the server would refuse by a rule across its fields is not read; one it takes is', () => {
  it('every mirrored kind has its cases here', () => {
    expect(CASES.map((x) => x.kind).sort()).toEqual(Object.keys(SERVER_REFINES_MIRRORED).sort());
  });

  for (const { kind, act, variants } of CASES) {
    it.each(variants.map((v) => [v.label, v] as const))(`${kind}, %s: read exactly when the server's own schema takes it`, (_label, v) => {
      const server = schemaOf(kind).safeParse(v.input).success;
      expect(isKnownOutboxOp(act(v.input))).toBe(server);
    });
    it(`${kind}: its cases hold both an act the server takes and one it refuses`, () => {
      const taken = variants.map((v) => schemaOf(kind).safeParse(v.input).success);
      expect(taken).toContain(true);
      expect(taken).toContain(false);
    });
  }
});

const USER = 'u-eng';
const P2 = 'p-2';
const general = `vitan.outbox.dev:${USER}.${P2}`;
function onP2(raw: string, gw: Record<string, unknown> = {}) {
  localStorage.setItem(general, raw);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
  useStore.getState()._setGateway({ project: P2, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  useStore.getState().hydrateOutbox();
}

afterEach(() => {
  vi.restoreAllMocks();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('#1071 F4: a key holding such an act is set aside, never sent or dropped', () => {
  it('an allocation naming both a worker and a crew: the key is listed, nothing is sent, and Set aside keeps its bytes', async () => {
    const both = { t: 'allocateLabour', input: { activityId: 'a', requirementId: 'r', civilDate: day, workerId: 'w', crewId: 'c' }, idempotencyKey: k, coalesceKey: c };
    const raw = JSON.stringify([both]);
    const allocateLabour = vi.fn(async () => ({}));
    onP2(raw, { allocateLabour });
    expect(useStore.getState().queueUnreadable.map((u) => u.key)).toEqual([general]);
    expect(useStore.getState().outbox).toEqual([]);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(allocateLabour).not.toHaveBeenCalled();
    expect(localStorage.getItem(general)).toBe(raw);
    useStore.getState().setAsideUnreadableQueue();
    const copies = Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${general}.`)).map((x) => localStorage.getItem(x));
    expect(copies).toEqual([raw]);
  });

  it('guard: an allocation the server takes loads and is sent', async () => {
    const one = { t: 'allocateLabour', input: { activityId: 'a', requirementId: 'r', civilDate: day, crewId: 'c' }, idempotencyKey: k, coalesceKey: c };
    const allocateLabour = vi.fn(async () => ({}));
    onP2(JSON.stringify([one]), { allocateLabour });
    expect(useStore.getState().queueUnreadable).toEqual([]);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(allocateLabour).toHaveBeenCalledWith(one.input, k);
  });
});
