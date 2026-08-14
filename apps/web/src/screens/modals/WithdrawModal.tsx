import { Modal, Button } from '@/components';
import { useStore } from '@/store/store';

const inputStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 6,
  padding: 12,
  border: '1px solid rgba(35,33,28,.2)',
  borderRadius: 10,
  background: 'var(--paper)',
  fontSize: 13.5,
  outline: 'none',
};
const fieldLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '.12em',
  color: 'var(--faint)',
};

/** Withdraw a PUBLISHED, never-approved decision (Phase 6 task 4a) — pmc only, terminal.
 *  The reason is REQUIRED (a withdrawal without one is a silent delete); the register keeps
 *  the record and the client's pending surfaces clear by themselves. */
export function WithdrawModal() {
  const modal = useStore((s) => s.modal);
  const closeModal = useStore((s) => s.closeModal);
  const confirmWithdraw = useStore((s) => s.confirmWithdraw);
  const setWithdrawReason = useStore((s) => s.setWithdrawReason);
  const reasonBlank = !(modal.withdrawReason ?? '').trim();

  return (
    <Modal onClose={closeModal} labelledBy="withdraw-title">
      <div style={{ padding: 24 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.18em', color: 'var(--muted)' }}>
          WITHDRAW DECISION
        </div>
        <div id="withdraw-title" style={{ fontSize: 20, fontWeight: 700, marginTop: 8, lineHeight: 1.25 }}>
          {modal.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>
          This takes the decision back permanently. The client&rsquo;s pending item disappears; the
          register keeps the withdrawal and its reason. To ask the question again, issue a new
          decision.
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={fieldLabel}>REASON FOR WITHDRAWAL (REQUIRED)</div>
          <input
            value={modal.withdrawReason ?? ''}
            onChange={(e) => setWithdrawReason(e.target.value)}
            placeholder="e.g. Issued against the wrong room…"
            data-testid="withdraw-reason"
            style={{ ...inputStyle, fontFamily: 'var(--font-sans)' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <Button variant="outline" style={{ flex: 1 }} onClick={closeModal}>
            Cancel
          </Button>
          <Button variant="accent" style={{ flex: 1.4 }} onClick={confirmWithdraw} disabled={reasonBlank} data-testid="confirm-withdraw">
            Withdraw Decision
          </Button>
        </div>
      </div>
    </Modal>
  );
}
