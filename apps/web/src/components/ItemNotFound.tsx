import { Button } from './Button';
import { recordBoundaryText as T, type Lang } from '@vitan/shared';

/**
 * Live bug 1 (deep-link target fidelity) — a link named one record and this screen cannot show it:
 * it was completed or removed, or the viewer cannot open it. Said plainly, with the way on, rather
 * than leaving the viewer on the parent list as though that were what the link meant.
 */
/** `lang` is the caller's: it passes `what` and `showAllLabel`, so it says which language they are in (English
 *  unless it says otherwise), and this card's own words follow it. */
export function ItemNotFound({ what, id, onShowAll, showAllLabel, lang = 'en' }: { what: string; id: string; onShowAll: () => void; showAllLabel: string; lang?: Lang }) {
  return (
    <div
      role="status"
      data-testid="item-not-found"
      style={{ display: 'grid', gap: 10, justifyItems: 'start', margin: '14px 0', padding: '14px 16px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--panel)' }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
        {what} <span style={{ fontFamily: 'var(--font-mono)' }}>{id}</span>{T.missingAfter[lang]}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        {T.missingDetail[lang]}
      </div>
      <Button data-testid="item-not-found-show-all" onClick={onShowAll}>{showAllLabel}</Button>
    </div>
  );
}
