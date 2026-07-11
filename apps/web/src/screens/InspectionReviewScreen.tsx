import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectActiveReview } from '@/store/selectors';
import { Eyebrow, ResultChip, Button, Modal } from '@/components';
import { LocationPicker } from '@/components/LocationPicker';
import { X, Plus, Minus } from '@/lib/icons';
import { swatch as swatchGradient, can, type Review } from '@vitan/shared';
import styles from './responsive.module.css';

export function InspectionReviewScreen() {
  const reviews = useStore(useShallow((s) => s.reviews));
  const active = useStore(selectActiveReview);
  const setActiveReview = useStore((s) => s.setActiveReview);
  const toggleReject = useStore((s) => s.toggleReject);
  const approveInspection = useStore((s) => s.approveInspection);
  const sendReinspection = useStore((s) => s.sendReinspection);

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
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 2px' }} role="tablist" aria-label="Review queue">
          {reviews.map((r) => {
            const on = r.id === review.id;
            return (
              <button
                key={r.id}
                onClick={() => setActiveReview(r.id)}
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
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>{review.title}</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 7, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>{review.zone}</span>
            <span>·</span>
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
                <div style={{ width: 130, height: 100, flex: 'none', borderRadius: 8, background: swatchGradient(it.swatch), position: 'relative', overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', left: 6, bottom: 6, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,.9)', background: 'rgba(0,0,0,.4)', padding: '1px 5px', borderRadius: 3 }}>PHOTO</span>
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
                    onClick={() => toggleReject(i)}
                    style={{ padding: '9px 14px', fontSize: 12, whiteSpace: 'nowrap' }}
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
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="success" onClick={approveInspection} style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>Approve Inspection</Button>
          <Button variant="dangerOutline" onClick={sendReinspection} data-testid="send-reinspection" style={{ flex: 1, minWidth: 200, padding: 15, fontSize: 14 }}>Send Rejections &amp; Create Re-inspection</Button>
        </div>
        <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--faint)', marginTop: 9 }}>{summary}</div>
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

function IssueChecklistModal({ onClose }: { onClose: () => void }) {
  const issueChecklist = useStore((s) => s.issueChecklist);
  const [title, setTitle] = useState('');
  const [zone, setZone] = useState('');
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [items, setItems] = useState<string[]>(['']);

  const clean = items.map((s) => s.trim()).filter(Boolean);
  const ready = Boolean(title.trim() && zone.trim() && clean.length > 0);

  const setItem = (i: number, v: string) => setItems((prev) => prev.map((it, j) => (j === i ? v : it)));
  const addItem = () => setItems((prev) => (prev.length < 20 ? [...prev, ''] : prev));
  const removeItem = (i: number) => setItems((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));

  const save = () => {
    if (!ready) return;
    issueChecklist({ title: title.trim(), zone: zone.trim(), items: clean, ...(nodeId ? { nodeId } : {}) });
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={460} labelledBy="new-chk-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="new-chk-title" style={{ fontWeight: 700, fontSize: 17 }}>Issue checklist</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          The site engineer fills this in the field with photos, then submits it back here for your review.
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (e.g. Waterproofing — 2nd coat)" style={{ ...fld, marginTop: 14, width: '100%' }} data-testid="chk-title" />
        <input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Zone (free text — or pick a location below)" style={{ ...fld, marginTop: 10, width: '100%' }} data-testid="chk-zone" />
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)', margin: '14px 0 7px' }}>LOCATION (OPTIONAL)</div>
        <LocationPicker value={nodeId} onChange={setNodeId} idPrefix="chk-loc" />

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)', margin: '16px 0 8px' }}>CHECKLIST ITEMS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((it, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)', width: 18, flex: 'none' }}>{i + 1}</span>
              <input value={it} onChange={(e) => setItem(i, e.target.value)} placeholder="Item to verify on site" style={{ ...fld, flex: 1 }} data-testid={`chk-item-${i}`} />
              {items.length > 1 && (
                <button onClick={() => removeItem(i)} aria-label={`Remove item ${i + 1}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
                  <Minus size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
        {items.length < 20 && (
          <button onClick={addItem} style={{ marginTop: 10, background: 'transparent', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 10, padding: '9px 14px', fontSize: 12.5, cursor: 'pointer', color: 'var(--muted)', width: '100%' }} data-testid="chk-add-item">
            + Add item
          </button>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: 1, padding: 12 }}>Cancel</Button>
          <Button variant="ink" onClick={save} disabled={!ready} data-testid="save-checklist" style={{ flex: 1, padding: 12 }}>Issue to engineer</Button>
        </div>
      </div>
    </Modal>
  );
}

const fld: CSSProperties = { height: 42, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
