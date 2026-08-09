/**
 * §F — which COPY of a claim's lifecycle a control may act on, and whether it may act at all.
 *
 * A claim's status arrives from two independent reads: the claim LIST (`commercialBills`) and the
 * per-claim bundle (`commercialClaims[billId]`). Neither is a cache of the other, so on any surface
 * showing both, one of them is older — and which one is older is not knowable from when its
 * response arrived. Ordering by response completion was the defect PR #306 round 5 fixed: a list
 * request started while a bill was `verified`, certification committed, a claim request returned
 * `certified`, and the held list response landed LAST — so a completion counter regressed the row
 * to `verified` and offered the transitions of a claim that had already been certified.
 *
 * `statusChangedAt` is the moment the SERVER stamped on the transition, so comparing it asks about
 * the bill rather than about the requests. But it is not a lifecycle version: every transition
 * writes `new Date()` at millisecond precision, so two DIFFERENT transitions can carry one stamp.
 * Breaking that tie in either direction imposes a total order on data that does not have one — the
 * round-6 finding. Equal stamp + SAME status is not a tie (the copies agree); equal stamp +
 * DIFFERING status is genuinely undecidable from what the reads carry, and this refuses to decide.
 *
 * This lives here, as a pure function, because the ambiguity term is the part a SECOND surface
 * forgets. The Claims tab derived it inline; the Certification tab renders `claim.bill` — the copy
 * that can be the older one — and gating a transition on it alone would reintroduce the same defect
 * one tab over. One rule both surfaces call cannot disagree with itself.
 *
 * The durable fix is a monotonic per-bill lifecycle version from the server, which is a schema
 * change carried in its own unit; refusing to decide is sound without it.
 */

/** The two fields every copy of a claim's lifecycle carries, whichever read produced it. */
export interface BillLifecycleCopy {
  status: string;
  statusChangedAt: string;
}

export interface BillReading<T extends BillLifecycleCopy> {
  /** WHICH read won, named rather than left to be inferred.
   *
   *  Round 4 is why this exists. A caller needed "is the claim bundle still good enough to act
   *  on?" and derived it as `reading.copy === claim.bill` — object identity. But equal stamps with
   *  the SAME status is agreement, and this function returns the LIST object for it, so the normal
   *  case (both reads current) read as "the bundle is stale" and disabled Certify permanently.
   *  A concept the caller needs is stated here; inferring it from which object came back is how a
   *  correctness fix became a functional regression. */
  source: 'agreed' | 'list' | 'claim';
  /** The copy to DISPLAY. Never the claim copy when the two are undecidable — that is the one
   *  that can be older, and showing it would present a regression as current truth. */
  copy: T;
  /** Whether the two reads disagree in a way this cannot resolve. Transitions are refused while
   *  it holds; a fresh pair of reads converges, because the ambiguity is a property of reading at
   *  two times rather than of the timestamps. */
  ambiguous: boolean;
}

/**
 * Choose between the list copy and the claim copy of ONE bill.
 *
 * Either may be absent: `claimCopy` is null for every unselected row (no claim bundle is loaded),
 * and `listCopy` is null on a surface reached before the claim list landed. One copy is not a
 * disagreement, so a single source is authoritative and unambiguous. NEITHER copy answers `null`,
 * and `transitionOffered` reads that as "no transition" — a control cannot act on a lifecycle it
 * has no reading of, and making that the type rather than a convention is what keeps a call site
 * from inventing a default.
 */
export function arbitrateBillCopy<T extends BillLifecycleCopy>(
  listCopy: T | null,
  claimCopy: T | null,
): BillReading<T> | null {
  if (listCopy === null) return claimCopy === null ? null : { copy: claimCopy, ambiguous: false, source: 'claim' };
  if (claimCopy === null) return { copy: listCopy, ambiguous: false, source: 'list' };
  const listAt = Date.parse(listCopy.statusChangedAt);
  const claimAt = Date.parse(claimCopy.statusChangedAt);
  // An unparseable stamp orders nothing. `Date.parse` answers NaN, and every NaN comparison is
  // false, so a naive `>` would silently fall through to the list copy and never say why — the
  // same "decide anyway" mistake as the equal-stamp tie, arrived at by a different route.
  if (Number.isNaN(listAt) || Number.isNaN(claimAt)) {
    const agree = claimCopy.status === listCopy.status;
    return { copy: listCopy, ambiguous: !agree, source: agree ? 'agreed' : 'list' };
  }
  if (claimAt > listAt) return { copy: claimCopy, ambiguous: false, source: 'claim' };
  if (listAt > claimAt) return { copy: listCopy, ambiguous: false, source: 'list' };
  // equal stamps: agreement is not a tie, disagreement is undecidable
  const agree = claimCopy.status === listCopy.status;
  return { copy: listCopy, ambiguous: !agree, source: agree ? 'agreed' : 'list' };
}

/**
 * Whether a §F transition may be OFFERED for this reading.
 *
 * Both terms in one place on purpose. `from` is the shared admissible set the SERVICE itself reads
 * (`BILL_SUBMITTABLE_FROM` and friends in `@vitan/shared`), so a control cannot offer a transition
 * the server refuses; the ambiguity term is the one a new control forgets, and forgetting it here
 * is impossible because there is nowhere else to ask.
 *
 * Why offering an impossible transition is not cosmetic: the outbox is WRITE-AHEAD. The op is
 * persisted and the user is told it is saved, and only on reconnect does the server answer a
 * terminal 409 — a claim someone believes they submitted, silently dropped.
 */
export function transitionOffered<T extends BillLifecycleCopy>(
  reading: BillReading<T> | null,
  from: readonly string[],
): boolean {
  if (reading === null) return false;
  return !reading.ambiguous && from.includes(reading.copy.status);
}
