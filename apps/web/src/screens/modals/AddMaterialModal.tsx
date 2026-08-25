import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectVisibleDecisions } from '@/store/selectors';
import { Button, Modal, Swatch, InheritedContext, MoreDetails } from '@/components';
import { SW, type SwatchKey } from '@vitan/shared';
import { inheritsLocation, type CaptureContext } from '@/lib/captureContext';

/**
 * Engineer/PMC records a material delivery.
 *
 * The place a delivery belongs to is inherited rather than re-asked, like every other form
 * here. Its `zone` field is NOT part of that: for a delivery the column holds where and how
 * the goods are STORED — the seed's own rows pair a room node with "Zone B · covered, on
 * pallets" and "Store room · locked", and the daily log prints that text beside the
 * quantity. Deriving it from the location would answer a question nobody asked and discard
 * the one the storekeeper actually recorded, so it stays a field — relabelled to say what
 * it is, and optional, because it always was.
 *
 * Only a name and a quantity block the save, as the domain requires. The three fields that
 * block nothing — storage, the decision link and the swatch — open folded: the form asks
 * what arrived, how much, and where, and the storekeeper who has more to say opens it.
 */
export function AddMaterialModal({ context, onClose }: { context?: CaptureContext; onClose: () => void }) {
  const addSiteMaterial = useStore((s) => s.addSiteMaterial);
  // a delivery matches a published decision — drafts aren't linkable
  // …and a WITHDRAWN decision is terminal: a delivery can no longer match it, so the picker
  // excludes it for EVERY role on top of the shared audience rule (4a round 6, Codex)
  const decisions = useStore(useShallow((s) => selectVisibleDecisions(s).filter((d) => d.status !== 'withdrawn')));
  const inherited = inheritsLocation(context);
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [storage, setStorage] = useState('');
  const [decisionId, setDecisionId] = useState('');
  const [nodeId, setNodeId] = useState<string | null>(context?.nodeId ?? null);
  const [swatch, setSwatch] = useState<SwatchKey>('tile');

  const ready = Boolean(name.trim() && qty.trim());
  const save = () => {
    if (!ready) return;
    addSiteMaterial({
      name: name.trim(),
      qty: qty.trim(),
      zone: storage.trim(),
      decisionId: decisionId || undefined,
      swatch,
      ...(nodeId ? { nodeId } : {}),
    });
    onClose();
  };
  const swatchKeys = Object.keys(SW) as SwatchKey[];

  return (
    <Modal onClose={onClose} maxWidth={440} labelledBy="add-mat-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="add-mat-title" style={{ fontWeight: 700, fontSize: 17 }}>Record material delivery</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          What arrived, how much, and where. Under <b>More details</b>: how it is stored, and a
          link to a locked decision so the PMC can confirm the delivery matches what the client
          approved.
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Material (e.g. Italian Marble slabs)" style={{ ...fldM, marginTop: 14, width: '100%' }} data-testid="mat-name" />
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty (e.g. 40 sqm)" style={{ ...fldM, marginTop: 10, width: '100%' }} data-testid="mat-qty" />

        <div style={{ marginTop: 12 }}>
          <InheritedContext value={nodeId} onChange={setNodeId} inherited={inherited} idPrefix="mat-loc" testId="mat-place" />
        </div>

        <MoreDetails testId="mat-more">
          {/* where and how it is STORED — not the location, which the place above carries */}
          <input value={storage} onChange={(e) => setStorage(e.target.value)} placeholder="Stored how? (e.g. covered, on pallets)" style={{ ...fldM, width: '100%' }} data-testid="mat-storage" />

          <div style={{ ...sectionLabel, marginTop: 14 }}>LINK TO DECISION</div>
          <select value={decisionId} onChange={(e) => setDecisionId(e.target.value)} style={{ ...fldM, width: '100%' }} data-testid="mat-decision" aria-label="Link to decision">
            <option value="">— No linked decision —</option>
            {decisions.map((d) => (
              <option key={d.id} value={d.id}>{d.id} · {d.title}</option>
            ))}
          </select>

          <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
            <Swatch swatch={swatch} size={40} radius={9} />
            <select value={swatch} onChange={(e) => setSwatch(e.target.value as SwatchKey)} style={{ ...fldM, flex: 1, minWidth: 0 }} aria-label="Material swatch">
              {swatchKeys.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
        </MoreDetails>

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: 1, padding: 12 }}>Cancel</Button>
          <Button variant="ink" onClick={save} disabled={!ready} data-testid="save-material" style={{ flex: 1, padding: 12 }}>Record delivery</Button>
        </div>
      </div>
    </Modal>
  );
}

const fldM: CSSProperties = { height: 42, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
const sectionLabel: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)', margin: '0 0 6px' };
