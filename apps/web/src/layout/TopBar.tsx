import { useState } from 'react';
import { useStore } from '@/store/store';
import { Bell, Power, ChevronDown } from '@/lib/icons';
import { ROLE_LABEL } from '@/lib/screens';
import { DEV_AUTH } from '@/data/apiGateway';
import { useProjectSwitch } from './useProjectSwitch';
import { ProjectSheet } from './MobileSheet';
import type { Role } from '@vitan/shared';
import logo from '@/assets/vitan-logo.jpeg';
import styles from './TopBar.module.css';

const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor'];

/**
 * Compact top bar — mobile only (<640px). Holds the ACTIVE PROJECT (the mobile equivalent of
 * the rail's `ProjectSwitcher`, and the fastest way to change project), the persona switch and
 * the bell. The project name is the bar's primary text so "which site am I in?" is answered
 * without navigating; it truncates with an ellipsis rather than pushing the controls off-screen.
 */
export function TopBar() {
  const role = useStore((s) => s.role);
  const setRole = useStore((s) => s.setRole);
  const signOut = useStore((s) => s.signOut);
  const toggleNotif = useStore((s) => s.toggleNotif);
  const notifCount = useStore((s) => s.notifications.length);
  const { label, canSwitch } = useProjectSwitch();
  const [switching, setSwitching] = useState(false);

  return (
    <header className={styles.bar}>
      <div className={styles.brandWrap}>
        <div className={styles.logoTile}>
          <img src={logo} alt="Vitan" />
        </div>
        <button
          className={styles.project}
          data-testid="mobile-project-switcher"
          onClick={() => canSwitch && setSwitching(true)}
          disabled={!canSwitch}
          aria-haspopup={canSwitch ? 'dialog' : undefined}
          aria-expanded={canSwitch ? switching : undefined}
          aria-label={canSwitch ? `Project: ${label} — switch project` : `Project: ${label}`}
        >
          <span className={styles.projectName}>{label}</span>
          {canSwitch && <ChevronDown size={15} className={styles.projectChevron} />}
        </button>
      </div>
      <div className={styles.right}>
        {DEV_AUTH ? (
          <label className={styles.selectWrap}>
            <span className={styles.viewingAs}>as</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={styles.select} aria-label="Viewing as">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <button className={styles.bell} onClick={signOut} aria-label="Sign out">
            <Power size={16} />
          </button>
        )}
        <button className={styles.bell} onClick={toggleNotif} aria-label="Notifications">
          <Bell size={16} />
          {notifCount > 0 && <span className={styles.bellDot}>{notifCount}</span>}
        </button>
      </div>
      {switching && <ProjectSheet onClose={() => setSwitching(false)} />}
    </header>
  );
}
