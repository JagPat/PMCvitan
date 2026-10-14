import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { unreadCount } from '@/lib/notificationSeen';
import { BUILD_INFO } from '@/lib/buildInfo';
import { useShallow } from 'zustand/react/shallow';
import { useNavItems, type NavItem } from './useNavItems';
import { RolePicker } from './RolePicker';
import { ProjectSwitcher } from './ProjectSwitcher';
import { CreateRailButton } from './CreateControl';
import { LanguageSwitch } from './LanguageSwitch';
import { Bell, ChevronDown, MoreHorizontal, Power } from '@/lib/icons';
import { DEV_AUTH } from '@/data/apiGateway';
import { ROLE_LABEL } from '@/lib/screens';
import { navLabelFor, splitMobileNav } from '@/lib/mobileNav';
import { shellLabels } from '@vitan/shared';
import logo from '@/assets/vitan-logo.jpeg';
import styles from './LeftRail.module.css';

/** Persistent left rail — the primary navigation on tablet/desktop (>=640px).
 *  #482 QA item 2 (Jagrut, 14 Oct 2026): at most five main items per role, the rest under "More". The rail
 *  shows the same main items as the phone bar (`splitMobileNav`), so a person finds the same screens in the
 *  same order on both. "More" opens in place, and opens by itself when one of its screens is on stage. */
export function LeftRail() {
  const items = useNavItems();
  const setScreen = useStore((s) => s.setScreen);
  const toggleNotif = useStore((s) => s.toggleNotif);
  // Top 10 #4b unit D (#778) — the badge counts UNREAD notices (server `unread`, less this device's in-flight
  // and confirmed marks), not every notice
  const notifCount = useStore((s) => unreadCount(s.notifications, s.notifSeen));
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
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
  const { primary, secondary } = splitMobileNav(items, role);
  // attention never hides behind More: while it is closed it carries the badges of the screens inside it
  const moreBadge = secondary.reduce((n, i) => n + i.badge, 0);
  const activeMoreKey = secondary.find((i) => i.active)?.key;
  const moreActive = activeMoreKey !== undefined;
  const [moreOpen, setMoreOpen] = useState(moreActive);
  // a screen inside More reached another way (a link, a notice, the For You list) opens More to show it,
  // also when More was folded by hand while another screen inside it was on stage
  useEffect(() => {
    if (activeMoreKey) setMoreOpen(true);
  }, [activeMoreKey]);

  const navButton = (n: NavItem) => (
    <button
      key={n.key}
      onClick={() => setScreen(n.key)}
      aria-current={n.active ? 'page' : undefined}
      className={n.active ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <n.icon size={16} />
        {/* the rail follows the language switch above it: English keeps the full screen
            names, hi/gu read the same words as the phone's tab bar */}
        {lang === 'en' ? n.label : navLabelFor(n.key, role, lang)}
      </span>
      {n.badge > 0 && <span className={n.active ? `${styles.badge} ${styles.badgeActive}` : styles.badge}>{n.badge}</span>}
    </button>
  );

  return (
    <aside className={styles.rail} data-surface="ink">
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

      <div className={styles.persona} style={{ paddingTop: 4 }}>
        <LanguageSwitch />
      </div>

      {/* The DESKTOP create trigger. It cannot live in `TopBar`: that bar is display:none from
          640px upward, so a control mounted there is invisible at every desktop width. */}
      <div className={styles.persona} style={{ paddingTop: 4 }}>
        <CreateRailButton />
      </div>

      <nav className={`${styles.nav} vscroll`}>
        <div className={styles.navLabel}>{shellLabels.screens[lang]}</div>
        {primary.map(navButton)}
        {secondary.length > 0 && (
          <>
            <button
              data-testid="rail-more"
              onClick={() => setMoreOpen((open) => !open)}
              aria-expanded={moreOpen}
              aria-controls="rail-more-items"
              className={moreActive && !moreOpen ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <MoreHorizontal size={16} />
                {shellLabels.more[lang]}
              </span>
              {!moreOpen && moreBadge > 0 ? (
                <span className={styles.badge}>{moreBadge}</span>
              ) : (
                <ChevronDown size={14} style={{ transform: moreOpen ? 'rotate(180deg)' : undefined }} aria-hidden="true" />
              )}
            </button>
            {moreOpen && <div id="rail-more-items">{secondary.map(navButton)}</div>}
          </>
        )}
      </nav>

      <div className={styles.footer}>
        <div>
          <div className={styles.projName}>{activeName}</div>
          <div className={styles.projMeta}>{projMeta}</div>
          <div className={styles.projMeta} title={`Built ${BUILD_INFO.builtAt}`} data-testid="build-version">
            build {BUILD_INFO.commitShort}
          </div>
        </div>
        <button className={styles.bell} onClick={toggleNotif} aria-label="Notifications">
          <Bell size={16} />
          {notifCount > 0 && <span className={styles.bellDot}>{notifCount}</span>}
        </button>
      </div>
    </aside>
  );
}
