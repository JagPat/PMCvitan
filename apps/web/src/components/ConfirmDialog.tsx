import { useId, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { confirmDialogLabels, type Lang } from '@vitan/shared';

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
  lang = 'en',
  guide,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  blocked?: string;
  testId?: string;
  /** #482 — the Cancel/Close word; English unless the caller's own words are translated */
  lang?: Lang;
  /** #482 — the in-app guide's name for the confirm button (`data-guide`), when a guide points at it */
  guide?: string;
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
            {blocked ? confirmDialogLabels.close[lang] : confirmDialogLabels.cancel[lang]}
          </Button>
          {!blocked && (
            <Button variant="danger" onClick={() => { onConfirm(); onCancel(); }} data-testid={`${testId}-confirm`} data-guide={guide} style={{ padding: '10px 16px' }}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
