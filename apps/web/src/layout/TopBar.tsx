import { useState } from 'react';
import { useStore } from '@/store/store';
import { Bell, Power, ChevronDown } from '@/lib/icons';
import { ROLE_LABEL, ROLES } from '@/lib/screens';
import type { Role } from '@vitan/shared';
import { DEV_AUTH } from '@/data/apiGateway';
import { useProjectSwitch } from './useProjectSwitch';
import { LanguageSheet, ProjectSheet } from './MobileSheet';
import { LANG_SWITCH, shellLabels } from '@vitan/shared';
import logo from '@/assets/vitan-logo.jpeg';
import styles from './TopBar.module.css';

/**
 * Compact top bar — mobile only (<640px). Holds the ACTIVE PROJECT (the mobile equivalent of
 * the rail's `ProjectSwitcher`, and the fastest way to change project), the language, the persona
 * switch and the bell. The project name is the bar's primary text so "which site am I in?" is answered
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
  const lang = useStore((s) => s.lang);
  const [choosingLang, setChoosingLang] = useState(false);
  const current = LANG_SWITCH.find((l) => l.key === lang) ?? LANG_SWITCH[0];

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
        {/* every role, every screen: the language is one tap from anywhere on the phone */}
        <button
          className={styles.lang}
          data-testid="lang-switch"
          lang={current.key}
          onClick={() => setChoosingLang(true)}
          aria-haspopup="dialog"
          aria-expanded={choosingLang}
          aria-label={`${shellLabels.language[lang]}: ${current.name}`}
        >
          {current.mark}
        </button>
        {DEV_AUTH ? (
          // API-less deployments expose this demo selector to real users too.
          <label className={styles.selectWrap} data-testid="mobile-role-switcher">
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
      {choosingLang && <LanguageSheet onClose={() => setChoosingLang(false)} />}
    </header>
  );
}
