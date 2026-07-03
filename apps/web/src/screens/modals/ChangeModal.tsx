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

/** Change Request against a locked decision — reason + cost + time impact. */
export function ChangeModal() {
  const modal = useStore((s) => s.modal);
  const closeModal = useStore((s) => s.closeModal);
  const submitChange = useStore((s) => s.submitChange);
  const setChangeText = useStore((s) => s.setChangeText);
  const setChangeCost = useStore((s) => s.setChangeCost);
  const setChangeTime = useStore((s) => s.setChangeTime);

  return (
    <Modal onClose={closeModal} labelledBy="change-title">
      <div style={{ padding: 24 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.18em', color: 'var(--amber-text)' }}>
          CHANGE REQUEST
        </div>
        <div id="change-title" style={{ fontSize: 20, fontWeight: 700, marginTop: 8, lineHeight: 1.25 }}>
          {modal.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>
          This decision is locked. A change must be re-approved by the client with cost &amp; time impact.
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={fieldLabel}>REASON FOR CHANGE</div>
          <input
            value={modal.changeText ?? ''}
            onChange={(e) => setChangeText(e.target.value)}
            placeholder="e.g. Client prefers a lighter tone…"
            style={{ ...inputStyle, fontFamily: 'var(--font-sans)' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>COST IMPACT (₹)</div>
            <input
              value={modal.changeCost ?? ''}
              onChange={(e) => setChangeCost(e.target.value)}
              placeholder="+45000"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>TIME IMPACT (DAYS)</div>
            <input
              value={modal.changeTime ?? ''}
              onChange={(e) => setChangeTime(e.target.value)}
              placeholder="+4"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <Button variant="outline" style={{ flex: 1 }} onClick={closeModal}>
            Cancel
          </Button>
          <Button variant="accent" style={{ flex: 1.4 }} onClick={submitChange}>
            Submit for Re-approval
          </Button>
        </div>
      </div>
    </Modal>
  );
}
