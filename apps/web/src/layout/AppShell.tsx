import { useStore } from '@/store/store';
import { Toast } from '@/components';
import { DEV_AUTH } from '@/data/apiGateway';
import { LeftRail } from './LeftRail';
import { TopBar } from './TopBar';
import { BottomTabs } from './BottomTabs';
import { NotificationPanel } from './NotificationPanel';
import { ModalHost } from './ModalHost';
import { ScreenView } from './ScreenView';
import { RouteBridge } from './RouteBridge';
import { ProjectLoadBoundary } from './ProjectLoadBoundary';
import { AuthGate } from './AuthGate';
import styles from './AppShell.module.css';

export function AppShell() {
  const toast = useStore((s) => s.toast);
  const sessionToken = useStore((s) => s.sessionToken);
  const projectLoadState = useStore((s) => s.projectLoadState);
  const projectLoadError = useStore((s) => s.projectLoadError);
  const retryProjectLoad = useStore((s) => s.retryProjectLoad);
  const short = useStore((s) => s.short);

  // Secure default: with dev auth off, require a real sign-in before the console.
  // The worker/mistri flows are terminal inside the gate (they never take a token).
  if (!DEV_AUTH && !sessionToken) return <AuthGate />;

  return (
    <div className={styles.shell}>
      <RouteBridge />
      <LeftRail />
      <div className={styles.main}>
        <TopBar />
        <main className={`${styles.stage} vscroll`}>
          <div className={`drawing-grid ${styles.backdrop}`} />
          <div className={styles.stageInner}>
            {/* On a project transition the previous project's records are ALREADY cleared;
                the boundary covers the gap until the new project's snapshot lands, and a
                failed transition shows a recoverable error — never stale records. */}
            <ProjectLoadBoundary state={projectLoadState} error={projectLoadError} label={short} onRetry={retryProjectLoad}>
              <ScreenView />
            </ProjectLoadBoundary>
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
