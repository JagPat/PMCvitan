import { useState, type ReactNode, type CSSProperties } from 'react';
import { ChevronRight, ChevronDown } from '@/lib/icons';

/**
 * Secondary fields, folded away until someone wants them.
 *
 * A creation form should open at the size of the common case. Everything a record CAN
 * carry — cost and time impact, tags, dependencies, technical metadata, optional
 * categorisation — is real, but asking for it up front turns a thirty-second capture into
 * paperwork, and a long form is the thing users avoid.
 *
 * This only hides what the domain does not require: a field that blocks saving must stay
 * visible, or the user is left hunting for the reason a disabled button will not move.
 */
export function MoreDetails({
  children,
  label = 'More details',
  testId,
}: {
  children: ReactNode;
  label?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 12 }} data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={testId ? `${testId}-toggle` : undefined}
        style={toggle}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {label}
      </button>
      {open && (
        <div style={{ marginTop: 10 }} data-testid={testId ? `${testId}-body` : undefined}>
          {children}
        </div>
      )}
    </div>
  );
}

const toggle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  border: 'none',
  padding: '6px 0',
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--muted)',
  cursor: 'pointer',
};
