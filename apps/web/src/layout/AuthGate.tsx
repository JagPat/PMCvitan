import { TeamAccessScreen } from '@/screens/TeamAccessScreen';
import { Toast } from '@/components';
import { useStore } from '@/store/store';
import styles from './AuthGate.module.css';

/**
 * Full-screen sign-in gate. Rendered by AppShell when dev auth is off and there
 * is no real session, so the console is never reachable without signing in
 * (phone OTP / email OTP / password / Google / worker tap). Hosts the existing
 * TeamAccessScreen flow in a phone-shaped card centered on the canvas.
 */
export function AuthGate() {
  const toast = useStore((s) => s.toast);
  return (
    <div className={styles.gate}>
      <div className={`drawing-grid ${styles.backdrop}`} />
      <div className={styles.card}>
        <TeamAccessScreen />
      </div>
      {toast && <Toast message={toast} />}
    </div>
  );
}
