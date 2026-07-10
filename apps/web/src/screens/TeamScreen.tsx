import { useEffect, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Eyebrow, Button, Modal } from '@/components';
import { Plus, X, Trash2, Pencil } from '@/lib/icons';
import type { OrgRole, Role, CompanyKind, ProjectCompany } from '@vitan/shared';
import type { AddMemberInput, NewProjectInput, CompanyInput } from '@/data/apiGateway';
import styles from './responsive.module.css';

const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor'];
const ROLE_LABEL: Record<string, string> = { pmc: 'PMC', client: 'Client', engineer: 'Engineer', contractor: 'Contractor', worker: 'Worker' };
const ORG_ROLES: OrgRole[] = ['owner', 'admin', 'member'];
const ORG_ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const COMPANY_KINDS: CompanyKind[] = ['client', 'contractor', 'architect', 'structural', 'mep', 'pmc', 'consultant', 'other'];
const COMPANY_KIND_LABEL: Record<CompanyKind, string> = {
  client: 'Client', contractor: 'Contractor', architect: 'Architect', structural: 'Structural', mep: 'MEP', pmc: 'PMC', consultant: 'Consultant', other: 'Other',
};

export function TeamScreen() {
  const members = useStore(useShallow((s) => s.members));
  const memberships = useStore(useShallow((s) => s.memberships));
  const myOrgs = useStore(useShallow((s) => s.myOrgs));
  const activeProjectId = useStore((s) => s.activeProjectId);
  const sessionRole = useStore((s) => s.role);
  const loadTeam = useStore((s) => s.loadTeam);
  const addMember = useStore((s) => s.addMember);
  const updateMemberRole = useStore((s) => s.updateMemberRole);
  const removeMember = useStore((s) => s.removeMember);
  const deleteProject = useStore((s) => s.deleteProject);
  const projStart = useStore((s) => s.projStart);
  const projEnd = useStore((s) => s.projEnd);
  const descriptor = useStore((s) => s.descriptor);
  const stage = useStore((s) => s.stage);
  const siteCode = useStore((s) => s.siteCode);
  const location = useStore((s) => s.location);
  // membership role when known; else the current session role (covers the demo persona)
  const activeMembership = memberships.find((m) => m.projectId === activeProjectId);
  const myRole = activeMembership?.role ?? sessionRole;
  const canManage = myRole === 'pmc';
  // deleting a project is an org-admin power (owner/admin of the project's org)
  const activeOrgId = activeMembership?.orgId ?? null;
  const orgRole = myOrgs.find((o) => o.id === activeOrgId)?.role;
  const canDeleteProject = orgRole === 'owner' || orgRole === 'admin';
  // Granting/revoking org admins is the OWNER's alone — the single gatekeeper.
  const canManageOrgRoster = orgRole === 'owner';
  const canEditProject = (canManage || canDeleteProject) && !!activeOrgId;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => { loadTeam(); setConfirmDelete(false); setEditing(false); }, [loadTeam, activeProjectId]);

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
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Eyebrow>PROJECT TEAM</Eyebrow>
          <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 20px', maxWidth: 560 }}>
            Who has access to this project and the role they hold. Adding someone provisions their account, so they can sign in by email/phone.
          </div>
        </div>
        {canEditProject && (
          <Button variant="outline" onClick={() => setEditing(true)} data-testid="edit-project" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 13 }}>
            <Pencil size={14} /> Edit project
          </Button>
        )}
      </div>

      {editing && activeOrgId && (
        <EditProjectModal
          orgId={activeOrgId}
          projectId={activeProjectId}
          initial={{ name: activeMembership?.name ?? '', short: activeMembership?.short ?? '', descriptor, stage, siteCode, location, projStart, projEnd }}
          onClose={() => setEditing(false)}
        />
      )}

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

      <CompaniesSection canManage={canEditProject} />

      {canManageOrgRoster && activeOrgId && <OrgRoster orgId={activeOrgId} />}

      {canDeleteProject && activeOrgId && (
        <div style={{ marginTop: 34, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--red-solid)', marginBottom: 10 }}>DANGER ZONE</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 440 }}>
              Archiving hides this project from everyone — the switcher, portfolio, and all listings. It’s reversible: an org admin can restore it.
            </div>
            {confirmDelete ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="dangerOutline" onClick={() => { deleteProject(activeOrgId, activeProjectId); setConfirmDelete(false); }} data-testid="confirm-delete-project" style={{ fontSize: 13, padding: '10px 14px' }}>Yes, archive it</Button>
                <Button variant="outline" onClick={() => setConfirmDelete(false)} style={{ fontSize: 13, padding: '10px 14px' }}>Cancel</Button>
              </div>
            ) : (
              <Button variant="dangerOutline" onClick={() => setConfirmDelete(true)} data-testid="delete-project" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '10px 14px' }}>
                <Trash2 size={15} /> Archive project
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Organization roster — the admin tier, distinct from a project team. Owners/admins
 * run every project in the org as PMC; a member only sees projects they're added to.
 * Adding someone here provisions their account (homed as PMC on an org project), so
 * they can then sign in by email/phone and land in the admin view. Managed by the
 * org OWNER only (the single gatekeeper) — this whole section is owner-gated.
 */
function OrgRoster({ orgId }: { orgId: string }) {
  const orgMembers = useStore(useShallow((s) => s.orgMembers));
  const loadOrgMembers = useStore((s) => s.loadOrgMembers);
  const addOrgMember = useStore((s) => s.addOrgMember);
  const updateOrgMemberRole = useStore((s) => s.updateOrgMemberRole);
  const removeOrgMember = useStore((s) => s.removeOrgMember);
  useEffect(() => { loadOrgMembers(orgId); }, [loadOrgMembers, orgId]);
  const ownerCount = orgMembers.filter((m) => m.orgRole === 'owner').length;

  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [role, setRole] = useState<OrgRole>('admin');
  const isEmail = contact.includes('@');
  const ready = name.trim() && contact.trim();
  const submit = () => {
    if (!ready) return;
    addOrgMember(orgId, { name: name.trim(), role, ...(isEmail ? { email: contact.trim() } : { phone: contact.replace(/\D/g, '') }) });
    setName('');
    setContact('');
  };

  return (
    <div style={{ marginTop: 34, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
      <Eyebrow>ORGANIZATION ADMINS</Eyebrow>
      <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 16px', maxWidth: 560 }}>
        Owners &amp; admins can create projects, build teams, and run every project in the org. Adding someone provisions their login and lands them in the admin view.
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18, padding: 14, background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 13 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={{ ...fld, flex: '1 1 140px' }} data-testid="org-member-name" />
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Email or phone" style={{ ...fld, flex: '1 1 180px' }} data-testid="org-member-contact" />
        <select value={role} onChange={(e) => setRole(e.target.value as OrgRole)} style={{ ...fld, flex: '0 0 130px' }} aria-label="Org role">
          {ORG_ROLES.map((r) => <option key={r} value={r}>{ORG_ROLE_LABEL[r]}</option>)}
        </select>
        <Button variant="ink" onClick={submit} disabled={!ready} data-testid="add-org-member" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 15px', fontSize: 13 }}>
          <Plus size={15} /> Add admin
        </Button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {orgMembers.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>No admins loaded — this needs the server.</div>}
        {orgMembers.map((m) => {
          // The sole owner can't be demoted or removed — the org must keep an owner.
          const lastOwner = m.orgRole === 'owner' && ownerCount <= 1;
          return (
            <div key={m.userId} style={cardStyle}>
              <div style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16 }}>{m.name[0]}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{m.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.email ?? m.phone ?? '—'}</div>
              </div>
              <select
                value={m.orgRole}
                disabled={lastOwner}
                onChange={(e) => updateOrgMemberRole(orgId, m.userId, e.target.value as OrgRole)}
                aria-label={`Org role for ${m.name}`}
                data-testid="org-member-role"
                style={{ ...fld, flex: '0 0 120px', height: 38, opacity: lastOwner ? 0.6 : 1 }}
              >
                {ORG_ROLES.map((r) => <option key={r} value={r}>{ORG_ROLE_LABEL[r]}</option>)}
              </select>
              <button
                onClick={() => removeOrgMember(orgId, m.userId)}
                disabled={lastOwner}
                aria-label={`Remove ${m.name}`}
                title={lastOwner ? 'The org must keep at least one owner' : undefined}
                data-testid="remove-org-member"
                style={{ background: 'transparent', border: 'none', cursor: lastOwner ? 'not-allowed' : 'pointer', color: 'var(--muted)', display: 'flex', padding: 4, opacity: lastOwner ? 0.35 : 1 }}
              >
                <X size={17} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Edit a project's details (name/short/stage/dates). Only non-empty fields are sent,
 *  so the server updates just what changed. PMC / org-admin only. */
interface EditProjectInitial {
  name: string;
  short: string;
  descriptor: string;
  stage: string;
  siteCode: string;
  location: string;
  projStart: string;
  projEnd: string;
}

function EditProjectModal({ orgId, projectId, initial, onClose }: { orgId: string; projectId: string; initial: EditProjectInitial; onClose: () => void }) {
  const update = useStore((s) => s.updateProjectDetails);
  const [name, setName] = useState(initial.name);
  const [short, setShort] = useState(initial.short);
  const [descriptor, setDescriptor] = useState(initial.descriptor);
  const [stage, setStage] = useState(initial.stage);
  const [siteCode, setSiteCode] = useState(initial.siteCode);
  const [location, setLocation] = useState(initial.location);
  const [projStart, setProjStart] = useState(initial.projStart);
  const [projEnd, setProjEnd] = useState(initial.projEnd);

  const save = () => {
    const input: Partial<NewProjectInput> = {};
    if (name.trim() && name.trim() !== initial.name) input.name = name.trim();
    if (short.trim() && short.trim() !== initial.short) input.short = short.trim();
    if (descriptor.trim() !== initial.descriptor) input.descriptor = descriptor.trim();
    if (stage.trim() !== initial.stage) input.stage = stage.trim();
    if (siteCode.trim() !== initial.siteCode) input.siteCode = siteCode.trim();
    if (location.trim() !== initial.location) input.location = location.trim();
    if (projStart.trim() && projStart.trim() !== initial.projStart) input.projStart = projStart.trim();
    if (projEnd.trim() && projEnd.trim() !== initial.projEnd) input.projEnd = projEnd.trim();
    if (Object.keys(input).length) update(orgId, projectId, input);
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={460} labelledBy="edit-proj-title">
      <div style={{ padding: '18px 20px' }}>
        <div id="edit-proj-title" style={{ fontWeight: 700, fontSize: 17 }}>Edit project</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>Update the details below. Blank fields are left unchanged.</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" style={{ ...fld, marginTop: 16, width: '100%' }} data-testid="edit-name" />
        <input value={short} onChange={(e) => setShort(e.target.value)} placeholder="Short name" style={{ ...fld, marginTop: 10, width: '100%' }} />
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location / site address" style={{ ...fld, marginTop: 10, width: '100%' }} data-testid="edit-location" />
        <input value={descriptor} onChange={(e) => setDescriptor(e.target.value)} placeholder="Descriptor (e.g. G+2 Private Residence)" style={{ ...fld, marginTop: 10, width: '100%' }} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <input value={stage} onChange={(e) => setStage(e.target.value)} placeholder="Stage" style={{ ...fld, flex: 1 }} />
          <input value={siteCode} onChange={(e) => setSiteCode(e.target.value)} placeholder="Site code" style={{ ...fld, flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <input value={projStart} onChange={(e) => setProjStart(e.target.value)} placeholder="Start" style={{ ...fld, flex: 1 }} />
          <input value={projEnd} onChange={(e) => setProjEnd(e.target.value)} placeholder="End" style={{ ...fld, flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: 1, padding: 12 }}>Cancel</Button>
          <Button variant="ink" onClick={save} data-testid="save-project" style={{ flex: 1, padding: 12 }}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Companies & consultants for the active project — the client firm, main contractor,
 *  structural/MEP consultants, etc. Add/edit/remove for the PMC or org admin. */
function CompaniesSection({ canManage }: { canManage: boolean }) {
  const companies = useStore(useShallow((s) => s.companies));
  const removeCompany = useStore((s) => s.removeCompany);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProjectCompany | null>(null);

  return (
    <div style={{ marginTop: 34, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <Eyebrow>COMPANIES &amp; CONSULTANTS</Eyebrow>
        {canManage && (
          <Button variant="ink" onClick={() => { setEditing(null); setAdding(true); }} data-testid="add-company" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
            <Plus size={15} /> Add company
          </Button>
        )}
      </div>

      {companies.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>No companies or consultants recorded yet{canManage ? ' — add the client firm, contractor, and consultants.' : '.'}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {companies.map((c) => (
            <div key={c.id} style={cardStyle}>
              <span style={{ ...roleChip, flex: 'none' }}>{COMPANY_KIND_LABEL[c.kind]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {[c.contactName, c.contactPhone, c.contactEmail].filter(Boolean).join(' · ') || (c.notes ? c.notes : '—')}
                </div>
              </div>
              {canManage && (
                <>
                  <button onClick={() => { setAdding(false); setEditing(c); }} aria-label={`Edit ${c.name}`} style={iconBtn}><Pencil size={16} /></button>
                  <button onClick={() => removeCompany(c.id)} aria-label={`Remove ${c.name}`} style={iconBtn}><X size={17} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {canManage && (adding || editing) && (
        <CompanyModal company={editing} onClose={() => { setAdding(false); setEditing(null); }} />
      )}
    </div>
  );
}

/** Add or edit a single company/consultant. */
function CompanyModal({ company, onClose }: { company: ProjectCompany | null; onClose: () => void }) {
  const addCompany = useStore((s) => s.addCompany);
  const updateCompany = useStore((s) => s.updateCompany);
  const [name, setName] = useState(company?.name ?? '');
  const [kind, setKind] = useState<CompanyKind>(company?.kind ?? 'contractor');
  const [contactName, setContactName] = useState(company?.contactName ?? '');
  const [contactPhone, setContactPhone] = useState(company?.contactPhone ?? '');
  const [contactEmail, setContactEmail] = useState(company?.contactEmail ?? '');
  const [notes, setNotes] = useState(company?.notes ?? '');

  const save = () => {
    if (!name.trim()) return;
    const payload: CompanyInput = { name: name.trim(), kind, contactName: contactName.trim(), contactPhone: contactPhone.trim(), contactEmail: contactEmail.trim(), notes: notes.trim() };
    if (company) updateCompany(company.id, payload);
    else addCompany(payload);
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={460} labelledBy="company-title">
      <div style={{ padding: '18px 20px' }}>
        <div id="company-title" style={{ fontWeight: 700, fontSize: 17 }}>{company ? 'Edit company' : 'Add company / consultant'}</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Firm / organisation name" style={{ ...fld, marginTop: 16, width: '100%' }} data-testid="company-name" />
        <select value={kind} onChange={(e) => setKind(e.target.value as CompanyKind)} style={{ ...fld, marginTop: 10, width: '100%' }} data-testid="company-kind">
          {COMPANY_KINDS.map((k) => <option key={k} value={k}>{COMPANY_KIND_LABEL[k]}</option>)}
        </select>
        <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact person" style={{ ...fld, marginTop: 10, width: '100%' }} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Phone" style={{ ...fld, flex: 1 }} />
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email" style={{ ...fld, flex: 1 }} />
        </div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" style={{ ...fld, marginTop: 10, width: '100%' }} />
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: 1, padding: 12 }}>Cancel</Button>
          <Button variant="ink" onClick={save} disabled={!name.trim()} data-testid="save-company" style={{ flex: 1, padding: 12 }}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

const cardStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid var(--hairline)', borderRadius: 13, padding: '12px 14px' };
const fld: CSSProperties = { height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--ink)', outline: 'none' };
const roleChip: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', padding: '4px 9px', borderRadius: 6, border: '1px solid var(--hairline)', color: 'var(--muted)', textTransform: 'uppercase' };
const iconBtn: CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 };
