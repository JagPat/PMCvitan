import { Modal, Button } from '@/components';
import { useStore } from '@/store/store';
import { signed, swatch as swatchGradient, approveModalLabels as L, approveModalTitle } from '@vitan/shared';
import { Lock, ArrowRight } from '@/lib/icons';

/** Confirmation modal for the irreversible approve-and-lock step.
 *
 *  Phase 6 task 4d-ii-b / B4 — under an ACTIVE architect chain the approval is provisional: the server's
 *  compare-and-set lands the decision `awaiting_countersign`, not `approved` (4d-ii-a / A8a). The DTO says
 *  so up front through the `countersignRequired` overlay, so the confirmation reads it and tells the
 *  decider what their approval does — sent to the architect for countersign, locked only when they sign —
 *  instead of promising a lock the server will not grant. Absent the overlay (the delivered world, and
 *  every project while the doors stand) the copy is byte-identical to what it always said. */
export function ApproveModal() {
  const modal = useStore((s) => s.modal);
  const closeModal = useStore((s) => s.closeModal);
  const lang = useStore((s) => s.lang);
  const confirmApprove = useStore((s) => s.confirmApprove);
  const countersignRequired = useStore((s) => s.decisions.find((d) => d.id === s.modal.decId)?.countersignRequired === true);

  return (
    <Modal onClose={closeModal} labelledBy="approve-title">
      <div style={{ height: 130, background: swatchGradient(modal.swatch), position: 'relative' }}>
        <span
          style={{
            position: 'absolute',
            left: 14,
            bottom: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: '#fff',
            background: 'rgba(0,0,0,.4)',
            padding: '3px 9px',
            borderRadius: 5,
          }}
        >
          {modal.optionLabel}
        </span>
      </div>
      <div style={{ padding: '22px 24px 24px' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.18em', color: 'var(--amber-text)' }}>
          {L.eyebrow[lang]}
        </div>
        <div id="approve-title" style={{ fontSize: 20, fontWeight: 700, marginTop: 8, lineHeight: 1.25 }}>
          {approveModalTitle(modal.optionLabel ?? '', modal.material ?? '', lang)}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 16,
            padding: '13px 15px',
            background: 'var(--paper)',
            border: '1px solid var(--hairline)',
            borderRadius: 11,
          }}
        >
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>{L.costImpact[lang]}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 16, marginTop: 2 }}>
              {signed(modal.delta ?? 0)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>{L.decision[lang]}</div>
            {countersignRequired ? (
              <div data-testid="approve-outcome" style={{ fontWeight: 600, fontSize: 14, marginTop: 2, color: '#31567F', display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
                {L.toCountersign[lang]} <ArrowRight size={13} />
              </div>
            ) : (
              <div data-testid="approve-outcome" style={{ fontWeight: 600, fontSize: 14, marginTop: 2, color: 'var(--green-solid)', display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
                {L.willLock[lang]} <Lock size={13} />
              </div>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.5 }} data-testid="approve-explainer">
          {countersignRequired
            ? L.explainCountersign[lang]
            : L.explainLock[lang]}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" style={{ flex: 1 }} onClick={closeModal}>
            {L.cancel[lang]}
          </Button>
          <Button variant="success" style={{ flex: 1.4 }} onClick={confirmApprove} data-testid="approve-lock" data-guide="approve-confirm" data-guide-key={modal.decId ?? undefined}>
            {countersignRequired ? L.approveCountersign[lang] : L.approveLock[lang]}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
