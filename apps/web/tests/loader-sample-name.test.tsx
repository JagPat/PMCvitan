import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { projectLoadingTitle } from '@vitan/shared';

/**
 * #953 (#482 6229527017, observation 3) — on a signed-in reload of /projects/qa-test-d135/dashboard the loader
 * briefly read "Loading Residence at Ambli…": the store started with the bundled sample project's name, and a
 * restore onto the project the URL already names keeps the identity fields until the snapshot lands. Against a
 * real API the store now starts with no project name, so the loader says only that the project is loading.
 */

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  globalThis.sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function reloadOn(path: string) {
  window.history.replaceState(null, '', path);
  const token = jwt({ sub: 'u-pmc', role: 'pmc', projectId: 'qa-test-d135', exp: Date.now() / 1000 + 3600 });
  globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token, role: 'pmc', name: 'QA PMC', projectId: 'qa-test-d135' }));
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore } = await import('@/store/store');
  expect(useStore.getState().restoreSession()).toBe(true);
  return useStore;
}

describe('#953 the loader never names the sample project', () => {
  it('a signed-in reload on the QA project shows a plain loading title, never "Residence at Ambli"', async () => {
    const useStore = await reloadOn('/projects/qa-test-d135/dashboard');
    const st = useStore.getState();
    expect(st.activeProjectId).toBe('qa-test-d135');
    expect(st.projectLoadState).toBe('loading');
    expect(st.short).toBe('');
    expect(st.name).toBe('');
    const { ProjectLoadBoundary } = await import('@/layout/ProjectLoadBoundary');
    const r = render(<ProjectLoadBoundary state="loading" error={null} label={st.short} onRetry={() => {}}><div /></ProjectLoadBoundary>);
    expect(r.getByTestId('project-switching')).toHaveTextContent('Loading the project…');
    expect(r.container.textContent).not.toMatch(/Ambli/);
  });

  it('a known project keeps its name in the title, in en, hi and gu', () => {
    expect(projectLoadingTitle('QA TEST', 'en')).toBe('Loading QA TEST…');
    expect(projectLoadingTitle('', 'en')).toBe('Loading the project…');
    expect(projectLoadingTitle('', 'hi')).toBe('प्रोजेक्ट खुल रहा है…');
    expect(projectLoadingTitle('', 'gu')).toBe('પ્રોજેક્ટ ખૂલી રહ્યો છે…');
  });

  it('the demo build (no API) still shows its sample project', async () => {
    vi.resetModules();
    const { useStore } = await import('@/store/store');
    expect(useStore.getState().short).toBe('Residence at Ambli');
  });
});
