import { useStore } from '@/store/store';
import { useNavItems } from './useNavItems';
import { RolePicker } from './RolePicker';
import { Bell } from '@/lib/icons';
import { PROJECT } from '@vitan/shared';
import logo from '@/assets/vitan-logo.jpeg';
import styles from './LeftRail.module.css';

/** Persistent left rail — the primary navigation on tablet/desktop (>=640px). */
export function LeftRail() {
  const items = useNavItems();
  const setScreen = useStore((s) => s.setScreen);
  const toggleNotif = useStore((s) => s.toggleNotif);
  const notifCount = useStore((s) => s.notifications.length);

  return (
    <aside className={styles.rail}>
      <div className={styles.header}>
        <div className={styles.logoTile}>
          <img src={logo} alt="Vitan" />
        </div>
        <div>
          <div className={styles.brand}>VITAN</div>
          <div className={styles.brandSub}>PMC CONSOLE</div>
        </div>
      </div>

      <div className={styles.persona}>
        <RolePicker />
      </div>

      <nav className={`${styles.nav} vscroll`}>
        <div className={styles.navLabel}>SCREENS</div>
        {items.map((n) => (
          <button
            key={n.key}
            onClick={() => setScreen(n.key)}
            className={n.active ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <n.icon size={16} />
              {n.label}
            </span>
            {n.badge > 0 && <span className={n.active ? `${styles.badge} ${styles.badgeActive}` : styles.badge}>{n.badge}</span>}
          </button>
        ))}
      </nav>

      <div className={styles.footer}>
        <div>
          <div className={styles.projName}>{PROJECT.short}</div>
          <div className={styles.projMeta}>G+2 · FINISHING STAGE</div>
        </div>
        <button className={styles.bell} onClick={toggleNotif} aria-label="Notifications">
          <Bell size={16} />
          {notifCount > 0 && <span className={styles.bellDot}>{notifCount}</span>}
        </button>
      </div>
    </aside>
  );
}
