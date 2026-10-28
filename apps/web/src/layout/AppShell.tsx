import { useStore } from '@/store/store';
import { Toast, ReturnToPlace } from '@/components';
import { DEV_AUTH } from '@/data/apiGateway';
import { LeftRail } from './LeftRail';
import { TopBar } from './TopBar';
import { BottomTabs } from './BottomTabs';
import { NotificationPanel } from './NotificationPanel';
import { ModalHost } from './ModalHost';
import { CreateControl } from './CreateControl';
import { ScreenView } from './ScreenView';
import { RouteBridge } from './RouteBridge';
import { ProjectLoadBoundary } from './ProjectLoadBoundary';
import { QueueUnreadable } from './QueueUnreadable';
import { AuthGate } from './AuthGate';
import { LangPreference } from './LangPreference';
import { GuideHost } from '@/guide/GuideHost';
import { HelpRow } from '@/guide/Help';
import { Welcome } from '@/guide/Welcome';
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
      <LangPreference />
      <LeftRail />
      <div className={styles.main}>
        <TopBar />
        <main className={`${styles.stage} vscroll`}>
          <div className={`drawing-grid ${styles.backdrop}`} />
          <div className={styles.stageInner}>
            <QueueUnreadable />
            {/* #482 — Help on every screen of every project, and "Guide me" where this screen has a guide */}
            <HelpRow />
            {/* #482 — the first-time welcome, once per person, once the project's data is on screen */}
            <Welcome />
            {/* On a project transition the previous project's records are ALREADY cleared;
                the boundary covers the gap until the new project's snapshot lands, and a
                failed transition shows a recoverable error — never stale records. */}
            <ProjectLoadBoundary state={projectLoadState} error={projectLoadError} label={short} onRetry={retryProjectLoad}>
              <ReturnToPlace />
              <ScreenView />
            </ProjectLoadBoundary>
          </div>
        </main>
      </div>
      <BottomTabs />
      {/* Unit C1 — the universal create control. Mounted in the shell so it is reachable from
          every screen; it gates ITSELF on project-load state, because the shell is outside
          `ProjectLoadBoundary` and nothing here unmounts it during a transition. */}
      <CreateControl />
      {/* #482 — coach marks over the live screen; "Guide me" and Help sit in the stage above */}
      <GuideHost />
      <NotificationPanel />
      <ModalHost />
      {toast && <Toast message={toast} />}
    </div>
  );
}
