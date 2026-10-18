import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectActiveReview } from '@/store/selectors';
import { Eyebrow, ResultChip, Button, LocationContext, EditState, ItemNotFound, ConfirmDialog } from '@/components';
import { IssueChecklistModal } from '@/screens/modals/IssueChecklistModal';
import { X, Plus } from '@/lib/icons';
import { EmptyHint } from '@/guide/EmptyHint';
import { swatch as swatchGradient, can, reviewItemText as RIT, inspectionReviewLabels as L, inspectionReviewText as T, inspectionTitle, servedDayIn, type Checklist, type Lang, type Review } from '@vitan/shared';
import { resolveMediaUrl, inspectionsReadMode } from '@/data/apiGateway';
import { inspectionsSliceSettled } from '@/lib/notifications';
import { useUrlItem } from '@/lib/useUrlItem';
import styles from './responsive.module.css';

export function InspectionReviewScreen() {
  const reviews = useStore(useShallow((s) => s.reviews));
  const active = useStore(selectActiveReview);
  const setActiveReview = useStore((s) => s.setActiveReview);
  const toggleReject = useStore((s) => s.toggleReject);
  const approveInspection = useStore((s) => s.approveInspection);
  const sendReinspection = useStore((s) => s.sendReinspection);
  const lang = useStore((s) => s.lang);
  // Phase 2 Task 10 (Module 3 — Inspections): under module read-ownership the inspection slices are a
  // SEPARATE async surface from the project snapshot, with their own honest load state. Never claim "No
  // inspections awaiting review" until a read has actually SUCCEEDED; while it loads show a loading state;
  // on failure show an unavailable/Retry boundary. In snapshot mode `inspectionsLoad` stays 'idle' and
  // these gates never trigger.
  const openChecklists = useStore(useShallow((s) => s.openChecklists));
  const inspectionsLoad = useStore((s) => s.inspectionsLoad);
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const moduleOwned = inspectionsReadMode() === 'moduleQuery';
  const reading = moduleOwned && (inspectionsLoad === 'idle' || inspectionsLoad === 'loading');
  const unavailable = moduleOwned && inspectionsLoad === 'error';

  // Live bug 1b — `/review/<inspectionId>` names ONE inspection: a review in the queue is opened, an
  // outstanding checklist (a re-inspection task is one until it is submitted) is brought into view,
  // and an id this screen cannot show says so once the inspections have settled.
  const routeItem = useStore((s) => s.routeItem);
  // Codex 4212901994 — an inspection the URL names that the store has not yet adopted
  const urlItem = useUrlItem('inspect-review');
  const adopting = typeof urlItem === 'string' && urlItem !== routeItem ? urlItem : null;
  // Codex 4213640383 — Back to the bare parent URL, before the store has cleared its item: the departing
  // record is not shown under the parent's URL
  const clearing = urlItem === null && routeItem !== null;
  const setRouteItem = useStore((s) => s.setRouteItem);
  const activeReviewId = useStore((s) => s.activeReviewId);
  const projectLoadState = useStore((s) => s.projectLoadState);
  // Codex 4204448859 — a committed command's reconcile still owed means the retained slices predate it
  // (the predicate the bell judges by, so the two cannot disagree)
  // (a module read that has not yet landed — `idle` before its first pull — is not settled either)
  const settled = useStore(inspectionsSliceSettled) && !reading;
  const routeReview = routeItem !== null && reviews.some((r) => r.id === routeItem) ? routeItem : null;
  const routeChecklist = routeItem !== null && openChecklists.some((c) => c.id === routeItem) ? routeItem : null;
  // Codex 4209321867 / 4209988812 — a decision ends the route's claim on its review only once it has
  // LANDED: the server's queue holds only undecided reviews, so the routed review leaving the queue after
  // this viewer decided it returns the URL to the queue (never "not found"). A refused or failed decision
  // leaves the review in the queue, so the route — and a reload of it — keeps naming that review.
  const [decidedId, setDecidedId] = useState<string | null>(null);
  // the review whose Approve is awaiting confirmation (by id, so switching reviews never carries it over)
  const [confirmApproveId, setConfirmApproveId] = useState<string | null>(null);
  const released = routeItem !== null && routeItem === decidedId && !routeReview && !routeChecklist;
  useEffect(() => {
    if (released) setRouteItem(null);
  }, [released, setRouteItem]);
  // the decision's claim ends with the route that named it (released, Back, another link)
  useEffect(() => {
    if (decidedId !== null && routeItem !== decidedId) setDecidedId(null);
  }, [routeItem, decidedId]);
  const missingItem = routeItem !== null && settled && !routeReview && !routeChecklist && !released ? routeItem : null;
  useEffect(() => {
    if (routeReview && activeReviewId !== routeReview) setActiveReview(routeReview);
  }, [routeReview, activeReviewId, setActiveReview]);
  // Codex 4203544331 — a link to an inspection this screen cannot show shows ONLY that: never the
  // default review beneath it, whose live approve/reject would present an unrelated inspection as the
  // one the link meant. "Show all inspections" reveals the queue.
  // Codex 4203960945 — a named inspection that is not (yet) found while the inspections are loading or
  // failed shows that boundary, never a retained review standing in for it under its URL.
  const unsettledItem = routeItem !== null && !routeReview && !routeChecklist && !settled && !released;
  const decide = (act: () => void) => {
    if (active && routeItem === active.id) setDecidedId(active.id);
    act();
  };
  // Codex 4212402110 — between the decided review leaving the queue and the route being cleared (an
  // effect), the selection has already fallen back to another review: nothing actionable is rendered
  // under the departing URL
  if (adopting) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="inspections-opening">
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{T.opening(adopting, lang)}</div>
      </div>
    );
  }
  if (released || clearing) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="inspections-returning">
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{L.returning[lang]}</div>
      </div>
    );
  }
  // Codex 4208284788 — the routed review becomes the active one in an effect, so for one render the
  // previous active review (with its live Approve / Send Re-inspection, which act on the active id)
  // would stand under the routed URL: until the two agree, nothing actionable is rendered
  if (routeReview && active?.id !== routeReview) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="inspections-opening">
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{T.opening(routeReview, lang)}</div>
      </div>
    );
  }
  // Codex 4208735406 — a route naming an OUTSTANDING CHECKLIST shows that checklist, not the active
  // review: the review's live Approve / Send Re-inspection would otherwise stand under the checklist's URL
  if (routeChecklist && !routeReview) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="routed-checklist">
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        <OutstandingChecklists items={openChecklists} focused={routeChecklist} lang={lang} />
        <div style={{ marginTop: 18 }}>
          <Button data-testid="routed-checklist-show-reviews" onClick={() => setRouteItem(null)}>{L.showAwaiting[lang]}</Button>
        </div>
      </div>
    );
  }
  if (unsettledItem) {
    const failed = moduleOwned ? unavailable : projectLoadState === 'error';
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid={failed ? 'inspections-unavailable' : 'inspections-loading'}>
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        {failed ? (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14, display: 'grid', gap: 12, justifyItems: 'center' }}>
            <span>{L.loadFailed[lang]}</span>
            <Button data-testid="inspections-retry" onClick={() => void requestFreshSnapshot()}>{L.retry[lang]}</Button>
          </div>
        ) : (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{L.loading[lang]}</div>
        )}
      </div>
    );
  }
  if (missingItem) {
    return (
      <div className={`${styles.screen} ${styles.mid}`}>
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        <ItemNotFound what={L.what[lang]} id={missingItem} onShowAll={() => setRouteItem(null)} showAllLabel={L.showAll[lang]} lang={lang} />
      </div>
    );
  }

  // finding-4 parity — these fire only when there is no last-good review to show; a failed refresh that
  // RETAINS a last-good queue falls through to the review below.
  if (!active && reading) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="inspections-loading">
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{L.loading[lang]}</div>
      </div>
    );
  }
  if (!active && unavailable) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="inspections-unavailable">
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14, display: 'grid', gap: 12, justifyItems: 'center' }}>
          <span>{L.loadFailed[lang]}</span>
          <Button data-testid="inspections-retry" onClick={() => void requestFreshSnapshot()}>{L.retry[lang]}</Button>
        </div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className={`${styles.screen} ${styles.mid}`}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
          <NewChecklist />
        </div>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          {L.empty[lang]}
          <EmptyHint task="checklist" />
        </div>
        <OutstandingChecklists items={openChecklists} focused={routeChecklist} lang={lang} />
      </div>
    );
  }

  const review: Review = active;
  const pendingCount = reviews.filter((r) => !r.decided).length;
  const rejectedCount = review.items.filter((it) => it.rejected).length;
  // #482 QA item 2 — when any item FAILED, sending it back is the expected decision: Send back leads
  // and Approve steps down to a secondary button that asks first, so a failed item is never signed
  // off by a stray tap. With nothing failed the order is unchanged.
  const failedCount = review.items.filter((it) => it.result === 'FAIL').length;
  const summary = review.decided ? L.decided[lang] : T.marked(rejectedCount, lang);

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Eyebrow>{L.eyebrow[lang]}{pendingCount > 1 ? T.pending(pendingCount, lang) : ''}</Eyebrow>
        <NewChecklist />
      </div>

      {reviews.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 2px' }} role="group" aria-label={L.queue[lang]}>
          {reviews.map((r) => {
            const on = r.id === review.id;
            return (
              <button
                key={r.id}
                // a plain pressed-button group: the queue switches the review in place, with no
                // tab panel or arrow-key model, so tab roles would promise navigation it lacks
                aria-pressed={on}
                onClick={() => {
                  setActiveReview(r.id);
                  setRouteItem(r.id);
                }}
                data-testid={`review-tab-${r.id}`}
                style={{
                  padding: '7px 12px',
                  borderRadius: 20,
                  fontFamily: 'var(--font-sans)',
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: 'pointer',
                  border: `1px solid ${on ? 'var(--ink)' : 'var(--hairline)'}`,
                  background: on ? 'var(--ink)' : 'var(--panel)',
                  color: on ? '#fff' : 'var(--muted)',
                  opacity: r.decided ? 0.6 : 1,
                }}
              >
                {inspectionTitle(r, lang)}
                {r.decided ? ' ✓' : ''}
              </button>
            );
          })}
        </div>
      )}

      <div className={styles.headRule} style={{ margin: '6px 0 22px' }}>
        <div>
          {review.closing && (
            // Task 5: a closing review is the activity's SIGN-OFF — approving it is
            // what marks the named activity done, so say so up front
            <div data-testid="closing-signoff-label" style={{ display: 'inline-block', marginBottom: 7, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.08em', padding: '4px 10px', borderRadius: 14, background: '#E6ECF3', color: '#31567F', border: '1px solid #C4D3E4' }}>
              {T.closing(review.activityName ?? review.activityId ?? null, lang)}
            </div>
          )}
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>{inspectionTitle(review, lang)}</div>
          {/* WHERE this inspection was carried out — the filed trail, tappable back to the
              Site Map. Falls back to the legacy free-text zone for a review with no node. */}
          <div style={{ marginTop: 7 }}>
            <LocationContext nodeId={review.nodeId} fallback={review.zone} compact testId={`review-place-${review.id}`} lang={lang} />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>{T.submittedBy(review.by, lang)}</span>
            <span>·</span>
            {/* a served "18 Oct 2026" day reads in the viewer's calendar; any other text as recorded */}
            <span>{servedDayIn(review.date, lang)}</span>
          </div>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '5px 11px', border: '1px solid var(--amber-border)', background: 'var(--amber-chip)', color: 'var(--amber-text)', borderRadius: 20 }}>
          {review.decided ? L.reviewed[lang] : L.awaiting[lang]}
        </div>
      </div>

      {review.items.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13.5, padding: '8px 0 4px' }}>
          {L.noItems[lang]}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {review.items.map((it, i) => {
            const border = it.rejected ? '#D9B4B0' : it.result === 'FAIL' ? '#E7CBC7' : 'var(--hairline)';
            return (
              <div key={it.name} className={styles.reviewRow} style={{ background: 'var(--panel)', border: `1px solid ${border}`, borderRadius: 12, padding: '16px 18px' }}>
                {/* the ACTUAL evidence photo when one is linked (Task 4); swatch = legacy placeholder */}
                <div style={{ width: 130, height: 100, flex: 'none', borderRadius: 8, background: swatchGradient(it.swatch), position: 'relative', overflow: 'hidden' }}>
                  {(it.evidence?.length ?? 0) > 0 && (
                    <img src={resolveMediaUrl(it.evidence![0])} alt={T.evidenceAlt(it.name, lang)} data-testid={`review-evidence-${i}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                  )}
                  {/* #482 F-C4.5 — the tag names attached photos. V-1018-1 — it is legible on any photo, and a
                      photo-less item SAYS so, so its placeholder swatch is never read as a thumbnail */}
                  {(it.evidence?.length ?? 0) > 0 ? (
                    <span data-testid={`review-photo-tag-${i}`} style={{ position: 'absolute', left: 6, bottom: 6, fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, letterSpacing: '.04em', color: '#fff', background: 'rgba(0,0,0,.72)', padding: '2px 7px', borderRadius: 4 }}>
                      {RIT.photos(it.evidence!.length, lang)}
                    </span>
                  ) : (
                    <span data-testid={`review-no-photo-${i}`} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 8, fontSize: 12, fontWeight: 600, color: 'var(--muted)', background: 'rgba(255,255,255,.55)' }}>
                      {L.noPhoto[lang]}
                    </span>
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{it.name}</span>
                    <ResultChip result={it.result} lang={lang} />
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>{it.note}</div>
                  {it.rejected && (
                    <div data-testid={`review-reject-state-${i}`} style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--red-solid)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      {/* #482 F-C4.4 — "Reject item" only marks it; the re-inspection exists once Send back is decided */}
                      <X size={12} /> {review.decided ? RIT.sentBack[lang] : RIT.willSendBack[lang]}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center' }}>
                  <Button
                    variant={it.rejected ? 'danger' : 'dangerOutline'}
                    onClick={() => { if (!review.decided) toggleReject(i); }}
                    disabled={review.decided}
                    data-testid={`review-reject-${i}`}
                    style={{ padding: '9px 14px', fontSize: 12, whiteSpace: 'nowrap', cursor: review.decided ? 'not-allowed' : 'pointer', opacity: review.decided ? 0.5 : 1 }}
                  >
                    {it.rejected ? L.rejected[lang] : L.reject[lang]}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.stickyFoot} style={{ marginTop: 26 }}>
        {/* A decided review is the RECORD of a decision, not a queue item: re-approving would
            re-send it. The verdict is stated and the actions are withdrawn, rather than left
            live over a decision that has already been made. */}
        {review.decided ? (
          <EditState
            state="locked"
            // `decided` alone does NOT mean approved: rejecting a closing inspection also sets
            // it, returning the activity to execution with a re-inspection. `Review` carries no
            // approved/rejected field, so the wording states what IS known and points at the
            // activity, where the outcome actually shows.
            reason={review.closing ? T.decidedClosing(review.activityName ?? review.activityId ?? null, lang) : L.decidedReason[lang]}
            testId={`review-decided-${review.id}`}
          />
        ) : (
          <>
            {failedCount > 0 ? (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button variant="danger" onClick={() => decide(sendReinspection)} data-testid="send-reinspection" style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>{L.sendBack[lang]}</Button>
                <Button variant="outline" onClick={() => setConfirmApproveId(review.id)} data-testid="approve-inspection" style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>{L.approve[lang]}</Button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button variant="success" onClick={() => decide(approveInspection)} data-testid="approve-inspection" style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>{L.approve[lang]}</Button>
                <Button variant="dangerOutline" onClick={() => decide(sendReinspection)} data-testid="send-reinspection" style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>{L.sendBack[lang]}</Button>
              </div>
            )}
            {confirmApproveId === review.id && failedCount > 0 && (
              <ConfirmDialog
                title={L.confirmTitle[lang]}
                confirmLabel={L.confirmLabel[lang]}
                lang={lang}
                onConfirm={() => decide(approveInspection)}
                onCancel={() => setConfirmApproveId(null)}
                testId="confirm-approve"
              >
                {T.failedConfirm(failedCount, lang)}
              </ConfirmDialog>
            )}
            <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--faint)', marginTop: 9 }}>{summary}</div>
          </>
        )}
      </div>
      <OutstandingChecklists items={openChecklists} focused={routeChecklist} lang={lang} />
    </div>
  );
}

/**
 * Checklists that have been ISSUED and are still out on site — filled in the field, not yet
 * submitted back. They are not in the review queue (nothing to review yet) and they used to
 * appear nowhere at all: the read carried one checklist, so issuing a second hid the first,
 * and the PMC who issued them saw none of them. Shown with a count, so "how many are open"
 * is answerable from the screen the PMC issues them on.
 */
function OutstandingChecklists({ items, focused, lang }: { items: Checklist[]; focused: string | null; lang: Lang }) {
  useEffect(() => {
    if (focused) document.querySelector(`[data-testid="outstanding-checklist-${CSS.escape(focused)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focused]);
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 26 }} data-testid="outstanding-checklists">
      <Eyebrow>{T.outOnSite(items.length, lang)}</Eyebrow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
        {items.map((c) => (
          <div
            key={c.id}
            data-testid={`outstanding-checklist-${c.id}`}
            aria-current={c.id === focused ? 'true' : undefined}
            style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '11px 13px', borderRadius: 10, border: c.id === focused ? '2px solid var(--ink)' : '1px solid rgba(35,33,28,.12)', background: '#fff' }}
          >
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>{c.id}</span>
            <span style={{ fontSize: 13.5, color: 'var(--ink)', flex: 1, minWidth: 160 }}>{inspectionTitle(c, lang)}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{T.items(c.items.length, lang)}</span>
            <LocationContext nodeId={c.nodeId} fallback={c.zone} lang={lang} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** PMC-only "New checklist" affordance — issues a field checklist the site
 *  engineer fills in with photos, then submits back into this review queue. */
function NewChecklist() {
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const [open, setOpen] = useState(false);
  if (!can('inspection.create', role)) return null;
  return (
    <>
      <Button variant="ink" onClick={() => setOpen(true)} data-testid="new-checklist" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
        <Plus size={15} /> {L.newChecklist[lang]}
      </Button>
      {open && <IssueChecklistModal onClose={() => setOpen(false)} />}
    </>
  );
}

