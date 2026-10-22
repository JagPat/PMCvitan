import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { Photo } from '@vitan/shared';
import { deleteEvidence, putEvidence } from '@/data/evidenceStore';
import { warmImports } from './warm-imports';

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/DashboardScreen'));

/**
 * #482 site photos — an evidence photo's upload lives in IndexedDB and comes back into the outbox only once that is
 * read after a reload. A Delete before then could be followed by the replay of an upload that already landed, which
 * would add the photo again (Codex 4322142028), so the Delete waits for the read and for the upload.
 */
async function load(photos: Photo[]) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready', short: 'Villa B' });
  useStore.setState({ role: 'pmc', lang: 'en', screen: 'dashboard', photos, timeZone: 'Asia/Kolkata', online: true } as never);
  const { DashboardScreen } = await import('@/screens/DashboardScreen');
  return { r: render(<DashboardScreen />), useStore };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('a Delete of an own evidence photo after a reload waits for its upload (#482)', () => {
  it('is refused before the evidence rows are read and while its row is pending, and goes once the upload has landed', async () => {
    // the upload landed on the server (its reply was lost), its row is still pending here, and its outbox op was lost
    await putEvidence({ userScope: 'anon', projectId: 'villa-b', clientKey: 'k-ev', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-1', inspectionItemId: 'item-1' });
    const photo: Photo = { id: 'ev', url: '/media/ev', kind: 'inspection', at: new Date().toISOString(), deletable: true, clientKey: 'k-ev' };
    const { r, useStore } = await load([photo]);
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true, dailyLogId: null });
    useStore.getState()._setGateway({ deleteMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as never);
    // the reload: the queue comes back from localStorage at once, the evidence rows later
    act(() => { useStore.getState().hydrateOutbox(); });
    expect(useStore.getState().outbox).toEqual([]);
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    await useStore.getState().deleteSitePhoto('ev');
    expect(deleteMedia).not.toHaveBeenCalled();
    // read: its row is pending, and its op is back in the queue
    await act(async () => { await useStore.getState().hydrateEvidence(); });
    expect(useStore.getState().pendingEvidenceKeys).toEqual(['k-ev']);
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    await useStore.getState().deleteSitePhoto('ev');
    expect(deleteMedia).not.toHaveBeenCalled();
    // the upload lands: its row and op go (as a flush does on the server's yes)
    await deleteEvidence('anon', 'villa-b', 'k-ev');
    await act(async () => { useStore.setState({ outbox: [] }); await useStore.getState().hydrateEvidence(); });
    expect(useStore.getState().pendingEvidenceKeys).toEqual([]);
    expect(r.getByTestId('site-photo-delete')).toBeTruthy();
    await useStore.getState().deleteSitePhoto('ev');
    expect(deleteMedia).toHaveBeenCalledWith('ev');
  });
});
