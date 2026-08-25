import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';

/**
 * The ONE source of project-switching data, shared by the desktop rail's `ProjectSwitcher`
 * and the mobile top bar. It owns no state of its own: `memberships`, `activeProjectId` and
 * `switchProject` are read straight from the store, so the two surfaces cannot drift and a
 * switch from either goes through the same scope-generation transition (and the same
 * project-scoped URL update via `applyAuthResult`).
 */
export function useProjectSwitch() {
  const memberships = useStore(useShallow((s) => s.memberships));
  const myOrgs = useStore(useShallow((s) => s.myOrgs));
  const activeProjectId = useStore((s) => s.activeProjectId);
  const switchProject = useStore((s) => s.switchProject);
  // live project identity from the snapshot; the membership short is the fast label during a switch
  const liveShort = useStore((s) => s.short);

  const active = memberships.find((m) => m.projectId === activeProjectId);
  const label = active?.short ?? liveShort;
  // Prefer the ACTIVE project's org so "save as template → pick it at New project" holds for
  // multi-org admins; fall back to the first org they administer.
  const adminOrgs = myOrgs.filter((o) => o.role === 'owner' || o.role === 'admin');
  const adminOrg = adminOrgs.find((o) => o.id === active?.orgId) ?? adminOrgs[0];
  const canSwitch = memberships.length > 1 || Boolean(adminOrg);

  return { memberships, activeProjectId, active, label, adminOrg, canSwitch, switchProject };
}
