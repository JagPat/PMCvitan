import { type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { createOptionsFor, type CreateKind } from '@/lib/createOptions';
import { Modal } from './Modal';

/**
 * The shared Add menu.
 *
 * One list serves both devices: a phone and a desktop create the same records under the
 * same rules, so the options and their permission filter live in one place (§14). Only
 * the presentation differs, and for now both get the shared `Modal` — the device-specific
 * shells (a bottom sheet on mobile, a header popover on desktop) belong with the universal
 * `+` entry point, not with this list.
 *
 * A role with no create authority never reaches here: the caller hides the button when
 * `createOptionsFor` is empty, so no one is offered an action that would be refused.
 */
export function CreateMenu({
  title,
  subtitle,
  onPick,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onPick: (kind: CreateKind) => void;
  onClose: () => void;
}) {
  const role = useStore((s) => s.role);
  const options = createOptionsFor(role);

  return (
    <Modal onClose={onClose} maxWidth={420} labelledBy="create-menu-title">
      <div style={{ padding: '18px 20px' }}>
        <div id="create-menu-title" style={{ fontWeight: 700, fontSize: 17 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{subtitle}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
          {options.map((o) => (
            <button key={o.kind} onClick={() => onPick(o.kind)} data-testid={`create-${o.kind}`} style={row}>
              <o.icon size={18} style={{ flex: 'none', color: 'var(--accent)' }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{o.label}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{o.detail}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: '100%',
  // a comfortable touch target on a 390px screen, and a normal row on a desktop
  minHeight: 56,
  padding: '12px 14px',
  background: '#fff',
  border: '1px solid rgba(35,33,28,.12)',
  borderRadius: 12,
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink)',
  textAlign: 'left',
  cursor: 'pointer',
};
