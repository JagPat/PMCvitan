import { type CSSProperties } from 'react';
import { useStore } from '@/store/store';

/**
 * #633 — the way back to the Site Map place a record was opened from.
 *
 * A place's records open at their own URL, so browser Back already returns; this makes that
 * return visible and one tap on a phone, naming the place the reader came from (which, for a
 * drawing inherited from a parent zone, is not the drawing's own filed place). It shows only on
 * the screen the record was opened on; any other navigation clears it in the store.
 */
export function ReturnToPlace() {
  const returnPlace = useStore((s) => s.returnPlace);
  const screen = useStore((s) => s.screen);
  const placeName = useStore((s) =>
    s.returnPlace?.nodeId ? s.nodes.find((n) => n.id === s.returnPlace?.nodeId)?.name ?? null : null);
  const openPlace = useStore((s) => s.openPlace);
  if (!returnPlace || returnPlace.screen !== screen || screen === 'places') return null;
  // a place removed meanwhile: return to the Site Map itself rather than to a node it can't open
  const target = placeName ? returnPlace.nodeId : null;
  return (
    <button type="button" style={link} data-testid="return-to-place" onClick={() => openPlace(target)}>
      ← Back to {placeName ?? 'the Site Map'}
    </button>
  );
}

const link: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  marginBottom: 8,
  padding: '6px 10px',
  border: '1px solid var(--hairline-strong)',
  borderRadius: 8,
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
