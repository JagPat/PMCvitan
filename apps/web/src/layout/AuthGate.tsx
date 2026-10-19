import { TeamAccessScreen } from '@/screens/TeamAccessScreen';
import { Toast } from '@/components';
import { useStore } from '@/store/store';
import styles from './AuthGate.module.css';

/**
 * Full-screen sign-in gate. Rendered by AppShell when dev auth is off and there
 * is no real session, so the console is never reachable without signing in
 * (phone OTP / email OTP / password / worker tap; Google sign-in was removed, #827). Hosts the existing
 * TeamAccessScreen flow in a phone-shaped card centered on the canvas. A live build opens on the phone
 * number with the language row above it; until SMS is live the code arrives by email (#827).
 */
export function AuthGate() {
  const toast = useStore((s) => s.toast);
  return (
    <div className={styles.gate}>
      <div className={`drawing-grid ${styles.backdrop}`} />
      <div className={styles.card}>
        <TeamAccessScreen atGate />
      </div>
      {toast && <Toast message={toast} />}
    </div>
  );
}
