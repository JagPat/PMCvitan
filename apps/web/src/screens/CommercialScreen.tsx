import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Eyebrow, Button } from '@/components';
import { RefreshCw, WifiOff } from '@/lib/icons';
import { isClaimMoneyPending, isBudgetPendingForHead, costHeadCoalesceKey, attributionCoalesceKey, billCoalesceKey, isCorrectionPendingFor, isMeasurePendingForLine, isBillTransitionPending, sodGrantCoalesceKey, deductionCoalesceKey, deductionReleaseCoalesceKey, payCoalesceKey, reverseCoalesceKey, commercialWriteBlocked } from '@/lib/commercialKeys';
import type { CommercialClaimView } from '@/store/commercial';
import { BILL_BEGIN_VERIFICATION_FROM, BILL_CERTIFY_FROM, DEDUCTION_TYPES, DEDUCTION_TYPES_REQUIRING_REASON, BILL_REJECTABLE_FROM, BILL_STATUSES_PAST_CERTIFICATION, BILL_SUBMITTABLE_FROM, BILL_VERIFY_FROM, claimLineMayCarryCharges, isCorrectionDelta, isMoneyString, isPositiveQuantity, isRealCivilDate, normalizedBillNumber, ROLE_POLICY, SOD_RULES, type SodRule } from '@vitan/shared';
import type { CostHeadPositionDto, MeasurementRegisterDto, SodGrantState } from '@vitan/shared';
import { correctionRefused, exceedsMeasurableCap, lineOrdersNothing, remainingMeasurable, remainingWithdrawable } from '@/lib/measurement';
import { arbitrateBillCopy, transitionOffered } from '@/lib/billLifecycle';
import { decGt, decSub, decIsPositive } from '@/lib/decimal';
import styles from './responsive.module.css';

/**
 * Phase 5 Task 7B-i (§M) — the pilot COMMERCIAL hub, opened on the MONEY POSITION.
 *
 * Capability-gated (the nav only surfaces it on a `commercial` project, and every read 404s
 * off-pilot), cloning the cleared Materials/Labour hub idioms exactly: ONE screen, tabbed panels,
 * honest reading / unavailable+Retry / stale states, and a Retry that falls back to the shell when
 * capabilities are unknown.
 *
 * READ ONLY, and that is the unit's boundary rather than an omission. §M is two user workflows:
 * *where do we stand* (this one — budget · commitments · cash forecast, a PMC's question) and
 * *process this vendor claim* (measurements · bills · certification · payments, a different actor
 * with different authority), which is 7B-ii. The §M write actions and their two-key outbox
 * lifecycle land in 7B-iii, with their own reviewer, because that is precisely the concern
 * Phase-3 Task 7 shipped alongside its readiness reads and then needed four corrections for.
 *
 * ── What this screen does NOT do ────────────────────────────────────────────────────────────────
 *
 * It derives no money. Every figure is a server fold: `budget` is the LIVE per-head position
 * (always current), `cashForecast` is the same seven buckets rolled up from the eighth rebuildable
 * projection with a live fallback. §J's rule that `budget` is the CEILING and never a seventh
 * addend is the SERVER's arithmetic; re-adding the buckets here to "check" it would create a second
 * opinion, which is the defect the one-serializer design exists to prevent. The one thing rendered
 * that is not a bucket — `exposure` — is likewise served, not summed.
 */

type Tab = 'position' | 'commitments' | 'forecast' | 'claims' | 'certification' | 'payments' | 'measurements';
const TABS: { key: Tab; label: string }[] = [
  { key: 'position', label: 'Budget' },
  { key: 'commitments', label: 'Commitments' },
  { key: 'forecast', label: 'Cash forecast' },
  // Task 7B-ii — the CLAIM workflow. Four tabs, one selected claim: `Claims` picks it and the
  // other three are views of the SAME server bundle, so they cannot disagree with each other.
  { key: 'claims', label: 'Claims' },
  { key: 'certification', label: 'Certification' },
  { key: 'payments', label: 'Payments' },
  { key: 'measurements', label: 'Measurements' },
];

/** The claim tabs are views of one selected claim; without one there is nothing to show. */
// Round 3 — 'measurements' LEFT this set. A claim tab is one whose content IS a property of the
// selected claim; a labour PO line's measurement register is not, and treating it as one made the
// workflow's first step require its last.
const CLAIM_TABS: readonly Tab[] = ['certification', 'payments'];

/**
 * Codex H2 — the tabs that need the MONEY bundle, as opposed to the ones that need a claim.
 *
 * This PR argued in prose that the claim workflow is independent of the money position — "nothing
 * in the claim list is derived from the money position" — and then rendered every tab inside
 * `{commercial && …}`. So a failed `/commercial/money-position` hid the whole claim workflow behind
 * a headroom retry, even though `/commercial/bills` and `/commercial/claims/:id` were fine. The
 * principle was right and applied to exactly the layer I was looking at.
 */
const MONEY_TABS: readonly Tab[] = ['position', 'commitments', 'forecast'];

/**
 * §I — what each authorisation state MEANS to the person reading it, and its remedy.
 *
 * A `Record` over the shared state union rather than a chain of `&&`s in the JSX, because the
 * chain silently rendered an empty card for the one state it did not enumerate: `stale-review`
 * arrived with 7B-iii-h and a certifier whose authorisation had gone stale saw a box with nothing
 * in it, no reason and no remedy. The map makes that unrepresentable — a state added to
 * `SodGrantState` without a message here is a compile error, not a blank panel.
 *
 * `none` maps to null and renders NO card: there is no authorisation in play, which is different
 * from having one and saying nothing about it.
 */
const SOD_STATE_MESSAGE: Record<SodGrantState, string | null> = {
  live: 'A segregation-of-duties authorisation stands for you on this claim, and certifying will consume it.',
  'stale-version': 'Your authorisation was granted against an earlier version of this claim — it has been amended since, so it needs authorising again.',
  'stale-review': 'Your authorisation was granted against an earlier state of this claim — it has moved on since, so it needs authorising again against the claim as it stands now.',
  'approver-lost-standing': 'Your authorisation was granted by someone who no longer holds pmc standing on this project — a pmc with standing must authorise it again.',
  none: null,
};

const rowCard: CSSProperties = { border: '1px solid var(--hairline)', borderRadius: 11, padding: '11px 13px', marginTop: 10, background: 'var(--panel)' };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--faint)' };
const muted: CSSProperties = { fontSize: 12.5, color: 'var(--muted)' };
const num: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink)' };
const breachChip: CSSProperties = {
  display: 'inline-block', background: 'var(--red-chip, #F6E4E1)', color: 'var(--red-text, #B4462E)',
  border: '1px solid #E1BEB6', borderRadius: 6, padding: '2px 7px',
  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
};

/** An UNBUDGETED head has no authority to breach — `headroom: null` is not headroom zero, and
 *  showing it as a breach would flag every commitment on a project that has not budgeted yet. */
function isBreached(position: CostHeadPositionDto): boolean {
  return position.headroom !== null && position.headroom.trimStart().startsWith('-');
}

/** Money, as served. Never re-derived, never re-rounded — the server already rounded once from the
 *  full-precision total, and rounding a rounded figure is how a phantom paisa of breach appears. */
function money(value: string | null): string {
  return value === null ? '—' : value;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Codex I3 — WHAT A RESOURCE SHOWS, as a total function instead of a list of guards.
 *
 * This is the third finding on this PR where a state fell through every branch and the panel
 * rendered **nothing** — no rows, no loading, no error, no explanation, no retry. G1 was a scope
 * reset under an open tab; H3 was a capability-gated loader no-opping; I3 is a shell failure that
 * leaves the list `idle` with `onPilot` false, so no branch matches and `(bills ?? []).map` over
 * null renders an empty div. Three times, three different states, one shape: independent `&&`
 * guards ENUMERATE the states someone thought of, and a state nobody thought of renders nothing.
 *
 * Patching in a fourth branch would fix I3 and leave the shape. So the decision is made once, here,
 * over the whole space: a resource either has a value to show, is being fetched, or cannot be
 * shown. The return is a discriminated union, the callers `switch` on it, and TypeScript's
 * exhaustiveness check is what guarantees coverage — the property is structural rather than
 * remembered.
 *
 * `willLoad` is the term I3 turns on and the one a status alone cannot supply. `idle` means "no
 * read has happened", which is a HOPEFUL state when something is about to fetch and a DEAD one when
 * nothing is — and the difference is not visible from the status. The caller passes the same
 * condition its loader gates on (H3's lesson: name the term, do not proxy it), so "idle and nothing
 * is coming" resolves to unavailable-with-a-retry rather than a spinner that never ends.
 */
type ResourceView<T> =
  | { show: 'content'; value: T; stale: boolean; refreshing: boolean }
  | { show: 'loading' }
  | { show: 'unavailable' };

function viewOf<T>(value: T | null | undefined, status: LoadState | null | undefined, willLoad: boolean): ResourceView<T> {
  // A value we hold is shown whatever the read is doing — that IS stale-while-revalidate, and it
  // belongs to the value. What the read is doing is reported ALONGSIDE it (Codex I2): `error` means
  // what is on screen is known-stale, `loading` means a fresh read is in flight right now.
  if (value !== null && value !== undefined) {
    return { show: 'content', value, stale: status === 'error', refreshing: status === 'loading' };
  }
  if (status === 'error') return { show: 'unavailable' };
  if (status === 'loading') return { show: 'loading' };
  // 'idle', or no status at all (never attempted, or attempted while inert).
  return willLoad ? { show: 'loading' } : { show: 'unavailable' };
}

export function CommercialScreen() {
  const commercial = useStore(useShallow((s) => s.commercialView));
  const commercialLoad = useStore((s) => s.commercialLoad);
  const capabilities = useStore(useShallow((s) => s.capabilities));
  const loadCommercial = useStore((s) => s.loadCommercial);
  const loadShell = useStore((s) => s.loadShell);
  const bills = useStore(useShallow((s) => s.commercialBills));
  const billsLoad = useStore((s) => s.commercialBillsLoad);
  const claims = useStore(useShallow((s) => s.commercialClaims));
  const claimLoad = useStore(useShallow((s) => s.commercialClaimLoad));
  // §D — the per-LINE measurement registers. The claim bundle carries registers only for a LIVE
  // version's lines, so this is what a measurement taken on a lodged DRAFT becomes visible in.
  const lineRegisters = useStore(useShallow((s) => s.commercialLineRegisters));
  const pendingQty = useStore(useShallow((s) => s.commercialPendingQty));
  /** The cap reservations held for one line — every pending write that spends its authority. */
  const reservedFor = (lineId: string): string[] =>
    Object.values(pendingQty).filter((p) => p.lineId === lineId).map((p) => p.qty);
  const lineRegisterLoad = useStore(useShallow((s) => s.commercialLineRegisterLoad));
  const loadLineRegister = useStore((s) => s.loadCommercialLineRegister);
  // Task 7B-iii-a — the §M writes and their disable-while-pending set.
  const role = useStore((s) => s.role);
  /**
   * Codex J1 — the hub is READABLE by pmc AND engineer (`commercial.read`), but all three writes
   * are `pmc`. An engineer saw the forms, and because the outbox is WRITE-AHEAD the op is
   * persisted before it is sent: offline they were told "saved, will sync" and the command was
   * then discarded on reconnect with a 403. Being told a budget was set that never could be is
   * worse than not seeing the control.
   *
   * Read from `ROLE_POLICY` rather than testing `role === 'pmc'`. All three are pmc-only today,
   * and hardcoding that would be a second copy of the policy that a future widening would leave
   * behind — the recurrence this phase has named six times. The policy is the source; this asks it.
   */
  const may = (permission: keyof typeof ROLE_POLICY): boolean =>
    (ROLE_POLICY[permission] as readonly string[]).includes(role);
  const mayBudget = may('commercial.budget.manage');
  const mayManage = may('commercial.manage');
  const mayAttribute = may('commercial.attribute');
  // The two commercial permissions that admit `engineer` — so unlike the three above, these
  // controls ARE visible to an engineer, which is what makes reading the policy load-bearing
  // rather than a formality (Codex J1).
  const mayMeasure = may('commercial.measure');
  const mayBill = may('commercial.bill');
  // 7B-iii-c-i — pmc-only, and DELIBERATELY not the same permission as `commercial.bill`: §E's
  // separation of duties starts here, with the actor who lodges a claim being unable to verify it.
  const mayVerify = may('commercial.verify');
  // 7B-iii-f — SEPARATE from `commercial.verify` even though both resolve to pmc today: certifying
  // decides what is OWED. (`commercial.sod.grant` is separate again — authority to EXCUSE the rule
  // is a stronger thing than authority to perform the act it excuses — and its surface is
  // 7B-iii-h.)
  const mayCertify = may('commercial.certify');
  // §I — issuing an authorisation is the APPROVER's act and a DIFFERENT permission from certifying.
  // Both resolve to pmc today; naming them separately is what keeps that a fact about the policy
  // rather than an assumption baked into the screen.
  const mayGrant = may('commercial.sod.grant');
  // 7B-iii-d — SIX distinct permissions, asked separately. They all resolve to pmc today; asking
  // once and reusing the answer would bake that coincidence into the screen.
  const mayDeduct = may('commercial.deduct');
  const mayRelease = may('commercial.deduct.release');
  const mayApprove = may('commercial.approve-payment');
  const mayPay = may('commercial.record-payment');
  const mayReverse = may('commercial.reverse-payment');
  const commercialPending = useStore(useShallow((s) => s.commercialPending));
  const setBudget = useStore((s) => s.setCommercialBudget);
  const defineHead = useStore((s) => s.defineCostHead);
  const reattribute = useStore((s) => s.reattributeCommitment);
  const grantSodException = useStore((s) => s.grantSodException);
  const recordDeduction = useStore((s) => s.recordDeduction);
  const releaseDeduction = useStore((s) => s.releaseDeduction);
  const approvePayment = useStore((s) => s.approvePayment);
  const recordPayment = useStore((s) => s.recordPayment);
  const reversePayment = useStore((s) => s.reversePayment);
  // 7B-iii-b — the engineer's writes.
  const takeMeasurement = useStore((s) => s.takeMeasurement);
  const correctMeasurement = useStore((s) => s.correctMeasurement);
  const submitBill = useStore((s) => s.submitVendorBill);
  const rejectBill = useStore((s) => s.rejectVendorBill);
  // 7B-iii-c-i — the verifier's two.
  const beginVerification = useStore((s) => s.beginVerification);
  const verifyBill = useStore((s) => s.verifyVendorBill);
  // 7B-iii-f — the certifier's three.
  const certifyBill = useStore((s) => s.certifyBill);
  const supersedeCertificate = useStore((s) => s.supersedeCertificate);
  const recordBill = useStore((s) => s.recordVendorBill);
  const loadCommercialBills = useStore((s) => s.loadCommercialBills);
  const loadCommercialClaim = useStore((s) => s.loadCommercialClaim);
  const [tab, setTab] = useState<Tab>('position');
  // The scope a selection belongs to. A project switch (or a re-auth) bumps this, and the selection
  // below is only honoured while its recorded scope still matches — see the comment at `claim`.
  const scopeKey = useStore((s) => `${s.activeProjectId}:${s.projectScopeGeneration}`);
  const [selection, setSelection] = useState<{ scope: string; billId: string | null }>({ scope: '', billId: null });
  // Form state is SCOPED the same way the claim selection is: a project switch bumps `scopeKey`,
  // so a half-typed budget for one site can never be submitted against another. Derived, not
  // reset in an effect — an effect runs after the offending render.
  const [draft, setDraft] = useState<{ scope: string; head: string; amount: string; reason: string }>(
    { scope: '', head: '', amount: '', reason: '' },
  );
  const form = draft.scope === scopeKey ? draft : { scope: scopeKey, head: '', amount: '', reason: '' };
  const setForm = (next: Partial<typeof form>): void => setDraft({ ...form, scope: scopeKey, ...next });
  const [headDraft, setHeadDraft] = useState<{ scope: string; code: string; name: string }>({ scope: '', code: '', name: '' });
  const headForm = headDraft.scope === scopeKey ? headDraft : { scope: scopeKey, code: '', name: '' };
  const setHeadForm = (next: Partial<typeof headForm>): void => setHeadDraft({ ...headForm, scope: scopeKey, ...next });
  /**
   * Codex J2 — the attribution draft is PER ROW, and the first version was not.
   *
   * One component-wide `attrForm` meant choosing a destination head and reason on line A also
   * enabled line B's submit button carrying A's values — invisible on B, because B's own select
   * showed them too. Clicking the wrong row then re-attributed the wrong commitment to a head
   * nobody chose for it. On a screen whose whole job is stating where money sits, that is the
   * worst kind of defect: silent, plausible, and about someone else's line.
   *
   * Keyed by attribution id, so only the row the user actually edited can submit, and the empty
   * default keeps every other row's button disabled.
   */
  const [measureDrafts, setMeasureDrafts] = useState<{ scope: string; byId: Record<string, { qty: string; activityId: string; outputId: string }> }>(
    { scope: '', byId: {} },
  );
  const measureScoped = measureDrafts.scope === scopeKey ? measureDrafts.byId : {};
  const measureFormFor = (id: string) => measureScoped[id] ?? { qty: '', activityId: '', outputId: '' };
  const setMeasureForm = (id: string, next: Partial<{ qty: string; activityId: string; outputId: string }>): void =>
    setMeasureDrafts({ scope: scopeKey, byId: { ...measureScoped, [id]: { ...measureFormFor(id), ...next } } });
  const [corrDrafts, setCorrDrafts] = useState<{ scope: string; byId: Record<string, { qty: string; reason: string }> }>(
    { scope: '', byId: {} },
  );
  const corrScoped = corrDrafts.scope === scopeKey ? corrDrafts.byId : {};
  const corrFormFor = (id: string) => corrScoped[id] ?? { qty: '', reason: '' };
  const setCorrForm = (id: string, next: Partial<{ qty: string; reason: string }>): void =>
    setCorrDrafts({ scope: scopeKey, byId: { ...corrScoped, [id]: { ...corrFormFor(id), ...next } } });
  // Codex M2 — the LODGE form. The engineer's workflow bound measure/correct/submit/reject and
  // never surfaced `recordVendorBill`, so on a project with no claim yet the Claims tab showed an
  // empty state and no way out of it: a workflow that cannot create the thing it processes. One
  // line is enough to lodge a draft; amendment (a full replacement line set) stays out of scope.
  /**
   * Codex round-3 P2 — a vendor's invoice can cover MORE THAN ONE purchase-order line, and the
   * contract accepts up to 200. Lodging a singleton made the rest of that invoice unreachable: the
   * document number is the frozen duplicate key, so the second line is refused as a duplicate
   * claim, and amendment (a full replacement line set) is deliberately not surfaced here. One
   * invoice line was enough to record a claim and not enough to record THAT claim.
   *
   * So the form collects the whole line set first. `lines` is the claim; the `lineKind`/id/qty/rate
   * inputs are an entry row that appends to it.
   */
  // Round 4 (P2) — a vendor's material invoice carries TAX and FREIGHT, and the contract accepts
  // both per line. Omitting them defaults each to zero server-side, so a claim with ₹900 tax and
  // ₹250 freight was lodged, certified and paid at its base amount alone — the claim silently
  // disagreeing with the document it represents. Optional (a labour line ordinarily has neither),
  // validated by the SAME money rule when present.
  // Codex N2 — the server's XOR: a claim line names EXACTLY ONE kind of purchase-order line. This
  // unit adds the LABOUR side, which is why the kind is now a choice: an engineer who has just
  // measured `LPL-1` lodges the claim for it, and serializing that as `poLineId` sends the server
  // down the material path to a not-found.
  type LodgeLine = { lineKind: 'material' | 'labour'; poLineId: string; qty: string; rate: string; tax: string; freight: string };
  type LodgeDraft = { scope: string; vendorId: string; number: string; date: string } & LodgeLine
    & { lines: LodgeLine[] };
  const emptyLodge = (scope: string): LodgeDraft => ({
    scope, vendorId: '', number: '', date: '',
    lineKind: 'material', poLineId: '', qty: '', rate: '', tax: '', freight: '', lines: [],
  });
  const [lodgeDraft, setLodgeDraft] = useState(emptyLodge(''));
  const lodge = lodgeDraft.scope === scopeKey ? lodgeDraft : emptyLodge(scopeKey);
  const setLodge = (next: Partial<typeof lodge>): void => setLodgeDraft({ ...lodge, scope: scopeKey, ...next });
  // the ENTRY row is addable on its own terms; the CLAIM needs at least one added line
  const optionalMoneyOk = (v: string): boolean => v.trim() === '' || isMoneyString(v);
  // Codex Q-b — a LABOUR purchase-order snapshot freezes neither tax nor freight, so the server
  // refuses a labour claim line carrying either. The rule is the SAME function the service guards
  // with, imported rather than restated, so the form cannot drift from it.
  const chargesAllowed = claimLineMayCarryCharges(lodge.lineKind);
  const entryValid = lodge.poLineId.trim() !== '' && isPositiveQuantity(lodge.qty) && isMoneyString(lodge.rate)
    && optionalMoneyOk(lodge.tax) && optionalMoneyOk(lodge.freight)
    && (chargesAllowed || (lodge.tax.trim() === '' && lodge.freight.trim() === ''));
  const entryAsLine = (): LodgeLine => ({
    lineKind: lodge.lineKind,
    poLineId: lodge.poLineId.trim(), qty: lodge.qty.trim(), rate: lodge.rate.trim(),
    tax: lodge.tax.trim(), freight: lodge.freight.trim(),
  });
  const addLodgeLine = (): void => setLodge({
    lines: [...lodge.lines, entryAsLine()],
    poLineId: '', qty: '', rate: '', tax: '', freight: '',
  });
  /**
   * Round 7 — what happens to a line the user has typed but not ADDED.
   *
   * Lodge looked only at `lodge.lines`, so filling `PL-2` and pressing Lodge instead of Add line
   * silently dropped it — and the vendor's document number is frozen by the duplicate index the
   * moment the claim is recorded, so that line had no later path into the invoice. Data visible on
   * screen disappeared into a claim that did not contain it.
   *
   * The entry has three states and each needs an answer, so all three are stated rather than the
   * one the finding named: EMPTY (nothing to lose), VALID (the user means it — fold it in, which is
   * what pressing Lodge with a filled row plainly intends), and DIRTY-BUT-INVALID (refuse, and say
   * why, because silently dropping it is the defect and silently sending it is worse).
   */
  const entryDirty = [lodge.poLineId, lodge.qty, lodge.rate, lodge.tax, lodge.freight]
    .some((v) => v.trim() !== '');
  const lodgeLines = entryValid ? [...lodge.lines, entryAsLine()] : lodge.lines;
  // Codex N5 — the server's duplicate-document index refuses another claim for the same
  // (vendor, normalized number) unless the existing one is `rejected` or `resolved`. A claim
  // already ON SCREEN is enough to know that, so the form refuses rather than promising a write
  // reconnect will discard.
  const lodgeDuplicate = (bills ?? []).some((b) =>
    b.vendorId === lodge.vendorId.trim()
    && normalizedBillNumber(b.vendorBillNumber) === normalizedBillNumber(lodge.number)
    && b.status !== 'rejected' && b.status !== 'resolved');
  const lodgeValid = lodge.vendorId.trim() !== '' && lodge.number.trim() !== ''
    && isRealCivilDate(lodge.date)                       // N4 — a real calendar day, not a shape
    && lodgeLines.length > 0                             // round-3 P2 — the whole invoice, not a line
    && !(entryDirty && !entryValid)                      // round 7 — never drop a line on screen
    && !lodgeDuplicate;
  const lodgePending = commercialPending.includes(billCoalesceKey(lodge.vendorId.trim(), lodge.number));

  const [billDrafts, setBillDrafts] = useState<{ scope: string; byId: Record<string, string> }>({ scope: '', byId: {} });
  const billScoped = billDrafts.scope === scopeKey ? billDrafts.byId : {};
  const billReasonFor = (id: string): string => billScoped[id] ?? '';
  const setBillReason = (id: string, reason: string): void =>
    setBillDrafts({ scope: scopeKey, byId: { ...billScoped, [id]: reason } });

  // 7B-iii-f — the certifier's drafts, SCOPED exactly like the reason drafts above (J2: a
  // component-wide draft armed one row's button with another row's text). Two fields because a
  // supersede reason and a SoD authorisation are different acts with different authority.
  const [certDrafts, setCertDrafts] = useState<{
    scope: string;
    byId: Record<string, {
      supersedeReason: string; sodActorId: string; sodReason: string; sodRule: SodRule;
    }>;
  }>({ scope: '', byId: {} });
  const certScoped = certDrafts.scope === scopeKey ? certDrafts.byId : {};
  const EMPTY_CERT_DRAFT = {
    supersedeReason: '', sodActorId: '', sodReason: '',
    sodRule: SOD_RULES.evidenceRecorderMayNotCertify as SodRule,
  };
  const certDraftFor = (id: string) => certScoped[id] ?? EMPTY_CERT_DRAFT;
  const setCertDraft = (
    id: string,
    patch: Partial<{ supersedeReason: string; sodActorId: string; sodReason: string; sodRule: SodRule }>,
  ): void =>
    setCertDrafts({ scope: scopeKey, byId: { ...certScoped, [id]: { ...certDraftFor(id), ...patch } } });

  // 7B-iii-d — the payer's forms, scoped per claim like every other draft on this screen: a
  // component-wide draft armed one row's button with another row's text (7B-iii-a's lesson).
  const [payDrafts, setPayDrafts] = useState<{
    scope: string;
    byId: Record<string, {
      deductType: string; deductAmount: string; deductReason: string;
      releaseId: string; releaseAmount: string; releaseReason: string;
      approveAmount: string;
      payApprovalId: string; payAmount: string; payMethod: string; payReference: string;
      reversePaymentId: string; reverseAmount: string; reverseReason: string;
    }>;
  }>({ scope: '', byId: {} });
  const paySc = payDrafts.scope === scopeKey ? payDrafts.byId : {};
  const EMPTY_PAY_DRAFT = {
    deductType: '', deductAmount: '', deductReason: '',
    releaseId: '', releaseAmount: '', releaseReason: '',
    approveAmount: '',
    payApprovalId: '', payAmount: '', payMethod: '', payReference: '',
    reversePaymentId: '', reverseAmount: '', reverseReason: '',
  };
  const payDraftFor = (id: string) => paySc[id] ?? EMPTY_PAY_DRAFT;
  const setPayDraft = (id: string, patch: Partial<typeof EMPTY_PAY_DRAFT>): void =>
    setPayDrafts({ scope: scopeKey, byId: { ...paySc, [id]: { ...payDraftFor(id), ...patch } } });


  const [attrDrafts, setAttrDrafts] = useState<{ scope: string; byId: Record<string, { head: string; reason: string }> }>(
    { scope: '', byId: {} },
  );
  const attrScoped = attrDrafts.scope === scopeKey ? attrDrafts.byId : {};
  const attrFormFor = (id: string): { head: string; reason: string } => attrScoped[id] ?? { head: '', reason: '' };
  const setAttrForm = (id: string, next: Partial<{ head: string; reason: string }>): void =>
    setAttrDrafts({ scope: scopeKey, byId: { ...attrScoped, [id]: { ...attrFormFor(id), ...next } } });
  const selectedBillId = selection.scope === scopeKey ? selection.billId : null;

  // Declared here because THREE things now depend on it: the money view below, the claim-list
  // load condition, and Refresh — every one of them gating on the capability the loaders
  // themselves gate on, rather than on a proxy for it (Codex H3, then I1).
  const onPilot = capabilities.includes('commercial');

  // The money bundle's own states, and they belong to the MONEY tabs only (Codex H2).
  //
  // Codex I3, applied to the case the finding did NOT name. `viewOf` was written for the claim
  // list, and the money bundle three lines up had the same three-independent-guards shape with the
  // same hole: `commercial === null` with the status still `idle` because `loadCommercial()` is
  // capability-gated rendered "Loading the money position…" with nothing loading and nothing that
  // would — the permanent spinner F3 found on the claim panel, on the tab this hub OPENS on.
  //
  // Root F of the convergence audit is the reason this is here rather than in the next round:
  // stating a principle covers the instance you are looking at and nothing else unless you go and
  // count them. There are three resources on this screen; all three now decide the same way.
  const moneyView = viewOf(commercial, commercialLoad, onPilot);
  const reading = moneyView.show === 'loading';
  const unavailable = moneyView.show === 'unavailable';
  const stale = moneyView.show === 'content' && moneyView.stale;
  const moneyRefreshing = moneyView.show === 'content' && moneyView.refreshing;
  const positions = commercial?.budget.positions ?? [];
  // Codex F3 — `commercial/attributions` returns the WHOLE register, superseded history included,
  // because a re-attribution supersedes the old row and inserts its successor rather than editing
  // in place (§C: there is no "revoke", which would drop a live obligation out of every budget).
  // Rendering all of it as current commitments double-counts a re-attributed line — the CIVIL row
  // it left AND the MEP row it moved to — which misstates the very money position this hub exists
  // to state. Only the LIVE rows are current commitments; the history is not this tab's subject.
  const liveAttributions = (commercial?.attributions ?? []).filter((a) => a.supersededAt === null);
  const headName = (code: string): string =>
    commercial?.costHeads.find((h) => h.code === code)?.name
    ?? positions.find((p) => p.costHeadCode === code)?.costHeadName
    ?? code;

  // Task 7B-ii — the claim list is fetched when the user is in the claim workflow rather than on
  // hub open: it answers a different question from the money position, and paying for it up front
  // would make every PMC checking headroom wait on a list only an accountant opens.
  //
  // Codex G1 — DECLARATIVE, not a click handler. The first version loaded on the tab CLICK when the
  // list was `idle`, which treats "the user opened Claims" as a moment. It is a STATE: a project
  // switch resets the list to `null`/`idle` while the Claims tab is still showing, and no click
  // follows, so the panel rendered nothing at all — no rows, no loading, no error, no empty state,
  // because `(bills ?? []).map` over null renders nothing and every other branch was false.
  //
  // Expressed as a condition instead, the load re-fires whenever the condition becomes true again,
  // whatever made it true. The one-shot trigger is deleted rather than supplemented — a second
  // trigger beside the first would leave the same class of gap for the next state change.
  const inClaimWorkflow = tab === 'claims' || CLAIM_TABS.includes(tab);
  const onMoneyTab = MONEY_TABS.includes(tab);
  // Codex H3 — the condition must name EVERY term it depends on. `loadCommercialBills()` is itself
  // capability-gated, and a project switch resets capabilities to `[]` at the same moment it resets
  // the list to `idle`: the effect fired, the loader no-opped, and when `loadShell()` later reported
  // the new project's `commercial` capability neither dependency had changed — so it never fired
  // again and the Claims tab rendered the same blank panel the previous round was meant to fix.
  //
  // Expressing a condition instead of an event (the previous round) is only half of it; the
  // condition also has to be complete. `onPilot` is the missing term, in the guard AND the deps.
  useEffect(() => {
    if (inClaimWorkflow && onPilot && billsLoad === 'idle') void loadCommercialBills();
  }, [inClaimWorkflow, onPilot, billsLoad, loadCommercialBills]);

  /**
   * Codex I1 — REFRESH RE-READS WHAT THIS SCREEN IS SHOWING.
   *
   * The page-level button drove the money bundle alone, because it was written when the hub had
   * money tabs only and never revisited when the claim workflow was added beside them. On a claim
   * tab it therefore re-read something not on screen and left the claim list and the open claim —
   * the lifecycle an accountant is about to authorise money against — exactly as stale as before.
   *
   * The gate is `onPilot`, not `capabilitiesKnown`. Both loaders gate on the CAPABILITY itself, so
   * `capabilitiesKnown` was a proxy for "the loader will do something" that is wrong in the case
   * that matters: capabilities known but not yet reporting `commercial` (a shell failure, or the
   * gap after a project switch) makes every loader an inert no-op, and a Refresh that dispatches
   * inert no-ops is a dead button. Re-driving the shell is the only thing that can recover it, and
   * naming the loader's own condition is the same lesson H3 cost a round to learn.
   */
  const refresh = (): void => {
    if (!onPilot) { loadShell(); return; }
    if (onMoneyTab) { void loadCommercial(); return; }
    void loadCommercialBills();
    if (selectedBillId) void loadCommercialClaim(selectedBillId);
    if (tab === 'measurements') {
      // the LINE LIST comes from the money bundle's attributions, so refreshing only the registers
      // could never recover a failed or stale bundle — the tab would keep reporting "no labour
      // lines" from the one control offered to fix exactly that, and a newly attributed line would
      // never appear. Refresh the thing the list is derived FROM, not only the things it names.
      void loadCommercial();
    }
    // the §D registers are their own read, so Refresh has to say so — otherwise a line whose
    // register failed is unreachable from the one control offered for exactly that situation
    for (const id of measurableLineIds) void loadLineRegister(id);
  };

  const openTab = (next: Tab): void => { setTab(next); };
  const selectClaim = (billId: string): void => {
    setSelection({ scope: scopeKey, billId });
    // Always re-read on selection. The lifecycle is what someone is about to ACT on — a certified
    // amount or an approvable balance held from an earlier visit is the one number that must not be
    // stale here, and the per-claim token makes a slow earlier read unable to overwrite this one.
    void loadCommercialClaim(billId);
  };
  // Codex F3 — the SELECTION IS SCOPED. `selectedBillId` is component state and the claim map is
  // store state, so a project switch tore one down and left the other pointing at a claim that
  // belongs to a site the user is no longer on. The guard then rendered "Loading the claim…"
  // forever: nothing was loading, nothing would, and no Retry was offered.
  //
  // Derived rather than reset in an effect: an effect runs AFTER the offending render, so there is
  // a frame in which the old id is live in the new scope. Carrying the scope WITH the selection
  // means the stale id is simply not selected, with no frame in between and nothing to clean up.
  const claim = selectedBillId ? claims[selectedBillId] ?? null : null;
  const claimStatus = selectedBillId ? claimLoad[selectedBillId] ?? null : null;
  // Nothing auto-loads a claim: selection does, and a selection whose scope no longer matches is
  // simply not selected (above). So a selected claim with no status at all is a claim nothing is
  // going to fetch — `willLoad: false` — which `viewOf` answers with a retry rather than the
  // permanent "Loading the claim…" that was F3's finding.
  const claimView = viewOf<CommercialClaimView>(claim, claimStatus, false);

  /**
   * §D — the labour lines the selected claim's CURRENT version bills.
   *
   * The measurement register belongs to the LINE, not to the claim, which is why these come from
   * the version rather than from `claim.measurements`: that map is built from the LIVE version's
   * lines, and `draft` is not a live status. Round 2 (N3) used it to make the form reachable on a
   * lodged draft; round 3 finishes the thought, because a form whose EFFECT is invisible is only
   * half a control — the engineer measures, the bundle still reports nothing, and the natural
   * response is to measure again.
   */
  const measurableLineIds = useMemo(() => {
    // Round 3 — the lines come from the PROJECT's live labour commitments, not from a selected
    // claim. §D measurement is a fact about a labour PO LINE, recorded when the work is done and
    // long before any claim exists; scoping the tab under `claimPanel` inverted that, so the
    // advertised order (measure → lodge → submit) was unreachable and an engineer had to create a
    // commercial document before they could record an operational fact. A selected claim's own
    // labour lines are unioned in, so opening a claim still shows exactly what it bills.
    //
    // The source is `attributions` — every live commitment carries one under §C — filtered to the
    // un-superseded rows. A labour PO line that has never been attributed is therefore not listed;
    // that is stated rather than hidden, and attributing it is the §C action that surfaces it.
    const version = claim?.bill.versions.find((v) => v.live) ?? claim?.bill.versions.at(-1);
    const fromClaim = (version?.lines ?? [])
      .filter((l) => l.type === 'labour' && l.labourPoLineId !== null)
      .map((l) => l.labourPoLineId as string);
    const fromCommitments = (commercial?.attributions ?? [])
      .filter((a) => a.supersededAt === null && a.labourPoLineId !== null)
      .map((a) => a.labourPoLineId as string);
    return [...new Set([...fromClaim, ...fromCommitments])].sort();
  }, [claim, commercial]);
  const lineKey = measurableLineIds.join(',');
  useEffect(() => {
    if (!onPilot) return;
    // once per line: the reconcile refreshes them after a write, and `viewOf` reports the rest
    for (const id of lineKey === '' ? [] : lineKey.split(',')) {
      if (!(id in lineRegisterLoad)) void loadLineRegister(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lineKey` is the stable identity of `measurableLineIds`
  }, [onPilot, lineKey, loadLineRegister]);

  /**
   * Codex F2 — EVERY claim tab wears the same states, because they are properties of the CLAIM.
   *
   * The three tabs are views of ONE bundle; a banner on one of them is not a property of the thing
   * they all show. Round 1 had the warning on Certification only — and Payments is where
   * `approvable` lives, the figure someone is about to authorise money against.
   *
   * Codex I3 — this used to be TWO functions: a `claimPanel` wrapper and a `claimGuard` fallback,
   * with every call site spelling `{claim ? claimPanel(…) : claimGuard()}`. Two functions that are
   * only correct when used together are one function written twice, and the pairing is what let a
   * state fall between them. Merged, the panel takes what to render WITH a claim and decides every
   * other case itself, so no call site can get the pairing wrong and the non-null assertion the old
   * shape needed is gone.
   */
  // Task 7B-iii-a — disable-while-pending. The BUDGET test is prefix-matched on the cost head
  // and deliberately ignores the amount: the coalesce key carries the amount (two figures are two
  // different actions), but a test that included it would re-enable the button the instant the
  // user edits the input while the first command is still in flight, and write two revisions.
  // Labour round 7 paid for that distinction.
  const budgetPending = (code: string): boolean => commercialPending.some((k) => isBudgetPendingForHead(k, code));
  const headPending = (code: string): boolean => commercialPending.includes(costHeadCoalesceKey(code));
  // The LINE is the constrained resource — §C keeps exactly one live attribution per line — so a
  // pending attribution disables the line whatever cost head it names (labour round 5).
  const attrPending = (lineId: string): boolean => commercialPending.includes(attributionCoalesceKey(lineId));
  // Round 2 — LINE-wide, not (line, activity): the cap belongs to the line, so a second activity
  // must not queue against a remainder the first has already claimed. The dispatcher shares the
  // same rule (`commercialWriteBlocked`), because a screen guard the durable layer does not hold
  // is not a guard at all.
  const measurePending = (lineId: string): boolean =>
    commercialPending.some((k) => isMeasurePendingForLine(k, lineId));
  const correctionPending = (measurementId: string): boolean =>
    commercialPending.some((k) => isCorrectionPendingFor(k, measurementId));
  // §F — submit / amend / reject are three transitions on ONE claim, so a pending any-of-them
  // disables all three. The claim is the constrained resource, not the verb (labour r5 / J2, third
  // instance): keyed per verb, a queued reject could sit beside a pending submit and the server
  // would terminally 4xx whichever lost, after the user was told both were saved.
  const billTxPending = (billId: string): boolean =>
    commercialPending.some((k) => isBillTransitionPending(k, billId));
  const input: CSSProperties = {
    border: '1px solid var(--hairline)', borderRadius: 8, padding: '7px 9px',
    fontSize: 12.5, fontFamily: 'inherit', background: 'var(--canvas)', color: 'var(--ink)', minWidth: 0,
  };

  const claimPanel = (render: (loaded: CommercialClaimView) => JSX.Element): JSX.Element => {
    if (!selectedBillId) {
      return <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-none">Choose a claim on the Claims tab.</div>;
    }
    switch (claimView.show) {
      case 'loading':
        return <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-loading">Loading the claim…</div>;
      case 'unavailable':
        return (
          <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-unavailable">
            <div>This claim couldn&rsquo;t load.</div>
            <div style={{ marginTop: 10 }}>
              <Button variant="ink" onClick={() => selectClaim(selectedBillId)} data-testid="commercial-claim-retry">
                <RefreshCw size={14} /> Retry
              </Button>
            </div>
          </div>
        );
      case 'content':
        return (
          <>
            {claimView.stale && (
              <div style={{ ...rowCard, ...muted, borderColor: 'var(--amber-border)', background: 'var(--amber-chip)', color: 'var(--amber-text)' }} data-testid="commercial-claim-stale">
                Showing the last-known claim — the latest couldn&rsquo;t load.{' '}
                <button onClick={() => selectClaim(selectedBillId)} data-testid="commercial-claim-stale-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer' }}>
                  Retry
                </button>
              </div>
            )}
            {/* Codex I2 — a read IS in flight, and saying so is the whole point of an honest status.
                Without it, a lifecycle held from an earlier visit and a lifecycle a completed read
                just confirmed look identical on a page about to authorise a payment. */}
            {claimView.refreshing && (
              <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-refreshing">Refreshing this claim…</div>
            )}
            {render(claimView.value)}
          </>
        );
    }
  };

  return (
    <div className={styles.screen}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Eyebrow>Commercial</Eyebrow>
          <h1 style={{ margin: '4px 0 0', fontSize: 21, letterSpacing: '-0.01em' }}>Money position</h1>
          <div style={muted}>What this project has authorised, what it has committed, and what it still owes.</div>
        </div>
        <Button variant="ghost" onClick={() => refresh()} data-testid="commercial-refresh" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>

      {stale && onMoneyTab && (
        <div data-testid="commercial-stale-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px', marginTop: 14 }}>
          <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>Showing the last-known money picture — the latest couldn&rsquo;t load.</span>
          <button onClick={() => refresh()} data-testid="commercial-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {reading && onMoneyTab && (
        <div data-testid="commercial-loading" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Loading the money position…</div>
      )}
      {/* Codex I2, third instance — a refresh over money already on screen is visible, for the same
          reason it is on the claim: the figures are what someone acts on, and "held from earlier"
          and "just confirmed" must not look identical. */}
      {moneyRefreshing && onMoneyTab && (
        <div data-testid="commercial-refreshing" style={{ ...mono, marginTop: 12 }}>Refreshing the money position…</div>
      )}
      {unavailable && onMoneyTab && (
        <div data-testid="commercial-unavailable" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><WifiOff size={18} /> Commercial unavailable.</div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>Check your connection and access, then retry.</div>
          <div style={{ marginTop: 14 }}>
            <Button variant="ink" onClick={() => refresh()} data-testid="commercial-retry-empty" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={15} /> Retry
            </Button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => openTab(t.key)}
                data-testid={`commercial-tab-${t.key}`}
                style={{
                  border: '1px solid var(--hairline)', borderRadius: 8, padding: '6px 11px', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                  background: tab === t.key ? 'var(--ink)' : 'transparent',
                  color: tab === t.key ? 'var(--canvas)' : 'var(--muted)',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

      {tab === 'position' && commercial && (
            <div data-testid="commercial-position">
              {/* Task 7B-iii-a — the §B budget write. ONE command for v1 and every revision: the
                  server supersedes the live row and inserts the next version atomically, so the
                  form does not distinguish "create" from "revise" either. */}
              {mayBudget && (
              <div style={rowCard} data-testid="commercial-budget-form">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Set a budget</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <select
                    value={form.head}
                    onChange={(e) => setForm({ head: e.target.value })}
                    data-testid="budget-head"
                    style={{ ...input, flex: '1 1 140px' }}
                  >
                    <option value="">Cost head…</option>
                    {commercial.costHeads.map((h) => (
                      <option key={h.code} value={h.code}>{h.code} — {h.name}</option>
                    ))}
                  </select>
                  {/* a money STRING all the way down — §A forbids a float64 round trip, and an
                      `<input type="number">` would hand one to the store */}
                  <input
                    value={form.amount}
                    onChange={(e) => setForm({ amount: e.target.value })}
                    placeholder="Amount"
                    inputMode="decimal"
                    data-testid="budget-amount"
                    style={{ ...input, flex: '1 1 110px' }}
                  />
                  <input
                    value={form.reason}
                    onChange={(e) => setForm({ reason: e.target.value })}
                    placeholder="Reason"
                    data-testid="budget-reason"
                    style={{ ...input, flex: '2 1 180px' }}
                  />
                  <Button
                    variant="ink"
                    data-testid="budget-submit"
                    disabled={!form.head || !isMoneyString(form.amount) || !form.reason.trim() || budgetPending(form.head)}
                    onClick={() => { setBudget(form.head, form.amount.trim(), form.reason.trim()); }}
                  >
                    {budgetPending(form.head) ? 'Setting…' : 'Set budget'}
                  </Button>
                </div>
                {/* Codex J3 — the amount is checked against the SAME rule the server contract
                    uses, before the op reaches the durable outbox. The message is shown rather
                    than only disabling, so a rejected figure explains itself. */}
                {form.amount.trim() !== '' && !isMoneyString(form.amount) && (
                  <div style={{ ...muted, marginTop: 8, color: 'var(--amber-text)' }} data-testid="budget-amount-invalid">
                    Enter a non-negative amount with at most two decimals.
                  </div>
                )}
              </div>
              )}

              {/* §C — the cost-head taxonomy every budget and attribution hangs off. It is on the
                  hub rather than left to an operator because without at least one head the Budget
                  tab cannot do anything at all on a freshly enabled pilot project, and
                  `commercial.manage` is a `pmc` permission like the other two. */}
              {mayManage && (
              <div style={rowCard} data-testid="commercial-costhead-form">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Define a cost head</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <input
                    value={headForm.code}
                    onChange={(e) => setHeadForm({ code: e.target.value })}
                    placeholder="Code"
                    data-testid="costhead-code"
                    style={{ ...input, flex: '1 1 110px' }}
                  />
                  <input
                    value={headForm.name}
                    onChange={(e) => setHeadForm({ name: e.target.value })}
                    placeholder="Name"
                    data-testid="costhead-name"
                    style={{ ...input, flex: '2 1 180px' }}
                  />
                  <Button
                    variant="ink"
                    data-testid="costhead-submit"
                    disabled={!headForm.code.trim() || !headForm.name.trim() || headPending(headForm.code.trim())}
                    onClick={() => { defineHead(headForm.code.trim(), headForm.name.trim()); }}
                  >
                    {headPending(headForm.code.trim()) ? 'Defining…' : 'Define'}
                  </Button>
                </div>
              </div>
              )}

              {commercial.budget.openExceptions > 0 && (
                <div data-testid="commercial-open-exceptions" style={{ ...rowCard, borderColor: '#E1BEB6' }}>
                  <span style={breachChip}>OVER BUDGET</span>
                  <span style={{ ...muted, marginLeft: 8 }}>
                    {commercial.budget.openExceptions} cost head{commercial.budget.openExceptions === 1 ? '' : 's'} standing over budget.
                  </span>
                </div>
              )}
              {positions.length === 0 && (
                <div data-testid="commercial-position-empty" style={{ ...rowCard, ...muted }}>No cost heads defined yet.</div>
              )}
              {positions.map((p) => (
                <div key={p.costHeadCode} style={rowCard} data-testid={`commercial-head-${p.costHeadCode}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{p.costHeadName}</div>
                      <div style={mono}>{p.costHeadCode}</div>
                    </div>
                    {isBreached(p) && <span style={breachChip} data-testid={`commercial-breach-${p.costHeadCode}`}>OVER BUDGET</span>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                    <span style={muted}>Budget <span style={num} data-testid={`commercial-budget-${p.costHeadCode}`}>{money(p.budget)}</span></span>
                    <span style={muted}>Exposure <span style={num} data-testid={`commercial-exposure-${p.costHeadCode}`}>{p.exposure}</span></span>
                    <span style={muted}>Headroom <span style={num} data-testid={`commercial-headroom-${p.costHeadCode}`}>{money(p.headroom)}</span></span>
                  </div>
                </div>
              ))}
            </div>
          )}

      {tab === 'commitments' && commercial && (
            <div data-testid="commercial-commitments">
              {liveAttributions.length === 0 && (
                <div data-testid="commercial-commitments-empty" style={{ ...rowCard, ...muted }}>
                  No purchase-order line is attributed to a cost head yet.
                </div>
              )}
              {liveAttributions.map((a) => {
                // §C: the LINE is the identity a re-attribution supersedes, and exactly one of
                // the two columns is populated (the PG XOR CHECK). `lineId` is what the coalesce
                // key and the disable test both name.
                const lineId = a.poLineId ?? a.labourPoLineId ?? '';
                const pending = attrPending(lineId);
                return (
                <div key={a.id} style={rowCard} data-testid={`commercial-attribution-${a.id}`}>
                  <div style={{ fontWeight: 600 }}>{headName(a.costHeadCode)}</div>
                  <div style={mono}>
                    {a.costHeadCode} · {a.poLineId ? `material line ${a.poLineId}` : `labour line ${a.labourPoLineId}`}
                  </div>
                  {a.reason && <div style={{ ...muted, marginTop: 6 }}>{a.reason}</div>}
                  {/* Re-attribute this line. An ATOMIC REPLACEMENT, never a revocation — §C has no
                      "revoke" precisely because it would drop a live vendor obligation out of every
                      budget while no other head picked the payable up. */}
                  {mayAttribute && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                    <select
                      value={attrFormFor(a.id).head}
                      onChange={(e) => setAttrForm(a.id, { head: e.target.value })}
                      data-testid={`attr-head-${a.id}`}
                      style={{ ...input, flex: '1 1 140px' }}
                    >
                      <option value="">Move to…</option>
                      {commercial.costHeads
                        .filter((h) => h.code !== a.costHeadCode)
                        .map((h) => <option key={h.code} value={h.code}>{h.code} — {h.name}</option>)}
                    </select>
                    <input
                      value={attrFormFor(a.id).reason}
                      onChange={(e) => setAttrForm(a.id, { reason: e.target.value })}
                      placeholder="Reason"
                      data-testid={`attr-reason-${a.id}`}
                      style={{ ...input, flex: '2 1 180px' }}
                    />
                    <Button
                      variant="ink"
                      data-testid={`attr-submit-${a.id}`}
                      disabled={!attrFormFor(a.id).head || !attrFormFor(a.id).reason.trim() || pending}
                      onClick={() => {
                        reattribute(
                          a.poLineId ? { poLineId: a.poLineId } : { labourPoLineId: a.labourPoLineId as string },
                          attrFormFor(a.id).head,
                          attrFormFor(a.id).reason.trim(),
                        );
                      }}
                    >
                      {pending ? 'Moving…' : 'Re-attribute'}
                    </Button>
                  </div>
                  )}
                </div>
                );
              })}
            </div>
          )}

      {tab === 'forecast' && commercial && (
            <div data-testid="commercial-forecast">
              {/* The projection's freshness, reported rather than implied. `refreshedAt: null` is the
                  LIVE fallback path — an honest "computed just now", never a stamped timestamp. */}
              <div style={{ ...mono, marginTop: 12 }} data-testid="commercial-forecast-freshness">
                {commercial.cashForecast.refreshedAt
                  ? `Projection refreshed ${commercial.cashForecast.refreshedAt}`
                  : 'Computed live from canonical state'}
              </div>
              <div style={rowCard} data-testid="commercial-forecast-totals">
                <div style={{ fontWeight: 600 }}>Project totals</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '6px 18px', marginTop: 8 }}>
                  <span style={muted}>Committed <span style={num} data-testid="forecast-committed">{commercial.cashForecast.totals.committed}</span></span>
                  <span style={muted}>Received, not billed <span style={num} data-testid="forecast-received-not-billed">{commercial.cashForecast.totals.receivedNotBilled}</span></span>
                  <span style={muted}>Awaiting certification <span style={num} data-testid="forecast-awaiting-certification">{commercial.cashForecast.totals.awaitingCertification}</span></span>
                  <span style={muted}>Certified payable <span style={num} data-testid="forecast-certified-payable">{commercial.cashForecast.totals.certifiedPayable}</span></span>
                  <span style={muted}>Approved <span style={num} data-testid="forecast-approved">{commercial.cashForecast.totals.approved}</span></span>
                  <span style={muted}>Paid <span style={num} data-testid="forecast-paid">{commercial.cashForecast.totals.paid}</span></span>
                </div>
                {/* §J — `budget` is the CEILING the six exposure buckets are measured against, never
                    a seventh addend, so it is reported ALONGSIDE `exposure` and `headroom` rather
                    than among them. Two earlier revisions of §J got this wrong in opposite
                    directions, which is why the separation is visible in the layout too. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}>
                  <span style={muted}>Exposure <span style={num} data-testid="forecast-exposure">{commercial.cashForecast.totals.exposure}</span></span>
                  <span style={muted}>Budget <span style={num} data-testid="forecast-budget">{commercial.cashForecast.totals.budget}</span></span>
                  <span style={muted}>Headroom <span style={num} data-testid="forecast-headroom">{commercial.cashForecast.totals.headroom}</span></span>
                </div>
              </div>
            </div>
          )}

          {tab === 'claims' && (() => {
            // Codex I3 — the list's state is DECIDED, not enumerated. `willLoad` is exactly the
            // effect's own condition above, so "idle" is a spinner only while something is actually
            // going to fetch; after a shell failure `onPilot` is false, nothing will, and the panel
            // says so with a retry instead of rendering an empty div.
            const v = viewOf(bills, billsLoad, onPilot && billsLoad === 'idle');
            return (
            <div data-testid="commercial-claims">
              {v.show === 'loading' && (
                <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-loading">Loading claims…</div>
              )}
              {v.show === 'unavailable' && (
                <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-unavailable">
                  <div>Claims couldn&rsquo;t load.</div>
                  <div style={{ marginTop: 10 }}>
                    <Button variant="ink" onClick={() => refresh()} data-testid="commercial-claims-retry">
                      <RefreshCw size={14} /> Retry
                    </Button>
                  </div>
                </div>
              )}
              {v.show === 'content' && (
                <>
                  {mayBill && (
                    <div style={rowCard} data-testid="commercial-lodge-form">
                      <div style={{ fontWeight: 600, marginBottom: 8 }}>Lodge a vendor claim</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <input value={lodge.vendorId} onChange={(e) => setLodge({ vendorId: e.target.value })} placeholder="Vendor id" data-testid="lodge-vendor" style={{ ...input, flex: '1 1 120px' }} />
                        <input value={lodge.number} onChange={(e) => setLodge({ number: e.target.value })} placeholder="Their bill number" data-testid="lodge-number" style={{ ...input, flex: '1 1 130px' }} />
                        <input value={lodge.date} onChange={(e) => setLodge({ date: e.target.value })} placeholder="Document date (YYYY-MM-DD)" data-testid="lodge-date" style={{ ...input, flex: '1 1 150px' }} />
                        <select value={lodge.lineKind} onChange={(e) => { const k = e.target.value as 'material' | 'labour'; setLodge(claimLineMayCarryCharges(k) ? { lineKind: k } : { lineKind: k, tax: '', freight: '' }); }} data-testid="lodge-linekind" style={{ ...input, flex: '0 1 110px' }}>
                          <option value="material">Material line</option>
                          <option value="labour">Labour line</option>
                        </select>
                        <input value={lodge.poLineId} onChange={(e) => setLodge({ poLineId: e.target.value })} placeholder="PO line id" data-testid="lodge-poline" style={{ ...input, flex: '1 1 120px' }} />
                        <input value={lodge.qty} onChange={(e) => setLodge({ qty: e.target.value })} placeholder="Quantity" inputMode="decimal" data-testid="lodge-qty" style={{ ...input, flex: '1 1 100px' }} />
                        <input value={lodge.rate} onChange={(e) => setLodge({ rate: e.target.value })} placeholder="Rate" inputMode="decimal" data-testid="lodge-rate" style={{ ...input, flex: '1 1 100px' }} />
                        <input value={lodge.tax} onChange={(e) => setLodge({ tax: e.target.value })} disabled={!chargesAllowed} placeholder="Tax (optional)" inputMode="decimal" data-testid="lodge-tax" style={{ ...input, flex: '1 1 110px' }} />
                        <input value={lodge.freight} onChange={(e) => setLodge({ freight: e.target.value })} disabled={!chargesAllowed} placeholder="Freight (optional)" inputMode="decimal" data-testid="lodge-freight" style={{ ...input, flex: '1 1 120px' }} />
                        <Button variant="outline" disabled={!entryValid} data-testid="lodge-add-line" onClick={addLodgeLine}>
                          Add line
                        </Button>
                        <Button
                          variant="ink"
                          data-testid="lodge-submit"
                          disabled={!lodgeValid || lodgePending}
                          onClick={() => recordBill({
                            vendorId: lodge.vendorId.trim(),
                            vendorBillNumber: lodge.number.trim(),
                            documentDate: lodge.date.trim(),
                            lines: lodgeLines.map((l) => ({
                              ...(l.lineKind === 'labour' ? { labourPoLineId: l.poLineId } : { poLineId: l.poLineId }),
                              quantity: l.qty,
                              rate: l.rate,
                              // omitted rather than sent as '0.00' when blank: the server's own
                              // default is zero, and an explicit zero would claim the document says so
                              ...(l.tax === '' ? {} : { taxAmount: l.tax }),
                              ...(l.freight === '' ? {} : { freightAmount: l.freight }),
                            })),
                          })}
                        >
                          {lodgePending ? 'Lodging…' : 'Lodge claim'}
                        </Button>
                      </div>
                      {lodge.lines.length > 0 && (
                        <div style={{ marginTop: 8 }} data-testid="lodge-lines">
                          {lodge.lines.map((l, i) => (
                            <div key={`${l.poLineId}:${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                              <span style={{ ...mono, flex: '1 1 auto' }} data-testid={`lodge-line-${i}`}>
                                {l.lineKind === 'labour' ? 'Labour' : 'Material'} · {l.poLineId} · {l.qty} × {l.rate}
                                {l.tax !== '' && ` · tax ${l.tax}`}{l.freight !== '' && ` · freight ${l.freight}`}
                              </span>
                              <Button
                                variant="ghost"
                                data-testid={`lodge-line-remove-${i}`}
                                onClick={() => setLodge({ lines: lodge.lines.filter((_, j) => j !== i) })}
                              >
                                Remove
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* the §A rules, from the SAME functions the zod contract uses */}
                      {((lodge.qty.trim() !== '' && !isPositiveQuantity(lodge.qty)) || (lodge.rate.trim() !== '' && !isMoneyString(lodge.rate))
                        || (lodge.date.trim() !== '' && !isRealCivilDate(lodge.date))) && (
                        <div style={{ ...muted, marginTop: 8, color: 'var(--amber-text)' }} data-testid="lodge-invalid">
                          Quantity must be positive (≤6dp), rate a non-negative money value (≤2dp), and the
                          document date a real calendar day (YYYY-MM-DD).
                        </div>
                      )}
                      {entryDirty && !entryValid && (
                        <div style={{ ...muted, marginTop: 8, color: 'var(--amber-text)' }} data-testid="lodge-entry-incomplete">
                          Finish or clear the line you are editing — lodging now would leave it out of
                          the claim, and the bill number is frozen once the claim is recorded.
                        </div>
                      )}
                      {lodgeDuplicate && (
                        <div style={{ ...muted, marginTop: 8, color: 'var(--amber-text)' }} data-testid="lodge-duplicate">
                          A live claim for this vendor and bill number already exists — amend or reject it instead.
                        </div>
                      )}
                    </div>
                  )}
                  {/* Codex H1 — a cached list whose latest refresh FAILED says so. Round 2 hoisted
                      exactly this warning for the CLAIM and left the LIST without one, so an open
                      Claims tab could render "No vendor claim has been recorded yet" after a failed
                      refresh that would have shown the first claim another user recorded. Both
                      resources now render through the SAME decision, so the pair cannot drift. */}
                  {v.stale && (
                    <div style={{ ...rowCard, ...muted, borderColor: 'var(--amber-border)', background: 'var(--amber-chip)', color: 'var(--amber-text)' }} data-testid="commercial-claims-stale">
                      Showing the last-known claim list — the latest couldn&rsquo;t load.{' '}
                      <button onClick={() => refresh()} data-testid="commercial-claims-stale-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer' }}>
                        Retry
                      </button>
                    </div>
                  )}
                  {v.refreshing && (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-refreshing">Refreshing the claim list…</div>
                  )}
                  {v.value.length === 0 && (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-empty">No vendor claim has been recorded yet.</div>
                  )}
                  {v.value.map((row) => {
                // The SELECTED row reads whichever COPY OF THIS BILL is authoritative, because the
                // list and the claim bundle both carry its status and are fetched independently.
                // `arbitrateBillCopy` owns that rule and the reasoning behind it — including why an
                // equal stamp with a differing status is refused rather than broken toward either
                // copy. It is a shared function rather than an expression here because the
                // Certification tab acts on the same lifecycle and the ambiguity term is the part a
                // second surface forgets.
                const reading = arbitrateBillCopy(row, row.id === selectedBillId ? claim?.bill ?? null : null);
                // `row` is non-null here, so the reading is too; the fallback satisfies the type
                // without a non-null assertion and is the identity in this branch.
                const b = reading?.copy ?? row;
                const ambiguous = reading?.ambiguous ?? false;
                return (
                  <div key={b.id}>
                  <button
                    onClick={() => selectClaim(b.id)}
                    data-testid={`commercial-claim-row-${b.id}`}
                    style={{
                      ...rowCard, display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                      borderColor: b.id === selectedBillId ? 'var(--ink)' : 'var(--hairline)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                      <div style={{ fontWeight: 600 }}>{b.vendorBillNumber}</div>
                      <span style={mono} data-testid={`commercial-claim-status-${b.id}`}>{b.status}</span>
                      {ambiguous && (
                        <span style={{ ...muted, color: 'var(--amber-text)' }} data-testid={`commercial-claim-ambiguous-${b.id}`}>
                          two reads disagree about this claim's status and carry the same timestamp — refresh to resolve
                        </span>
                      )}
                    </div>
                    <div style={mono}>{b.id}</div>
                  </button>
                  {/* §F lifecycle. Submit / reject are two of the three transitions on ONE claim,
                      so `billTxPending` disables both together — the claim is the constrained
                      resource, not the verb. (Amend carries a full line set and belongs with the
                      claim-editing surface, not this row; it is wired in the store and gateway and
                      is stated in the PR as not yet surfaced.) */}
                  {mayBill && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                      {/* Codex M3/M4 — offered only where the SERVER admits the transition. A
                          control for an impossible transition is not cosmetic: the write-ahead
                          outbox persists it and reports it saved, then reconnect drops it with a
                          terminal 409. The admissible sets are the shared ones the service uses. */}
                      <Button
                        variant="ink"
                        data-testid={`bill-submit-${b.id}`}
                        disabled={!transitionOffered(reading, BILL_SUBMITTABLE_FROM) || billTxPending(b.id)}
                        onClick={() => submitBill(b.id)}
                      >
                        {billTxPending(b.id) ? 'Working…' : 'Submit'}
                      </Button>
                      <input
                        value={billReasonFor(b.id)}
                        onChange={(e) => setBillReason(b.id, e.target.value)}
                        placeholder="Rejection reason"
                        data-testid={`bill-reason-${b.id}`}
                        style={{ ...input, flex: '2 1 160px' }}
                      />
                      <Button
                        variant="ghost"
                        data-testid={`bill-reject-${b.id}`}
                        disabled={!transitionOffered(reading, BILL_REJECTABLE_FROM) || !billReasonFor(b.id).trim() || billTxPending(b.id)}
                        onClick={() => rejectBill(b.id, billReasonFor(b.id).trim())}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                  </div>
                );
                  })}
                </>
              )}
            </div>
            );
          })()}

          {tab === 'certification' && (
            <div data-testid="commercial-certification">
              {claimPanel((claim) => (
                <>
                  {/* §E — the verification triple, DERIVED server-side on every call. A stored
                      verdict is stale the moment a receipt is reversed, which is why it is not
                      cached here either. */}
                  <div style={rowCard} data-testid="commercial-verification">
                    <div style={{ fontWeight: 600 }}>Verification</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                      <span style={muted}>Verdict <span style={num} data-testid="verification-verdict">{claim.verification.verdict}</span></span>
                      {/* §E is explicit that the VERDICT and the claim's STATUS answer different
                          questions — a claim disputed for its evidence and then re-evidenced reads
                          `matched` with a `disputed` status, true on both counts. Rendering only one
                          of them would let a reader mistake it for the other. */}
                      <span style={muted}>Claim status <span style={num} data-testid="verification-bill-status">{claim.verification.billStatus}</span></span>
                    </div>
                    {claim.verification.exceptions.length > 0 && (
                      <div style={{ ...muted, marginTop: 6 }} data-testid="verification-exceptions">
                        {claim.verification.exceptions.join(', ')}
                      </div>
                    )}
                  </div>
                  {/* §E/§F — the verification CHAIN, on the tab that shows what it decides.
                      `begin-verification` opens the three-way check on a submitted claim; `verify`
                      runs it and records the verdict, which moves the claim to `verified` or
                      `disputed` depending on what the check finds. Neither takes an operator
                      verdict as input: §E DERIVES it, so there is nothing to type here.

                      Gated on `arbitrateBillCopy` for the same reason the Claims tab is, and
                      through the same function. This panel renders `claim.bill` — the copy that
                      CAN be the older one — so asking it alone would offer "Begin verification"
                      on a claim the list already shows as verified, and the write-ahead outbox
                      would report that saved before dropping it on a terminal 409. */}
                  {(() => {
                    const listRow = (bills ?? []).find((r) => r.id === claim.bill.id) ?? null;
                    const reading = arbitrateBillCopy(listRow, claim.bill);
                    return (
                      <>
                        {/* Outside the authority gate on purpose: an undecidable pair means the
                            status and verdict above may not be current, and that is true for
                            whoever is reading them. Hiding it from the actor who lodged the claim
                            would leave them the only person on this page not told. */}
                        {reading?.ambiguous && (
                          <div style={{ ...rowCard, ...muted, borderColor: 'var(--amber-border)', background: 'var(--amber-chip)', color: 'var(--amber-text)' }} data-testid="commercial-verification-ambiguous">
                            two reads disagree about this claim&rsquo;s status and carry the same
                            timestamp — refresh to resolve
                          </div>
                        )}
                        {mayVerify && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }} data-testid="commercial-verification-actions">
                            <Button
                              variant="ink"
                              data-testid={`bill-begin-verification-${claim.bill.id}`}
                              disabled={!transitionOffered(reading, BILL_BEGIN_VERIFICATION_FROM) || billTxPending(claim.bill.id)}
                              onClick={() => beginVerification(claim.bill.id)}
                            >
                              {billTxPending(claim.bill.id) ? 'Working…' : 'Begin verification'}
                            </Button>
                            <Button
                              variant="ink"
                              data-testid={`bill-verify-${claim.bill.id}`}
                              disabled={!transitionOffered(reading, BILL_VERIFY_FROM) || billTxPending(claim.bill.id)}
                              onClick={() => verifyBill(claim.bill.id)}
                            >
                              Record verdict
                            </Button>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {/* §I — WHAT THE SERVER SAID about this reader's authorisation on this claim.
                      Reported for whoever can act on it, because a certifier who has just been
                      authorised otherwise cannot tell whether the authorisation is live and
                      version-matched, and "granted against an earlier version" is discoverable
                      only by being refused.

                      Note what is NOT claimed: nothing here says an authorisation is NEEDED. §I
                      asks about the rows the certificate freezes, which are decided inside the
                      certification transaction, so that question has no honest answer before the
                      act — see `CertifyPreflightDto`. The panel reports the state that IS known
                      and leaves the rest to the server's refusal, which the block below makes
                      legible instead of guessing at. */}
                  {mayCertify && SOD_STATE_MESSAGE[claim.certifyPreflight.grantState] !== null && (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-sod-state">
                      {SOD_STATE_MESSAGE[claim.certifyPreflight.grantState]}
                    </div>
                  )}

                  {/* ── §I (7B-iii-g) — the APPROVER's own act, on the surface that reports the refusal ──
                      Before this, a certifier who recorded the evidence got an accurate refusal
                      naming `commercial.sod.grant` and no way to reach it. The remedy is now where
                      the problem is stated.

                      The picker NARROWS; the server DECIDES. It offers active pmc members and
                      excludes the caller (§I forbids a self-grant, and `callerActorId` exists in
                      the preflight precisely so the client can honour that instead of queueing the
                      one choice the server is certain to refuse). It does NOT enumerate authority:
                      standing is re-checked at the command, because a picker is not the only way
                      in, and a second implementation of the standing question is exactly the root
                      this unit's audit opens with. */}
                  {mayGrant && (() => {
                    const draft = certDraftFor(claim.bill.id);
                    const viewedVersion = claim.bill.versions.find((v) => v.live)?.id ?? null;
                    // ── the SAME reading the Certify control acts on ──────────────────────────
                    //
                    // Round 1 findings 4 and 5, and they are one mistake: this form pinned
                    // `claim.bill` directly while the control beneath it arbitrated the list copy
                    // against the bundle. Two consequences, both the write-ahead lie:
                    //
                    //  · the bundle can be OLDER than the list. Pinning its status and revision
                    //    queues an authorisation against facts the server has already moved past,
                    //    and refuses it after the outbox reported it saved.
                    //  · certification is legal only from `verified`. An authorisation recorded
                    //    while the claim is draft/submitted/under-verification can NEVER be spent —
                    //    it is `stale-review` the moment the claim reaches the state it was meant
                    //    for. Recording one is worse than refusing it, because the approver is told
                    //    an authority exists that does not.
                    //
                    // So the form is offered exactly where certification is, from exactly the copy
                    // certification acts on.
                    const grantListRow = (bills ?? []).find((r) => r.id === claim.bill.id) ?? null;
                    const grantReading = arbitrateBillCopy(grantListRow, claim.bill);
                    const grantAuthoritative = grantReading !== null && grantReading.source !== 'list';
                    // 7B-iv round 3 — CERTIFICATION rule only; the payment rule is PARKED as 7B-v
                    // with its five findings named (`docs/reviews/phase-5-t7b-v-parked-findings.md`).
                    // Each was an incomplete precondition set, and the decisive one needs a SERVER
                    // guard — `approve()` consumes a grant only when `certifiedById === actor`.
                    const spendable = transitionOffered(grantReading, BILL_CERTIFY_FROM);
                    // ── who may be named, decided by the module that owns the rule ─────────────
                    //
                    // Round 1, finding 6. The first draft filtered the team roster in the browser
                    // (`role === 'pmc' && status === 'active'`), which I had argued was "narrowing,
                    // not enumerating authority". It was enumerating authority — badly. The server
                    // admits an org owner/admin as pmc where they hold no active membership here,
                    // and that filter silently excluded exactly those people, so a legitimate
                    // approver could not be named for an authorisation the command would accept.
                    //
                    // A picker built from an approximation of an authority rule IS an authority
                    // rule, and a second one. The list is now computed server-side beside the
                    // predicate itself and arrives on the claim read — which also means the form
                    // needs no team data the screen never asked for (finding 3).
                    const candidates = claim.certifyPreflight.sodCandidates;
                    // R5-1 — the SAME function the dispatcher refuses with, so the screen and the
                    // outbox cannot answer differently. A pending claim transition is about to move
                    // the version, status and revision this authorisation pins.
                    const blocked = draft.sodActorId !== ''
                      && commercialWriteBlocked(
                        sodGrantCoalesceKey(claim.bill.id, draft.sodActorId, draft.sodRule), commercialPending,
                      );
                    return (
                      <div style={rowCard} data-testid="commercial-sod-grant">
                        <div style={{ ...muted, marginBottom: 7 }}>
                          Authorise someone to CERTIFY evidence they recorded, against this claim as
                          it stands now. §I's other rule — authorising a certifier to APPROVE the
                          claim they certified — is not issued here yet; the payments tab still
                          reports that refusal accurately, and its remedy lands with 7B-v.
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          <select
                            style={input}
                            data-testid="sod-actor"
                            value={draft.sodActorId}
                            onChange={(e) => setCertDraft(claim.bill.id, { sodActorId: e.target.value })}
                          >
                            <option value="">Who is being authorised…</option>
                            {candidates.map((m) => (
                              <option key={m.userId} value={m.userId}>{m.name}</option>
                            ))}
                          </select>
                          <input
                            style={{ ...input, flex: 1 }}
                            data-testid="sod-reason"
                            placeholder="Why this authorisation is justified"
                            value={draft.sodReason}
                            onChange={(e) => setCertDraft(claim.bill.id, { sodReason: e.target.value })}
                          />
                          <Button
                            variant="ink"
                            data-testid={`sod-grant-${claim.bill.id}`}
                            disabled={draft.sodActorId === '' || !draft.sodReason.trim()
                              || viewedVersion === null || blocked
                              || !spendable || !grantAuthoritative}
                            onClick={() => {
                              grantSodException(claim.bill.id, draft.sodActorId, draft.sodReason.trim(), {
                                versionId: viewedVersion as string,
                                status: grantReading!.copy.status,
                                lifecycleVersion: claim.certifyPreflight.lifecycleVersion,
                              }, draft.sodRule);
                              setCertDraft(claim.bill.id, { sodActorId: '', sodReason: '' });
                            }}
                          >
                            {blocked ? 'Working…' : 'Authorise'}
                          </Button>
                        </div>
                        {!blocked && !spendable && (
                          <div style={{ ...muted, marginTop: 7 }} data-testid="sod-grant-not-certifiable">
                            Certification is only legal once this claim is verified, so an
                            authorisation recorded now could never be spent. Authorise it once the
                            claim is verified.
                          </div>
                        )}
                        {blocked && (
                          <div style={{ ...muted, marginTop: 7 }} data-testid="sod-grant-blocked">
                            This claim has a change in flight. An authorisation records the version,
                            state and revision it was given against, and that change is about to move
                            all three — authorise again once it has landed.
                          </div>
                        )}
                        {candidates.length === 0 && (
                          <div style={{ ...muted, marginTop: 7 }} data-testid="sod-grant-nobody">
                            There is nobody else on this project with pmc standing to authorise.
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {mayCertify && (() => {
                    const listRow = (bills ?? []).find((r) => r.id === claim.bill.id) ?? null;
                    const reading = arbitrateBillCopy(listRow, claim.bill);
                    const draft = certDraftFor(claim.bill.id);
                    // Codex round-2 — the facts this reader is LOOKING AT, carried with the command
                    // so a replay cannot act on a version/document they never saw. Round 1 pinned
                    // the grant and stopped there; certification and supersession have the same
                    // exposure, and certification is the act that creates money.
                    const viewedVersion = claim.bill.versions.find((v) => v.live)?.id ?? null;
                    const viewedCertificate = claim.certificate?.id ?? null;
                    // Round 5 — §0's rule that cash already gone is not corrected by correcting a
                    // document. The server's paid-vs-approved bound refuses a supersession while
                    // cash stands against the certificate, and this bundle already carries the
                    // payment ledger — so offering the button anyway is the write-ahead lie again,
                    // told with a figure the screen is holding.
                    // …and round 4: `paid` is what the bundle SAW, which is not the same as what
                    // will stand when this supersede lands. A payment queued on this claim is cash
                    // the FIFO outbox will apply FIRST, so the server then refuses the supersede
                    // for the very reason above — after the outbox reported the correction saved.
                    //
                    // Round 3 closed this conflict in one direction only (a pending supersede
                    // blocks a payment) and a conflict between two commands is not one-directional
                    // unless the bounds make it so. Here BOTH orderings end in a server refusal,
                    // so both are refused up front.
                    const cashQueued = commercialPending.some((k) => k.startsWith(`com:pay:${claim.bill.id}:`));
                    const cashStands = decGt(claim.payments.paid, '0') || cashQueued;
                    // Codex round 3 — the GATE and the PAYLOAD must come from ONE copy. The gate
                    // arbitrates list-vs-claim; the payload is pinned from the CLAIM bundle. When
                    // the list is the fresher of the two, the gate says yes while the pin is stale,
                    // and the server refuses a command the screen had already reported saved — the
                    // write-ahead lie, produced by my own arbitration used inconsistently. So these
                    // acts are offered only while the claim bundle IS the authoritative copy.
                    // Round 4 — the claim bundle is good enough to act on unless the LIST is
                    // strictly newer. Derived from the named source, because the previous spelling
                    // compared object identity and `arbitrateBillCopy` returns the LIST object when
                    // the two AGREE — so the ordinary case of opening a current claim read as
                    // "stale" and disabled certification outright. A correctness guard that
                    // disables the workflow it guards is worse than the defect it closed.
                    const claimIsAuthoritative = reading !== null && reading.source !== 'list';
                    return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }} data-testid="commercial-certify-actions">
                        <Button
                          variant="ink"
                          data-testid={`bill-certify-${claim.bill.id}`}
                          disabled={!transitionOffered(reading, BILL_CERTIFY_FROM) || !claimIsAuthoritative
                            || viewedVersion === null || billTxPending(claim.bill.id)}
                          onClick={() => certifyBill(
                            claim.bill.id, viewedVersion as string, claim.certifyPreflight.lifecycleVersion,
                          )}
                        >
                          {billTxPending(claim.bill.id) ? 'Working…' : 'Certify'}
                        </Button>
                        {/* §F — past certification the correction path is a SUPERSEDING certificate,
                            never an edit, so the reason is required rather than optional. */}
                        <input
                          value={draft.supersedeReason}
                          onChange={(e) => setCertDraft(claim.bill.id, { supersedeReason: e.target.value })}
                          placeholder="Reason for superseding"
                          data-testid={`cert-supersede-reason-${claim.bill.id}`}
                          style={{ ...input, flex: '2 1 160px' }}
                        />
                        <Button
                          variant="ghost"
                          data-testid={`cert-supersede-${claim.bill.id}`}
                          disabled={!transitionOffered(reading, BILL_STATUSES_PAST_CERTIFICATION)
                            || !claimIsAuthoritative
                            || !draft.supersedeReason.trim() || viewedCertificate === null
                            || cashStands || billTxPending(claim.bill.id)}
                          onClick={() => supersedeCertificate(claim.bill.id, draft.supersedeReason.trim(), viewedCertificate as string)}
                        >
                          Supersede
                        </Button>
                      </div>
                    );
                  })()}

                  {/* §I — the AUTHORISATION surface (issue an exception, and the register of
                      those that stand) is 7B-iii-h, parked whole on
                      `claude/phase5-task7b-iii-f-sod-parked`. It is split out because the review
                      lifecycle reported this unit at its head limit and nearly every finding across
                      five rounds landed on that surface: it mirrors server AUTHORITY decisions, and
                      round 5 established it also needs a schema change (the reviewed status must be
                      PERSISTED on the grant, not merely checked at issue).

                      What remains here is honest about the gap: a certifier who recorded the
                      evidence is refused by §I with a message naming `commercial.sod.grant`, and
                      cannot self-serve that remedy on this screen until 7B-iii-h lands. That is a
                      narrower gap than it sounds — the common path is a certifier who did NOT
                      record the evidence, which works end to end — but it IS a gap, and it is
                      stated rather than papered over. */}
                  {claim.certificate === null ? (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-certificate-none">
                      Not certified yet. A claim before certification is an ordinary state, not an error.
                    </div>
                  ) : (
                    <div style={rowCard} data-testid="commercial-certificate">
                      <div style={{ fontWeight: 600 }}>Certificate</div>
                      <div style={mono}>{claim.certificate.id}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                        <span style={muted}>Certified <span style={num} data-testid="certificate-amount">{claim.certificate.certifiedAmount}</span></span>
                        <span style={muted}>Withheld <span style={num} data-testid="certificate-withheld">{claim.deductions.withheld}</span></span>
                        <span style={muted}>Net payable <span style={num} data-testid="certificate-net-payable">{money(claim.deductions.netPayable)}</span></span>
                      </div>
                      {claim.deductions.deductions.length > 0 && (
                        <div style={{ marginTop: 8 }} data-testid="commercial-deductions">
                          {claim.deductions.deductions.map((d) => (
                            <div key={d.id} style={{ ...muted, marginTop: 4 }} data-testid={`commercial-deduction-${d.id}`}>
                              {d.type} <span style={num}>{d.amount}</span>{d.reason ? ` — ${d.reason}` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ))}
            </div>
          )}

          {tab === 'payments' && (
            <div data-testid="commercial-payments">
              {claimPanel((claim) => (
                <div style={rowCard} data-testid="commercial-payment-ledger">
                  <div style={{ fontWeight: 600 }}>Approvals and payments</div>
                  {/* `approvable` is DERIVED from `netPayable` server-side, and both arrive in the
                      same repeatable-read snapshot — which is why they are rendered together here
                      rather than on the tab that happens to own each one. */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                    <span style={muted}>Approved <span style={num} data-testid="payments-approved">{claim.payments.approved}</span></span>
                    <span style={muted}>Paid <span style={num} data-testid="payments-paid">{claim.payments.paid}</span></span>
                    <span style={muted}>Approvable <span style={num} data-testid="payments-approvable">{money(claim.payments.approvable)}</span></span>
                    <span style={muted}>Status <span style={num} data-testid="payments-bill-status">{claim.payments.billStatus}</span></span>
                  </div>
                  {claim.payments.approvals.length === 0 && (
                    <div style={{ ...muted, marginTop: 8 }} data-testid="commercial-approvals-empty">Nothing authorised yet.</div>
                  )}
                  {claim.payments.approvals.map((a) => (
                    <div key={a.id} style={{ ...muted, marginTop: 6 }} data-testid={`commercial-approval-${a.id}`}>
                      <span style={num}>{a.amount}</span> approved · paid <span style={num}>{a.paid}</span>
                    </div>
                  ))}

                  {/* ── 7B-iii-d — the payer's chain ────────────────────────────────────────────
                      Every control here moves a §F FOLD, so every one of them advances the claim's
                      monotonic revision. That is why `approve` — the only command carrying a
                      viewed-fact pin — is disabled while ANY of the others is in flight: queued
                      behind one, its `lifecycleVersion` names a passage of the claim that is
                      already gone, and the server refuses it after the outbox reported it saved.
                      `commercialWriteBlocked` owns that rule and the dispatcher enforces it; this
                      screen asks the same function so the two cannot disagree. */}
                  {(() => {
                    const d = payDraftFor(claim.bill.id);
                    // The contract requires these arrays. They are read defensively anyway: this
                    // bundle arrives over the network, and a partial body on a MONEY surface must
                    // degrade to "no controls offered", never to a thrown render.
                    const approvals = claim.payments.approvals ?? [];
                    // §G bound 5 — a payment draws on ONE approval, so payments hang off the
                    // approval that authorised them rather than off the ledger.
                    const paymentsMade = approvals.flatMap((a) => a.payments ?? []);
                    const withheld = claim.deductions?.deductions ?? [];
                    // ── ONE PRECONDITION TABLE FOR ALL SIX CONTROLS ────────────────────────────
                    //
                    // Two review rounds and thirteen findings said the same thing: I wrote these
                    // gates CONTROL BY CONTROL, so every rule I discovered reached the controls I
                    // was holding in mind and no others. Round 1 even called four of its findings
                    // "one mistake made four times", fixed it in four places, and left the fifth
                    // control out of the sweep it had just named.
                    //
                    // So the gates are computed HERE, together, keyed by control. A rule is written
                    // once as a row; a control missing one is a visible hole in a table instead of
                    // an absence nobody can see. Full audit: `docs/reviews/pr-316-convergence.md`.
                    //
                    // Money is compared with `lib/decimal.ts`'s bigint-scaled helpers, not through
                    // `Number`: round 1's helper lost paisa on large values, and the exact tool was
                    // one import away.
                    const shaped = (v: string): boolean => isMoneyString(v.trim()) && decIsPositive(v.trim());
                    const fits = (typed: string, remaining: string | null): boolean =>
                      remaining !== null && shaped(typed) && !decGt(typed.trim(), remaining);

                    // ── WHAT A WITHHOLDING MAY CONSUME ────────────────────────────────────────
                    //
                    // Not `netPayable`, and the difference is a §F seal rather than a preference.
                    // A withholding LOWERS `NET_PAYABLE`, and the derived-status seal re-runs after
                    // the insert requiring `APPROVED <= NET_PAYABLE`. So withholding the whole
                    // payable on a claim that already carries a ₹30 approval leaves the claim in
                    // breach and the write is rejected AT COMMIT. What is free to withhold is what
                    // is left AFTER standing approvals — which is exactly `approvable`, already
                    // derived server-side from the same snapshot.
                    //
                    // …and `advance-recovery` is the one type with a SECOND ceiling: it draws on a
                    // VENDOR-scoped pool, what the counterparty still owes back across every claim.
                    // The bundle carries it, and its contract says why — "so an operator can see
                    // the ceiling BEFORE a recovery is refused by it rather than only in the
                    // refusal". `bothOf` is null-propagating on purpose: an undeterminable ceiling
                    // must refuse, never fall back to the other one.
                    const approvable = claim.payments.approvable ?? null;
                    // §I, from the rule the PAYMENT service actually consumes. `certifyPreflight`
                    // answers `evidence-recorder-may-not-certify`, which is a different question;
                    // gating approval on it was wrong in both directions until 7B-iv exposed this.
                    const selfApproving = claim.approvePreflight.callerIsCertifier
                      && claim.approvePreflight.grantState !== 'live';
                    const recoverable = claim.deductions?.advance?.recoverable ?? null;

                    // ── IS THIS BUNDLE STILL GOOD ENOUGH TO ACT ON? ──────────────────────────
                    //
                    // 7B-iv makes this EXACT. Rounds 3 and 4 argued about a status comparison that
                    // was only a partial staleness detector — a withholding moves `NET_PAYABLE`
                    // and the claim's revision WITHOUT moving the §F label, so two reads could
                    // agree on the status while the bundle was already behind. The server now puts
                    // `lifecycleVersion` on the list row, so the client compares the very number
                    // the approval bound compares.
                    //
                    // It subsumes the old check rather than sitting beside it: the revision
                    // advances on every §F transition AND every fold write, so equal revisions IS
                    // agreement. A missing list row is one reading, not a disagreement — the same
                    // rule `arbitrateBillCopy` applies, and refusing there would disable the whole
                    // surface for the moment before the list lands.
                    // …and the comparison is ORDERED, not an equality. The revision is monotonic,
                    // so which side is larger is the whole answer: only a list row AHEAD of the
                    // bundle proves the bundle stale. Equality was the wrong test in one direction
                    // — a withholding lands, the claim bundle reloads to the new revision, and the
                    // list read is still in flight or has failed and kept its older row. The
                    // bundle is then the FRESHER reading and carries exactly the revision the
                    // server expects, yet every control was disabled.
                    const listRow = (bills ?? []).find((r) => r.id === claim.bill.id) ?? null;
                    const bundleCurrent = listRow === null
                      || listRow.lifecycleVersion <= claim.certifyPreflight.lifecycleVersion;

                    const bothOf = (a: string | null, b: string | null): string | null =>
                      a === null || b === null ? null : (decGt(a, b) ? b : a);

                    const selectedApproval = approvals.find((a) => a.id === d.payApprovalId) ?? null;
                    const selectedPayment = paymentsMade.find((pmt) => pmt.id === d.reversePaymentId) ?? null;
                    const selectedWithholding = withheld.find((x) => x.id === d.releaseId) ?? null;
                    const reasonRequired = (DEDUCTION_TYPES_REQUIRING_REASON as readonly string[])
                      .includes(d.deductType);
                    // an approval whose certificate is no longer the live one cannot be paid: the
                    // service refuses it, and the bundle already names the live certificate
                    const liveCertificateId = claim.certificate?.id ?? null;
                    const approvalIsLive = selectedApproval !== null
                      && selectedApproval.certificateId === liveCertificateId;

                    // Which rules apply where. THREE are universal — shape, balance, and the
                    // pending-conflict on the resource each command constrains — and every row
                    // carries all three. ONE is narrow, and the blank says so rather than reading
                    // as another missed sweep: only `pay` is blocked by a lifecycle TRANSITION,
                    // because only `pay` rests on a document a transition can invalidate. A
                    // supersede replaces the certificate an approval hangs off, and the payment
                    // service re-reads that certificate and refuses; a withholding, a release and
                    // a reversal name rows a supersede does not move.
                    const gate = {
                      approve: {
                        // an approval PINS the revision, and every fold write on this claim moves it
                        blocked: commercialPending.some((k) => isClaimMoneyPending(k, claim.bill.id)),
                        ready: bundleCurrent && shaped(d.approveAmount)
                          && fits(d.approveAmount, approvable) && !selfApproving,
                      },
                      pay: {
                        blocked: (d.payApprovalId !== ''
                          && commercialWriteBlocked(payCoalesceKey(claim.bill.id, d.payApprovalId), commercialPending))
                          // …and behind a pending supersede, whose key names the BILL. The FIFO
                          // outbox would replay the supersede first, leaving this payment drawing
                          // on an authority the server has already retired.
                          || commercialPending.some((k) => isBillTransitionPending(k, claim.bill.id)),
                        ready: bundleCurrent && approvalIsLive && shaped(d.payAmount) && d.payMethod.trim() !== ''
                          && fits(d.payAmount, selectedApproval === null ? null
                            : decSub(selectedApproval.amount, selectedApproval.paid)),
                      },
                      reverse: {
                        blocked: d.reversePaymentId !== ''
                          && commercialWriteBlocked(reverseCoalesceKey(claim.bill.id, d.reversePaymentId), commercialPending),
                        ready: bundleCurrent && selectedPayment !== null && shaped(d.reverseAmount)
                          && d.reverseReason.trim() !== ''
                          && fits(d.reverseAmount, decSub(selectedPayment.amount, selectedPayment.reversed ?? '0')),
                      },
                      deduct: {
                        blocked: commercialWriteBlocked(deductionCoalesceKey(claim.bill.id), commercialPending),
                        // §G bound 3 — a withholding draws on what is still payable, and the bundle
                        // carries that figure. Round 2's finding: the round-1 balance sweep named
                        // four controls and this was the fifth.
                        ready: bundleCurrent && d.deductType !== '' && shaped(d.deductAmount)
                          && fits(d.deductAmount, d.deductType === 'advance-recovery'
                            ? bothOf(approvable, recoverable) : approvable)
                          && !(reasonRequired && d.deductReason.trim() === ''),
                      },
                      release: {
                        blocked: d.releaseId !== ''
                          && commercialWriteBlocked(deductionReleaseCoalesceKey(claim.bill.id, d.releaseId), commercialPending),
                        ready: bundleCurrent && selectedWithholding !== null && shaped(d.releaseAmount)
                          && d.releaseReason.trim() !== ''
                          && fits(d.releaseAmount, selectedWithholding.unreleased),
                      },
                    };
                    const unreleased = withheld.filter((x) => decIsPositive(x.unreleased));

                    return (
                      <div data-testid="commercial-payer-actions" style={{ marginTop: 12 }}>
                        {mayApprove && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                            <input
                              style={input} data-testid="approve-amount" placeholder="Approve amount"
                              value={d.approveAmount}
                              onChange={(e) => setPayDraft(claim.bill.id, { approveAmount: e.target.value })}
                            />
                            <Button
                              variant="ink" data-testid={`approve-${claim.bill.id}`}
                              disabled={gate.approve.blocked || !gate.approve.ready}
                              onClick={() => {
                                approvePayment(claim.bill.id, d.approveAmount.trim(),
                                  claim.certifyPreflight.lifecycleVersion);
                                setPayDraft(claim.bill.id, { approveAmount: '' });
                              }}
                            >{gate.approve.blocked ? 'Working…' : 'Approve'}</Button>
                          </div>
                        )}
                        {mayApprove && selfApproving && (
                          <div style={{ ...muted, marginTop: 6 }} data-testid="approve-self">
                            You certified this claim, so §I does not let you also approve its
                            payment. The exception that would excuse it is not issuable in the app
                            yet — it lands with 7B-v — so it has to be recorded through the API by
                            another pmc with standing. An authorisation to CERTIFY does not excuse
                            this, and §I forbids a self-grant, so it cannot be issued by you.
                          </div>
                        )}
                        {mayApprove && !bundleCurrent && (
                          <div style={{ ...muted, marginTop: 6 }} data-testid="approve-stale">
                            This claim has moved since it was read here. An approval records the
                            revision it was authorised against — reopen the claim to see what
                            stands now.
                          </div>
                        )}
                        {mayApprove && gate.approve.blocked && (
                          <div style={{ ...muted, marginTop: 6 }} data-testid="approve-blocked">
                            This claim's money is moving. An approval records the revision it was
                            authorised against, and the change in flight moves it — approve once it
                            has landed.
                          </div>
                        )}

                        {mayPay && approvals.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                            <select
                              style={input} data-testid="pay-approval" value={d.payApprovalId}
                              onChange={(e) => setPayDraft(claim.bill.id, { payApprovalId: e.target.value })}
                            >
                              <option value="">Against which authorisation…</option>
                              {approvals.map((a) => (
                                <option key={a.id} value={a.id}>{a.amount} approved · {a.paid} paid</option>
                              ))}
                            </select>
                            <input style={input} data-testid="pay-amount" placeholder="Amount"
                              value={d.payAmount}
                              onChange={(e) => setPayDraft(claim.bill.id, { payAmount: e.target.value })} />
                            <input style={input} data-testid="pay-method" placeholder="Method"
                              value={d.payMethod}
                              onChange={(e) => setPayDraft(claim.bill.id, { payMethod: e.target.value })} />
                            <input style={input} data-testid="pay-reference" placeholder="Reference (optional)"
                              value={d.payReference}
                              onChange={(e) => setPayDraft(claim.bill.id, { payReference: e.target.value })} />
                            <Button
                              variant="ink" data-testid={`pay-${claim.bill.id}`}
                              disabled={gate.pay.blocked || !gate.pay.ready}
                              onClick={() => {
                                recordPayment(claim.bill.id, d.payApprovalId, d.payAmount.trim(), d.payMethod.trim(),
                                  d.payReference.trim() === '' ? null : d.payReference.trim());
                                setPayDraft(claim.bill.id, { payApprovalId: '', payAmount: '', payMethod: '', payReference: '' });
                              }}
                            >Record payment</Button>
                          </div>
                        )}

                        {mayReverse && paymentsMade.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                            <select
                              style={input} data-testid="reverse-payment" value={d.reversePaymentId}
                              onChange={(e) => setPayDraft(claim.bill.id, { reversePaymentId: e.target.value })}
                            >
                              <option value="">Which payment…</option>
                              {paymentsMade.map((pmt) => (
                                <option key={pmt.id} value={pmt.id}>{pmt.amount} · {pmt.method}</option>
                              ))}
                            </select>
                            <input style={input} data-testid="reverse-amount" placeholder="Amount"
                              value={d.reverseAmount}
                              onChange={(e) => setPayDraft(claim.bill.id, { reverseAmount: e.target.value })} />
                            <input style={{ ...input, flex: 1 }} data-testid="reverse-reason"
                              placeholder="Why it came back"
                              value={d.reverseReason}
                              onChange={(e) => setPayDraft(claim.bill.id, { reverseReason: e.target.value })} />
                            <Button
                              variant="ink" data-testid={`reverse-${claim.bill.id}`}
                              disabled={gate.reverse.blocked || !gate.reverse.ready}
                              onClick={() => {
                                reversePayment(claim.bill.id, d.reversePaymentId, d.reverseAmount.trim(), d.reverseReason.trim());
                                setPayDraft(claim.bill.id, { reversePaymentId: '', reverseAmount: '', reverseReason: '' });
                              }}
                            >Reverse</Button>
                          </div>
                        )}

                        {mayDeduct && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                            <select
                              style={input} data-testid="deduct-type" value={d.deductType}
                              onChange={(e) => setPayDraft(claim.bill.id, { deductType: e.target.value })}
                            >
                              <option value="">What kind of withholding…</option>
                              {DEDUCTION_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
                            </select>
                            <input style={input} data-testid="deduct-amount" placeholder="Amount"
                              value={d.deductAmount}
                              onChange={(e) => setPayDraft(claim.bill.id, { deductAmount: e.target.value })} />
                            <input style={{ ...input, flex: 1 }} data-testid="deduct-reason"
                              placeholder={reasonRequired ? 'Reason (required for this kind)' : 'Reason (optional)'}
                              value={d.deductReason}
                              onChange={(e) => setPayDraft(claim.bill.id, { deductReason: e.target.value })} />
                            <Button
                              variant="ink" data-testid={`deduct-${claim.bill.id}`}
                              disabled={gate.deduct.blocked || !gate.deduct.ready}
                              onClick={() => {
                                recordDeduction(claim.bill.id, d.deductType, d.deductAmount.trim(),
                                  d.deductReason.trim() === '' ? null : d.deductReason.trim());
                                setPayDraft(claim.bill.id, { deductType: '', deductAmount: '', deductReason: '' });
                              }}
                            >{gate.deduct.blocked ? 'Working…' : 'Withhold'}</Button>
                          </div>
                        )}

                        {mayRelease && unreleased.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                            <select
                              style={input} data-testid="release-deduction" value={d.releaseId}
                              onChange={(e) => setPayDraft(claim.bill.id, { releaseId: e.target.value })}
                            >
                              <option value="">Which withholding…</option>
                              {unreleased.map((x) => (
                                <option key={x.id} value={x.id}>{x.type} · {x.unreleased} held</option>
                              ))}
                            </select>
                            <input style={input} data-testid="release-amount" placeholder="Amount"
                              value={d.releaseAmount}
                              onChange={(e) => setPayDraft(claim.bill.id, { releaseAmount: e.target.value })} />
                            <input style={{ ...input, flex: 1 }} data-testid="release-reason"
                              placeholder="Why it is being returned"
                              value={d.releaseReason}
                              onChange={(e) => setPayDraft(claim.bill.id, { releaseReason: e.target.value })} />
                            <Button
                              variant="ink" data-testid={`release-${claim.bill.id}`}
                              disabled={gate.release.blocked || !gate.release.ready}
                              onClick={() => {
                                releaseDeduction(claim.bill.id, d.releaseId, d.releaseAmount.trim(), d.releaseReason.trim());
                                setPayDraft(claim.bill.id, { releaseId: '', releaseAmount: '', releaseReason: '' });
                              }}
                            >Release</Button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}

          {tab === 'measurements' && (
            <div data-testid="commercial-measurements">
              {/* Round 3 — NOT `claimPanel`: a measurement is a fact about a labour PO line, and
                  requiring a claim to reach it made the workflow's first step depend on its last. */}
              {((): JSX.Element => {
                // The line source is the MONEY BUNDLE's attributions (round 3), and its
                // loading/unavailable/stale boundaries were gated by `onMoneyTab` — so on this tab
                // a failed bundle read rendered "No labour purchase-order lines are attributed on
                // this project yet", which is a claim about the PROJECT made from a read that never
                // arrived. Round 3 moved the data source and its recovery path and left its HONESTY
                // behind; this is that third move. The empty-project statement is only made once
                // the source it describes has actually loaded.
                const lineSource = viewOf(commercial, commercialLoad, onPilot);
                // `viewOf` reports staleness ON content — `{ show: 'content', stale: true }` is a
                // cached bundle whose LATEST read failed. Round 6 handled only `show !== 'content'`,
                // so the cached half of this same finding survived: an empty cached bundle plus a
                // failed refresh still announced "no labour lines are attributed on this project",
                // when the read that failed is exactly the one that would have carried a newly
                // attributed line. Half a finding fixed is the instance, not the class.
                const sourceStale = lineSource.show === 'content' && lineSource.stale;
                const sourceRefreshing = lineSource.show === 'content' && lineSource.refreshing;
                if (lineSource.show !== 'content') {
                  return lineSource.show === 'loading' ? (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-measurements-loading">
                      Reading this project's labour commitments…
                    </div>
                  ) : (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-measurements-unavailable">
                      This project's labour commitments are unavailable, so the lines that can be measured
                      are not known.{' '}
                      <Button variant="ghost" data-testid="commercial-measurements-retry" onClick={() => void loadCommercial()}>
                        Retry
                      </Button>
                    </div>
                  );
                }
                // Codex N3 — `claim.measurements` is keyed from the LIVE version, and a newly
                  // lodged claim is `draft`, so it has none. That made the workflow circular: the
                  // engineer lodges a labour claim, the Measurements tab shows the material-only
                  // empty state, the only control left is Submit — which disputes the claim for
                  // missing measured evidence — and a disputed claim is still not live, so the form
                  // never appears. Lodge → measure → submit was unreachable in exactly the order
                  // this unit exists to support.
                  //
                  // So the ROWS come from the lines of the version on screen (`measurableLineIds`),
                  // and each line's REGISTER comes from THAT LINE'S OWN READ — the claim bundle's
                  // map is deliberately not a source here.
                  //
                  // Round 4 (P1) is why it is one source rather than two with a fallback. Round 3
                  // released `com:meas:` on the line-register read while rendering the bundle's
                  // copy, so on a LIVE claim the register read could win, clear the key, and
                  // re-enable Measure over the stale bundle register — the exact defect being
                  // fixed, with the two halves reading different things. The read that RELEASES a
                  // key and the read that RENDERS its value have to be the same read; the simplest
                  // way to guarantee that is to have only one. (Both are `registerIn` server-side,
                  // so nothing is lost — a second copy was only ever a second opinion.)
                  const measurable: Array<[string, MeasurementRegisterDto | null]> =
                    measurableLineIds.map((id) => [id, lineRegisters[id] ?? null]);
                  return measurable.length === 0 ? (
                  // §D applies to LABOUR lines. A material line's evidence is accepted stock, which
                  // the verification triple already reports — so this says "does not apply" rather
                  // than showing empty registers, which would read as "measured nothing".
                  sourceStale ? (
                    <div style={{ ...rowCard, ...muted, color: 'var(--amber-text)' }} data-testid="commercial-measurements-stale">
                      This project's labour commitments could not be refreshed, so the lines that can be
                      measured are not known to be current — a line attributed since the last successful
                      read would not appear here.{' '}
                      <Button variant="ghost" data-testid="commercial-measurements-retry" onClick={() => void loadCommercial()}>
                        Retry
                      </Button>
                    </div>
                  ) : (
                  <div style={{ ...rowCard, ...muted }} data-testid="commercial-measurements-empty">
                    No labour purchase-order lines are attributed on this project yet — §D measurement
                    applies to labour, and a material claim's evidence is accepted stock, shown under
                    Certification.
                  </div>
                  )
                ) : (
                  <>
                    {(sourceStale || sourceRefreshing) && (
                      // a NON-empty list can be stale too: the lines shown are real, and a line
                      // attributed since the last successful read is missing from them
                      <div style={{ ...rowCard, ...muted, ...(sourceStale ? { color: 'var(--amber-text)' } : {}) }} data-testid="commercial-measurements-source-state">
                        {sourceStale ? (
                          <>
                            This line list could not be refreshed — a line attributed since the last
                            successful read would not appear.{' '}
                            <Button variant="ghost" data-testid="commercial-measurements-retry" onClick={() => void loadCommercial()}>
                              Retry
                            </Button>
                          </>
                        ) : 'Refreshing this project\u2019s labour commitments…'}
                      </div>
                    )}
                    {measurable.map(([lineId, register]) => (
                      <div key={lineId} style={rowCard} data-testid={`commercial-measurement-${lineId}`}>
                        <div style={mono}>{lineId}</div>
                        {register !== null && lineOrdersNothing(register) && (
                          // Round 5 — `append` refuses every POSITIVE row on a line whose order
                          // version is cancelled or superseded, and no quantity says so: a dead
                          // line can still report authority. The register now carries the flag.
                          <div style={{ ...muted, marginTop: 8, color: 'var(--amber-text)' }} data-testid={`measurement-dead-${lineId}`}>
                            This line belongs to a purchase-order version that is no longer live — it orders
                            nothing, so no further work can be measured against it. A reducing correction is
                            still available.
                          </div>
                        )}
                        {register !== null && lineRegisterLoad[lineId] === 'error' && (
                          // Round 2 — a cached register whose LATEST refresh failed is stale, and
                          // writes derived from it are exactly the ones another measurer may have
                          // just invalidated. Show it, say so, and refuse the writes until a read
                          // succeeds — rather than quietly enabling a command against numbers the
                          // app already knows it could not confirm.
                          <div style={{ ...muted, marginTop: 8, color: 'var(--amber-text)' }} data-testid={`measurement-stale-${lineId}`}>
                            This register could not be refreshed — the figures below may be out of date.{' '}
                            <Button variant="ghost" data-testid={`measurement-retry-${lineId}`} onClick={() => void loadLineRegister(lineId)}>
                              Retry
                            </Button>
                          </div>
                        )}
                        {register ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                            <span style={muted}>Measured <span style={num}>{register.measured}</span></span>
                            <span style={muted}>Ordered <span style={num}>{register.orderedPersonShiftQty}</span></span>
                            <span style={muted}>Live authority <span style={num}>{register.liveAuthorityPersonShiftQty}</span></span>
                          </div>
                        ) : (
                          // The register has not LANDED yet — which is a different statement from
                          // "nothing is measured", and rendering zeros would make them look alike.
                          <div style={{ ...muted, marginTop: 8 }} data-testid={`measurement-none-${lineId}`}>
                            {lineRegisterLoad[lineId] === 'error' ? (
                              <>
                                {/* Round 4 (P2): a failed register read holds this line's
                                    `com:meas:` key — only a SUCCESSFUL read releases it — so
                                    without a way back the row stays disabled after connectivity
                                    returns. Refresh reloads them too; this is the row-local one. */}
                                This line’s measurement register is unavailable.{' '}
                                <Button variant="ghost" data-testid={`measurement-retry-${lineId}`} onClick={() => void loadLineRegister(lineId)}>
                                  Retry
                                </Button>
                              </>
                            ) : 'Reading this line’s measurement register…'}
                          </div>
                        )}
                        {/* §D — take a measurement. `citedOutputId` is REQUIRED by the contract, not
                            optional: a measurement is bounded by operational evidence, and an
                            optional citation is one a commercial actor can simply omit. The form
                            therefore cannot submit without it. */}
                        {mayMeasure && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                            <input
                              value={measureFormFor(lineId).activityId}
                              onChange={(e) => setMeasureForm(lineId, { activityId: e.target.value })}
                              placeholder="Activity id"
                              data-testid={`measure-activity-${lineId}`}
                              style={{ ...input, flex: '1 1 130px' }}
                            />
                            <input
                              value={measureFormFor(lineId).qty}
                              onChange={(e) => setMeasureForm(lineId, { qty: e.target.value })}
                              placeholder="Person-shifts"
                              inputMode="decimal"
                              data-testid={`measure-qty-${lineId}`}
                              style={{ ...input, flex: '1 1 110px' }}
                            />
                            <input
                              value={measureFormFor(lineId).outputId}
                              onChange={(e) => setMeasureForm(lineId, { outputId: e.target.value })}
                              placeholder="Cited work output"
                              data-testid={`measure-output-${lineId}`}
                              style={{ ...input, flex: '1 1 150px' }}
                            />
                            <Button
                              variant="ink"
                              data-testid={`measure-submit-${lineId}`}
                              disabled={
                                !measureFormFor(lineId).activityId.trim()
                                || !isPositiveQuantity(measureFormFor(lineId).qty)
                                || !measureFormFor(lineId).outputId.trim()
                                || measurePending(lineId)
                                // Codex Q-c — and never a quantity the register in front of the
                                // user already rules out. Without the register there is nothing to
                                // prove it against, so the control waits rather than guessing.
                                || register === null
                                || lineRegisterLoad[lineId] === 'error'
                                || lineOrdersNothing(register)
                                || exceedsMeasurableCap(register, measureFormFor(lineId).qty.trim(), reservedFor(lineId))
                              }
                              onClick={() => {
                                const f = measureFormFor(lineId);
                                takeMeasurement({
                                  labourPoLineId: lineId,
                                  activityId: f.activityId.trim(),
                                  quantity: f.qty.trim(),
                                  citedOutputId: f.outputId.trim(),
                                });
                              }}
                            >
                              {measurePending(lineId) ? 'Measuring…' : 'Measure'}
                            </Button>
                            {measureFormFor(lineId).qty.trim() !== '' && !isPositiveQuantity(measureFormFor(lineId).qty) && (
                              <div style={{ ...muted, flexBasis: '100%', color: 'var(--amber-text)' }} data-testid={`measure-qty-invalid-${lineId}`}>
                                A measurement is a positive quantity with at most six decimals.
                              </div>
                            )}
                            {register !== null && isPositiveQuantity(measureFormFor(lineId).qty)
                              && exceedsMeasurableCap(register, measureFormFor(lineId).qty.trim(), reservedFor(lineId)) && (
                              <div style={{ ...muted, flexBasis: '100%', color: 'var(--amber-text)' }} data-testid={`measure-over-cap-${lineId}`}>
                                Only {remainingMeasurable(register, reservedFor(lineId))} person-shifts remain
                                measurable on this line's live order authority, net of anything already queued for it.
                              </div>
                            )}
                          </div>
                        )}
                        {/* §D — a correction is a SIGNED delta appended as a new row; the original
                            is never edited, which is why the control sits on each row rather than
                            offering to "edit" the register. */}
                        {mayMeasure && (register?.rows ?? []).filter((r) => r.correctsId === null).map((row) => (
                          <div key={row.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--hairline)' }}>
                            <span style={{ ...mono, flex: '1 1 100%' }}>{row.id} · {row.quantity}</span>
                            <input
                              value={corrFormFor(row.id).qty}
                              onChange={(e) => setCorrForm(row.id, { qty: e.target.value })}
                              placeholder="Delta (e.g. -0.5)"
                              data-testid={`correct-qty-${row.id}`}
                              style={{ ...input, flex: '1 1 110px' }}
                            />
                            <input
                              value={corrFormFor(row.id).reason}
                              onChange={(e) => setCorrForm(row.id, { reason: e.target.value })}
                              placeholder="Reason"
                              data-testid={`correct-reason-${row.id}`}
                              style={{ ...input, flex: '2 1 160px' }}
                            />
                            <Button
                              variant="ghost"
                              data-testid={`correct-submit-${row.id}`}
                              disabled={
                                !isCorrectionDelta(corrFormFor(row.id).qty) || !corrFormFor(row.id).reason.trim()
                                || correctionPending(row.id)
                                // Codex Q-d — the rows on screen prove when a withdrawal exceeds
                                // what this measurement still has to give. The floor is the ROW's,
                                // not the line's: the server bounds a correction by the row it
                                // adjusts, so a positive line total does not make this legal.
                                || register === null || lineRegisterLoad[lineId] === 'error'
                                // Round 2 — a POSITIVE correction is another measurement to the
                                // server, which re-checks the same caps; a NEGATIVE one is bounded
                                // by what its row still has to give AFTER a live certificate's
                                // frozen consumption.
                                || correctionRefused(register, row.id, corrFormFor(row.id).qty.trim(), reservedFor(lineId))
                              }
                              onClick={() => correctMeasurement(row.id, corrFormFor(row.id).qty.trim(), corrFormFor(row.id).reason.trim(), lineId)}
                            >
                              {correctionPending(row.id) ? 'Correcting…' : 'Correct'}
                            </Button>
                            {corrFormFor(row.id).qty.trim() !== '' && !isCorrectionDelta(corrFormFor(row.id).qty) && (
                              <div style={{ ...muted, flexBasis: '100%', color: 'var(--amber-text)' }} data-testid={`correct-qty-invalid-${row.id}`}>
                                A correction is a NON-ZERO signed delta with at most six decimals.
                              </div>
                            )}
                            {register !== null && isCorrectionDelta(corrFormFor(row.id).qty)
                              && correctionRefused(register, row.id, corrFormFor(row.id).qty.trim(), reservedFor(lineId)) && (
                              <div style={{ ...muted, flexBasis: '100%', color: 'var(--amber-text)' }} data-testid={`correct-over-withdraw-${row.id}`}>
                                {corrFormFor(row.id).qty.trim().startsWith('-')
                                  ? `This measurement has ${remainingWithdrawable(register, row.id)} person-shifts left to withdraw — evidence a live certificate rests on requires superseding that certificate first.`
                                  : `Only ${remainingMeasurable(register, reservedFor(lineId))} person-shifts remain measurable on this line, and a positive correction is measured work too.`}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
          )}
    </div>
  );
}
