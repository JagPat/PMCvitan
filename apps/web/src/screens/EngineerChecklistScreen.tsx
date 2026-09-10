import { useRef, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, checklistFrozen } from '@/store/store';
import { EmptyState, Eyebrow, StatTile, Button, LocationContext, EditState } from '@/components';
import { Camera } from '@/lib/icons';
import type { ItemState } from '@vitan/shared';
import { inspectionsReadMode } from '@/data/apiGateway';
import styles from './responsive.module.css';

const toggleBase: CSSProperties = {
  flex: 1,
  padding: '9px 0',
  borderRadius: 9,
  fontFamily: 'var(--font-sans)',
  fontWeight: 600,
  fontSize: 12.5,
  cursor: 'pointer',
};

function toggleStyle(active: boolean, solid: string, text: string): CSSProperties {
  return active
    ? { ...toggleBase, border: `1px solid ${solid}`, background: solid, color: '#fff' }
    : { ...toggleBase, border: '1px solid rgba(35,33,28,.15)', background: '#fff', color: text };
}

export function EngineerChecklistScreen() {
  const checklist = useStore((s) => s.checklist);
  // EVERY checklist issued to this site, so a second one is work the engineer can actually open
  // rather than a count they can only read. `checklist` is one OF these — the picker below is how
  // they move the edit slot between them.
  const openChecklists = useStore(useShallow((s) => s.openChecklists));
  const selectChecklist = useStore((s) => s.selectChecklist);
  // gate round 8: once a submit is dispatched (submitting / queued) or the server
  // confirms it submitted, the checklist is FROZEN — every input is read-only.
  const frozen = useStore((s) => checklistFrozen(s));
  const submissionStatus = useStore((s) => s.submission.status);
  const setItem = useStore((s) => s.setItem);
  const setNote = useStore((s) => s.setNote);
  const submitInspection = useStore((s) => s.submitInspection);
  const addChecklistEvidence = useStore((s) => s.addChecklistEvidence);
  const failedEvidence = useStore((s) => s.failedEvidence);
  const pendingEvidenceCount = useStore((s) => s.pendingEvidenceCount);
  const retryFailedEvidence = useStore((s) => s.retryFailedEvidence);
  const deleteFailedEvidence = useStore((s) => s.deleteFailedEvidence);
  // Task 10 (Module 3) — the module read's honest load state gates the honest-absence empty below.
  const inspectionsLoad = useStore((s) => s.inspectionsLoad);
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const moduleOwned = inspectionsReadMode() === 'moduleQuery';
  const reading = inspectionsLoad === 'idle' || inspectionsLoad === 'loading';
  const unavailable = inspectionsLoad === 'error';
  // one hidden file input, re-targeted per item (Task 4: photos are REAL evidence rows)
  const fileRef = useRef<HTMLInputElement>(null);
  // The capture target is the item AND the checklist it belongs to. More than one checklist can be out
  // on site, and reading the file is asynchronous — an engineer who switches tabs while the read runs
  // would otherwise have the photo land on the checklist that arrived in the slot, at the same index.
  // Pinned when the camera opens; read back in the handler and carried to the store.
  const target = useRef<{ inspectionId: string; idx: number } | null>(null);
  const pickEvidence = (i: number) => {
    if (!checklist) return;
    target.current = { inspectionId: checklist.id, idx: i };
    fileRef.current?.click();
  };
  const onPicked = (file: File | null) => {
    if (!file || !checklist) return;
    // The pin is the AUTHORITY when the camera was opened through `pickEvidence`, which is the only
    // route the app itself offers. A file can still arrive on the input without that gesture — the
    // acceptance suites populate it directly — and refusing those captures would silently drop a
    // photo, so the fallback is the edit slot at item 0: exactly what this handler resolved to
    // before the pin existed. It is a fallback, never a correction: a pinned target is used as
    // pinned even when the slot has moved on, which is the whole point.
    const t = target.current ?? { inspectionId: checklist.id, idx: 0 };
    const reader = new FileReader();
    reader.onload = () => { void addChecklistEvidence(t.idx, String(reader.result), t.inspectionId); };
    reader.readAsDataURL(file);
    target.current = null; // one capture per gesture — the next file needs its own pin or the fallback
    if (fileRef.current) fileRef.current.value = '';
  };

  // Phase 2 Task 10 (Module 3 — Inspections): under module read-ownership the checklist is a SEPARATE
  // async surface — never claim "No checklist issued" until a read has actually SUCCEEDED. While it loads
  // show a loading state; on failure show an unavailable/Retry boundary. In snapshot mode these are inert.
  if (!checklist && moduleOwned && reading) {
    return <EmptyState title="Loading checklist…" detail="Fetching this project's current inspection checklist." />;
  }
  if (!checklist && moduleOwned && unavailable) {
    return (
      <div data-testid="inspections-unavailable" style={{ display: 'grid', gap: 14, justifyItems: 'center', padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
        <span>Couldn't load the checklist — check your connection and access.</span>
        <Button data-testid="inspections-retry" onClick={() => void requestFreshSnapshot()}>Retry</Button>
      </div>
    );
  }
  // honest absence: no fabricated blank checklist — the PMC simply hasn't issued one
  if (!checklist) {
    return (
      <EmptyState
        title="No checklist issued"
        detail="The PMC has not issued an inspection checklist for this project yet. It will appear here the moment one is assigned to you."
      />
    );
  }

  const doneCount = checklist.items.filter((it) => it.state).length;
  const photoCount = checklist.items.reduce((a, it) => a + it.photos, 0);

  /**
   * WHOSE work a refused photo belongs to, in the words the engineer already uses for it: the item's
   * own name, and the checklist's title when the row is not from the one on screen. Resolved from
   * `openChecklists` (the outstanding set this screen already holds) and falling back to the stored
   * ids when the checklist has since been submitted and left that list — a name that no longer
   * resolves is still better than no name, because Delete here is permanent.
   */
  const evidenceOrigin = (inspectionId: string, itemId: string): string => {
    const owner = openChecklists.find((c) => c.id === inspectionId);
    const itemName = owner?.items.find((it) => it.id === itemId)?.name;
    const where = itemName ?? `item ${itemId}`;
    if (inspectionId === checklist.id) return `on this checklist — ${where}`;
    return `on ${owner?.title ?? inspectionId} — ${where}`;
  };

  const set = (i: number, v: Exclude<ItemState, null>) => () => setItem(i, v);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className={styles.mobileScreen} style={{ flex: 1, paddingBottom: 20 }}>
        <div style={{ padding: '10px 0 14px' }}>
          <Eyebrow size={9}>TODAY'S INSPECTION</Eyebrow>
          <div data-testid="checklist-title" style={{ fontWeight: 700, fontSize: 21, marginTop: 4, lineHeight: 1.2 }}>{checklist.title}</div>
          {/* WHERE this check is carried out — the filed trail, tappable back to the Site Map. */}
          <div style={{ marginTop: 4 }}>
            <LocationContext nodeId={checklist.nodeId} fallback={checklist.zone} compact testId="checklist-place" />
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{checklist.date}</div>
          {/* More than one checklist is out on this site. Before this, the engineer saw only the
              oldest and the rest were invisible work — so the picker is the whole point of the
              list, not decoration. Unsubmitted marks on the one they leave are kept, so moving
              between them costs nothing. */}
          {openChecklists.length > 1 && (
            <div data-testid="checklist-picker" style={{ marginTop: 12 }}>
              <Eyebrow size={9}>{openChecklists.length} CHECKLISTS OUT — TAP TO SWITCH</Eyebrow>
              <div style={{ display: 'flex', gap: 7, marginTop: 7, flexWrap: 'wrap' }}>
                {openChecklists.map((c) => {
                  const active = c.id === checklist.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => selectChecklist(c.id)}
                      aria-current={active ? 'true' : undefined}
                      data-testid={`checklist-tab-${c.id}`}
                      style={{
                        padding: '7px 11px',
                        borderRadius: 9,
                        fontFamily: 'var(--font-sans)',
                        fontWeight: 600,
                        fontSize: 12,
                        textAlign: 'left',
                        cursor: active ? 'default' : 'pointer',
                        border: active ? '1px solid var(--ink, #23211c)' : '1px solid rgba(35,33,28,.15)',
                        background: active ? 'var(--ink, #23211c)' : '#fff',
                        color: active ? '#fff' : 'var(--muted)',
                      }}
                    >
                      {c.title}
                      <span style={{ display: 'block', fontWeight: 500, fontSize: 11, opacity: 0.8 }}>{c.zone}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <StatTile label="DONE" value={`${doneCount}/${checklist.items.length}`} />
            <StatTile label="PHOTOS" value={photoCount} />
          </div>
          {/* Every item control below is read-only once a submit is dispatched. The submit
              button carries the same state, but it sits past a long list on a phone — so the
              reason is stated ONCE here, where the disabled controls actually are. */}
          {frozen && (
            <div style={{ marginTop: 12 }}>
              <EditState
                state={checklist.submitted ? 'locked' : 'paused'}
                // `Checklist` carries no `decided` field, and an ALREADY-REVIEWED checklist can
                // still come back as the engineer's current one — so the lock says what is
                // certain (it was submitted, it is now a record) without claiming a pending review.
                reason={checklist.submitted
                  ? 'Submitted — this checklist is now a submitted record, so it can no longer be edited.'
                  : submissionStatus === 'queued'
                    ? 'Queued offline — editing is paused until it reaches the architect. It sends when you reconnect.'
                    : 'Submitting — editing is paused until it reaches the architect.'}
                testId="checklist-frozen-reason"
              />
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {checklist.items.map((it, i) => {
            const border = it.state === 'fail' ? '#E7CBC7' : it.state ? 'rgba(63,122,84,.35)' : 'rgba(35,33,28,.1)';
            return (
              <div key={it.name} style={{ background: '#fff', border: `1px solid ${border}`, borderRadius: 14, padding: '13px 14px' }}>
                <div style={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.3 }}>{it.name}</div>
                <div style={{ display: 'flex', gap: 7, marginTop: 11, opacity: frozen ? 0.55 : 1 }}>
                  <button onClick={set(i, 'pass')} disabled={frozen} style={toggleStyle(it.state === 'pass', 'var(--green-solid)', 'var(--green-solid)')}>Pass</button>
                  <button onClick={set(i, 'fail')} disabled={frozen} style={toggleStyle(it.state === 'fail', 'var(--red-solid)', 'var(--red-solid)')}>Fail</button>
                  <button onClick={set(i, 'na')} disabled={frozen} style={toggleStyle(it.state === 'na', '#6b665c', '#6b665c')}>N.A.</button>
                  <button
                    onClick={() => pickEvidence(i)}
                    disabled={frozen}
                    data-testid={`evidence-${i}`}
                    aria-label="Add photo"
                    style={{
                      flex: 1,
                      padding: '9px 0',
                      borderRadius: 9,
                      cursor: frozen ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      border: it.photos > 0 ? '1px solid var(--ink)' : '1px solid rgba(35,33,28,.15)',
                      background: it.photos > 0 ? 'var(--ink)' : '#fff',
                      color: it.photos > 0 ? 'var(--sidebar-text)' : 'var(--ink)',
                    }}
                  >
                    <Camera size={15} />
                    {it.photos > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{it.photos}</span>}
                  </button>
                </div>
                {(it.evidence?.length ?? 0) > 0 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                    {it.evidence!.map((url, k) => (
                      <img key={k} src={url} alt={`Evidence ${k + 1} — ${it.name}`} style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(35,33,28,.15)' }} />
                    ))}
                  </div>
                )}
                {it.state === 'fail' && (
                  <div style={{ marginTop: 10, background: '#FBF0EF', border: '1px solid #E7CBC7', borderRadius: 9, padding: '9px 11px' }}>
                    {/* #584 review round 1, finding 3 — the fail-evidence REQUIREMENT is what the engineer must
                        do before this checklist can be submitted, so it leaves metadata type for F-1b's 13px
                        floor with real weight. The letter-spacing goes with the mono face. */}
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--red-solid)' }}>Fail requires a note + photo evidence</div>
                    <input
                      value={it.note}
                      onChange={(e) => setNote(i, e.target.value)}
                      disabled={frozen}
                      placeholder="Describe the issue…"
                      style={{ width: '100%', marginTop: 7, border: 'none', background: 'transparent', fontFamily: 'var(--font-sans)', fontSize: 13, outline: 'none', color: 'var(--ink)' }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {pendingEvidenceCount > 0 && (
          <div style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--amber-text)' }} data-testid="evidence-pending">
            {pendingEvidenceCount} photo{pendingEvidenceCount === 1 ? '' : 's'} saved offline — will upload when signal returns
          </div>
        )}
        {/* The refused-photo list is PROJECT-WIDE and the checklist picker above is not, so a row on
            this screen can belong to a checklist the engineer is no longer looking at. Delete here is
            the one non-server path that drops bytes for good, and `upload rejected (400)` alone never
            said whose work was about to be destroyed — so every row names its checklist and item, and
            a row from another checklist says so outright (#571 round 7, finding 4). Filtering them out
            instead would have hidden the other checklist's failures entirely, which is the same defect
            the picker exists to fix: work nobody can see is work nobody can recover. */}
        {failedEvidence.length > 0 && (
          <div style={{ marginTop: 12, background: '#FBF0EF', border: '1px solid #E7CBC7', borderRadius: 12, padding: '11px 13px' }} data-testid="evidence-failed">
            {/* #584 review round 1, finding 3 — a refused photo is evidence that did not land, and this
                line is the instruction to deal with each one; 13px with weight, not an eyebrow. */}
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--red-solid)' }}>Photos the server refused — choose for each</div>
            {failedEvidence.map((f) => (
              <div key={f.clientKey} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ flex: 1, fontSize: 12.5 }} data-testid={`evidence-failed-${f.clientKey}`}>
                  {f.reason}
                  <span
                    style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}
                    data-testid={`evidence-failed-where-${f.clientKey}`}
                  >
                    {evidenceOrigin(f.inspectionId, f.inspectionItemId)}
                  </span>
                </span>
                <button onClick={() => void retryFailedEvidence(f.clientKey)} data-testid={`evidence-retry-${f.clientKey}`} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--ink)', background: '#fff', cursor: 'pointer', fontSize: 12 }}>Retry</button>
                <button onClick={() => void deleteFailedEvidence(f.clientKey)} data-testid={`evidence-delete-${f.clientKey}`} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--red-solid)', color: 'var(--red-solid)', background: '#fff', cursor: 'pointer', fontSize: 12 }}>Delete</button>
              </div>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => onPicked(e.target.files?.[0] ?? null)} data-testid="evidence-file-input" />
      </div>

      <div className={styles.stickyFoot} style={{ padding: '12px 16px 20px', borderTop: '1px solid rgba(35,33,28,.1)', background: 'var(--panel)' }}>
        <button
          onClick={submitInspection}
          disabled={frozen}
          data-testid="submit-inspection"
          data-submission={checklist.submitted ? 'submitted' : submissionStatus}
          style={{
            width: '100%',
            maxWidth: 460,
            margin: '0 auto',
            display: 'block',
            padding: 15,
            borderRadius: 12,
            fontFamily: 'var(--font-sans)',
            fontWeight: 600,
            fontSize: 15,
            cursor: frozen ? 'not-allowed' : 'pointer',
            border: 'none',
            background: checklist.submitted ? 'var(--green-chip)' : 'var(--ink)',
            color: checklist.submitted ? 'var(--green-text)' : 'var(--sidebar-text)',
            opacity: !checklist.submitted && frozen ? 0.7 : 1,
          }}
        >
          {checklist.submitted
            ? 'Submitted ✓ — awaiting architect'
            : submissionStatus === 'submitting'
            ? 'Submitting…'
            : submissionStatus === 'queued'
            ? 'Queued — will submit when you reconnect'
            : 'Submit Inspection'}
        </button>
      </div>
    </div>
  );
}
