import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Button, Modal, InheritedContext } from '@/components';
import { Minus } from '@/lib/icons';
import { zoneLabelFor, inheritsLocation, type CaptureContext } from '@/lib/captureContext';

/**
 * PMC issues a field checklist.
 *
 * Two data-entry corrections over the version that lived inside `InspectionReviewScreen`:
 *
 *  1. The location is asked ONCE. The form used to require a typed `zone` AND offer an
 *     optional location picker — two questions for one fact, with the canonical answer
 *     (`nodeId`) as the optional one. The node is now the question and `zoneLabelFor`
 *     derives the legacy string, so the checklist still carries both fields and every
 *     existing reader keeps working.
 *  2. When the user started from a place, that place is inherited: shown as a fact with
 *     a Change escape, not re-asked as an empty tree.
 */
export function IssueChecklistModal({ context, onClose }: { context?: CaptureContext; onClose: () => void }) {
  const issueChecklist = useStore((s) => s.issueChecklist);
  const nodes = useStore(useShallow((s) => s.nodes));
  const inherited = inheritsLocation(context);
  const [title, setTitle] = useState('');
  const [nodeId, setNodeId] = useState<string | null>(context?.nodeId ?? null);
  const [items, setItems] = useState<string[]>(['']);

  const clean = items.map((s) => s.trim()).filter(Boolean);
  // The NODE is the location requirement now — `zone` is derived, so it can never be the
  // thing standing between a filled-in checklist and the Issue button.
  const ready = Boolean(title.trim() && nodeId && clean.length > 0);

  const setItem = (i: number, v: string) => setItems((prev) => prev.map((it, j) => (j === i ? v : it)));
  const addItem = () => setItems((prev) => (prev.length < 20 ? [...prev, ''] : prev));
  const removeItem = (i: number) => setItems((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));

  const save = () => {
    if (!ready) return;
    issueChecklist({
      title: title.trim(),
      zone: zoneLabelFor(nodes, nodeId),
      items: clean,
      ...(nodeId ? { nodeId } : {}),
    });
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

        <div style={{ marginTop: 12 }}>
          <InheritedContext value={nodeId} onChange={setNodeId} inherited={inherited} idPrefix="chk-loc" testId="chk-place" />
        </div>

        <div style={sectionLabel}>CHECKLIST ITEMS</div>
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
const sectionLabel: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)', margin: '16px 0 8px' };
