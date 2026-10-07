import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectActiveReview } from '@/store/selectors';
import { Eyebrow, ResultChip, Button, LocationContext, EditState, ItemNotFound } from '@/components';
import { IssueChecklistModal } from '@/screens/modals/IssueChecklistModal';
import { X, Plus } from '@/lib/icons';
import { swatch as swatchGradient, can, type Checklist, type Review } from '@vitan/shared';
import { resolveMediaUrl, inspectionsReadMode } from '@/data/apiGateway';
import { inspectionsSliceSettled } from '@/lib/notifications';
import styles from './responsive.module.css';

export function InspectionReviewScreen() {
  const reviews = useStore(useShallow((s) => s.reviews));
  const active = useStore(selectActiveReview);
  const setActiveReview = useStore((s) => s.setActiveReview);
  const toggleReject = useStore((s) => s.toggleReject);
  const approveInspection = useStore((s) => s.approveInspection);
  const sendReinspection = useStore((s) => s.sendReinspection);
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
  const setRouteItem = useStore((s) => s.setRouteItem);
  const activeReviewId = useStore((s) => s.activeReviewId);
  const projectLoadState = useStore((s) => s.projectLoadState);
  // Codex 4204448859 — a committed command's reconcile still owed means the retained slices predate it
  // (the predicate the bell judges by, so the two cannot disagree)
  const settled = useStore((s) => inspectionsSliceSettled(s, moduleOwned));
  const routeReview = routeItem !== null && reviews.some((r) => r.id === routeItem) ? routeItem : null;
  const routeChecklist = routeItem !== null && openChecklists.some((c) => c.id === routeItem) ? routeItem : null;
  const missingItem = routeItem !== null && settled && !routeReview && !routeChecklist ? routeItem : null;
  useEffect(() => {
    if (routeReview && activeReviewId !== routeReview) setActiveReview(routeReview);
  }, [routeReview, activeReviewId, setActiveReview]);
  // Codex 4203544331 — a link to an inspection this screen cannot show shows ONLY that: never the
  // default review beneath it, whose live approve/reject would present an unrelated inspection as the
  // one the link meant. "Show all inspections" reveals the queue.
  // Codex 4203960945 — a named inspection that is not (yet) found while the inspections are loading or
  // failed shows that boundary, never a retained review standing in for it under its URL.
  const unsettledItem = routeItem !== null && !routeReview && !routeChecklist && !settled;
  // Codex 4208284788 — the routed review becomes the active one in an effect, so for one render the
  // previous active review (with its live Approve / Send Re-inspection, which act on the active id)
  // would stand under the routed URL: until the two agree, nothing actionable is rendered
  if (routeReview && active?.id !== routeReview) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="inspections-opening">
        <Eyebrow>INSPECTION REVIEW</Eyebrow>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Opening {routeReview}…</div>
      </div>
    );
  }
  if (unsettledItem) {
    const failed = moduleOwned ? unavailable : projectLoadState === 'error';
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid={failed ? 'inspections-unavailable' : 'inspections-loading'}>
        <Eyebrow>INSPECTION REVIEW</Eyebrow>
        {failed ? (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14, display: 'grid', gap: 12, justifyItems: 'center' }}>
            <span>Couldn't load inspections — check your connection and access.</span>
            <Button data-testid="inspections-retry" onClick={() => void requestFreshSnapshot()}>Retry</Button>
          </div>
        ) : (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Loading inspections…</div>
        )}
      </div>
    );
  }
  if (missingItem) {
    return (
      <div className={`${styles.screen} ${styles.mid}`}>
        <Eyebrow>INSPECTION REVIEW</Eyebrow>
        <ItemNotFound what="Inspection" id={missingItem} onShowAll={() => setRouteItem(null)} showAllLabel="Show all inspections" />
      </div>
    );
  }

  // finding-4 parity — these fire only when there is no last-good review to show; a failed refresh that
  // RETAINS a last-good queue falls through to the review below.
  if (!active && reading) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="inspections-loading">
        <Eyebrow>INSPECTION REVIEW</Eyebrow>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Loading inspections…</div>
      </div>
    );
  }
  if (!active && unavailable) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid="inspections-unavailable">
        <Eyebrow>INSPECTION REVIEW</Eyebrow>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14, display: 'grid', gap: 12, justifyItems: 'center' }}>
          <span>Couldn't load inspections — check your connection and access.</span>
          <Button data-testid="inspections-retry" onClick={() => void requestFreshSnapshot()}>Retry</Button>
        </div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className={`${styles.screen} ${styles.mid}`}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <Eyebrow>INSPECTION REVIEW</Eyebrow>
          <NewChecklist />
        </div>
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          No inspections awaiting review. Submitted checklists and closing inspections land here.
        </div>
        <OutstandingChecklists items={openChecklists} focused={routeChecklist} />
      </div>
    );
  }

  const review: Review = active;
  const pendingCount = reviews.filter((r) => !r.decided).length;
  const rejectedCount = review.items.filter((it) => it.rejected).length;
  const summary = review.decided ? 'Decision recorded ✓' : `${rejectedCount} item(s) marked for rejection`;

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Eyebrow>INSPECTION REVIEW{pendingCount > 1 ? ` · ${pendingCount} PENDING` : ''}</Eyebrow>
        <NewChecklist />
      </div>

      {reviews.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 2px' }} role="group" aria-label="Review queue">
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
                {r.title}
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
              CLOSING SIGN-OFF · {review.activityName ?? review.activityId ?? 'ACTIVITY'} — APPROVAL MARKS IT DONE
            </div>
          )}
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>{review.title}</div>
          {/* WHERE this inspection was carried out — the filed trail, tappable back to the
              Site Map. Falls back to the legacy free-text zone for a review with no node. */}
          <div style={{ marginTop: 7 }}>
            <LocationContext nodeId={review.nodeId} fallback={review.zone} compact testId={`review-place-${review.id}`} />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>Submitted by {review.by}</span>
            <span>·</span>
            <span>{review.date}</span>
          </div>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '5px 11px', border: '1px solid var(--amber-border)', background: 'var(--amber-chip)', color: 'var(--amber-text)', borderRadius: 20 }}>
          {review.decided ? 'REVIEWED' : 'AWAITING REVIEW'}
        </div>
      </div>

      {review.items.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13.5, padding: '8px 0 4px' }}>
          No checklist items were recorded for this inspection — approve to sign it off, or send it back for a re-inspection.
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
                    <img src={resolveMediaUrl(it.evidence![0])} alt={`Evidence — ${it.name}`} data-testid={`review-evidence-${i}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                  )}
                  <span style={{ position: 'absolute', left: 6, bottom: 6, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,.9)', background: 'rgba(0,0,0,.4)', padding: '1px 5px', borderRadius: 3 }}>
                    {(it.evidence?.length ?? 0) > 1 ? `${it.evidence!.length} PHOTOS` : 'PHOTO'}
                  </span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{it.name}</span>
                    <ResultChip result={it.result} />
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>{it.note}</div>
                  {it.rejected && (
                    <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--red-solid)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <X size={12} /> Rejected — re-inspection task created
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
                    {it.rejected ? 'Rejected ✕' : 'Reject item'}
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
            reason={review.closing
              ? `Reviewed — the closing decision for ${review.activityName ?? review.activityId ?? 'this activity'} is recorded. Its outcome shows on that activity in the Schedule.`
              : 'Reviewed — this inspection has been decided; its outcome and any re-inspection it created are recorded.'}
            testId={`review-decided-${review.id}`}
          />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant="success" onClick={approveInspection} style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>Approve Inspection</Button>
              <Button variant="dangerOutline" onClick={sendReinspection} data-testid="send-reinspection" style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>Send Rejections &amp; Create Re-inspection</Button>
            </div>
            <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--faint)', marginTop: 9 }}>{summary}</div>
          </>
        )}
      </div>
      <OutstandingChecklists items={openChecklists} focused={routeChecklist} />
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
function OutstandingChecklists({ items, focused }: { items: Checklist[]; focused: string | null }) {
  useEffect(() => {
    if (focused) document.querySelector(`[data-testid="outstanding-checklist-${CSS.escape(focused)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focused]);
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 26 }} data-testid="outstanding-checklists">
      <Eyebrow>
        OUT ON SITE · {items.length} AWAITING THE ENGINEER
      </Eyebrow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
        {items.map((c) => (
          <div
            key={c.id}
            data-testid={`outstanding-checklist-${c.id}`}
            aria-current={c.id === focused ? 'true' : undefined}
            style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '11px 13px', borderRadius: 10, border: c.id === focused ? '2px solid var(--ink)' : '1px solid rgba(35,33,28,.12)', background: '#fff' }}
          >
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>{c.id}</span>
            <span style={{ fontSize: 13.5, color: 'var(--ink)', flex: 1, minWidth: 160 }}>{c.title}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{c.items.length} item{c.items.length === 1 ? '' : 's'}</span>
            <LocationContext nodeId={c.nodeId} fallback={c.zone} />
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
  const [open, setOpen] = useState(false);
  if (!can('inspection.create', role)) return null;
  return (
    <>
      <Button variant="ink" onClick={() => setOpen(true)} data-testid="new-checklist" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
        <Plus size={15} /> New checklist
      </Button>
      {open && <IssueChecklistModal onClose={() => setOpen(false)} />}
    </>
  );
}

