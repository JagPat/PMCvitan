import { type CSSProperties, type ReactNode } from 'react';
import { Lock, Pencil, FileEdit, ShieldCheck, RefreshCw } from '@/lib/icons';

/**
 * The standard answer to three questions the user must never have to guess:
 * *can I edit this?*, *if not why?*, and *what do I do instead?*
 *
 * It presents governance, it does not decide it: every caller passes the verdict its own
 * domain rules already produced (a decision is locked because it is APPROVED, a control is
 * restricted because `can(...)` said so). Nothing here weakens a permission — a disabled
 * control simply stops being silent.
 *
 * · `editable`   — the action is available; render it
 * · `draft`      — private work in progress; edit and publish are both valid
 * · `locked`     — a governance state after approval; the next action is usually a change request
 * · `restricted` — this role may not edit (say WHO may)
 * · `workflow`   — the item's own state blocks editing (say what must happen first)
 * · `paused`     — a transient system condition (an unsettled read); it will clear on its own
 */
export type EditAvailability = 'editable' | 'draft' | 'locked' | 'restricted' | 'workflow' | 'paused';

export interface EditAction {
  label: string;
  onClick: () => void;
  testId?: string;
  disabled?: boolean;
}

const META: Record<EditAvailability, { icon: typeof Lock; fg: string; bg: string; border: string }> = {
  editable: { icon: Pencil, fg: 'var(--muted)', bg: 'transparent', border: 'transparent' },
  draft: { icon: FileEdit, fg: 'var(--muted)', bg: 'var(--panel)', border: 'var(--hairline)' },
  locked: { icon: Lock, fg: 'var(--muted)', bg: 'var(--panel)', border: 'var(--hairline)' },
  restricted: { icon: ShieldCheck, fg: 'var(--muted)', bg: 'var(--panel)', border: 'var(--hairline)' },
  workflow: { icon: Lock, fg: 'var(--red-text)', bg: 'rgba(180,70,46,.07)', border: 'rgba(180,70,46,.2)' },
  paused: { icon: RefreshCw, fg: 'var(--amber-text)', bg: 'var(--amber-chip)', border: 'var(--amber-border)' },
};

export function EditState({
  state,
  reason,
  action,
  extra,
  testId,
}: {
  state: EditAvailability;
  /** WHY, in the user's words — "Locked after approval", "Only PMC can edit this item" */
  reason: string;
  /** the valid next action, when the domain offers one */
  action?: EditAction;
  /** any further caller-owned controls (e.g. a second permitted action) */
  extra?: ReactNode;
  testId?: string;
}) {
  const meta = META[state];
  const Icon = meta.icon;

  return (
    <div
      data-testid={testId}
      data-edit-state={state}
      style={{ ...wrap, background: meta.bg, border: `1px solid ${meta.border}`, color: meta.fg }}
    >
      <Icon size={13} style={{ flex: 'none' }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.45 }}>{reason}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          data-testid={action.testId}
          style={{ ...btn, opacity: action.disabled ? 0.5 : 1, cursor: action.disabled ? 'not-allowed' : 'pointer' }}
        >
          {action.label}
        </button>
      )}
      {extra}
    </div>
  );
}

const wrap: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  borderRadius: 10,
  padding: '7px 10px',
};

const btn: CSSProperties = {
  flex: 'none',
  // a real touch target on a phone, not a text link
  minHeight: 34,
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid currentColor',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  fontWeight: 600,
};
