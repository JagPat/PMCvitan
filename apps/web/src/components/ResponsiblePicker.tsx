import { useEffect, useId, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { can, responsibleMemberLabels as L } from '@vitan/shared';

/** The roles a member must hold to be named (the server's `RESPONSIBLE_ROLES`; it refuses anyone else with a 400). */
const NAMEABLE = new Set(['contractor', 'consultant']);

/**
 * #482 site photos, "Who fixes this?" (RM-w1) — the PMC or the engineer names the contractor or consultant member who
 * fixes an inspection's failed work, or nobody. Optional, empty at start, changeable at any time.
 *
 * ONLINE ONLY (Stage 1, 2 Nov): the choice is a keyed PUT, never an outbox kind, so it is disabled while offline and
 * says why. The current name is the snapshot's `responsibleMembers`, which the server already filters to members who
 * still stand; the choices are the project's ACTIVE contractors and consultants (`members.read`, open to both roles).
 * A member the list no longer offers reads as "Nobody yet", as the server serves them.
 */
export function ResponsiblePicker({ inspectionId, testId }: { inspectionId: string; testId: string }) {
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const online = useStore((s) => s.online);
  const members = useStore(useShallow((s) => s.members));
  const named = useStore((s) => s.responsibleMembers.find((r) => r.inspectionId === inspectionId)?.memberId ?? null);
  const setResponsibleMember = useStore((s) => s.setResponsibleMember);
  const loadTeam = useStore((s) => s.loadTeam);
  const [saving, setSaving] = useState(false);
  // The team list (the Team screen's read) is asked for only when it is needed: the picker being opened, or a name to show
  // that the list does not hold. `readFor` is the name the last read was made for, so a member named later (by another
  // tab, after the list was read) is asked for again rather than shown as nobody.
  const [readFor, setReadFor] = useState<string | null | undefined>(undefined);
  const [wantTeam, setWantTeam] = useState(false);
  const id = useId();
  const allowed = can('inspection.responsible', role);

  const choices = members
    .filter((m) => m.status === 'active' && NAMEABLE.has(m.role))
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  const known = named !== null && choices.some((m) => m.userId === named);
  // a named member the list does not hold, before a read made for that name has come back: held, not shown as nobody
  const pending = named !== null && !known && readFor !== named;
  const needTeam = allowed && (pending || (wantTeam && readFor === undefined));
  useEffect(() => {
    if (!needTeam) return;
    let live = true;
    const asked = named;
    void Promise.resolve(loadTeam()).finally(() => { if (live) setReadFor(asked); });
    return () => { live = false; };
  }, [needTeam, named, loadTeam]);

  if (!allowed) return null;

  // The server serves only a member who still stands. Once the list is read, one it does not offer reads as nobody, as
  // it does there.
  const value = known || pending ? (named as string) : '';
  const disabled = saving || !online || pending;

  const choose = (next: string) => {
    const memberId = next === '' ? null : next;
    if (memberId === (value === '' ? null : value)) return;
    setSaving(true);
    void setResponsibleMember(inspectionId, memberId).finally(() => setSaving(false));
  };

  return (
    <div data-testid={testId} style={{ marginTop: 10 }}>
      <label htmlFor={id} style={label}>{L.label[lang]}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(e) => choose(e.target.value)}
        onFocus={() => setWantTeam(true)}
        onPointerDown={() => setWantTeam(true)}
        data-testid={`${testId}-select`}
        style={{ ...field, opacity: disabled ? 0.6 : 1 }}
      >
        <option value="">{L.nobody[lang]}</option>
        {pending && <option value={named as string}>…</option>}
        {choices.map((m) => (
          <option key={m.userId} value={m.userId}>{m.name}</option>
        ))}
      </select>
      <div id={`${id}-hint`} style={hint} data-testid={`${testId}-hint`}>
        {online ? L.hint[lang] : L.offline[lang]}
      </div>
    </div>
  );
}

const label: CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 };
// the shared field token (44px, the four-copies rule in IssueChecklistModal)
const field: CSSProperties = { height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', width: '100%', maxWidth: 360 };
const hint: CSSProperties = { fontSize: 12, color: 'var(--muted)', marginTop: 5 };
