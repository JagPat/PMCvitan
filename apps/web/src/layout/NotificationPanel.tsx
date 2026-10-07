import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { notificationLink, type NotificationLink, type NotificationRecords } from '@/lib/notifications';
import { SCREEN_META } from '@/lib/screens';
import { ChevronRight } from '@/lib/icons';
import styles from './NotificationPanel.module.css';

export function NotificationPanel() {
  const open = useStore((s) => s.notifOpen);
  const notifications = useStore((s) => s.notifications);
  const toggleNotif = useStore((s) => s.toggleNotif);
  const role = useStore((s) => s.role);
  // openItem also closes the panel (it clears notifOpen), so a notification tap is one call.
  const openItem = useStore((s) => s.openItem);
  const decisions = useStore(useShallow((s) => s.decisions));
  const reviews = useStore(useShallow((s) => s.reviews));
  const openChecklists = useStore(useShallow((s) => s.openChecklists));
  // Live bug 1 — the notice whose record could not be found, explained in place (by row index).
  const [explained, setExplained] = useState<number | null>(null);
  // a row index means nothing once the panel closes (the list may change before it reopens)
  useEffect(() => {
    if (!open) setExplained(null);
  }, [open]);

  // the records a notice may name, from the viewer's own slices only
  const records = useMemo<NotificationRecords>(
    () => ({
      decisions,
      inspections: [...reviews, ...openChecklists].map((i) => ({ id: i.id, title: i.title, zone: i.zone })),
    }),
    [decisions, reviews, openChecklists],
  );

  if (!open) return null;

  const follow = (i: number, link: NotificationLink) => {
    if (link.missing) setExplained(explained === i ? null : i);
    else openItem(link.screen, link.item);
  };

  return (
    <>
      <div className={styles.scrim} onClick={toggleNotif} />
      <div className={styles.panel} role="dialog" aria-label="Notifications">
        <div className={styles.label}>NOTIFICATIONS</div>
        <div className={styles.list}>
          {notifications.map((n, i) => {
            const link = notificationLink(n, role, records);
            const body = (
              <>
                <span className={styles.dot} style={{ background: n.color }} />
                <div style={{ flex: 1 }}>
                  <div className={styles.text}>{n.text}</div>
                  <div className={styles.time}>{n.time}</div>
                </div>
                {link && <ChevronRight size={15} style={{ alignSelf: 'center', opacity: 0.5, flex: 'none' }} />}
              </>
            );
            // A notification about a record opens THAT record (live bug 1); one about a screen the
            // role can reach opens the screen. Others render as plain, non-interactive rows.
            if (!link) return <div className={styles.item} key={i}>{body}</div>;
            return (
              <div key={i}>
                <button
                  className={styles.item}
                  data-testid="notif-item"
                  aria-expanded={link.missing ? explained === i : undefined}
                  onClick={() => follow(i, link)}
                  style={{ background: 'transparent', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
                >
                  {body}
                </button>
                {link.missing && explained === i && (
                  // the record is gone or out of reach: say so, and offer the screen it lived on
                  <div role="status" data-testid="notif-missing" className={styles.time} style={{ display: 'grid', gap: 8, padding: '0 14px 12px 32px' }}>
                    <span>The record this notification refers to isn't available. It may have been completed or removed.</span>
                    <button
                      data-testid="notif-missing-open"
                      onClick={() => openItem(link.screen, null)}
                      style={{ justifySelf: 'start', minHeight: 44, padding: '0 12px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}
                    >
                      Open {SCREEN_META[link.screen].label}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
