import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectVisibleDecisions } from '@/store/selectors';
import { Button, Modal, Swatch, InheritedContext, MoreDetails } from '@/components';
import { SW, type SwatchKey } from '@vitan/shared';
import { zoneLabelFor, inheritsLocation, type CaptureContext } from '@/lib/captureContext';

/**
 * Engineer/PMC records a material delivery.
 *
 * Same two corrections as the checklist: the location is asked once (the typed `Zone` box
 * that sat beside the picker is gone — `zoneLabelFor` derives it), and a place the user
 * started from is inherited rather than re-asked.
 *
 * The decision link and the swatch move under More details. Neither blocks the save — the
 * domain requires only a name and a quantity — so the form now opens at the size of what
 * a delivery actually is: what arrived, and how much.
 */
export function AddMaterialModal({ context, onClose }: { context?: CaptureContext; onClose: () => void }) {
  const addSiteMaterial = useStore((s) => s.addSiteMaterial);
  const nodes = useStore(useShallow((s) => s.nodes));
  // a delivery matches a published decision — drafts aren't linkable
  // …and a WITHDRAWN decision is terminal: a delivery can no longer match it, so the picker
  // excludes it for EVERY role on top of the shared audience rule (4a round 6, Codex)
  const decisions = useStore(useShallow((s) => selectVisibleDecisions(s).filter((d) => d.status !== 'withdrawn')));
  const inherited = inheritsLocation(context);
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [decisionId, setDecisionId] = useState('');
  const [nodeId, setNodeId] = useState<string | null>(context?.nodeId ?? null);
  const [swatch, setSwatch] = useState<SwatchKey>('tile');

  const ready = Boolean(name.trim() && qty.trim());
  const save = () => {
    if (!ready) return;
    addSiteMaterial({
      name: name.trim(),
      qty: qty.trim(),
      zone: zoneLabelFor(nodes, nodeId),
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
          What arrived and how much. Link it to a locked decision under More details so the PMC can
          confirm the delivery matches what the client approved.
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Material (e.g. Italian Marble slabs)" style={{ ...fldM, marginTop: 14, width: '100%' }} data-testid="mat-name" />
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty (e.g. 40 sqm)" style={{ ...fldM, marginTop: 10, width: '100%' }} data-testid="mat-qty" />

        <div style={{ marginTop: 12 }}>
          <InheritedContext value={nodeId} onChange={setNodeId} inherited={inherited} idPrefix="mat-loc" testId="mat-place" />
        </div>

        <MoreDetails testId="mat-more">
          <div style={sectionLabel}>LINK TO DECISION</div>
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
