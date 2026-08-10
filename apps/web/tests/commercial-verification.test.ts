import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { arbitrateBillCopy, transitionOffered } from '@/lib/billLifecycle';
import {
  billTransitionCoalesceKey, readClearsKey, sodGrantCoalesceKey, commercialWriteBlocked,
  COMMERCIAL_OUTBOX_OP_TYPES, normalizeCommercialOutbox,
  deductionCoalesceKey, deductionReleaseCoalesceKey, approveCoalesceKey, payCoalesceKey,
  reverseCoalesceKey, advanceCoalesceKey,
} from '@/lib/commercialKeys';
import { BILL_BEGIN_VERIFICATION_FROM, BILL_VERIFY_FROM } from '@vitan/shared';
import billServiceSource from '../../api/src/commercial/commercial-bill.service.ts?raw';
import gatewaySource from '@/data/apiGateway.ts?raw';
import controllerSource from '../../api/src/commercial/commercial.controller.ts?raw';
import verificationServiceSource from '../../api/src/commercial/commercial-verification.service.ts?raw';
import type { ApiGateway } from '@/data/apiGateway';

/**
 * Phase 5 Task 7B-iii-c-i (§E/§F) — the VERIFICATION CHAIN: `begin-verification` then `verify`.
 *
 * Two transitions on a claim already lodged and submitted by 7B-iii-b/e, under a DIFFERENT
 * authority: `commercial.verify` is pmc-only, and `commercial.bill` admits `engineer`. That
 * separation is the unit's subject, not an incidental detail — §E's whole point is that the actor
 * who claims is not the actor who verifies.
 *
 * Neither command takes a verdict as input. §E DERIVES the three-way check server-side, so `verify`
 * records what the check found and moves the claim to `verified` or `disputed` accordingly; there
 * is nothing for an operator to type, and a form offering a verdict would be inventing one.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const copy = (status: string, statusChangedAt: string) => ({ status, statusChangedAt });

describe('§F — one arbitration rule for both surfaces that act on a claim lifecycle', () => {
  /**
   * The rule itself, at the level it is written. The Claims tab derived it inline through PR #306's
   * six rounds; this unit adds transition controls to the Certification tab, which renders the
   * CLAIM copy — the one that can be older. Extracting the rule is what makes the second surface
   * unable to disagree with the first, so the extraction is worth pinning directly.
   */
  it('prefers the copy with the later server stamp, in EITHER direction', () => {
    const later = copy('verified', '2026-08-21T00:00:02.000Z');
    const earlier = copy('submitted', '2026-08-21T00:00:01.000Z');
    expect(arbitrateBillCopy(earlier, later)).toMatchObject({ copy: later, ambiguous: false, source: 'claim' });
    expect(arbitrateBillCopy(later, earlier)).toMatchObject({ copy: later, ambiguous: false, source: 'list' });
  });

  it('EQUAL stamp + SAME status is agreement, not a tie', () => {
    const a = copy('submitted', '2026-08-21T00:00:01.000Z');
    const b = copy('submitted', '2026-08-21T00:00:01.000Z');
    expect(arbitrateBillCopy(a, b)?.ambiguous).toBe(false);
    // …and it says so: round 4's regression came from inferring "is the bundle current?" from
    // WHICH OBJECT came back, when agreement deliberately returns the list one
    expect(arbitrateBillCopy(a, b)?.source).toBe('agreed');
  });

  /**
   * The round-6 finding, kept RED-able. `statusChangedAt` is `new Date()` at millisecond precision,
   * so two DIFFERENT transitions can share one stamp: certify at T, approve at T, a claim read
   * taken between them ties with a list read taken after. Breaking the tie toward EITHER copy is a
   * total order the data does not carry, and toward the claim copy it regresses the row.
   */
  it('EQUAL stamp + DIFFERING status is undecidable, and this refuses to decide', () => {
    const list = copy('approved-for-payment', '2026-08-21T00:00:01.000Z');
    const claim = copy('certified', '2026-08-21T00:00:01.000Z');
    const reading = arbitrateBillCopy(list, claim);
    expect(reading?.ambiguous).toBe(true);
    // shows the LIST copy — never the claim copy, which is the one that can be older
    expect(reading?.copy).toBe(list);
  });

  it('an UNPARSEABLE stamp orders nothing, and says so rather than silently picking one', () => {
    // `Date.parse` answers NaN and every NaN comparison is false, so a naive `>` falls through to
    // whichever copy the code happens to name last — deciding anyway, by a different route.
    const list = copy('submitted', 'not-a-date');
    const claim = copy('verified', '2026-08-21T00:00:01.000Z');
    expect(arbitrateBillCopy(list, claim)?.ambiguous).toBe(true);
    // agreement still is not a tie, even with no order between them
    expect(arbitrateBillCopy(copy('submitted', 'x'), copy('submitted', 'y'))?.ambiguous).toBe(false);
  });

  it('ONE copy is authoritative; NO copy offers nothing', () => {
    const only = copy('submitted', '2026-08-21T00:00:01.000Z');
    expect(arbitrateBillCopy(only, null)).toMatchObject({ copy: only, ambiguous: false, source: 'list' });
    expect(arbitrateBillCopy(null, only)).toMatchObject({ copy: only, ambiguous: false, source: 'claim' });
    // and a control with no reading at all acts on nothing
    expect(arbitrateBillCopy(null, null)).toBeNull();
    expect(transitionOffered(null, BILL_VERIFY_FROM)).toBe(false);
  });

  it('a transition is offered only where the SERVER admits it, and never while ambiguous', () => {
    const at = '2026-08-21T00:00:01.000Z';
    for (const status of ['draft', 'submitted', 'under-verification', 'verified', 'disputed', 'certified']) {
      const reading = arbitrateBillCopy(copy(status, at), null);
      expect(transitionOffered(reading, BILL_BEGIN_VERIFICATION_FROM))
        .toBe(status === 'submitted');
      expect(transitionOffered(reading, BILL_VERIFY_FROM))
        .toBe(status === 'under-verification');
    }
    // and the admissible status alone is not enough: an undecidable pair offers neither
    const ambiguous = arbitrateBillCopy(copy('submitted', at), copy('under-verification', at));
    expect(ambiguous?.ambiguous).toBe(true);
    expect(transitionOffered(ambiguous, BILL_BEGIN_VERIFICATION_FROM)).toBe(false);
    expect(transitionOffered(ambiguous, BILL_VERIFY_FROM)).toBe(false);
  });
});

describe('§E/§F — the admissible sets are the SERVICE\'s, not a copy of them', () => {
  /**
   * The round-5 lesson applied before the guard was written rather than after: a form that restates
   * a transition rule is a second copy of it, and the copies drift. Both services READ the shared
   * constant, so the screen and the server cannot answer differently — and a source tripwire is
   * what keeps a future edit from quietly reintroducing the inline literal.
   */
  it('`commercial-bill.service` guards begin-verification with the SHARED constant', () => {
    expect(billServiceSource).toContain('BILL_BEGIN_VERIFICATION_FROM');
    expect(billServiceSource).toContain('from: [...BILL_BEGIN_VERIFICATION_FROM]');
    // the literal it replaced must not be back
    expect(billServiceSource).not.toContain("from: ['submitted']");
  });

  it('`commercial-verification.service` guards verify with the SHARED constant', () => {
    expect(verificationServiceSource).toContain('BILL_VERIFY_FROM');
    expect(verificationServiceSource).not.toContain("['under-verification'].includes(bill.status)");
  });
});

describe('§M — the verification chain on the two-key outbox lifecycle', () => {
  let calls: string[];
  beforeEach(() => {
    useStore.setState(getInitialState());
    calls = [];
    useStore.setState({
      capabilities: ['commercial'],
      role: 'pmc',
      activeProjectId: 'p-1',
      online: false, // hold the ops in the queue so the DISPATCH is what is under test
    });
    const gw = {
      beginVerification: vi.fn(async (i: { billId: string }) => { calls.push(`begin:${i.billId}`); }),
      verifyVendorBill: vi.fn(async (i: { billId: string }) => { calls.push(`verify:${i.billId}`); }),
    } as unknown as ApiGateway;
    s()._setGateway(gw);
  });

  const keys = () => s().outbox.flatMap((o) => {
    const k = (o as { coalesceKey?: unknown }).coalesceKey;
    return typeof k === 'string' ? [k] : [];
  });

  it('each dispatch queues ONE command under a FRESH idempotency key', () => {
    s().beginVerification('bill-1');
    expect(keys()).toEqual([billTransitionCoalesceKey('bill-1', 'begin-verification')]);
    const first = (s().outbox[0] as { idempotencyKey: string }).idempotencyKey;
    expect(first.length).toBeGreaterThan(0);
    // a second, DIFFERENT claim is an independent action with its own key
    s().beginVerification('bill-2');
    const second = (s().outbox[1] as { idempotencyKey: string }).idempotencyKey;
    expect(second).not.toBe(first);
  });

  /**
   * The claim is the constrained resource, not the verb — labour round 5 / J2, and by this unit its
   * FOURTH instance. Keyed per verb, a queued `verify` could sit beside a pending
   * `begin-verification` and the server would terminally 4xx whichever lost, AFTER the write-ahead
   * outbox told the user both were saved.
   *
   * `commercialWriteBlocked` derives the conflicting verb set from the KEY SHAPE rather than
   * restating it, so the two verbs this unit adds are covered without editing the rule — which is
   * what this asserts, since a restated list is exactly what a new transition forgets.
   */
  it('a pending transition blocks EVERY other transition on the same claim, both directions', () => {
    s().beginVerification('bill-1');
    s().verifyVendorBill('bill-1');
    s().submitVendorBill('bill-1');
    s().rejectVendorBill('bill-1', 'no');
    expect(keys()).toEqual([billTransitionCoalesceKey('bill-1', 'begin-verification')]);

    // the reverse order is the same rule, not a second one
    useStore.setState({ outbox: [], commercialPending: [] });
    s().verifyVendorBill('bill-1');
    s().beginVerification('bill-1');
    expect(keys()).toEqual([billTransitionCoalesceKey('bill-1', 'verify')]);

    // …and a DIFFERENT claim is not blocked: the resource is the claim
    s().beginVerification('bill-2');
    expect(keys()).toHaveLength(2);
  });

  /**
   * Codex J1's defence in depth, on the permission this unit introduces. The screen hides the
   * control, but the outbox is DURABLE and the dispatcher is reachable without the screen — and an
   * op queued without authority is not merely refused, it is refused AFTER the user was told it was
   * saved. `commercial.verify` is the first commercial permission an `engineer` holding
   * `commercial.bill` does NOT have, so this is the case where the map does real work.
   */
  it('an ENGINEER queues nothing, though the same actor may lodge and submit', () => {
    useStore.setState({ role: 'engineer' });
    s().beginVerification('bill-1');
    s().verifyVendorBill('bill-1');
    expect(s().outbox).toHaveLength(0);
    // the same actor's own workflow is untouched — this is a separation, not a lockout
    s().submitVendorBill('bill-1');
    expect(keys()).toEqual([billTransitionCoalesceKey('bill-1', 'submit')]);
  });

  it('is inert off the commercial pilot', () => {
    useStore.setState({ capabilities: [] });
    s().beginVerification('bill-1');
    s().verifyVendorBill('bill-1');
    expect(s().outbox).toHaveLength(0);
  });

  it('replays each queued command through its OWN route, and reconciles the claim after', async () => {
    // the reconcile is part of the lifecycle, so the stub carries the reads it fires — a settled
    // transition that did NOT re-read the claim would leave the pre-command status on screen
    const reads: string[] = [];
    s()._setGateway({
      beginVerification: vi.fn(async (i: { billId: string }) => { calls.push(`begin:${i.billId}`); }),
      verifyVendorBill: vi.fn(async (i: { billId: string }) => { calls.push(`verify:${i.billId}`); }),
      commercialMoneyPosition: vi.fn(async () => { reads.push('money'); throw new Error('read boundary, not under test'); }),
      commercialBills: vi.fn(async () => { reads.push('bills'); throw new Error('read boundary, not under test'); }),
      commercialClaim: vi.fn(async () => { reads.push('claim'); throw new Error('read boundary, not under test'); }),
    } as unknown as ApiGateway);
    useStore.setState({ commercialClaimLoad: { 'bill-1': 'ready' } });

    const firstKey = (() => { s().beginVerification('bill-1'); return (s().outbox[0] as { idempotencyKey: string }).idempotencyKey; })();
    useStore.setState({ online: true });
    await s().flushOutbox();
    await flush();
    expect(calls).toEqual(['begin:bill-1']);
    expect(reads).toContain('claim');

    // a NEXT deliberate action is a different operation and mints its own key; the first key is
    // reused only on a RETRY of the same op, which is what makes the replay exactly-once
    useStore.setState({ outbox: [], commercialPending: [], online: false });
    s().verifyVendorBill('bill-1');
    expect((s().outbox[0] as { idempotencyKey: string }).idempotencyKey).not.toBe(firstKey);
  });

  it('the two op types are commercial ops, so hydration and the reconcile cover them', () => {
    expect(COMMERCIAL_OUTBOX_OP_TYPES).toContain('beginVerification');
    expect(COMMERCIAL_OUTBOX_OP_TYPES).toContain('verifyVendorBill');
    const ops = [
      { t: 'beginVerification', idempotencyKey: 'i1', coalesceKey: billTransitionCoalesceKey('b', 'begin-verification') },
      { t: 'verifyVendorBill', idempotencyKey: 'i2', coalesceKey: billTransitionCoalesceKey('b', 'verify') },
      { t: 'verifyVendorBill', idempotencyKey: 'i3' }, // malformed — no coalesce key was ever released
    ];
    const { ops: kept, changed } = normalizeCommercialOutbox(ops);
    expect(kept).toHaveLength(2);
    expect(changed).toBe(true);
  });
});

describe('Q-a — a read releases a key only if it could have OBSERVED the write', () => {
  /**
   * Q-a found this on the line register and fixed it THERE, as a field of one variant. That made
   * causality a property of one read rather than of reading: the money, list and claim reads
   * cleared their keys with no causality term at all.
   *
   * The interleaving it leaves open, on this unit's own transitions: open a claim, queue
   * `begin-verification`, let it commit, and a claim read that STARTED before the commit lands
   * afterwards carrying `submitted`. It clears the key, the button re-enables over a status that is
   * already stale, and a second `begin-verification` enters the durable outbox to be dropped on a
   * terminal 409 — after being reported saved.
   *
   * Holding a key too long is recoverable: the reconcile starts a fresh read that releases it.
   */
  it('a stale BILLS read releases nothing; a fresh one releases', () => {
    const key = billTransitionCoalesceKey('bill-1', 'begin-verification');
    expect(readClearsKey(key, { read: 'bills', observedWrite: false })).toBe(false);
    expect(readClearsKey(key, { read: 'bills', observedWrite: true })).toBe(true);
  });

  it('a stale CLAIM read releases nothing; a fresh one releases', () => {
    const key = billTransitionCoalesceKey('bill-1', 'verify');
    expect(readClearsKey(key, { read: 'claim', billId: 'bill-1', observedWrite: false })).toBe(false);
    expect(readClearsKey(key, { read: 'claim', billId: 'bill-1', observedWrite: true })).toBe(true);
    // and still only for the claim it names — N1 is not weakened by the causality term
    expect(readClearsKey(key, { read: 'claim', billId: 'bill-2', observedWrite: true })).toBe(false);
  });

  it('a stale MONEY read releases nothing; a fresh one releases', () => {
    expect(readClearsKey('com:head:CIVIL', { read: 'money', observedWrite: false })).toBe(false);
    expect(readClearsKey('com:head:CIVIL', { read: 'money', observedWrite: true })).toBe(true);
  });

  /**
   * What the store-level probe below actually establishes, stated honestly rather than claimed.
   *
   * I wrote it first as a causality reproduction — hold a claim read across a settling write, then
   * assert the key survives — and it passed with the causality guard MUTATED OUT. The reason is
   * that the flush reconcile unconditionally re-reads every open claim, list and the money after a
   * commercial write settles, which bumps each per-resource token; the held read then loses
   * OWNERSHIP and applies nothing at all. On today's read paths the two defences overlap, so a
   * probe through the store cannot separate them and one that claimed to would be measuring
   * ownership while reporting causality.
   *
   * So the two are pinned where each is decidable. The causality term is pinned above, at the level
   * it is written; ownership is pinned here. And the term is REQUIRED on every variant of
   * `CommercialRead` rather than optional, because the overlap is a property of today's four read
   * paths and not of the rule: a future read that does not go through the reconcile — a socket
   * handler, a manual Retry, a fifth resource — would have causality as its only defence, and a
   * field the compiler demands is the only kind a new call site cannot forget.
   */
  it('a SUPERSEDED read applies nothing and releases nothing', async () => {
    useStore.setState(getInitialState());
    let release: ((v: unknown) => void) | null = null;
    const held = new Promise((r) => { release = r; });
    const claimDto = (status: string) => ({
      bill: {
        id: 'bill-1', vendorId: 'v-1', vendorBillNumber: 'V-1', status,
        documentDate: '2026-08-20', statusChangedAt: '2026-08-21T00:00:00.000Z',
        statusReason: null, disputeReason: null, createdAt: '2026-08-20T00:00:00.000Z',
        createdById: 'u-1', versions: [],
      },
      verification: { billId: 'bill-1', versionId: 'v', verdict: 'matched', lines: [], exceptions: [], billStatus: status },
      certificate: null,
      deductions: { billId: 'bill-1', certificateId: null, certifiedAmount: null, deductions: [], withheld: '0.00', netPayable: null, billStatus: status, advance: { vendorId: 'v-1', advanced: '0.00', recovered: '0.00', recoverable: '0.00' } },
      payments: { billId: 'bill-1', certificateId: null, approvals: [], approved: '0.00', paid: '0.00', approvable: null, billStatus: status },
      measurements: {},
    });
    let call = 0;
    const gw = {
      // the FIRST read is held and carries pre-write truth; the second answers immediately
      commercialClaim: vi.fn(async () => {
        call += 1;
        if (call === 1) { await held; return claimDto('submitted'); }
        return claimDto('under-verification');
      }),
    } as unknown as ApiGateway;
    useStore.setState({ capabilities: ['commercial'], role: 'pmc', activeProjectId: 'p-1' });
    s()._setGateway(gw);

    const stale = s().loadCommercialClaim('bill-1');   // starts first…
    const fresh = s().loadCommercialClaim('bill-1');   // …and is superseded before it lands
    await fresh;
    await flush();
    expect(s().commercialClaims['bill-1']?.bill.status).toBe('under-verification');

    release!(null);
    await stale;
    await flush();
    // the older read never overwrites the newer truth, in EITHER direction (the labour hub needed
    // a finding to learn that a late FAILURE must not overwrite a newer success either)
    expect(s().commercialClaims['bill-1']?.bill.status).toBe('under-verification');
    expect(s().commercialClaimLoad['bill-1']).toBe('ready');
  });
});

describe('Task 7B-iii-f (§F/§I) — the certification authority chain', () => {
  let calls: string[];
  beforeEach(() => {
    useStore.setState(getInitialState());
    calls = [];
    useStore.setState({
      capabilities: ['commercial'], role: 'pmc', activeProjectId: 'p-1', online: false,
    });
    s()._setGateway({
      certifyBill: vi.fn(async (i: { billId: string }) => { calls.push(`certify:${i.billId}`); }),
      supersedeCertificate: vi.fn(async (i: { billId: string }) => { calls.push(`supersede:${i.billId}`); }),
      // the flush reconcile re-reads commercial truth after any commercial write settles; these
      // are read boundaries, not what these probes are about
      commercialMoneyPosition: vi.fn(async () => { throw new Error('read boundary'); }),
      commercialBills: vi.fn(async () => { throw new Error('read boundary'); }),
      commercialClaim: vi.fn(async () => { throw new Error('read boundary'); }),
      // Every replay chains a snapshot, and a throwing one is a TRANSIENT error that stops the
      // flush — so without this the probe would have silently only ever exercised the first
      // command. It answers a snapshot for a DIFFERENT project, which `acceptSnapshot` discards as
      // out-of-scope on its first check: the replay path is what is under test here, not snapshot
      // application, and a stub that applied would be reaching past the boundary.
      snapshot: vi.fn(async () => ({ project: { id: 'not-this-project' } })),
    } as unknown as ApiGateway);
  });

  const keys = () => s().outbox.flatMap((o) => {
    const k = (o as { coalesceKey?: unknown }).coalesceKey;
    return typeof k === 'string' ? [k] : [];
  });

  /**
   * Certify and supersede are transitions on the CLAIM, so they join the existing conflict rule and
   * a pending verify blocks them — the claim is the constrained resource, not the verb.
   */
  it('certify and supersede join the CLAIM-wide transition conflict', () => {
    s().beginVerification('bill-1');
    s().certifyBill('bill-1', 'ver-1', 3);
    s().supersedeCertificate('bill-1', 'wrong quantity', 'cert-1');
    expect(keys()).toEqual([billTransitionCoalesceKey('bill-1', 'begin-verification')]);

    useStore.setState({ outbox: [], commercialPending: [] });
    s().certifyBill('bill-1', 'ver-1', 3);
    s().verifyVendorBill('bill-1');
    expect(keys()).toEqual([billTransitionCoalesceKey('bill-1', 'certify')]);
  });

  /**
   * An authorisation is NOT a claim transition, and keying it on the claim would be a real defect:
   * an approver authorising Ravi has not authorised Sunil, the server records a separate grant for
   * each, and coalescing the second away would leave the approver believing they had granted
   * something they had not. Labour round 5 inverted — there the key was too NARROW for a shared
   * resource; here it would be too WIDE for independent ones.
   */

  it('each command carries its OWN authority, and they are not interchangeable', () => {
    // `commercial.certify` and `commercial.sod.grant` both resolve to pmc today, so a role probe
    // cannot separate them; what CAN be asserted is that the dispatcher reads the policy per
    // command rather than one blanket answer — a contractor holds none of the three.
    useStore.setState({ role: 'contractor' });
    s().certifyBill('bill-1', 'ver-1', 3);
    s().supersedeCertificate('bill-1', 'why', 'cert-1');
    expect(s().outbox).toHaveLength(0);
  });

  it('is inert off the commercial pilot', () => {
    useStore.setState({ capabilities: [] });
    s().certifyBill('bill-1', 'ver-1', 3);
    s().supersedeCertificate('bill-1', 'why', 'cert-1');
    expect(s().outbox).toHaveLength(0);
  });

  it('replays each through its OWN route under its original key', async () => {
    s().certifyBill('bill-1', 'ver-1', 3);
    useStore.setState({ online: true });
    await s().flushOutbox();
    await flush();
    expect(calls).toEqual(['certify:bill-1']);
  });


  it('the three op types are commercial ops, so hydration and the reconcile cover them', () => {
    for (const t of ['certifyBill', 'supersedeCertificate']) {
      expect(COMMERCIAL_OUTBOX_OP_TYPES).toContain(t);
    }
  });
});

describe('7B-iii-f correction — the acts carry the facts they were decided on', () => {
  /**
   * The root the corrections turn on: a queued command replays against whatever is live when the
   * outbox drains, not against what the user was looking at when they decided. Round 1 pinned one
   * command and left its two siblings — fixing the instance a finding named instead of the class
   * it belongs to, which is the root `docs/reviews/pr-310-convergence.md` names.
   */
  beforeEach(() => {
    useStore.setState(getInitialState());
    useStore.setState({ capabilities: ['commercial'], role: 'pmc', activeProjectId: 'p-1', online: false });
    s()._setGateway({} as unknown as ApiGateway);
  });

  it('round-5: certify carries the claim REVISION it was authored against', () => {
    // The server contract requires it, and the reason the client half is pinned separately is that
    // a missing field here does not fail to compile — it arrives as `undefined`, the boundary
    // rejects it, and the failure surfaces to a certifier as a mysterious refusal rather than to us
    // as a red test. A version id cannot stand in for it: one version walks the whole payment
    // lifecycle, so `verified → certified → superseded → verified` matches the same id twice.
    s().certifyBill('bill-1', 'ver-7', 3);
    expect((s().outbox[0] as { input: { lifecycleVersion?: number } }).input.lifecycleVersion)
      .toBe(3);
  });

  it('round-2: certify carries the version READ, and supersede the certificate READ', () => {
    s().certifyBill('bill-1', 'ver-7', 3);
    expect((s().outbox[0] as { input: { versionId?: string } }).input.versionId).toBe('ver-7');
    useStore.setState({ outbox: [], commercialPending: [] });
    s().supersedeCertificate('bill-1', 'wrong quantity', 'cert-3');
    expect((s().outbox[0] as { input: { certificateId?: string } }).input.certificateId).toBe('cert-3');
  });


});

describe('§I (7B-iii-g) — an authorisation is independent of other GRANTS, not of the CLAIM', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    useStore.setState({
      capabilities: ['commercial'], role: 'pmc', activeProjectId: 'p-1', online: false,
    });
    s()._setGateway({ grantSodException: vi.fn(async () => {}) } as unknown as ApiGateway);
  });
  const keys = () => s().outbox.flatMap((o) => {
    const k = (o as { coalesceKey?: unknown }).coalesceKey;
    return typeof k === 'string' ? [k] : [];
  });
  const viewed = { versionId: 'ver-1', status: 'verified', lifecycleVersion: 4 };

  /**
   * R5-1, the finding this unit exists to close, asserted on the RULE rather than on a screen.
   *
   * The per-PERSON key was right and stays. What was carried one step too far is concluding that a
   * grant therefore conflicts with nothing: an authorisation PINS the claim's version, status and
   * revision, and a queued transition is precisely a command that moves all three. Queued behind
   * one, the grant is written against facts that are already gone — and the user was told it saved.
   */
  it('a pending claim transition BLOCKS a new authorisation on that claim', () => {
    expect(commercialWriteBlocked(
      sodGrantCoalesceKey('bill-1', 'u-2'), [billTransitionCoalesceKey('bill-1', 'certify')],
    ), 'a certify in flight is about to move every fact the grant pins').toBe(true);
    // …and the dispatcher REFUSES it, not merely the screen. An op it accepts has already been
    // persisted and reported as saved (Codex J1).
    s().certifyBill('bill-1', 'ver-1', 4);
    s().grantSodException('bill-1', 'u-2', 'only pmc on site', viewed);
    expect(keys()).toEqual([billTransitionCoalesceKey('bill-1', 'certify')]);
  });

  it('…but two authorisations for DIFFERENT people on one claim are independent', () => {
    s().grantSodException('bill-1', 'u-2', 'only pmc on site', viewed);
    s().grantSodException('bill-1', 'u-3', 'covering leave', viewed);
    expect(keys()).toEqual([
      sodGrantCoalesceKey('bill-1', 'u-2'), sodGrantCoalesceKey('bill-1', 'u-3'),
    ]);
    // and an EQUIVALENT one while pending still coalesces — the per-person key is a coalesce key
    s().grantSodException('bill-1', 'u-2', 'only pmc on site', viewed);
    expect(keys()).toHaveLength(2);
  });

  /** ONE-DIRECTIONAL by design: a certify arriving before its authorisation is refused by the
   *  server for a reason that is true and legible, not silently mis-pinned. */
  it('a pending authorisation does NOT block a claim transition', () => {
    expect(commercialWriteBlocked(
      billTransitionCoalesceKey('bill-1', 'certify'), [sodGrantCoalesceKey('bill-1', 'u-2')],
    )).toBe(false);
  });

  it('the authorisation carries the three facts its approver was looking at', () => {
    s().grantSodException('bill-1', 'u-2', 'only pmc on site', viewed);
    expect((s().outbox[0] as unknown as { input: Record<string, unknown> }).input).toMatchObject({
      billId: 'bill-1', actorId: 'u-2', reason: 'only pmc on site',
      versionId: 'ver-1', status: 'verified', lifecycleVersion: 4,
    });
  });

  it('a role without the granting authority queues NOTHING, even bypassing the screen', () => {
    useStore.setState({ role: 'engineer' });
    s().grantSodException('bill-1', 'u-2', 'only pmc on site', viewed);
    expect(s().outbox).toHaveLength(0);
  });

  /** Round 1, finding 1 — the client posted to a route the server does not expose, so every
   *  authorisation 404'd and the outbox discarded it as terminal AFTER reporting it saved. The
   *  route is pinned against the controller's own decorator rather than restated, because a
   *  restated constant is what drifted. */
  it('posts to the route the API controller actually exposes', () => {
    expect(gatewaySource).toContain("this.cmd('/commercial/bills/sod-grant'");
    expect(controllerSource, 'the server decorator is the source of truth for this path')
      .toContain("@Post('commercial/bills/sod-grant')");
  });

  /** Round 1, finding 2 — a key with no release path is not pending, it is stuck: the op settles,
   *  the read lands, and the button stays disabled until a hydration or a scope change. */
  it('the settling read RELEASES the authorisation key', () => {
    expect(readClearsKey('com:sodgrant:bill-1:u-2',
      { read: 'claim', billId: 'bill-1', observedWrite: true } as never)).toBe(true);
    // …and only for the claim it belongs to — a sibling claim's read settles nothing here
    expect(readClearsKey('com:sodgrant:bill-1:u-2',
      { read: 'claim', billId: 'bill-2', observedWrite: true } as never)).toBe(false);
  });

  it('the op type joins the ONE registry, so hydration and the flush cover it', () => {
    expect(COMMERCIAL_OUTBOX_OP_TYPES).toContain('grantSodException');
    s().grantSodException('bill-1', 'u-2', 'only pmc on site', viewed);
    const op = s().outbox[0] as { t: string; idempotencyKey: string; coalesceKey: string };
    expect(normalizeCommercialOutbox([op]).ops).toHaveLength(1);
  });
});

describe("§G/§H (7B-iii-d) — the payer's chain, keyed by the resource each command constrains", () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    useStore.setState({
      capabilities: ['commercial'], role: 'pmc', activeProjectId: 'p-1', online: false,
    });
    s()._setGateway({} as unknown as ApiGateway);
  });
  const keys = () => s().outbox.flatMap((o) => {
    const k = (o as { coalesceKey?: unknown }).coalesceKey;
    return typeof k === 'string' ? [k] : [];
  });

  /**
   * THE finding this unit's key design exists for, and it is R5-1 generalised.
   *
   * All six of these commands are §F FOLD SOURCES: a withholding moves NET_PAYABLE, an approval
   * moves APPROVED, a payment and a reversal move PAID. 7B-iii-h made the claim's monotonic
   * revision advance on every write that touches any of them — so each of them invalidates a
   * queued `approve`, which PINS `lifecycleVersion` and is refused by the server if the claim moved.
   */
  it('a pending fold write on this claim BLOCKS an approval, whichever fold it moves', () => {
    for (const pending of [
      deductionCoalesceKey('bill-1'),
      billTransitionCoalesceKey('bill-1', 'certify'),
      approveCoalesceKey('bill-1'),
    ]) {
      expect(commercialWriteBlocked(approveCoalesceKey('bill-1'), [pending]), pending).toBe(true);
    }
    // …and the dispatcher refuses it, not merely the screen (Codex J1)
    s().recordDeduction('bill-1', 'retention', '10.00', null);
    s().approvePayment('bill-1', '50.00', 4);
    expect(keys()).toEqual([deductionCoalesceKey('bill-1')]);
  });

  it('…but a fold write on ANOTHER claim blocks nothing here', () => {
    expect(commercialWriteBlocked(approveCoalesceKey('bill-1'), [deductionCoalesceKey('bill-2')]))
      .toBe(false);
  });

  /** A withholding is blocked by a lifecycle transition for the same reason — but NOT by a pending
   *  approval: approving does not change what may be withheld, and refusing it would invent a
   *  conflict the §G bounds do not have. */
  it('a withholding yields to a claim transition and not to an approval', () => {
    expect(commercialWriteBlocked(deductionCoalesceKey('bill-1'),
      [billTransitionCoalesceKey('bill-1', 'certify')])).toBe(true);
    expect(commercialWriteBlocked(deductionCoalesceKey('bill-1'), [approveCoalesceKey('bill-1')]))
      .toBe(false);
  });

  /** Each of the other four names the ROW it constrains, so two actions on DIFFERENT rows are
   *  independent and two on the SAME row coalesce. That is the §G bound in key form: bound 5 caps
   *  paid at what ONE approval authorised, so the approval is the resource. */
  it('release, pay and reverse are keyed by the row they draw down', () => {
    s().releaseDeduction('ded-1', '5.00', 'work made good');
    s().releaseDeduction('ded-2', '5.00', 'work made good');
    s().releaseDeduction('ded-1', '5.00', 'work made good'); // equivalent, coalesced
    expect(keys()).toEqual([deductionReleaseCoalesceKey('ded-1'), deductionReleaseCoalesceKey('ded-2')]);

    useStore.setState({ outbox: [], commercialPending: [] });
    s().recordPayment('appr-1', '10.00', 'neft', null);
    s().recordPayment('appr-2', '10.00', 'neft', null);
    expect(keys()).toEqual([payCoalesceKey('appr-1'), payCoalesceKey('appr-2')]);

    useStore.setState({ outbox: [], commercialPending: [] });
    s().reversePayment('pay-1', '10.00', 'bank returned it');
    s().reversePayment('pay-1', '10.00', 'bank returned it');
    expect(keys()).toEqual([reverseCoalesceKey('pay-1')]);
  });

  /** An advance names no claim, so it conflicts with nothing on one — only with another advance to
   *  the same counterparty. Asserted rather than assumed, because "it is money, so it must
   *  conflict" is the plausible wrong answer. */
  it('an advance is vendor-scoped and conflicts with no claim', () => {
    expect(commercialWriteBlocked(advanceCoalesceKey('v-1'),
      [approveCoalesceKey('bill-1'), billTransitionCoalesceKey('bill-1', 'certify')])).toBe(false);
    expect(commercialWriteBlocked(advanceCoalesceKey('v-1'), [advanceCoalesceKey('v-1')])).toBe(true);
  });

  it('every one of the six settles on the claim read that carries its ledger', () => {
    const read = (ids: string[]) =>
      ({ read: 'claim', billId: 'bill-1', observedWrite: true, settledIds: ids }) as never;
    expect(readClearsKey(deductionCoalesceKey('bill-1'), read([]))).toBe(true);
    expect(readClearsKey(approveCoalesceKey('bill-1'), read([]))).toBe(true);
    expect(readClearsKey(deductionReleaseCoalesceKey('ded-1'), read(['ded-1']))).toBe(true);
    expect(readClearsKey(payCoalesceKey('appr-1'), read(['appr-1']))).toBe(true);
    expect(readClearsKey(reverseCoalesceKey('pay-1'), read(['pay-1']))).toBe(true);
    // …and a row this read did NOT carry is not settled by it: inferring it from a prefix would
    // release a key for a withholding the user cannot yet see
    expect(readClearsKey(deductionReleaseCoalesceKey('ded-9'), read(['ded-1']))).toBe(false);
  });

  it('each command takes its OWN permission, so widening one does not widen six', () => {
    useStore.setState({ role: 'engineer' });
    s().recordDeduction('bill-1', 'retention', '10.00', null);
    s().releaseDeduction('ded-1', '5.00', 'r');
    s().approvePayment('bill-1', '50.00', 4);
    s().recordPayment('appr-1', '10.00', 'neft', null);
    s().reversePayment('pay-1', '10.00', 'r');
    s().payAdvance('v-1', '10.00', 'mobilisation', 'neft', null);
    expect(s().outbox, 'an engineer holds none of the six').toHaveLength(0);
  });

  it('all six join the ONE op-type registry', () => {
    for (const t of ['recordDeduction', 'releaseDeduction', 'approvePayment', 'recordPayment',
      'reversePayment', 'payAdvance']) {
      expect(COMMERCIAL_OUTBOX_OP_TYPES).toContain(t);
    }
  });
});
