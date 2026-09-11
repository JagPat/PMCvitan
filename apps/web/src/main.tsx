import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/global.css';
import './i18n/i18n';
import { App } from './App';
import { useStore } from './store/store';
import { DEV_AUTH } from './data/apiGateway';

// Rehydrate any mutations queued offline in a previous session (Phase 8 outbox).
useStore.getState().hydrateOutbox();

/**
 * Wave 0 / F-1b — #584 review round 12, finding 2: THE STATES A DEMO BUILD CANNOT REACH.
 *
 * The cross-surface action-target sweep walks every persona and every surface, and until now it
 * only ever rendered the API-LESS demo state: `members`, `orgMembers` and `failedEvidence` are
 * initialised empty, so every control that exists only when a project HAS members, or when an
 * evidence upload has FAILED, was never on screen for the sweep to measure. Three rounds of
 * findings have now been of that shape, and each round I made one more state reachable and left
 * the category — which is why this is a mechanism rather than another one-off.
 *
 * It is a DEV affordance and cannot exist in a real deployment: `DEV_AUTH` is false whenever an
 * API base is configured without `VITE_ALLOW_DEV_AUTH`, which is every deployed build. It writes
 * store state only — it cannot mint a session, reach the gateway, or bypass any server check —
 * so the worst a hostile caller could do in a dev build is render their own browser a lie.
 *
 * The alternative considered and rejected: pointing the e2e at a stubbed API. That exercises the
 * real read path and is the better test, but the Playwright `webServer` is shared by every spec,
 * so giving it an API base would make all the existing demo-mode specs start calling one. That is
 * a larger change than this unit should carry, and it is written down here rather than silently
 * not done.
 */
if (DEV_AUTH) {
  (window as unknown as { __vitanDevSeed?: (patch: Record<string, unknown>) => void }).__vitanDevSeed =
    (patch) => useStore.setState(patch as never);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// Register the PWA service worker (installable + offline app shell).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* no-op: the app works fine without the SW */
    });
  });
}
