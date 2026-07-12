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
import { AuthGate } from './AuthGate';
import styles from './AppShell.module.css';

export function AppShell() {
  const toast = useStore((s) => s.toast);
  const sessionToken = useStore((s) => s.sessionToken);
  const projectSwitching = useStore((s) => s.projectSwitching);
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
            {/* On a project switch the previous project's records are cleared; this covers the
                brief gap until the new project's snapshot lands, so no stale data ever shows. */}
            {projectSwitching ? (
              <div data-testid="project-switching" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '80px 16px' }}>
                <div style={{ fontWeight: 600, color: 'var(--ink)' }}>Loading {short}…</div>
                <div style={{ marginTop: 6 }}>Fetching this project’s decisions, schedule and site data.</div>
              </div>
            ) : (
              <ScreenView />
            )}
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
