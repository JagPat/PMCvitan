import { useEffect, useRef } from 'react';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleId {
  accounts: {
    id: {
      initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void;
      renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
    };
  };
}
declare global {
  interface Window {
    google?: GoogleId;
  }
}

function loadGsi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('gsi load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('gsi load failed'));
    document.head.appendChild(s);
  });
}

/**
 * "Continue with Google" (Google Identity Services). Renders nothing unless
 * VITE_GOOGLE_CLIENT_ID is set at build time — so the app degrades gracefully
 * when Google isn't configured. On sign-in it hands the ID token to `onToken`.
 */
export function GoogleSignInButton({ onToken }: { onToken: (idToken: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!CLIENT_ID || !ref.current) return;
    let cancelled = false;
    loadGsi()
      .then(() => {
        if (cancelled || !ref.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: (r) => onToken(r.credential),
        });
        window.google.accounts.id.renderButton(ref.current, { theme: 'outline', size: 'large', text: 'continue_with', width: 280 });
      })
      .catch(() => {
        /* offline / blocked — the other sign-in options still work */
      });
    return () => {
      cancelled = true;
    };
  }, [onToken]);

  if (!CLIENT_ID) return null;
  return <div ref={ref} style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }} />;
}
