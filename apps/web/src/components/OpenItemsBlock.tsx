import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, proofSendRunning } from '@/store/store';
import { projectScopeOf, type ProjectScope } from '@/store/projectScope';
import { API_BASE, type OpenItem } from '@/data/apiGateway';
import { Camera } from '@/lib/icons';
import { openItemsLabels as L, openItemsProofCount, PROOF_PHOTOS_PER_ITEM } from '@vitan/shared';

const STATUS: Record<OpenItem['status'], keyof typeof L> = { issued: 'issued', 'in-review': 'inReview', reinspection: 'reinspection' };

/**
 * #482 proof photos, "Your open items" (RM-w2b) — on a contractor's or consultant's Dashboard, the open inspections they
 * are named to fix (the snapshot's `openItems`, read live per viewer by the server), each failed item with "Add proof
 * photo". Read-only otherwise. Shown on a live project only, once the project has loaded.
 *
 * ONLINE ONLY, as the "Who fixes this?" picker: while offline the button is disabled and one line says why, and nothing is
 * queued. The button is gone once the item holds `PROOF_PHOTOS_PER_ITEM` proofs (every member's, the server's cap).
 */
export function OpenItemsBlock() {
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const ready = useStore((s) => s.projectLoadState === 'ready');
  const online = useStore((s) => s.online);
  const openItems = useStore(useShallow((s) => s.openItems));
  const sending = useStore(useShallow((s) => s.proofSending));
  const projectId = useStore((s) => s.activeProjectId);
  const addProofPhoto = useStore((s) => s.addProofPhoto);
  const fileRef = useRef<HTMLInputElement>(null);
  // the item the camera was opened for, and the scope it was opened in, pinned at the tap: reading the file is
  // asynchronous, and the list (or the project) can change before it ends
  const target = useRef<{ inspectionId: string; itemId: string; scope: ProjectScope } | null>(null);
  if (!API_BASE || (role !== 'contractor' && role !== 'consultant') || !ready) return null;

  const pick = (inspectionId: string, itemId: string) => {
    target.current = { inspectionId, itemId, scope: projectScopeOf(useStore.getState()) };
    fileRef.current?.click();
  };
  const onPicked = (file: File | null | undefined) => {
    const t = target.current;
    target.current = null; // one photo per tap
    if (fileRef.current) fileRef.current.value = '';
    if (!file || !t) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') void addProofPhoto(t.inspectionId, t.itemId, reader.result, t.scope);
    };
    reader.readAsDataURL(file);
  };

  return (
    <section data-testid="open-items" aria-labelledby="open-items-title" style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '18px 22px', marginBottom: 22 }}>
      <div id="open-items-title" style={{ fontWeight: 600, fontSize: 14 }}>{L.title[lang]}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{L.hint[lang]}</div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} data-testid="open-items-file" onChange={(e) => onPicked(e.target.files?.[0])} />
      {!online && openItems.some((i) => i.failedItems.length > 0) && (
        <div data-testid="open-items-offline" role="status" style={{ fontSize: 12, color: 'var(--amber-solid)', marginTop: 10 }}>{L.offline[lang]}</div>
      )}
      {openItems.length === 0 ? (
        <div data-testid="open-items-none" style={{ fontSize: 13, marginTop: 12 }}>{L.none[lang]}</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 12 }}>
          {openItems.map((insp) => (
            <li key={insp.inspectionId} data-testid={`open-item-${insp.inspectionId}`} style={{ borderTop: '1px solid var(--hairline)', paddingTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{insp.title} · {insp.zone}</span>
                <span data-testid={`open-item-${insp.inspectionId}-status`} style={{ fontSize: 11.5, color: 'var(--muted)' }}>{L[STATUS[insp.status]][lang]}</span>
              </div>
              {insp.failedItems.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{L.noFailed[lang]}</div>
              ) : (
                <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 8 }}>
                  {insp.failedItems.map((it) => {
                    const full = it.proofCount >= PROOF_PHOTOS_PER_ITEM;
                    const busy = proofSendRunning({ proofSending: sending, activeProjectId: projectId }, it.itemId);
                    return (
                      <li key={it.itemId} data-testid={`open-proof-${it.itemId}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ fontSize: 13 }}>
                          {it.name}
                          <span data-testid={`open-proof-${it.itemId}-count`} style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{openItemsProofCount(it.proofCount, PROOF_PHOTOS_PER_ITEM, lang)}</span>
                        </span>
                        {full ? (
                          <span data-testid={`open-proof-${it.itemId}-full`} style={{ fontSize: 11.5, color: 'var(--muted)' }}>{L.full[lang]}</span>
                        ) : (
                          <button
                            type="button"
                            data-testid={`open-proof-${it.itemId}-add`}
                            onClick={() => pick(insp.inspectionId, it.itemId)}
                            disabled={!online || busy}
                            aria-busy={busy || undefined}
                            // the button's name says which item it adds to: every row's button reads the same otherwise
                            aria-label={`${busy ? L.sending[lang] : L.addProof[lang]}: ${it.name}`}
                            style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', border: 'none', padding: '9px 13px', minHeight: 44, borderRadius: 9, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 12.5, cursor: !online || busy ? 'default' : 'pointer', opacity: !online || busy ? 0.55 : 1, display: 'flex', alignItems: 'center', gap: 6 }}
                          >
                            <Camera size={14} /> {busy ? L.sending[lang] : L.addProof[lang]}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
