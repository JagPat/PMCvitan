import { useStore } from '@/store/store';
import { useNavItems } from './useNavItems';
import styles from './BottomTabs.module.css';

/** Bottom tab bar — the primary navigation on mobile (<640px). */
export function BottomTabs() {
  const items = useNavItems();
  const setScreen = useStore((s) => s.setScreen);

  return (
    <nav className={styles.bar}>
      {items.map((n) => (
        <button
          key={n.key}
          onClick={() => setScreen(n.key)}
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
    </nav>
  );
}
