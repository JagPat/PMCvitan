import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Modal } from '@/components';
import { ChevronRight, Plus, Check } from '@/lib/icons';
import type { NewProjectInput } from '@/data/apiGateway';

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

  const liveShort = useStore((s) => s.short);
  const active = memberships.find((m) => m.projectId === activeProjectId);
  const label = active?.short ?? liveShort;
  const adminOrg = myOrgs.find((o) => o.role === 'owner' || o.role === 'admin');
  const canSwitch = memberships.length > 1 || Boolean(adminOrg);

  return (
    <div style={{ position: 'relative' }}>
      <div style={label0}>PROJECT</div>
      <button
        onClick={() => canSwitch && setOpen((v) => !v)}
        data-testid="project-switcher"
        style={{ ...pill, cursor: canSwitch ? 'pointer' : 'default' }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {canSwitch && <ChevronRight size={15} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flex: 'none' }} />}
      </button>

      {open && (
        <div style={panel}>
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

function CreateProjectModal({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const createProject = useStore((s) => s.createProject);
  const [name, setName] = useState('');
  const [short, setShort] = useState('');
  const submit = () => {
    if (!name.trim() || !short.trim()) return;
    const input: NewProjectInput = { name: name.trim(), short: short.trim(), stage: 'Planning' };
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
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={{ ...btn, background: '#fff', color: 'var(--ink)', border: '1px solid rgba(35,33,28,.2)' }}>Cancel</button>
          <button onClick={submit} disabled={!name.trim() || !short.trim()} style={{ ...btn, background: 'var(--ink)', color: '#fff', border: 'none', opacity: name.trim() && short.trim() ? 1 : 0.5 }}>Create</button>
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
