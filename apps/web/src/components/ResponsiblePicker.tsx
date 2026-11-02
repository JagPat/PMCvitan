import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
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
  const readTeamShared = useStore((s) => s.readTeamShared);
  const [saving, setSaving] = useState(false);
  // The team list (the Team screen's read, one read shared by every picker on the screen) is asked for only when it is
  // needed: the picker being opened, or a name to show that the list does not hold. `readFor` is the name the last
  // SUCCESSFUL read was made for, so a member named later (by another tab, after the list was read) is asked for again
  // rather than shown as nobody. A read that fails (no network, a refused read, no server) records nothing: the named
  // member stays held as "…", never shown as nobody, and opening the picker asks again.
  const [readFor, setReadFor] = useState<string | null | undefined>(undefined);
  const [failedFor, setFailedFor] = useState<string | null | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const id = useId();
  const allowed = can('inspection.responsible', role);

  const choices = members
    .filter((m) => m.status === 'active' && NAMEABLE.has(m.role))
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  const known = named !== null && choices.some((m) => m.userId === named);
  // a named member the list does not hold, before a successful read made for that name: held, not shown as nobody
  const pending = named !== null && !known && readFor !== named;

  // never read while offline (it can only fail); the shown name is the server's either way
  const readTeam = () => {
    if (!allowed || !online || reading) return;
    const asked = named;
    setReading(true);
    void readTeamShared().then((ok) => {
      if (!live.current) return;
      setReading(false);
      if (ok) { setReadFor(asked); setFailedFor(undefined); } else setFailedFor(asked);
    });
  };
  // a pending name is read for once on its own; after a failure only the user opening the picker, or the phone coming
  // back online, asks again (no automatic retry)
  useEffect(() => { if (!online) setFailedFor(undefined); }, [online]);
  useEffect(() => {
    if (pending && failedFor !== named) readTeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, named, failedFor, online, reading]);
  const onOpen = () => { if (readFor === undefined || failedFor !== undefined) readTeam(); };

  if (!allowed) return null;

  // The server serves only a member who still stands. Once the list is read, one it does not offer reads as nobody, as
  // it does there.
  const value = known || pending ? (named as string) : '';
  const disabled = saving || !online || reading;

  const choose = (next: string) => {
    const memberId = next === '' ? null : next;
    if (memberId === (value === '' ? null : value)) return;
    setSaving(true);
    void setResponsibleMember(inspectionId, memberId).finally(() => { if (live.current) setSaving(false); });
  };

  return (
    <div data-testid={testId} style={{ marginTop: 10 }}>
      <label htmlFor={id} style={label}>{L.label[lang]}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-busy={reading}
        aria-describedby={`${id}-hint`}
        onChange={(e) => choose(e.target.value)}
        onFocus={onOpen}
        onPointerDown={onOpen}
        data-testid={`${testId}-select`}
        style={{ ...field, opacity: disabled ? 0.6 : 1 }}
      >
        <option value="">{L.nobody[lang]}</option>
        {pending && <option value={named as string} aria-label={L.nameNotLoaded[lang]}>…</option>}
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
