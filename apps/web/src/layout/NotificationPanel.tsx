import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { viewerIsDecider } from '@vitan/shared';
import { notificationLink, decisionsSliceSettled, type NotificationLink, type NotificationRecords } from '@/lib/notifications';
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
  const sessionUserId = useStore((s) => s.sessionUserId);
  // a decision is judged absent (or awaiting) only against a SETTLED slice: never while its read is in
  // flight or after it failed (a module read can fail while the snapshot that carried the notice
  // succeeds), nor while a committed command's reconcile is owed
  const decisionsSettled = useStore(decisionsSliceSettled);
  // Live bug 1 — the notice whose record could not be found, explained in place (by row index).
  const [explained, setExplained] = useState<number | null>(null);
  // a row index means nothing once the panel closes, or once the list itself changes (Codex
  // 4203960936: a realtime refresh can prepend or drop notices while the panel is open), so the
  // explanation is withdrawn rather than left under a different notice
  useEffect(() => {
    setExplained(null);
  }, [open, notifications]);

  // the decisions a notice may name, from the viewer's own slice only
  const records = useMemo<NotificationRecords>(
    () => ({
      decisions: decisions.map((d) => ({
        id: d.id,
        title: d.title,
        awaitsViewer: !d.draft && (d.status === 'pending' || d.status === 'change') && viewerIsDecider(d, role, sessionUserId),
      })),
      decisionsSettled,
    }),
    [decisions, role, sessionUserId, decisionsSettled],
  );

  if (!open) return null;

  const follow = (i: number, link: NotificationLink) => {
    if (link.missing || link.loading) setExplained(explained === i ? null : i);
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
                  aria-expanded={link.missing || link.loading ? explained === i : undefined}
                  onClick={() => follow(i, link)}
                  style={{ background: 'transparent', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
                >
                  {body}
                </button>
                {(link.missing || link.loading) && explained === i && (
                  // the record is gone or out of reach, or its list has not loaded: say which, and offer
                  // the screen it lives on
                  <div role="status" data-testid={link.missing ? 'notif-missing' : 'notif-loading'} className={styles.time} style={{ display: 'grid', gap: 8, padding: '0 14px 12px 32px' }}>
                    <span>
                      {link.missing
                        ? "The record this notification refers to isn't available. It may have been completed or removed."
                        : "This notification's record can't be checked yet — its list hasn't loaded. Try again in a moment."}
                    </span>
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
