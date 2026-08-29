import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useStore } from '@/store/store';
import { API_BASE, DEV_AUTH, ApiGateway } from './apiGateway';
import { subscribeToPush } from './push';
import { jwtSub } from '@/lib/jwt';

/**
 * When `VITE_API_URL` is configured: authenticate for the active session, inject
 * the gateway into the store (so mutations persist through the API), hydrate
 * from the snapshot, and open a realtime socket — any change another user makes
 * pushes a `changed` signal and this client refetches its own snapshot.
 *
 * Auth source, in order:
 *   1. a real session token (set by a phone/email-OTP or password sign-in) — used directly;
 *   2. else, when `DEV_AUTH` is on, passwordless dev auth for the active role (demo persona switch);
 *   3. else (secure default) no auth — the gateway is still injected so the
 *      sign-in screen can call the public `/auth/*` endpoints; the snapshot fetch
 *      401s harmlessly and the app shows the seeded local data behind the gate
 *      until a real sign-in supplies a token.
 * Re-runs when the role or token changes.
 *
 * A no-op when the env var is unset: the app runs entirely on the seeded local store.
 */
export function useApiSync(): void {
  const role = useStore((s) => s.role);
  const token = useStore((s) => s.sessionToken);
  const activeProjectId = useStore((s) => s.activeProjectId);

  useEffect(() => {
    if (!API_BASE) return;
    let cancelled = false;
    let socket: Socket | null = null;
    const gw = new ApiGateway(API_BASE, activeProjectId);

    const refresh = () => {
      // gate round 11: every snapshot pull — the initial load, a retry, and every
      // socket `changed` ping — routes through the store's central coordinator. It
      // captures the ordering lease + scope, surfaces the loading state on a
      // non-`ready` load (stale-while-revalidate on a background refresh), applies
      // through the single ordered entry point (so a reply that lands after a switch
      // or sign-in is dropped, and a newer owner wins), coalesces concurrent pulls,
      // and surfaces the recoverable error state itself. The `cancelled` closure is
      // no longer needed for correctness here — a torn-down effect's scope is
      // superseded/scope-moved by the coordinator — but still gates the socket
      // handler below so we don't schedule a pull after unmount.
      useStore.getState().requestFreshSnapshot();
      // Phase 3 Task 7 — keep the pilot Materials bundle fresh on the same pings (a no-op off-pilot,
      // gated by the `materials` capability). The initial call before the shell loads is a no-op; the
      // shell load then triggers the first real fetch, and subsequent `changed` pings refresh it.
      useStore.getState().loadMaterials();
      // Phase 4 Task 6 (Codex round 2) — the Labour bundle is module-query-only (never in the
      // snapshot), so another client's allocation/muster/revision would leave `labourView` and the
      // Labour/Inbox badges stale without this. Same discipline as materials: a no-op off-pilot.
      useStore.getState().loadLabour();
      // Phase 5 Task 7B-i (Codex F1) — the Commercial bundle is module-query-only too, so another
      // client's budget revision, PO issue, certification or payment would leave the money position
      // and the cash forecast stale until someone pressed Refresh. Same discipline: no-op off-pilot.
      void useStore.getState().loadCommercial();
      // Task 7B-ii — and the claim surfaces an accountant currently has open.
      //
      // Codex G2 — the claim LIST too, once it has been OPENED. The first version skipped it on the
      // grounds that "a ping is not evidence anyone is looking at it". True before the tab is
      // opened, false after: a list already on screen silently missed a claim another user recorded,
      // and showed stale statuses, until a full page reload. `billsLoad !== 'idle'` is the honest
      // test — it means this scope has fetched the list, which is exactly "someone opened it".
      if (useStore.getState().commercialBillsLoad !== 'idle') {
        void useStore.getState().loadCommercialBills();
      }
      // 7B-vi — and the ADVANCES, by the identical `!== 'idle'` test and for a sharper reason.
      // A stale claim list shows old statuses; a stale advances list is what the Pay control reads
      // to decide the counterparty's position is KNOWN. Two clients, one empty ready list: user B
      // pays, user A still sees nothing owed, and appends a second cash advance against a position
      // that moved. Append-only, no server ceiling — nothing downstream catches it.
      if (useStore.getState().commercialAdvancesLoad !== 'idle') {
        void useStore.getState().loadCommercialAdvances();
      }
      // Codex G3 — INTENT, not results. Keying the refresh on `commercialClaims` (the map of
      // ARRIVED lifecycles) misses a claim whose FIRST read is still in flight: the ping lands
      // before the response, there is no key yet, no follow-up is scheduled, and the in-flight
      // response — snapshotted before the payment committed — then lands as `ready` with a stale
      // `approvable` and no warning. `commercialClaimLoad` carries the loading and error keys too,
      // so the union is every claim the user has asked for. Re-reading an in-flight one is safe and
      // correct: the per-claim token makes the newer read own the slot and drops the older answer.
      const commercial = useStore.getState();
      for (const billId of new Set([
        ...Object.keys(commercial.commercialClaims),
        ...Object.keys(commercial.commercialClaimLoad),
      ])) {
        void useStore.getState().loadCommercialClaim(billId);
      }
      // …and every open LINE register. Round 3: without this, the money bundle, the claim list and
      // the claims all refreshed on a realtime change while a cached `measured=0 / authority=10`
      // register kept authorising writes another engineer had just consumed — the tab held the one
      // number the caps are computed from, and it was the one number nothing refreshed.
      for (const lineId of new Set([
        ...Object.keys(commercial.commercialLineRegisters),
        ...Object.keys(commercial.commercialLineRegisterLoad),
      ])) {
        void useStore.getState().loadCommercialLineRegister(lineId);
      }
    };

    (async () => {
      if (token) gw.setToken(token);
      else if (DEV_AUTH) {
        const issued = await gw.connect(role);
        // round-7 Codex F3 — dev-auth issues its JWT inside the gateway, but every audience
        // predicate (the decider queue, visibility mirrors, the approval route) keys on the
        // store's `sessionUserId`. Record the issued identity exactly like a real sign-in's
        // `applyAuthResult` does, so a seeded named decider selected through dev auth sees
        // their own obligations instead of being treated as a non-decider.
        if (issued && !cancelled) useStore.setState({ sessionUserId: jwtSub(issued) });
      }
      // else: secure default — inject the gateway unauthenticated so the sign-in
      // flow reaches the public /auth/* endpoints; snapshot() will 401 until sign-in.
      if (cancelled) return;
      useStore.getState()._setGateway(gw);
      // WEB-02: (re)load the offline queue for THIS user+project scope — a sign-in
      // or project switch swaps to that scope's persisted queue.
      useStore.getState().hydrateOutbox();
      refresh();
      // load the projects the user can switch between + their orgs + portfolio rollup
      useStore.getState().loadOrgData();
      useStore.getState().loadPortfolio();
      // Task 9 — the project-shell summary (enabledModules) for the manifest-driven nav
      useStore.getState().loadShell();

      // web push: register this browser if permission is already granted (best-effort)
      void subscribeToPush(gw);

      // Realtime: refetch whenever the project changes on the server. Join the
      // ACTIVE project's room (WEB-01) — the effect re-runs on a project switch,
      // disconnecting this socket (which leaves its room) and joining the new one,
      // so notifications for the old project stop refreshing the new view.
      socket = io(API_BASE, { transports: ['websocket', 'polling'] });
      socket.on('connect', () => {
        // Join the ACTIVE project's room, then request FRESH state (Task 10 correction). `connect`
        // fires on the initial connect AND on every RECONNECT — while the socket was down we may have
        // missed `changed` pings, so a plain rejoin would leave the register stale. Refetching after
        // the join closes that gap (coalesced by the coordinator, so the first-connect double-pull with
        // the initial load above is harmless).
        socket?.emit('join', { projectId: activeProjectId });
        if (!cancelled) refresh();
      });
      socket.on('changed', () => {
        if (!cancelled) refresh();
      });
    })().catch((err) => {
      // fall back to the local seeded store if the API is unreachable / project missing
      // eslint-disable-next-line no-console
      console.warn('[vitan] API sync failed, using local data:', err);
    });

    return () => {
      cancelled = true;
      socket?.disconnect();
      useStore.getState()._setGateway(null);
    };
  }, [role, token, activeProjectId]);
}
