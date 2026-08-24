import { useState } from 'react';
import { useStore } from '@/store/store';
import { useNavItems } from './useNavItems';
import { splitMobileNav } from '@/lib/mobileNav';
import { MoreSheet } from './MobileSheet';
import { MoreHorizontal } from '@/lib/icons';
import styles from './BottomTabs.module.css';

/**
 * Bottom tab bar — the primary navigation on mobile (<640px).
 *
 * The bar holds the four destinations a site day is actually navigated by — what needs me
 * (For You), when (Schedule), where (Places), which project (Portfolio) — and hands the rest
 * to "More". `splitMobileNav` is a presentation split over the ALREADY permission-filtered
 * list from `useNavItems`, so a role that lacks Schedule or Portfolio gets its own screens in
 * those slots and nothing a role cannot reach appears in either half.
 */
export function BottomTabs() {
  const items = useNavItems();
  const setScreen = useStore((s) => s.setScreen);
  const [moreOpen, setMoreOpen] = useState(false);
  const { primary, secondary } = splitMobileNav(items);
  // attention never hides behind More: the tab carries the overflow's badges, and it reads
  // "active" while any secondary screen is the one on stage
  const moreBadge = secondary.reduce((n, i) => n + i.badge, 0);
  const moreActive = secondary.some((i) => i.active);

  return (
    <>
      <nav className={styles.bar} data-testid="bottom-tabs">
        {primary.map((n) => (
          <button
            key={n.key}
            onClick={() => setScreen(n.key)}
            data-testid={`tab-${n.key}`}
            className={n.active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            aria-current={n.active ? 'page' : undefined}
          >
            <span className={styles.iconWrap}>
              <n.icon size={20} />
              {n.badge > 0 && <span className={styles.badge}>{n.badge}</span>}
            </span>
            <span className={styles.label}>{n.short}</span>
          </button>
        ))}
        {secondary.length > 0 && (
          <button
            onClick={() => setMoreOpen(true)}
            data-testid="tab-more"
            className={moreActive ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
          >
            <span className={styles.iconWrap}>
              <MoreHorizontal size={20} />
              {moreBadge > 0 && <span className={styles.badge}>{moreBadge}</span>}
            </span>
            <span className={styles.label}>More</span>
          </button>
        )}
      </nav>
      {moreOpen && <MoreSheet items={secondary} onClose={() => setMoreOpen(false)} />}
    </>
  );
}
