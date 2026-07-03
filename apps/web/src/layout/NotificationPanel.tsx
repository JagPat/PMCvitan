import { useStore } from '@/store/store';
import styles from './NotificationPanel.module.css';

export function NotificationPanel() {
  const open = useStore((s) => s.notifOpen);
  const notifications = useStore((s) => s.notifications);
  const toggleNotif = useStore((s) => s.toggleNotif);

  if (!open) return null;

  return (
    <>
      <div className={styles.scrim} onClick={toggleNotif} />
      <div className={styles.panel} role="dialog" aria-label="Notifications">
        <div className={styles.label}>NOTIFICATIONS</div>
        <div className={styles.list}>
          {notifications.map((n, i) => (
            <div className={styles.item} key={i}>
              <span className={styles.dot} style={{ background: n.color }} />
              <div style={{ flex: 1 }}>
                <div className={styles.text}>{n.text}</div>
                <div className={styles.time}>{n.time}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
