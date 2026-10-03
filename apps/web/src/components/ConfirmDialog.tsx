import { useId, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

/**
 * Audit B4 — the one confirmation every destructive action goes through: it names the thing,
 * says what else changes, and puts Cancel first so a stray tap never deletes. `blocked` explains
 * why the action can't run now and offers only Close.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  blocked,
  testId = 'confirm-dialog',
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  blocked?: string;
  testId?: string;
}) {
  const titleId = useId();
  return (
    <Modal onClose={onCancel} maxWidth={400} labelledBy={titleId}>
      <div style={{ padding: '18px 20px' }} data-testid={testId}>
        <div id={titleId} style={{ fontWeight: 700, fontSize: 16.5 }}>{title}</div>
        {children && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>{children}</div>}
        {blocked && <div style={{ fontSize: 13, color: 'var(--red-solid)', marginTop: 10, lineHeight: 1.5 }} data-testid={`${testId}-blocked`}>{blocked}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <Button variant="outline" onClick={onCancel} data-testid={`${testId}-cancel`} style={{ padding: '10px 16px' }}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {!blocked && (
            <Button variant="danger" onClick={() => { onConfirm(); onCancel(); }} data-testid={`${testId}-confirm`} style={{ padding: '10px 16px' }}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
