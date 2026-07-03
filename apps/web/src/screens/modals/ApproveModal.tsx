import { Modal, Button } from '@/components';
import { useStore } from '@/store/store';
import { signed, swatch as swatchGradient } from '@vitan/shared';
import { Lock } from '@/lib/icons';

/** Confirmation modal for the irreversible approve-and-lock step. */
export function ApproveModal() {
  const modal = useStore((s) => s.modal);
  const closeModal = useStore((s) => s.closeModal);
  const confirmApprove = useStore((s) => s.confirmApprove);

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
          CONFIRM APPROVAL
        </div>
        <div id="approve-title" style={{ fontSize: 20, fontWeight: 700, marginTop: 8, lineHeight: 1.25 }}>
          You are approving {modal.optionLabel} — {modal.material}
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
            <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>Cost impact</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 16, marginTop: 2 }}>
              {signed(modal.delta ?? 0)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>Decision</div>
            <div style={{ fontWeight: 600, fontSize: 14, marginTop: 2, color: 'var(--green-solid)', display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
              Will be locked <Lock size={13} />
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.5 }}>
          This decision will be recorded against your name, time-stamped, and locked. Any later change needs a formal Change Request.
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" style={{ flex: 1 }} onClick={closeModal}>
            Cancel
          </Button>
          <Button variant="success" style={{ flex: 1.4 }} onClick={confirmApprove} data-testid="approve-lock">
            Approve &amp; Lock
          </Button>
        </div>
      </div>
    </Modal>
  );
}
