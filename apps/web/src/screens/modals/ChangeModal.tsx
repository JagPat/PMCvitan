import { Modal, Button } from '@/components';
import { useStore } from '@/store/store';
import { readImpact } from '@/lib/impactInput';
import { deciderNoun } from '@vitan/shared';

// Wave 0 / F-1b round 8 — `minHeight: 44`. 12px of padding around a 13.5px line lands at 43,
// one pixel under the floor, which is exactly the kind of miss a rounded comparison hides and
// the raw-rect measurement (round 8, finding 1) catches. This token is DUPLICATED in
// `ChangeModal` and `WithdrawModal`; both copies carry the floor, because a shared rule with
// two private spellings is fixed twice or not at all.
const inputStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 6,
  minHeight: 44,
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
const fieldError: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.35, color: 'var(--red-solid)', marginTop: 4 };

/** Change Request against a locked decision — reason + cost + time impact. */
export function ChangeModal() {
  const modal = useStore((s) => s.modal);
  const closeModal = useStore((s) => s.closeModal);
  const submitChange = useStore((s) => s.submitChange);
  const setChangeText = useStore((s) => s.setChangeText);
  const setChangeCost = useStore((s) => s.setChangeCost);
  const setChangeTime = useStore((s) => s.setChangeTime);
  // round-11 Codex F2 — the re-approval instruction names the ACTUAL decider (the client-held
  // text stays byte-identical: deciderNoun('client') === 'the client')
  const kind = useStore((s) => s.decisions.find((x) => x.id === s.modal.decId)?.deciderKind ?? 'client');
  // #482 comment 5923291892 (family-wide): the impacts are read exactly or refused with a reason, and
  // Submit stays disabled while either is refused — nothing altered is ever sent
  const cost = readImpact(modal.changeCost ?? '', 'cost');
  const time = readImpact(modal.changeTime ?? '', 'days');

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
          This decision is locked. A change must be re-approved by {deciderNoun(kind)} with cost &amp; time impact.
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
              aria-label="Cost impact (₹)"
              aria-invalid={!cost.ok}
              aria-describedby={!cost.ok ? 'change-cost-error' : undefined}
              data-testid="change-cost"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', ...(cost.ok ? null : { borderColor: 'var(--red-solid)' }) }}
            />
            {!cost.ok && <div id="change-cost-error" role="alert" data-testid="change-cost-error" style={fieldError}>{cost.reason}</div>}
          </div>
          <div style={{ flex: 1 }}>
            <div style={fieldLabel}>TIME IMPACT (DAYS)</div>
            <input
              value={modal.changeTime ?? ''}
              onChange={(e) => setChangeTime(e.target.value)}
              placeholder="+4"
              aria-label="Time impact (days)"
              aria-invalid={!time.ok}
              aria-describedby={!time.ok ? 'change-time-error' : undefined}
              data-testid="change-time"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', ...(time.ok ? null : { borderColor: 'var(--red-solid)' }) }}
            />
            {!time.ok && <div id="change-time-error" role="alert" data-testid="change-time-error" style={fieldError}>{time.reason}</div>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <Button variant="outline" style={{ flex: 1 }} onClick={closeModal}>
            Cancel
          </Button>
          <Button variant="accent" style={{ flex: 1.4 }} onClick={submitChange} disabled={!cost.ok || !time.ok} data-testid="change-submit">
            Submit for Re-approval
          </Button>
        </div>
      </div>
    </Modal>
  );
}
