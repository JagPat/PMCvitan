import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { trailOf } from '@/lib/locationTree';
import { LocationPicker } from './LocationPicker';
import { MapPin } from '@/lib/icons';

/**
 * The location a creation form INHERITED, stated rather than asked for.
 *
 * When the user taps Add from a place they are already looking at, the app knows where
 * the record belongs. Re-opening the whole location hierarchy at that point is the form
 * asking a question it can already answer, so the inherited place is shown as a fact —
 * "Master Bathroom · Change" — and the picker appears only if the user disagrees.
 *
 * With nothing inherited the picker is shown outright: the form genuinely has to ask, and
 * hiding the question behind a disclosure would only add a tap.
 *
 * The trail comes from the shared `trailOf` walk that `LocationContext` reads, so the
 * place a form says it will file to is written exactly as every reader will later show it.
 */
export function InheritedContext({
  value,
  onChange,
  inherited,
  idPrefix,
  testId,
}: {
  value: string | null;
  onChange: (nodeId: string | null) => void;
  /** true when `value` arrived from the surface the user started on, not from their choice */
  inherited: boolean;
  idPrefix: string;
  testId?: string;
}) {
  const nodes = useStore(useShallow((s) => s.nodes));
  // Once the user asks to change it, the picker stays: they are mid-correction, and
  // collapsing it back under them on the next render would lose their place in the tree.
  const [changing, setChanging] = useState(false);
  const trail = trailOf(nodes, value);
  const showPicker = !inherited || changing || trail.length === 0;

  if (showPicker) {
    return (
      <div data-testid={testId}>
        <div style={label}>
          <MapPin size={12} /> LOCATION
        </div>
        <LocationPicker value={value} onChange={onChange} idPrefix={idPrefix} />
      </div>
    );
  }

  return (
    <div style={chip} data-testid={testId}>
      <MapPin size={13} style={{ flex: 'none', color: 'var(--accent)' }} />
      <span style={path} data-testid={testId ? `${testId}-trail` : undefined}>
        {trail.map((t) => t.name).join(' › ')}
      </span>
      <button
        type="button"
        onClick={() => setChanging(true)}
        data-testid={testId ? `${testId}-change` : undefined}
        style={change}
      >
        Change
      </button>
    </div>
  );
}

const label: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '.12em',
  color: 'var(--faint)',
  margin: '0 0 8px',
};

const chip: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: '#fff',
  border: '1px solid rgba(35,33,28,.12)',
  borderRadius: 11,
  padding: '10px 12px',
  minWidth: 0,
};

const path: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ink)',
  // a deep trail wraps rather than truncating away the room the user is filing to
  overflowWrap: 'anywhere',
};

const change: CSSProperties = {
  flex: 'none',
  background: 'transparent',
  border: 'none',
  padding: '4px 2px',
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--accent)',
  cursor: 'pointer',
};
