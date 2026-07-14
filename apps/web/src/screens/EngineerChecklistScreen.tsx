import { useRef, type CSSProperties } from 'react';
import { useStore, checklistFrozen } from '@/store/store';
import { EmptyState, Eyebrow, StatTile } from '@/components';
import { Camera } from '@/lib/icons';
import type { ItemState } from '@vitan/shared';
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
  // one hidden file input, re-targeted per item (Task 4: photos are REAL evidence rows)
  const fileRef = useRef<HTMLInputElement>(null);
  const targetIdx = useRef(0);
  const pickEvidence = (i: number) => {
    targetIdx.current = i;
    fileRef.current?.click();
  };
  const onPicked = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { void addChecklistEvidence(targetIdx.current, String(reader.result)); };
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = '';
  };

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

  const set = (i: number, v: Exclude<ItemState, null>) => () => setItem(i, v);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className={styles.mobileScreen} style={{ flex: 1, paddingBottom: 20 }}>
        <div style={{ padding: '10px 0 14px' }}>
          <Eyebrow size={9}>TODAY'S INSPECTION</Eyebrow>
          <div style={{ fontWeight: 700, fontSize: 21, marginTop: 4, lineHeight: 1.2 }}>{checklist.title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{checklist.zone} · {checklist.date}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <StatTile label="DONE" value={`${doneCount}/${checklist.items.length}`} />
            <StatTile label="PHOTOS" value={photoCount} />
          </div>
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
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red-solid)', letterSpacing: '.1em' }}>FAIL REQUIRES NOTE + PHOTO EVIDENCE</div>
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
        {failedEvidence.length > 0 && (
          <div style={{ marginTop: 12, background: '#FBF0EF', border: '1px solid #E7CBC7', borderRadius: 12, padding: '11px 13px' }} data-testid="evidence-failed">
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--red-solid)', letterSpacing: '.1em' }}>PHOTOS THE SERVER REFUSED — CHOOSE FOR EACH</div>
            {failedEvidence.map((f) => (
              <div key={f.clientKey} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ flex: 1, fontSize: 12.5 }}>{f.reason}</span>
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
