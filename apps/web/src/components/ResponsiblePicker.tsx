import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, responsibleSaveRunning } from '@/store/store';
import { can, responsibleMemberLabels as L } from '@vitan/shared';

/**
 * The inspection a picker names (Codex #1361 r1/r2): the one holding the failed work being fixed. The ONE rule every
 * picker site calls:
 * - a checklist not yet submitted that re-checks another (`reinspectionOfId`) names that one, the inspection sent back,
 *   whose failed items are the work being fixed (the outstanding row and the engineer's screen);
 * - a submitted checklist, or a review (always submitted: it is in the review queue), names itself, since its own failed
 *   items are what "Your open items" serves for that id (the server's openItems, inspections.query.ts).
 * A review is told from a checklist by its `decided` field, so a caller cannot leave the state out by mistake.
 */
export function responsibleTargetOf(
  c: { id: string; reinspectionOfId?: string | null } & ({ submitted: boolean } | { decided: boolean }),
): string {
  const open = 'submitted' in c && !c.submitted;
  return open && c.reinspectionOfId ? c.reinspectionOfId : c.id;
}

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
  // busy while THIS inspection has a save on its way (Codex #1361 r2/r3). The store holds it, one save per inspection,
  // so moving to another inspection leaves that one usable, and coming back finds this one still busy until its save
  // settles: a second save for it is never sent alongside the first.
  const saving = useStore((s) => responsibleSaveRunning(s, inspectionId));
  const joinSnapshotRead = useStore((s) => s.joinSnapshotRead);
  // The team list (the Team screen's read, one read shared by every picker on the screen) is asked for only when it is
  // needed: the picker being opened, or a name to show that the list does not hold. `readFor` is the name the last
  // SUCCESSFUL read was made for, so a member named later (by another tab, after the list was read) is asked for again
  // rather than shown as nobody. A read that fails (no network, a refused read, no server) records nothing: the named
  // member stays held as "…", never shown as nobody, and opening the picker asks again.
  const [readFor, setReadFor] = useState<string | null | undefined>(undefined);
  const [failedFor, setFailedFor] = useState<string | null | undefined>(undefined);
  // The caches say how fresh a READ is, so they belong to one naming in one project scope (Codex #1365 r1): a change of
  // the naming is new server state (a member named, cleared and named again must be read for again), and a read made in
  // an earlier scope (generation) answers nothing in this one. Both are dropped in the same render either changes.
  const generation = useStore((s) => s.projectScopeGeneration);
  const seenNow = `${generation}|${named ?? ''}`;
  const [seen, setSeen] = useState(seenNow);
  if (seen !== seenNow) {
    setSeen(seenNow);
    setReadFor(undefined);
    setFailedFor(undefined);
  }
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
  const readTeam = (opts?: { after?: boolean }) => {
    if (!allowed || !online || reading) return;
    const asked = named;
    setReading(true);
    void readTeamShared(opts).then((ok) => {
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
  // Every opening reads the list again (Codex #1361 r1): a member added, removed or re-roled in another tab after an
  // earlier read sends no snapshot event, so only a fresh read offers them as they stand now. The first read, and a read
  // after a failure, hold the picker busy; later ones refresh in the background under the same shared read.
  // An opening's reads START after it (Codex #1365 r1): a read already in flight may have been answered before a change
  // made elsewhere, so one more is chained behind it (shared by every opening until it is sent), never only joined.
  const onOpen = () => {
    if (readFor === undefined || failedFor !== undefined) readTeam({ after: true });
    else if (allowed && online) {
      void readTeamShared({ after: true });
      // a member's standing change sends no snapshot event, so the shown name (the server's) is read again too: a
      // member re-roled away and back is no longer the one named (Codex #1361 r2). A read in flight gets one rerun queued
      // behind it, shared by every opening until it starts, so opening many pickers makes one more read, not one each.
      joinSnapshotRead();
    }
  };

  if (!allowed) return null;

  // The server serves only a member who still stands. Once the list is read, one it does not offer reads as nobody, as
  // it does there.
  const value = known || pending ? (named as string) : '';
  const disabled = saving || !online || reading;

  const choose = (next: string) => {
    const memberId = next === '' ? null : next;
    if (memberId === (value === '' ? null : value)) return;
    void setResponsibleMember(inspectionId, memberId);
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
