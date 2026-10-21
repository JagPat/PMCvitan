import { type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { QW } from '@/lib/queueWords';

/**
 * WEB-02 (#792): this phone holds saved updates for this project that it cannot read. They are never written over;
 * one tap copies them aside (kept on this phone) and lets new updates be saved again. Updates a newer release saved
 * are read by that release, so the person is asked to reload; the reload runs only on their tap, and asks first while
 * updates are not kept (#1037 r1 re-check N1). They are not set aside until a reload of this same build has met them
 * still unreadable: the newer release is not to be had here (or the kind is damaged), so Set aside is offered for them
 * too, in words of their own (re-check N2).
 */
export function QueueUnreadable() {
  const listed = useStore((s) => s.queueUnreadable);
  const setAside = useStore((s) => s.setAsideUnreadableQueue);
  const requestReload = useStore((s) => s.requestReload);
  const lang = useStore((s) => s.lang);
  if (!listed) return null;
  const newer = listed.newer ?? [];
  const reloaded = listed.reloaded ?? [];
  // the keys Set aside can move: every listed key but a newer release's a reload has not yet met
  const rest = listed.keys.filter((k) => !newer.includes(k));
  const settable = rest.length > 0 || reloaded.length > 0;
  return (
    <div role="alert" style={strip} data-testid="queue-unreadable">
      {newer.some((k) => !reloaded.includes(k)) && <span data-testid="queue-newer">{QW.newerRelease[lang]}</span>}
      {reloaded.length > 0 && <span data-testid="queue-newer-reloaded">{QW.newerReloaded[lang]}</span>}
      {/* a key listed again only because a draft in it could not be copied aside reads fine: it is not called unreadable */}
      {rest.length > 0 && <span>{(rest.every((k) => listed.readable?.includes(k)) ? QW.notSetAside : QW.unreadable)[lang]}</span>}
      {listed.failed && <span data-testid="queue-unreadable-failed">{QW.setAsideFailed[lang]}</span>}
      {newer.length > 0 && <button type="button" style={button} onClick={requestReload}>{QW.reload[lang]}</button>}
      {settable && <button type="button" style={button} onClick={setAside}>{QW.setAside[lang]}</button>}
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
