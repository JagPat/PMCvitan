import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { CapabilitiesService, MATERIALS_CAPABILITY, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Every civil date a client sends is checked at the edge (live PG).
 *
 *   Eleven fields reach `parseCivilDate`: three query strings (labour capacity `from`
 *   and `to`, labour presence `civilDate`) and eight body fields (labour requisition
 *   `lines[].civilDate`, `promisedDate` on deliveries and labour commitments, commit and
 *   revise, `validUntil` on material and labour quotes, material quote
 *   `lines[].deliveryPromise`). A value that is not a calendar day answers an exact 400
 *   naming the field, never the 500 that `parseCivilDate`'s plain Error used to become.
 *   An empty or absent value keeps today's answer, and a real day still reaches the
 *   domain.
 */

const NOT_ISO = 'Expected an ISO civil date (YYYY-MM-DD)';
const NOT_REAL = 'Not a real calendar date';
const bad = (...message: string[]) => ({ statusCode: 400, error: 'Bad Request', message });

describe('civil-date fields answer 400, not 500 (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;
  let rfqId: string;
  let lineId: string;
  let vendorId: string;

  const RESET_TABLES = ['DomainEvent', 'OutboxDelivery', 'CommandExecution', 'VendorQuoteLine',
    'QuoteComparison', 'VendorQuote', 'Rfq', 'RequisitionLine', 'Requisition',
    'ProjectPartyVendorSource', 'ProjectPartyCompanySource', 'ProjectParty', 'ProjectVendor',
    'LabourDemandSlice', 'LabourRequirementSpec', 'MaterialRequirementSpec',
    'ActivityRequirement', 'ActivityRequirementRoot', 'ProjectCapability'
  ] as const;

  const P = () => f.projectA.id;
  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: P() }) as AuthUser;
  const get = (path: string) =>
    request(t.app.getHttpServer()).get(`/projects/${P()}${path}`).set('Authorization', `Bearer ${token}`);
  const post = (path: string, body: object) =>
    request(t.app.getHttpServer()).post(`/projects/${P()}${path}`).set('Authorization', `Bearer ${token}`).send(body);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    token = t.issueProjectToken(f.memberUser.id, P());
    const capabilities = t.app.get(CapabilitiesService);
    await capabilities.enable(P(), MATERIALS_CAPABILITY, f.memberUser.id);
    await capabilities.enable(P(), LABOUR_CAPABILITY, f.memberUser.id);
    // A live RFQ with a bound vendor, so a valid deliveryPromise is recorded (201).
    const activityId = `IT-CIV-${Date.now() % 1e6}`;
    await t.prisma.activity.create({ data: { id: activityId, projectId: P(), name: 'Civil act', zone: 'Z', plannedStart: 0, plannedEnd: 10 } });
    const requirement = await t.app.get(RequirementsService).create(P(), {
      type: 'material', activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty: '100', requiredBy: '2026-08-15', criticality: 'normal', decisionId: null,
      responsibleId: null, tolerance: null
    }, pmc());
    const procurement = t.app.get(ProcurementService);
    const draft = await procurement.createRequisition(P(), {
      title: 'Civil req', lines: [{ requirementId: requirement.requirementId, revision: requirement.revision, qty: '100' }]
    }, pmc());
    await procurement.submit(P(), draft.id, pmc());
    const requisition = await procurement.approve(P(), draft.id, pmc());
    lineId = requisition.lines[0]!.id;
    rfqId = (await procurement.createRfq(P(), { requisitionId: requisition.id }, pmc())).id;
    const vendors = t.app.get(VendorsService);
    const vendor = await vendors.create(f.orgA.id, { name: `Civil vendor ${Date.now() % 1e6}` }, { sub: f.ownerUser.id, role: 'pmc' } as AuthUser);
    await vendors.bind(P(), { vendorId: vendor.id }, pmc());
    vendorId = vendor.id;
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, RESET_TABLES, { cascade: true });
    await t?.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await t?.prisma.activity.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await f?.cleanup();
    await t?.close();
  });

  const materialLine = { requisitionLineId: 'l', baseRate: '1.00', taxAmount: '0.00', freightAmount: '0.00', landedCost: '1.00', quotedMake: 'm', matchesSpecification: true };
  const labourLine = { requisitionLineId: 'l', ratePerPersonShift: '1.00', shiftPremium: '0.00', landedPerPersonShift: '1.00', matchesSpecification: true };

  // Each field: the path its issues name, how to send a value, and what an empty value
  // and a real day answer today (status, message).
  const FIELDS: {
    field: string; path: string; send: (v: string) => request.Test;
    empty: [number, unknown]; real: [number, unknown];
  }[] = [
    { field: 'GET labour/capacity ?from', path: 'from', send: (v) => get(`/labour/capacity?from=${encodeURIComponent(v)}`),
      empty: [200, undefined], real: [200, undefined] },
    { field: 'GET labour/capacity ?to', path: 'to', send: (v) => get(`/labour/capacity?to=${encodeURIComponent(v)}`),
      empty: [200, undefined], real: [200, undefined] },
    { field: 'GET labour/presence ?civilDate', path: 'civilDate', send: (v) => get(`/labour/presence?civilDate=${encodeURIComponent(v)}`),
      empty: [400, 'civilDate must be an ISO civil date'], real: [200, undefined] },
    { field: 'POST labour/requisitions lines[].civilDate', path: 'lines.0.civilDate',
      send: (v) => post('/labour/requisitions', { title: 't', lines: [{ requirementId: 'r-none', revision: 1, civilDate: v, personShiftQty: 1 }] }),
      empty: [400, ['lines.0.civilDate: String must contain at least 1 character(s)']],
      real: [400, 'Requirement revision carries no labour specification (labour-only pipeline)'] },
    { field: 'POST labour/rfqs/:id/quotes validUntil', path: 'validUntil',
      send: (v) => post('/labour/rfqs/rfq-none/quotes', { vendorId: 'v-none', validUntil: v, lines: [labourLine] }),
      empty: [400, ['validUntil: String must contain at least 1 character(s)']],
      real: [400, 'rfqId does not belong to this project'] },
    { field: 'POST labour/commitments promisedDate', path: 'promisedDate',
      send: (v) => post('/labour/commitments', { poLineId: 'pl-none', promisedDate: v }),
      empty: [400, ['promisedDate: String must contain at least 1 character(s)']],
      real: [404, 'Labour purchase order line not found in this project'] },
    { field: 'POST labour/commitments/:id/revise promisedDate', path: 'promisedDate',
      send: (v) => post('/labour/commitments/c-none/revise', { promisedDate: v, reason: 'r' }),
      empty: [400, ['promisedDate: String must contain at least 1 character(s)']],
      real: [409, 'Only a live (committed/revised) capacity commitment can be revised — reload and retry'] },
    { field: 'POST deliveries promisedDate', path: 'promisedDate',
      send: (v) => post('/deliveries', { poLineId: 'pl-none', promisedDate: v }),
      empty: [400, ['promisedDate: String must contain at least 1 character(s)']],
      real: [404, 'Purchase order line not found in this project'] },
    { field: 'POST deliveries/:id/revise promisedDate', path: 'promisedDate',
      send: (v) => post('/deliveries/c-none/revise', { promisedDate: v, reason: 'r' }),
      empty: [400, ['promisedDate: String must contain at least 1 character(s)']],
      real: [409, 'Only a live (committed/revised) delivery commitment can be revised — reload and retry'] },
    { field: 'POST rfqs/:id/quotes validUntil', path: 'validUntil',
      send: (v) => post('/rfqs/rfq-none/quotes', { vendorId: 'v-none', validUntil: v, lines: [materialLine] }),
      empty: [400, ['validUntil: String must contain at least 1 character(s)']],
      real: [400, 'rfqId does not belong to this project'] },
    { field: 'POST rfqs/:id/quotes lines[].deliveryPromise', path: 'lines.0.deliveryPromise',
      send: (v) => post(`/rfqs/${rfqId}/quotes`, { vendorId, validUntil: '2027-01-01', lines: [{ ...materialLine, requisitionLineId: lineId, deliveryPromise: v }] }),
      empty: [400, ['lines.0.deliveryPromise: String must contain at least 1 character(s)']],
      real: [201, undefined] },
  ];

  it.each(FIELDS)('$field: a value that is not a calendar day answers an exact 400', async ({ path, send }) => {
    const nope = await send('nope');
    expect([nope.status, nope.body]).toEqual([400, bad(`${path}: ${NOT_ISO}`, `${path}: ${NOT_REAL}`)]);
    for (const v of ['2026-02-30', '2026-13-01']) {
      const res = await send(v);
      expect([v, res.status, res.body]).toEqual([v, 400, bad(`${path}: ${NOT_REAL}`)]);
    }
  });

  it.each(FIELDS)('$field: empty keeps today\'s answer and a real day reaches the domain', async ({ send, empty, real }) => {
    for (const [v, [status, message]] of [['', empty], ['2026-10-01', real]] as const) {
      const res = await send(v);
      expect([v, res.status]).toEqual([v, status]);
      if (message !== undefined) expect(res.body.message).toEqual(message);
    }
  });

  it('presence with no civilDate keeps its 400', async () => {
    const res = await get('/labour/presence');
    expect([res.status, res.body]).toEqual([400, { statusCode: 400, error: 'Bad Request', message: 'civilDate must be an ISO civil date' }]);
  });

  it('a padded query date is a 400 (bodies trim, query strings do not)', async () => {
    for (const [query, path] of [['/labour/capacity?from=', 'from'], ['/labour/capacity?to=', 'to'], ['/labour/presence?civilDate=', 'civilDate']]) {
      const res = await get(`${query}${encodeURIComponent(' 2026-10-01')}`);
      expect([path, res.status, res.body]).toEqual([path, 400, bad(`${path}: ${NOT_ISO}`, `${path}: ${NOT_REAL}`)]);
    }
    const body = await post('/deliveries', { poLineId: 'pl-none', promisedDate: ' 2026-10-01' });
    expect([body.status, body.body.message]).toEqual([404, 'Purchase order line not found in this project']);
  });

  it('a checked window reaches the service as from and to, and other query keys are still ignored', async () => {
    const spy = vi.spyOn(t.app.get(LabourCapacityService), 'capacity');
    try {
      const res = await get('/labour/capacity?from=2026-10-01&to=2026-10-31&x=1');
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(P(), expect.anything(), '2026-10-01', '2026-10-31');
    } finally {
      spy.mockRestore();
    }
    const presence = await get('/labour/presence?civilDate=2026-10-01&x=1');
    expect([presence.status, presence.body.civilDate]).toEqual([200, '2026-10-01']);
  });
});
