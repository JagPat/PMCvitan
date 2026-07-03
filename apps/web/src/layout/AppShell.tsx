import { useStore } from '@/store/store';
import { Toast } from '@/components';
import { LeftRail } from './LeftRail';
import { TopBar } from './TopBar';
import { BottomTabs } from './BottomTabs';
import { NotificationPanel } from './NotificationPanel';
import { ModalHost } from './ModalHost';
import { ScreenView } from './ScreenView';
import { RouteBridge } from './RouteBridge';
import styles from './AppShell.module.css';

export function AppShell() {
  const toast = useStore((s) => s.toast);

  return (
    <div className={styles.shell}>
      <RouteBridge />
      <LeftRail />
      <div className={styles.main}>
        <TopBar />
        <main className={`${styles.stage} vscroll`}>
          <div className={`drawing-grid ${styles.backdrop}`} />
          <div className={styles.stageInner}>
            <ScreenView />
          </div>
        </main>
      </div>
      <BottomTabs />
      <NotificationPanel />
      <ModalHost />
      {toast && <Toast message={toast} />}
    </div>
  );
}
