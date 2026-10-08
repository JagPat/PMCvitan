import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { DEV_AUTH, API_BASE } from '@/data/apiGateway';
import { viewerIsDecider } from '@vitan/shared';
import { parseLocation, pathForScreen, screensFor, withDeciderRoute, SCREEN_CAPABILITY, ITEM_SCREENS } from '@/lib/screens';
import type { ScreenKey } from '@vitan/shared';

/** B6 — the item the current screen's URL names. The client's decisions screen keeps its own
 *  `decisionFocus`; every other item screen reads `routeItem`. */
function routeItemOf(s: { screen: ScreenKey; routeItem: string | null; decisionFocus: string | null }): string | null {
  return s.screen === 'client-decisions' ? s.decisionFocus : s.routeItem;
}

/**
 * Keeps the URL, the active project, and the active screen in sync — the URL is
 * `/projects/:projectId/<screen>`, so a refresh, bookmark or shared link restores both
 * which project you're in and where you were.
 *
 *  - store (project + screen) changes -> navigate to the canonical path.
 *  - URL changes (back/fwd, deep link) -> switch to the project (if it's a different one
 *    you can access) and/or setScreen, both guarded: an unknown/forbidden project or screen
 *    redirects to the active project's role-default. While a switch is in flight
 *    (`projectSwitching`) the store is authoritatively navigating, so the URL->store
 *    direction stands down to avoid fighting it.
 * Renders nothing.
 */
export function RouteBridge() {
  const screen = useStore((s) => s.screen);
  const role = useStore((s) => s.role);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const pendingProjectId = useStore((s) => s.pendingProjectId);
  const projectLoadState = useStore((s) => s.projectLoadState);
  const memberships = useStore(useShallow((s) => s.memberships));
  const capabilities = useStore(useShallow((s) => s.capabilities));
  const capabilitiesKnown = useStore((s) => s.capabilitiesKnown);
  // Phase 6 task 4b (§A.3 round 4) — the approval route follows the DECIDER: a viewer holding at
  // least one open decision keeps `client-decisions` reachable (the Inbox CTA lands and stays);
  // a same-role non-decider is still bounced.
  const isOpenDecider = useStore((s) =>
    s.decisions.some(
      (d) => !d.draft && (d.status === 'pending' || d.status === 'change') && viewerIsDecider(d, s.role, s.sessionUserId),
    ),
  );
  // Round-1 Codex F7 — the settled-slice inputs: an authed viewer with no data yet is a read in
  // flight; a signed-out or locally-seeded state is already as settled as it will get.
  // Round-10 Codex F4 — "authed" is the SESSION IDENTITY, never the adopted token alone: a
  // dev-auth session holds its JWT inside the gateway (`sessionToken` stays null) and records
  // its identity as `sessionUserId` only after `connect` resolves. Judging the slice as a
  // signed-out settled state in that window would consume a PMC/member decider's bookmarked
  // `/client/decisions` link against the seeded or previous slice — so under DEV_AUTH the
  // viewer counts as authed from the start, and while the connect has not yet recorded the
  // identity the slice is explicitly NOT judgeable (`identityPending` below).
  const tokenPresent = useStore((s) => s.sessionToken !== null);
  const sessionUserId = useStore((s) => s.sessionUserId);
  const authed = tokenPresent || sessionUserId !== null || DEV_AUTH;
  const identityPending = DEV_AUTH && !tokenPresent && sessionUserId === null;
  const hasDecisions = useStore((s) => s.decisions.length > 0);
  // Replacement round (Codex R2-F2) — the module-read decision slice reports its OWN health: a
  // failed or in-flight decisions read is NOT a settled slice even when the snapshot landed.
  const decisionsLoad = useStore((s) => s.decisionsLoad);
  const setScreen = useStore((s) => s.setScreen);
  const switchProject = useStore((s) => s.switchProject);
  const setRouteItem = useStore((s) => s.setRouteItem);
  const routeItem = useStore((s) => routeItemOf(s));
  const navigate = useNavigate();
  const location = useLocation();
  const didInit = useRef(false);
  const lastPath = useRef<string | null>(null);
  // B6 — the item a URL CHANGE asked for, held until its project is active and loaded (a deep link
  // into another project, or a cold API load, empties the project scope that holds it), then
  // adopted once. Only a URL change sets it, so a stale URL never overwrites an in-app selection.
  const pendingItem = useRef<{ projectId: string; screen: ScreenKey; item: string | null } | null>(null);

  // Live bug 1 (owner live check, #482 6039737806) — a record reached by a link that STARTS this tab's
  // history (a shared link, a new tab, a typed URL) has nothing behind it, so Back would leave the app.
  // Its parent list is put underneath it once, on the first render: Back then goes to the list the
  // record belongs to. A record opened IN the app (a notification, a card, a row) is a pushed entry with
  // the previous screen behind it, and a reload keeps its place in history — neither is touched.
  // Codex 4212402103 — the parent is placed only once the role guard below has ACCEPTED the record's
  // screen for a settled identity (a loaded project, or a signed-out/local session): a forbidden record
  // is redirected and gets no parent, so Back can never land on a screen the role cannot hold.
  const [coldStart] = useState<string | null>(() => {
    const first = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    const { screen: fromPath, item } = parseLocation(location.pathname);
    return first === 0 && fromPath && item && ITEM_SCREENS.has(fromPath) ? location.pathname : null;
  });
  const coldRecord = useRef<string | null>(coldStart);

  // URL -> store (project + screen reconciliation, role-guarded)
  useEffect(() => {
    // While a project transition is pending, the store is authoritatively navigating —
    // the URL->store direction stands down so it can't fight (or restart) the switch.
    if (pendingProjectId !== null || projectLoadState === 'switching') return;
    // Only an actual URL CHANGE is a navigation request (deep link, back/forward).
    // This effect also re-runs on store changes (load state, memberships) while the
    // URL is momentarily stale — right after a switcher-initiated switch lands, the
    // path still names the OLD project until the store->URL effect rewrites it.
    const pathChanged = location.pathname !== lastPath.current;
    lastPath.current = location.pathname;
    const { projectId, screen: fromPath, item } = parseLocation(location.pathname);

    if (projectId && projectId !== activeProjectId) {
      // a deep-link / back-forward to a DIFFERENT project you can access → switch to it,
      // carrying the deep link's screen through the transition (adopted if the new role
      // is allowed to see it). The store->URL effect then rewrites the canonical path.
      if (pathChanged && memberships.some((m) => m.projectId === projectId)) {
        pendingItem.current = fromPath ? { projectId, screen: fromPath, item } : null;
        void switchProject(projectId, fromPath ?? undefined);
        return;
      }
      // an UNCHANGED path mismatching the active project is a stale URL awaiting
      // reconciliation — switching to it here would ping-pong the projects forever
      // (switch to A completes → stale B URL switches back to B → …). Stand down;
      // the store->URL effect below rewrites the canonical path.
      if (!pathChanged) return;
      // pathChanged but not a member: fall through — the screen logic below redirects
      // the forged/unknown-project path under the ACTIVE project's role-default.
    }

    // Codex F-deeplink — the role list alone is NOT enough for a capability-gated screen
    // (`materials`/`labour`): the nav hides it on a non-pilot project, but a direct/bookmarked
    // URL would land on a permanently-loading hub. Once the shell has REPORTED the project's
    // capabilities, a deep link to a screen whose capability the project lacks is redirected
    // like any forbidden screen. While capabilities are still UNKNOWN (cold load, shell in
    // flight or failed) nothing is bounced — a pilot deep link must survive the shell latency.
    const caps = new Set(capabilities);
    // Round-1 Codex F7 — the decider route is judged only against a SETTLED decision slice: on a
    // cold load `isOpenDecider` is false merely because the viewer-scoped decisions have not
    // arrived, and bouncing `/client/decisions` then would eat a named decider's bookmarked
    // approval link. While the read is in flight ('loading'/'switching' — and the authed
    // pre-fetch instant where 'idle' still holds no data) the route stays reachable, exactly
    // the capability branch's unknown-state posture; once the slice settles ('ready', or local
    // data already present) a real non-decider is bounced by this same effect re-running on
    // the load-state change.
    // Replacement round (Codex R2-F2): in module-read mode the decisions request can fail
    // INDEPENDENTLY while the snapshot succeeds (`projectLoadState: 'ready'` with
    // `decisionsLoad: 'error'`), retaining an empty/stale list — that slice is NOT settled, so
    // the decider route holds until Retry resolves the read one way that can be judged.
    // Round-6 Codex F4 — the SNAPSHOT-mode failure is the same unknown: a cold load ending in
    // `projectLoadState: 'error'` holds an EMPTY slice nothing judged, so it must not settle
    // either — the bookmarked approval route survives the transient failure until a
    // decision-bearing read succeeds (Retry / the next refresh), never consumed by an outage.
    // Round-10 Codex F4 — a dev-auth connect still in flight is an UNKNOWN identity: whatever
    // decisions the store holds belong to the seed or the previous persona, so the slice is
    // not judgeable until the issued identity lands (then the normal settle rules apply).
    const sliceHealthy = decisionsLoad === 'idle' || decisionsLoad === 'ready';
    const decisionsSettled =
      sliceHealthy
      && !identityPending
      && (projectLoadState === 'ready'
        || (projectLoadState === 'idle' && (!authed || hasDecisions)));
    const allowed = withDeciderRoute(
      screensFor(role)
        .filter((m) => {
          const cap = SCREEN_CAPABILITY[m.key];
          return cap === undefined || !capabilitiesKnown || caps.has(cap);
        })
        .map((m) => m.key),
      isOpenDecider || !decisionsSettled,
    );
    if (!fromPath || !allowed.includes(fromPath)) {
      pendingItem.current = null;
      coldRecord.current = null; // a redirected record gets no parent
      if (screen !== allowed[0]) setScreen(allowed[0]);
      return;
    }
    if (fromPath !== screen) setScreen(fromPath);
    if (pathChanged) pendingItem.current = { projectId: activeProjectId, screen: fromPath, item };
    const want = pendingItem.current;
    // a client decision is held until the decisions read lands: its screen closes a focus whose
    // decision it cannot find, so adopting it into a still-empty slice would drop the link
    const itemLoading = projectLoadState === 'loading' || (want?.screen === 'client-decisions' && decisionsLoad === 'loading');
    if (want && want.projectId === activeProjectId && want.screen === fromPath && !itemLoading) {
      pendingItem.current = null;
      if (routeItemOf(useStore.getState()) !== want.item) setRouteItem(want.item);
    }
    // the cold record's parent, once the guard has accepted it for a settled identity
    const record = coldRecord.current;
    if (record !== null) {
      // demo mode (no API) runs on a fixed persona; over the API the identity is settled once a signed-in
      // project has loaded (before sign-in the role is not yet the viewer's)
      const identitySettled = !API_BASE || (projectLoadState === 'ready' && !identityPending);
      if (location.pathname !== record) coldRecord.current = null; // the viewer has moved on: nothing to place
      // Codex 4212901999 — only a record in the ACTIVE project gets a parent: a project the viewer
      // cannot open is never placed in history (a member project is placed once its switch lands)
      else if (projectId && projectId !== activeProjectId) {
        if (!memberships.some((m) => m.projectId === projectId)) coldRecord.current = null;
      } else if (!fromPath || !item) {
        coldRecord.current = null;
      } else if (identitySettled && (fromPath !== 'client-decisions' || decisionsSettled)) {
        coldRecord.current = null;
        // Codex 4213640388 — both entries are the CANONICAL active-project paths: a legacy `/review/<id>`
        // link must not leave a bare parent the store->URL pass would canonicalize by pushing on Back
        navigate(pathForScreen(fromPath, activeProjectId, null), { replace: true });
        navigate(pathForScreen(fromPath, activeProjectId, item));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, role, activeProjectId, memberships, pendingProjectId, projectLoadState, capabilities, capabilitiesKnown, isOpenDecider, authed, identityPending, hasDecisions, decisionsLoad]);

  // store -> URL (canonical project-scoped path). ONE-WAY during a transition: while
  // a switch is pending or the target project is loading, the deep link's URL is the
  // authority — navigating now would rewrite it back to the OLD active project.
  // Read the LIVE store state: the URL->store effect above may have STARTED the switch
  // in this very commit, and the subscribed values here would still be pre-switch.
  useEffect(() => {
    const live = useStore.getState();
    if (live.pendingProjectId !== null || live.projectLoadState === 'switching' || live.projectLoadState === 'loading') return;
    const target = pathForScreen(live.screen, live.activeProjectId, routeItemOf(live));
    if (location.pathname !== target) {
      navigate(target, { replace: !didInit.current });
    }
    didInit.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, routeItem, activeProjectId, pendingProjectId, projectLoadState]);

  return null;
}
