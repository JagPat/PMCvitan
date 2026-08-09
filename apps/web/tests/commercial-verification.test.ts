import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { arbitrateBillCopy, transitionOffered } from '@/lib/billLifecycle';
import {
  billTransitionCoalesceKey, readClearsKey, sodGrantCoalesceKey,
  COMMERCIAL_OUTBOX_OP_TYPES, normalizeCommercialOutbox,
} from '@/lib/commercialKeys';
import { BILL_BEGIN_VERIFICATION_FROM, BILL_VERIFY_FROM } from '@vitan/shared';
import billServiceSource from '../../api/src/commercial/commercial-bill.service.ts?raw';
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
    expect(arbitrateBillCopy(earlier, later)).toEqual({ copy: later, ambiguous: false });
    expect(arbitrateBillCopy(later, earlier)).toEqual({ copy: later, ambiguous: false });
  });

  it('EQUAL stamp + SAME status is agreement, not a tie', () => {
    const a = copy('submitted', '2026-08-21T00:00:01.000Z');
    const b = copy('submitted', '2026-08-21T00:00:01.000Z');
    expect(arbitrateBillCopy(a, b)?.ambiguous).toBe(false);
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
    expect(arbitrateBillCopy(only, null)).toEqual({ copy: only, ambiguous: false });
    expect(arbitrateBillCopy(null, only)).toEqual({ copy: only, ambiguous: false });
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
      grantSodException: vi.fn(async (i: { billId: string; actorId: string }) => { calls.push(`sod:${i.billId}:${i.actorId}`); }),
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
    s().certifyBill('bill-1');
    s().supersedeCertificate('bill-1', 'wrong quantity');
    expect(keys()).toEqual([billTransitionCoalesceKey('bill-1', 'begin-verification')]);

    useStore.setState({ outbox: [], commercialPending: [] });
    s().certifyBill('bill-1');
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
  it('a SoD authorisation is keyed by the PERSON excused, so two are independent', () => {
    s().grantSodException('bill-1', 'user-ravi', 'only store user this week');
    s().grantSodException('bill-1', 'user-sunil', 'covering the weekend');
    expect(keys()).toEqual([
      sodGrantCoalesceKey('bill-1', 'user-ravi'),
      sodGrantCoalesceKey('bill-1', 'user-sunil'),
    ]);
    // …the SAME person twice while pending is still one command
    s().grantSodException('bill-1', 'user-ravi', 'edited justification');
    expect(keys()).toHaveLength(2);
    // …and an authorisation does not block the claim's own transitions, nor they it
    s().certifyBill('bill-1');
    expect(keys()).toHaveLength(3);
  });

  it('each command carries its OWN authority, and they are not interchangeable', () => {
    // `commercial.certify` and `commercial.sod.grant` both resolve to pmc today, so a role probe
    // cannot separate them; what CAN be asserted is that the dispatcher reads the policy per
    // command rather than one blanket answer — a contractor holds none of the three.
    useStore.setState({ role: 'contractor' });
    s().certifyBill('bill-1');
    s().grantSodException('bill-1', 'user-ravi', 'why');
    s().supersedeCertificate('bill-1', 'why');
    expect(s().outbox).toHaveLength(0);
  });

  it('is inert off the commercial pilot', () => {
    useStore.setState({ capabilities: [] });
    s().certifyBill('bill-1');
    s().grantSodException('bill-1', 'user-ravi', 'why');
    s().supersedeCertificate('bill-1', 'why');
    expect(s().outbox).toHaveLength(0);
  });

  it('replays each through its OWN route under its original key', async () => {
    s().certifyBill('bill-1');
    s().grantSodException('bill-2', 'user-ravi', 'why');
    useStore.setState({ online: true });
    await s().flushOutbox();
    await flush();
    expect(calls).toEqual(['certify:bill-1', 'sod:bill-2:user-ravi']);
  });

  it('the CLAIM read is what makes an authorisation visible, and only once it observed the write', () => {
    // `certifyPreflight` is part of the claim bundle, so that bundle IS the read a grant becomes
    // visible in — and the hoisted causality term applies to it like every other key.
    const key = sodGrantCoalesceKey('bill-1', 'user-ravi');
    expect(readClearsKey(key, { read: 'claim', billId: 'bill-1', observedWrite: true })).toBe(true);
    expect(readClearsKey(key, { read: 'claim', billId: 'bill-1', observedWrite: false })).toBe(false);
    // …and not by another claim's bundle, nor by the money position
    expect(readClearsKey(key, { read: 'claim', billId: 'bill-9', observedWrite: true })).toBe(false);
    expect(readClearsKey(key, { read: 'money', observedWrite: true })).toBe(false);
  });

  it('the three op types are commercial ops, so hydration and the reconcile cover them', () => {
    for (const t of ['certifyBill', 'grantSodException', 'supersedeCertificate']) {
      expect(COMMERCIAL_OUTBOX_OP_TYPES).toContain(t);
    }
  });
});
