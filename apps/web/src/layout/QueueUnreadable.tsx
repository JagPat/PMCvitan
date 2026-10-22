import { type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { QW } from '@/lib/queueWords';

/**
 * WEB-02 step A (#792): this phone holds saved updates for this project that this version cannot read. They are never
 * written over or sent, and the strip says so: a newer version's updates in their own words, damaged ones in theirs.
 * It offers no action on them yet (Reload and Set aside are step A2's).
 */
export function QueueUnreadable() {
  const listed = useStore((s) => s.queueUnreadable);
  const lang = useStore((s) => s.lang);
  if (listed.length === 0) return null;
  return (
    <div role="alert" style={strip} data-testid="queue-unreadable">
      {listed.some((u) => u.read === 'newer') && <span data-testid="queue-newer">{QW.newerRelease[lang]}</span>}
      {listed.some((u) => u.read === 'damaged') && <span>{QW.unreadable[lang]}</span>}
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
