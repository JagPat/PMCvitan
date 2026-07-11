import { useStore } from '@/store/store';
import { notificationTarget } from '@/lib/notifications';
import { ChevronRight } from '@/lib/icons';
import styles from './NotificationPanel.module.css';

export function NotificationPanel() {
  const open = useStore((s) => s.notifOpen);
  const notifications = useStore((s) => s.notifications);
  const toggleNotif = useStore((s) => s.toggleNotif);
  const role = useStore((s) => s.role);
  // setScreen also closes the panel (it clears notifOpen), so a notification tap is one call.
  const setScreen = useStore((s) => s.setScreen);

  if (!open) return null;

  return (
    <>
      <div className={styles.scrim} onClick={toggleNotif} />
      <div className={styles.panel} role="dialog" aria-label="Notifications">
        <div className={styles.label}>NOTIFICATIONS</div>
        <div className={styles.list}>
          {notifications.map((n, i) => {
            const target = notificationTarget(n.text, role);
            const body = (
              <>
                <span className={styles.dot} style={{ background: n.color }} />
                <div style={{ flex: 1 }}>
                  <div className={styles.text}>{n.text}</div>
                  <div className={styles.time}>{n.time}</div>
                </div>
                {target && <ChevronRight size={15} style={{ alignSelf: 'center', opacity: 0.5, flex: 'none' }} />}
              </>
            );
            // A notification with a screen the role can reach becomes a one-tap jump to it —
            // the bell mirrors the "For You" queue. Others render as plain, non-interactive rows.
            return target ? (
              <button
                key={i}
                className={styles.item}
                data-testid="notif-item"
                onClick={() => setScreen(target)}
                style={{ background: 'transparent', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
              >
                {body}
              </button>
            ) : (
              <div className={styles.item} key={i}>{body}</div>
            );
          })}
        </div>
      </div>
    </>
  );
}
