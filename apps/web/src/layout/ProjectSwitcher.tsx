import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Modal } from '@/components';
import { ChevronRight, Plus, Check } from '@/lib/icons';
import type { ModuleSelection, NewProjectInput } from '@/data/apiGateway';

/** Active-project display + switcher for the left rail. Real data arrives from
 *  the API (`/me/memberships`); with no API it's just the seeded project name. */
export function ProjectSwitcher() {
  const memberships = useStore(useShallow((s) => s.memberships));
  const myOrgs = useStore(useShallow((s) => s.myOrgs));
  const activeProjectId = useStore((s) => s.activeProjectId);
  const switchProject = useStore((s) => s.switchProject);
  const setScreen = useStore((s) => s.setScreen);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // Wave 0 / F-1a: the switcher is a NON-MODAL popup, not a dialog — no focus
  // trap, no aria-modal claim. Focus moves to the first option on open,
  // Escape closes and returns focus to the trigger, and any OUTSIDE
  // interaction (click or focus movement) light-dismisses without stealing
  // focus back — the user chose to go elsewhere.
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onOutside = (e: MouseEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  const liveShort = useStore((s) => s.short);
  const active = memberships.find((m) => m.projectId === activeProjectId);
  const label = active?.short ?? liveShort;
  // Prefer the ACTIVE project's org so "save as template → pick it at New project" holds
  // for multi-org admins; fall back to the first org they administer (review F5).
  const adminOrgs = myOrgs.filter((o) => o.role === 'owner' || o.role === 'admin');
  const adminOrg = adminOrgs.find((o) => o.id === active?.orgId) ?? adminOrgs[0];
  const canSwitch = memberships.length > 1 || Boolean(adminOrg);

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative' }}
      onBlurCapture={(e) => {
        // Focus leaving the whole switcher (trigger + panel) light-dismisses.
        if (open && e.relatedTarget instanceof Node && !rootRef.current?.contains(e.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <div style={label0}>PROJECT</div>
      <button
        ref={triggerRef}
        onClick={() => canSwitch && setOpen((v) => !v)}
        data-testid="project-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ ...pill, cursor: canSwitch ? 'pointer' : 'default' }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {canSwitch && <ChevronRight size={15} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flex: 'none' }} />}
      </button>

      {open && (
        <div
          ref={panelRef}
          style={panel}
          aria-label="Switch project"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          {memberships.map((m) => {
            const on = m.projectId === activeProjectId;
            return (
              <button key={m.projectId} onClick={() => { setOpen(false); switchProject(m.projectId); }} style={row(on)}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.short}</span>
                <span style={roleTag}>{m.role}</span>
                {on && <Check size={13} color="#8fce9f" />}
              </button>
            );
          })}
          {adminOrg && (
            <button onClick={() => { setOpen(false); setCreating(true); }} style={{ ...row(false), color: 'var(--accent)' }}>
              <Plus size={14} /> <span>New project</span>
            </button>
          )}
          <button onClick={() => { setOpen(false); setScreen('team'); }} style={row(false)}>
            Manage team →
          </button>
        </div>
      )}

      {creating && adminOrg && <CreateProjectModal orgId={adminOrg.id} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Exported for the nested-locations probes — the PUBLIC create-project door. */
export function CreateProjectModal({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const createProject = useStore((s) => s.createProject);
  const memberships = useStore(useShallow((s) => s.memberships));
  const orgModules = useStore(useShallow((s) => s.orgModules));
  const orgTemplates = useStore(useShallow((s) => s.orgTemplates));
  const loadOrgModules = useStore((s) => s.loadOrgModules);
  const loadOrgTemplates = useStore((s) => s.loadOrgTemplates);
  const [name, setName] = useState('');
  const [short, setShort] = useState('');
  // '' = blank slate · 'tpl:<id>' = a named preset · 'proj:<id>' = copy a project's structure
  const [startFrom, setStartFrom] = useState('');
  // the à-la-carte module picks: moduleId → {count, target} (Templates Slice 2). A
  // room-anchored (element-root) module needs a graft target — a named room, or a zone
  // for the nested-locations element-under-zone edge — so its pick carries the target
  // KIND plus the name for whichever kind is chosen (the server enforces exactly one).
  type Pick_ = { count: number; underZone: string; underRoom: string; roomTargetKind: 'room' | 'zone' };
  const [picked, setPicked] = useState<Record<string, Pick_>>({});
  useEffect(() => { loadOrgModules(orgId); loadOrgTemplates(orgId); }, [orgId, loadOrgModules, loadOrgTemplates]);

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = { count: 1, underZone: '', underRoom: '', roomTargetKind: 'room' };
      return next;
    });
  const setPick = (id: string, patch: Partial<Pick_>) =>
    setPicked((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }));

  // A selected room-anchored module with a blank target would be a guaranteed server
  // refusal — the Create button waits for the target instead of sending it.
  const targetsIncomplete = Object.entries(picked).some(([id, p]) => {
    if (orgModules.find((m) => m.id === id)?.anchorKind !== 'room') return false;
    return p.roomTargetKind === 'room' ? !p.underRoom.trim() : !p.underZone.trim();
  });

  const submit = () => {
    if (!name.trim() || !short.trim() || targetsIncomplete) return;
    const modules: ModuleSelection[] = Object.entries(picked).map(([moduleId, p]) => {
      if (orgModules.find((m) => m.id === moduleId)?.anchorKind === 'room') {
        return {
          moduleId,
          count: p.count,
          ...(p.roomTargetKind === 'room'
            ? { underRoom: p.underRoom.trim() }
            : { underZone: p.underZone.trim() }),
        };
      }
      return {
        moduleId,
        count: p.count,
        ...(p.underZone.trim() ? { underZone: p.underZone.trim() } : {}),
      };
    });
    const input: NewProjectInput = {
      name: name.trim(),
      short: short.trim(),
      stage: 'Planning',
      ...(startFrom.startsWith('tpl:') ? { templateId: startFrom.slice(4) } : {}),
      ...(startFrom.startsWith('proj:') ? { structureFrom: startFrom.slice(5) } : {}),
      ...(modules.length ? { modules } : {}),
    };
    createProject(orgId, input);
    onClose();
  };
  return (
    <Modal onClose={onClose} maxWidth={420} labelledBy="np-title">
      <div style={{ padding: '18px 20px' }}>
        <div id="np-title" style={{ fontWeight: 700, fontSize: 17 }}>New project</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>You'll be added as its PMC.</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name (Residence at Bodakdev)" style={fld} />
        <input value={short} onChange={(e) => setShort(e.target.value)} placeholder="Short name (Bodakdev Residence)" style={{ ...fld, marginTop: 10 }} />
        {(memberships.length > 0 || orgTemplates.length > 0) && (
          <>
            <label htmlFor="np-structure" style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.14em', color: 'var(--muted)', margin: '14px 2px 0' }}>START FROM</label>
            <select id="np-structure" value={startFrom} onChange={(e) => setStartFrom(e.target.value)} data-testid="np-structure-from" style={{ ...fld, marginTop: 6 }}>
              <option value="">Blank slate</option>
              {orgTemplates.length > 0 && (
                <optgroup label="Templates">
                  {orgTemplates.map((t) => (
                    <option key={t.id} value={`tpl:${t.id}`}>{t.name}</option>
                  ))}
                </optgroup>
              )}
              {memberships.length > 0 && (
                <optgroup label="Copy structure from a project">
                  {memberships.map((m) => (
                    <option key={m.projectId} value={`proj:${m.projectId}`}>{m.short}</option>
                  ))}
                </optgroup>
              )}
            </select>
            {startFrom.startsWith('tpl:') && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                {(orgTemplates.find((t) => `tpl:${t.id}` === startFrom)?.moduleNames ?? []).join(' · ') || 'This template'} — lands as drafts you refine and publish.
              </div>
            )}
            {startFrom.startsWith('proj:') && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                Copies the location tree (as drafts), phases, planned activities and checklist templates — never that project&apos;s approvals, dates, photos or people.
              </div>
            )}
          </>
        )}
        {orgModules.length > 0 && (
          <>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.14em', color: 'var(--muted)', margin: '14px 2px 6px' }}>ADD MODULES</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
              {orgModules.map((m) => {
                const sel = picked[m.id];
                return (
                  <div key={m.id} style={{ border: '1px solid rgba(35,33,28,.14)', borderRadius: 10, padding: '8px 10px', background: sel ? 'rgba(35,33,28,.04)' : '#fff' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                      <input type="checkbox" checked={Boolean(sel)} onChange={() => togglePick(m.id)} data-testid={`np-module-${m.id}`} />
                      <span style={{ fontWeight: 600, flex: 1 }}>{m.name}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.08em', color: 'var(--muted)', textTransform: 'uppercase' }}>{m.category}</span>
                    </label>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, paddingLeft: 24 }}>
                      {[m.counts.nodes && `${m.counts.nodes} places`, m.counts.inspections && `${m.counts.inspections} checklists`, m.counts.phases && `${m.counts.phases} phases`, m.counts.activities && `${m.counts.activities} activities`].filter(Boolean).join(' · ') || 'empty'}
                    </div>
                    {sel && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 7, paddingLeft: 24, alignItems: 'center' }}>
                        <label style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          ×
                          <input type="number" min={1} max={20} value={sel.count} onChange={(e) => setPick(m.id, { count: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} style={{ width: 52, height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid rgba(35,33,28,.18)', fontFamily: 'var(--font-sans)', fontSize: 13 }} />
                        </label>
                        {m.anchorKind === 'zone' && (
                          <input value={sel.underZone} onChange={(e) => setPick(m.id, { underZone: e.target.value })} placeholder="Under zone (Ground Floor)" style={{ flex: 1, minWidth: 0, height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid rgba(35,33,28,.18)', fontFamily: 'var(--font-sans)', fontSize: 12.5 }} />
                        )}
                        {m.anchorKind === 'room' && (
                          <>
                            <select value={sel.roomTargetKind} onChange={(e) => setPick(m.id, { roomTargetKind: e.target.value as 'room' | 'zone' })} data-testid={`np-target-kind-${m.id}`} aria-label={`Where ${m.name} grafts`} style={{ height: 30, padding: '0 6px', borderRadius: 8, border: '1px solid rgba(35,33,28,.18)', fontFamily: 'var(--font-sans)', fontSize: 12 }}>
                              <option value="room">Under room…</option>
                              <option value="zone">Under zone…</option>
                            </select>
                            {sel.roomTargetKind === 'room' ? (
                              <input value={sel.underRoom} onChange={(e) => setPick(m.id, { underRoom: e.target.value })} placeholder="Room name (Master Bedroom)" data-testid={`np-under-room-${m.id}`} style={{ flex: 1, minWidth: 0, height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid rgba(35,33,28,.18)', fontFamily: 'var(--font-sans)', fontSize: 12.5 }} />
                            ) : (
                              <input value={sel.underZone} onChange={(e) => setPick(m.id, { underZone: e.target.value })} placeholder="Zone name (Entrance)" data-testid={`np-under-zone-${m.id}`} style={{ flex: 1, minWidth: 0, height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid rgba(35,33,28,.18)', fontFamily: 'var(--font-sans)', fontSize: 12.5 }} />
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              Modules land as drafts — refine, then publish as the project firms up.
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={{ ...btn, background: '#fff', color: 'var(--ink)', border: '1px solid rgba(35,33,28,.2)' }}>Cancel</button>
          <button onClick={submit} disabled={!name.trim() || !short.trim() || targetsIncomplete} style={{ ...btn, background: 'var(--ink)', color: '#fff', border: 'none', opacity: name.trim() && short.trim() && !targetsIncomplete ? 1 : 0.5 }}>Create</button>
        </div>
      </div>
    </Modal>
  );
}

const label0: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.22em', color: 'rgba(237,231,218,.4)', marginBottom: 6 };
const pill: CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 11px', borderRadius: 9, border: '1px solid rgba(237,231,218,.16)', background: 'rgba(237,231,218,.04)', color: 'var(--sidebar-text)' };
const panel: CSSProperties = { position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 6, zIndex: 20, background: '#2a2823', border: '1px solid rgba(237,231,218,.16)', borderRadius: 10, padding: 5, boxShadow: '0 12px 32px rgba(0,0,0,.4)' };
function row(on: boolean): CSSProperties {
  return { width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderRadius: 7, border: 'none', background: on ? 'rgba(180,70,46,.2)' : 'transparent', color: 'rgba(237,231,218,.85)', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', textAlign: 'left' };
}
const roleTag: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.06em', color: 'rgba(237,231,218,.5)', textTransform: 'uppercase' };
const fld: CSSProperties = { width: '100%', height: 44, marginTop: 14, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--ink)', outline: 'none' };
const btn: CSSProperties = { flex: 1, padding: 12, borderRadius: 11, fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
