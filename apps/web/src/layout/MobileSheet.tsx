import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '@/store/store';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useProjectSwitch } from './useProjectSwitch';
import { CreateProjectModal } from './ProjectSwitcher';
import { Check, Plus, X, LayoutGrid } from '@/lib/icons';
import { ROLE_LABEL } from '@/lib/screens';
import { navLabelFor } from '@/lib/mobileNav';
import { noteLangChoice } from '@/lib/langPreference';
import { LANG_SWITCH, shellLabels } from '@vitan/shared';
import { useNavItems, type NavItem } from './useNavItems';
import styles from './MobileSheet.module.css';

/**
 * Bottom sheet — the mobile disclosure surface for the secondary navigation and the
 * project switcher. A sheet rises from the thumb rather than a centred dialog, is capped
 * at 78dvh so it never fills the screen, and respects the bottom safe-area inset.
 * Dialog semantics (focus trap, Escape, click-outside) match the app's `Modal`.
 */
export function MobileSheet({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const titleId = `sheet-title-${title.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-surface="light"
        data-testid={testId}
        className={styles.sheet}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.grabber} />
        <div className={styles.head}>
          <span id={titleId} className={styles.title}>{title}</span>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            <X size={19} />
          </button>
        </div>
        <div className={`${styles.body} vscroll`}>{children}</div>
      </div>
    </div>
  );
}

/**
 * "More" — the secondary navigation. Its contents are the OVERFLOW of the already
 * permission-filtered nav (`useNavItems` → `enabledScreensFor`), so role permissions,
 * enabled modules and per-project capabilities gate it exactly as the bottom bar and the
 * desktop rail. Nothing is added here that the role could not already reach.
 */
export function MoreSheet({ items, onClose }: { items: NavItem[]; onClose: () => void }) {
  const setScreen = useStore((s) => s.setScreen);
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  return (
    <MobileSheet title={shellLabels.more[lang]} onClose={onClose} testId="more-sheet">
      {items.map((n) => (
        <button
          key={n.key}
          data-testid={`more-item-${n.key}`}
          className={n.active ? `${styles.row} ${styles.rowActive}` : styles.row}
          aria-current={n.active ? 'page' : undefined}
          onClick={() => {
            setScreen(n.key);
            onClose();
          }}
        >
          <n.icon size={18} />
          {/* English keeps the full screen name; hi/gu read the same word the tab bar uses */}
          <span className={styles.rowLabel}>{lang === 'en' ? n.label : navLabelFor(n.key, role, lang)}</span>
          {n.badge > 0 && <span className={styles.rowBadge}>{n.badge}</span>}
        </button>
      ))}
      {items.length === 0 && <div className={styles.note}>Everything you can reach is already on the bar.</div>}
    </MobileSheet>
  );
}

/**
 * The mobile project switcher. One of the two valid project-access mechanisms (the other is
 * the Portfolio screen, which this links to rather than replaces). It reuses `useProjectSwitch`
 * — the same memberships and the same `switchProject` the desktop rail uses — so the project
 * scope, the snapshot transition and the project-scoped URL all update through one path.
 */
export function ProjectSheet({ onClose }: { onClose: () => void }) {
  const { memberships, activeProjectId, adminOrg, switchProject } = useProjectSwitch();
  const setScreen = useStore((s) => s.setScreen);
  const [creating, setCreating] = useState(false);
  // Portfolio is a pmc-only screen (`screensFor`), so offering it unconditionally would
  // advertise a destination `RouteBridge` immediately bounces — mounting PortfolioScreen and
  // starting its load before redirecting the user home. Same permission source as the nav.
  const canOpenPortfolio = useNavItems().some((n) => n.key === 'portfolio');

  if (creating && adminOrg) return <CreateProjectModal orgId={adminOrg.id} onClose={onClose} />;

  return (
    <MobileSheet title="Switch project" onClose={onClose} testId="project-sheet">
      {memberships.map((m) => {
        const on = m.projectId === activeProjectId;
        return (
          <button
            key={m.projectId}
            data-testid={`project-sheet-${m.projectId}`}
            className={on ? `${styles.row} ${styles.rowActive}` : styles.row}
            aria-current={on ? 'true' : undefined}
            onClick={() => {
              onClose();
              // no-ops in the store when it is already the active project
              switchProject(m.projectId);
            }}
          >
            <span className={styles.rowLabel}>{m.short}</span>
            <span className={styles.rowMeta}>{ROLE_LABEL[m.role]}</span>
            {on && <Check size={16} color="#3f7d55" />}
          </button>
        );
      })}
      {canOpenPortfolio && (
        <button
          className={styles.row}
          data-testid="project-sheet-portfolio"
          onClick={() => {
            setScreen('portfolio');
            onClose();
          }}
        >
          <LayoutGrid size={18} />
          <span className={styles.rowLabel}>All projects (Portfolio)</span>
        </button>
      )}
      {adminOrg && (
        <button className={styles.row} data-testid="project-sheet-new" onClick={() => setCreating(true)} style={{ color: 'var(--accent)' }}>
          <Plus size={18} />
          <span className={styles.rowLabel}>New project</span>
        </button>
      )}
    </MobileSheet>
  );
}

/**
 * The phone's language picker. Each language is written in its own script, so a reader finds
 * theirs without reading the others; the current one is marked with a check AND `aria-pressed`,
 * never colour alone. Choosing one applies it at once and closes the sheet.
 */
export function LanguageSheet({ onClose }: { onClose: () => void }) {
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  return (
    <MobileSheet title={shellLabels.language[lang]} onClose={onClose} testId="language-sheet">
      {LANG_SWITCH.map((l) => {
        const on = l.key === lang;
        return (
          <button
            key={l.key}
            lang={l.key}
            data-testid={`lang-option-${l.key}`}
            className={on ? `${styles.row} ${styles.rowActive}` : styles.row}
            aria-pressed={on}
            onClick={() => {
              noteLangChoice(l.key);
              setLang(l.key);
              onClose();
            }}
          >
            <span className={styles.rowLabel}>{l.name}</span>
            {on && <Check size={18} aria-hidden="true" />}
          </button>
        );
      })}
    </MobileSheet>
  );
}
