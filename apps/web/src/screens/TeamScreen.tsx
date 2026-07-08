import { useEffect, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Eyebrow, Button } from '@/components';
import { Plus, X } from '@/lib/icons';
import type { Role } from '@vitan/shared';
import type { AddMemberInput } from '@/data/apiGateway';
import styles from './responsive.module.css';

const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor'];
const ROLE_LABEL: Record<string, string> = { pmc: 'PMC', client: 'Client', engineer: 'Engineer', contractor: 'Contractor', worker: 'Worker' };

export function TeamScreen() {
  const members = useStore(useShallow((s) => s.members));
  const memberships = useStore(useShallow((s) => s.memberships));
  const activeProjectId = useStore((s) => s.activeProjectId);
  const sessionRole = useStore((s) => s.role);
  const loadTeam = useStore((s) => s.loadTeam);
  const addMember = useStore((s) => s.addMember);
  const updateMemberRole = useStore((s) => s.updateMemberRole);
  const removeMember = useStore((s) => s.removeMember);
  // membership role when known; else the current session role (covers the demo persona)
  const myRole = memberships.find((m) => m.projectId === activeProjectId)?.role ?? sessionRole;
  const canManage = myRole === 'pmc';

  useEffect(() => { loadTeam(); }, [loadTeam, activeProjectId]);

  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [role, setRole] = useState<Role>('engineer');
  const isEmail = contact.includes('@');
  const ready = name.trim() && contact.trim();
  const submit = () => {
    if (!ready) return;
    const input: AddMemberInput = { name: name.trim(), role, ...(isEmail ? { email: contact.trim() } : { phone: contact.replace(/\D/g, '') }) };
    addMember(input);
    setName('');
    setContact('');
  };

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <Eyebrow>PROJECT TEAM</Eyebrow>
      <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 20px', maxWidth: 560 }}>
        Who has access to this project and the role they hold. Adding someone provisions their account, so they can sign in by email/phone.
      </div>

      {canManage && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 22, padding: 14, background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 13 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={{ ...fld, flex: '1 1 140px' }} data-testid="member-name" />
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Email or phone" style={{ ...fld, flex: '1 1 180px' }} data-testid="member-contact" />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ ...fld, flex: '0 0 130px' }}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <Button variant="ink" onClick={submit} disabled={!ready} data-testid="add-member" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 15px', fontSize: 13 }}>
            <Plus size={15} /> Add
          </Button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {members.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>No team members loaded — this needs the server (sign in against the live API).</div>}
        {members.map((m) => (
          <div key={m.userId} style={cardStyle}>
            <div style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', background: 'var(--ink)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16 }}>{m.name[0]}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{m.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.email ?? m.phone ?? '—'}</div>
            </div>
            {canManage ? (
              <select value={m.role} onChange={(e) => updateMemberRole(m.userId, e.target.value as Role)} style={{ ...fld, flex: '0 0 120px', height: 38 }}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            ) : (
              <span style={roleChip}>{ROLE_LABEL[m.role]}</span>
            )}
            {canManage && (
              <button onClick={() => removeMember(m.userId)} aria-label={`Remove ${m.name}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}>
                <X size={17} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid var(--hairline)', borderRadius: 13, padding: '12px 14px' };
const fld: CSSProperties = { height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--ink)', outline: 'none' };
const roleChip: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', padding: '4px 9px', borderRadius: 6, border: '1px solid var(--hairline)', color: 'var(--muted)', textTransform: 'uppercase' };
