import { type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { QW } from '@/lib/queueWords';
import { settable } from '@/store/queueUnreadable';

/**
 * WEB-02 step 2 (#792): this phone holds saved updates for this project that this version cannot read. They are never
 * written over or sent. A newer version's updates are offered Reload, which runs only on the tap; once a reload of this
 * same build still cannot read them, they are offered Set aside, in words of their own. Damaged updates are offered Set
 * aside at once: one tap copies them aside (they stay on this phone) and lets new updates be saved again. Set aside is
 * offered only when every listed key may be set aside, as it sets them all aside or none.
 */
export function QueueUnreadable() {
  const listed = useStore((s) => s.queueUnreadable);
  const failed = useStore((s) => s.queueSetAsideFailed);
  const setAside = useStore((s) => s.setAsideUnreadableQueue);
  const reload = useStore((s) => s.reloadForNewerQueue);
  const lang = useStore((s) => s.lang);
  if (listed.length === 0) return null;
  const newer = listed.filter((u) => u.read === 'newer');
  return (
    <div role="alert" style={strip} data-testid="queue-unreadable">
      {newer.some((u) => !u.reloaded) && <span data-testid="queue-newer">{QW.newerRelease[lang]}</span>}
      {newer.some((u) => u.reloaded) && <span data-testid="queue-newer-reloaded">{QW.newerReloaded[lang]}</span>}
      {listed.some((u) => u.read === 'damaged') && <span>{QW.unreadable[lang]}</span>}
      {failed && <span data-testid="queue-unreadable-failed">{QW.setAsideFailed[lang]}</span>}
      {newer.some((u) => !u.reloaded) && <button type="button" style={button} onClick={reload}>{QW.reload[lang]}</button>}
      {listed.every(settable) && <button type="button" style={button} onClick={setAside}>{QW.setAside[lang]}</button>}
    </div>
  );
}

const strip: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
  padding: '8px 10px',
  border: '1px solid var(--hairline-strong)',
  borderRadius: 8,
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
};
const button: CSSProperties = {
  minHeight: 44,
  padding: '6px 10px',
  border: '1px solid var(--hairline-strong)',
  borderRadius: 8,
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
