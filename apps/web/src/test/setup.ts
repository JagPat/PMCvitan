import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { makeLockManager } from './lockManager';

// Every supported browser has the Web Locks API (`navigator.locks`); jsdom does not. The project-create
// reservation REFUSES to send without it (it is the only cross-tab serialization), so tests get a
// minimal per-name FIFO LockManager here — the same exclusive semantics within this one test document.
// As the browser's: the callback gets the lock, and an `ifAvailable` request that cannot be granted at once gets null
// (#917). Two store instances in one test share it, as two tabs share the browser's.
if (typeof navigator !== 'undefined' && !(navigator as Navigator & { locks?: unknown }).locks) {
  Object.defineProperty(navigator, 'locks', { value: makeLockManager(), configurable: true });
}

// xtab-drain redesign U2: a done fact (`vitan.done.*`) is the server's answer for one act's key on this phone. Test
// files reuse the same keys across rows that share one jsdom storage, so each row starts with none (a row that needs
// facts writes them itself)
beforeEach(() => {
  if (typeof localStorage !== 'undefined') {
    for (const name of Object.keys(localStorage)) if (name.startsWith('vitan.done.')) localStorage.removeItem(name);
  }
});
