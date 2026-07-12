import { useStore } from '@/store/store';
import { useShallow } from 'zustand/react/shallow';
import { useNavItems } from './useNavItems';
import { RolePicker } from './RolePicker';
import { ProjectSwitcher } from './ProjectSwitcher';
import { Bell, Power } from '@/lib/icons';
import { DEV_AUTH } from '@/data/apiGateway';
import { ROLE_LABEL } from '@/lib/screens';
import logo from '@/assets/vitan-logo.jpeg';
import styles from './LeftRail.module.css';

/** Persistent left rail — the primary navigation on tablet/desktop (>=640px). */
export function LeftRail() {
  const items = useNavItems();
  const setScreen = useStore((s) => s.setScreen);
  const toggleNotif = useStore((s) => s.toggleNotif);
  const notifCount = useStore((s) => s.notifications.length);
  const role = useStore((s) => s.role);
  const userName = useStore((s) => s.userName);
  const signOut = useStore((s) => s.signOut);
  const memberships = useStore(useShallow((s) => s.memberships));
  const activeProjectId = useStore((s) => s.activeProjectId);
  // live project identity from the snapshot; the membership short is a fast label during a switch
  const short = useStore((s) => s.short);
  const descriptor = useStore((s) => s.descriptor);
  const stage = useStore((s) => s.stage);
  const activeName = memberships.find((m) => m.projectId === activeProjectId)?.short ?? short;
  const projMeta = [descriptor, stage].filter(Boolean).join(' · ') || '—';

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
        <ProjectSwitcher />
      </div>

      {DEV_AUTH ? (
        <div className={styles.persona} style={{ paddingTop: 4 }}>
          <RolePicker />
        </div>
      ) : (
        <div className={styles.persona} style={{ paddingTop: 4 }}>
          <div className={styles.signedInLabel}>SIGNED IN AS</div>
          <div className={styles.signedInName}>{userName ?? ROLE_LABEL[role]}</div>
          <button className={styles.signOut} onClick={signOut}>
            <Power size={13} /> Sign out
          </button>
        </div>
      )}

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
          <div className={styles.projName}>{activeName}</div>
          <div className={styles.projMeta}>{projMeta}</div>
        </div>
        <button className={styles.bell} onClick={toggleNotif} aria-label="Notifications">
          <Bell size={16} />
          {notifCount > 0 && <span className={styles.bellDot}>{notifCount}</span>}
        </button>
      </div>
    </aside>
  );
}
