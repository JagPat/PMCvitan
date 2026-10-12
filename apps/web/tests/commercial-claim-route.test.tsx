import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useStore, getInitialState } from '@/store/store';
import { CommercialScreen } from '@/screens/CommercialScreen';
import { parseLocation, pathForScreen } from '@/lib/screens';
import type { CommercialBillRow, CommercialView } from '@/store/commercial';

/**
 * Top 10 #3 gap 12b (#798) — a vendor claim is a record at `/commercial/<billId>`: the open claim IS the URL's
 * item, so it survives a reload, can be shared, and Back/Forward walk it. "Not found" is judged only against a
 * claim list that has just landed.
 */

const bundle = (): CommercialView => ({
  budget: { positions: [], openExceptions: 0 },
  cashForecast: {
    heads: [],
    totals: {
      budget: '0.00', committed: '0.00', receivedNotBilled: '0.00', awaitingCertification: '0.00',
      certifiedPayable: '0.00', approved: '0.00', paid: '0.00', exposure: '0.00', headroom: '0.00',
    },
    refreshedAt: null,
  },
  costHeads: [],
  attributions: [],
});
const bill = (id: string): CommercialBillRow => ({
  id, vendorId: 'v-1', vendorBillNumber: `V-${id}`, status: 'submitted',
  documentDate: '2026-08-20', statusChangedAt: '2026-08-21T00:00:00.000Z',
  statusReason: null, disputeReason: null, lifecycleVersion: 0,
  createdAt: '2026-08-20T00:00:00.000Z', createdById: 'u-1',
  versions: [{
    id: `ver-${id}`, version: 1, supersedesVersion: null, claimedAmount: '100.00', lines: [],
    createdAt: '2026-08-20T00:00:00.000Z', createdById: 'u-1',
    supersededAt: null, supersededById: null, supersedeReason: null, live: true,
  }],
});

let loadClaim: ReturnType<typeof vi.fn<(billId: string) => Promise<void>>>;
beforeEach(() => {
  useStore.setState(getInitialState());
  useStore.getState()._setGateway(null);
  loadClaim = vi.fn((_billId: string) => Promise.resolve());
  useStore.setState({
    role: 'pmc',
    screen: 'commercial',
    capabilities: ['commercial'],
    commercialView: bundle(),
    commercialLoad: 'ready',
    commercialBills: [bill('b-1'), bill('b-2')],
    commercialBillsLoad: 'ready',
    loadCommercialClaim: loadClaim,
    loadCommercialBills: vi.fn(() => Promise.resolve()),
  });
});
afterEach(cleanup);

describe('/commercial/<billId>', () => {
  it('parses and round-trips', () => {
    expect(parseLocation('/projects/ambli/commercial/b-1')).toEqual({ projectId: 'ambli', screen: 'commercial', item: 'b-1' });
    expect(pathForScreen('commercial', 'ambli', 'b-1')).toBe('/projects/ambli/commercial/b-1');
  });

  it('choosing a claim makes it the route item, and the open claim is read', () => {
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-b-2'));
    expect(useStore.getState().routeItem).toBe('b-2');
    expect(loadClaim).toHaveBeenCalledWith('b-2');
    // choosing it again re-reads it (the lifecycle about to be acted on is never stale)
    loadClaim.mockClear();
    fireEvent.click(r.getByTestId('commercial-claim-row-b-2'));
    expect(loadClaim).toHaveBeenCalledWith('b-2');
  });

  it('a routed claim opens on the claim workflow, is read, and stays open across tabs', () => {
    useStore.setState({ routeItem: 'b-1' });
    const r = render(<CommercialScreen />);
    expect(r.getByTestId('commercial-claims')).toBeTruthy();
    expect(r.queryByTestId('commercial-position')).toBeNull();
    expect(loadClaim).toHaveBeenCalledWith('b-1');
    fireEvent.click(r.getByTestId('commercial-tab-position'));
    expect(r.getByTestId('commercial-position')).toBeTruthy();
    expect(useStore.getState().routeItem).toBe('b-1');
    fireEvent.click(r.getByTestId('commercial-tab-certification'));
    expect(r.queryByTestId('commercial-claim-none')).toBeNull();
  });

  it('a claim the landed list does not hold is "not found"; a list still loading or failed is not judged', () => {
    useStore.setState({ routeItem: 'gone' });
    const r = render(<CommercialScreen />);
    expect(r.getByTestId('item-not-found').textContent).toContain('gone');
    expect(loadClaim).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId('item-not-found-show-all'));
    expect(useStore.getState().routeItem).toBeNull();
    cleanup();

    useStore.setState({ routeItem: 'b-new', commercialBillsLoad: 'loading' });
    const loading = render(<CommercialScreen />);
    expect(loading.getByTestId('commercial-record-loading')).toBeTruthy();
    expect(loading.queryByTestId('item-not-found')).toBeNull();
    cleanup();

    useStore.setState({ commercialBillsLoad: 'error' });
    const failed = render(<CommercialScreen />);
    expect(failed.getByTestId('commercial-record-unavailable')).toBeTruthy();
  });

  it('a claim the list already holds stays open while the list re-reads, or after a failed re-read', () => {
    for (const commercialBillsLoad of ['loading', 'error'] as const) {
      useStore.setState({ routeItem: 'b-1', commercialBillsLoad });
      const r = render(<CommercialScreen />);
      expect(r.queryByTestId('commercial-record-loading')).toBeNull();
      expect(r.queryByTestId('commercial-record-unavailable')).toBeNull();
      expect(r.getByTestId('commercial-claims')).toBeTruthy();
      expect(loadClaim).toHaveBeenCalledWith('b-1');
      cleanup();
    }
  });

  it('a cold link waits for its claim to be adopted before showing the workflow', () => {
    const r = render(<MemoryRouter initialEntries={['/projects/ambli/commercial/b-1']}><CommercialScreen /></MemoryRouter>);
    expect(r.getByTestId('commercial-record-opening')).toBeTruthy();
    expect(r.queryByTestId('commercial-claims')).toBeNull();
  });
});
