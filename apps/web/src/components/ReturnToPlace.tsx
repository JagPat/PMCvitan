import { type CSSProperties } from 'react';
import { returnToPlaceText } from '@vitan/shared';
import { useStore } from '@/store/store';

/**
 * #633 — the way back to the Site Map place a record was opened from.
 *
 * A place's records open at their own URL, so browser Back already returns; this makes that
 * return visible and one tap on a phone, naming the place the reader came from (which, for a
 * drawing inherited from a parent zone, is not the drawing's own filed place). It shows only on
 * the screen the record was opened on, while that record is still the one on show (closing it or
 * moving to another record on the same screen leaves the way back behind); any other navigation
 * clears it in the store.
 */
export function ReturnToPlace({ inViewer = false }: { inViewer?: boolean }) {
  const returnPlace = useStore((s) => s.returnPlace);
  // #826 Codex 4258001540 — an open drawing is a full-screen modal over the shell, so its way back lives
  // inside the viewer (`inViewer`); the shell's copy stands aside while that viewer is up
  const drawingViewerUp = useStore((s) =>
    s.screen === 'drawings' && !!s.routeItem && s.drawings.some((d) => d.id === s.routeItem));
  const screen = useStore((s) => s.screen);
  // the record on show: the client's approval screen names it by `decisionFocus`, every other by `routeItem`
  const item = useStore((s) => (s.screen === 'client-decisions' ? s.decisionFocus : s.routeItem));
  const placeName = useStore((s) =>
    s.returnPlace?.nodeId ? s.nodes.find((n) => n.id === s.returnPlace?.nodeId)?.name ?? null : null);
  const openPlace = useStore((s) => s.openPlace);
  const lang = useStore((s) => s.lang);
  if (!returnPlace || returnPlace.screen !== screen || returnPlace.item !== item || screen === 'places') return null;
  if (drawingViewerUp !== inViewer) return null;
  // a place removed meanwhile: return to the Site Map itself rather than to a node it can't open
  const target = placeName ? returnPlace.nodeId : null;
  return (
    <button type="button" style={inViewer ? inModal : stuck} data-testid="return-to-place" onClick={() => openPlace(target)}>
      {returnToPlaceText(placeName, lang)}
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

// #826 Codex 4258001551 — a routed record scrolls itself into view; the way back stays pinned to the top of
// the stage instead of scrolling away with the page
const stuck: CSSProperties = { ...link, display: 'flex', width: 'fit-content', position: 'sticky', top: 8, zIndex: 5 };
const inModal: CSSProperties = { ...link, margin: '12px 18px 0' };
