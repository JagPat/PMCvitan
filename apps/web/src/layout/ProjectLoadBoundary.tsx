import type { ReactNode } from 'react';
import { Button } from '@/components';
import { projectLoadLabels as L, projectLoadingTitle } from '@vitan/shared';
import { projectDataUsable, type ProjectLoadState } from '@/store/projectScope';
import { useStore } from '@/store/store';

interface ProjectLoadBoundaryProps {
  state: ProjectLoadState;
  error: string | null;
  /** the project we're transitioning to / loading — for the loading label */
  label: string;
  onRetry: () => void;
  children: ReactNode;
}

/**
 * Renders project screens ONLY when their data is trustworthy (Phase 0 Task 3):
 *  - 'switching' / 'loading' → a stable full-content loading state (the project
 *    data underneath is already empty, so nothing stale can flash);
 *  - 'error' → a recoverable error with Retry, never records from a prior project;
 *  - 'idle' (local demo / pre-fetch) or 'ready' (snapshot applied) → the screens.
 */
export function ProjectLoadBoundary({ state, error, label, onRetry, children }: ProjectLoadBoundaryProps) {
  // `projectDataUsable` is the single authority (see its doc comment): it decides here whether
  // screens render, and it decides in the shell whether a control mounted OUTSIDE this boundary
  // may be shown or submitted. An earlier arrangement listed the states twice, which is how the
  // two could disagree about a state added later.
  const lang = useStore((s) => s.lang);
  if (projectDataUsable(state)) return <>{children}</>;

  if (state === 'error') {
    return (
      <div data-testid="project-load-error" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '80px 16px' }}>
        <div style={{ fontWeight: 600, color: 'var(--red-solid)' }}>{L.failed[lang]}</div>
        {/* The store's load error is English server/transport text; in Hindi or Gujarati the fixed
            advice line is shown instead of it (#827). */}
        <div style={{ marginTop: 6 }}>{lang === 'en' ? error ?? L.failedDetail.en : L.failedDetail[lang]}</div>
        <div style={{ marginTop: 16 }}>
          <Button variant="ink" onClick={onRetry} data-testid="project-load-retry">{L.retry[lang]}</Button>
        </div>
      </div>
    );
  }

  // 'switching' / 'loading' — the project data underneath is already empty, so nothing stale
  // can flash behind this.
  return (
    <div data-testid="project-switching" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '80px 16px' }}>
      <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{projectLoadingTitle(label, lang)}</div>
      <div style={{ marginTop: 6 }}>{L.loadingDetail[lang]}</div>
    </div>
  );
}
