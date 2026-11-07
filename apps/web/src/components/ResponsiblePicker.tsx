import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, responsibleSaveRunning } from '@/store/store';
import { can, responsibleMemberLabels as L } from '@vitan/shared';
import { API_BASE } from '@/data/apiGateway';

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
// Which keys open a closed, focused select differs by platform: Space, F4 and Alt+Up/Down open it in desktop Chrome and
// Firefox; Enter does not, so it is not an opening. On macOS a plain Up/Down opens the menu, while on Windows and Linux
// it only moves the choice, so plain arrows count only on macOS.
const ARROWS_OPEN = (() => {
  try { return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? ''); } catch { return false; }
})();

export function ResponsiblePicker({ inspectionId, testId }: { inspectionId: string; testId: string }) {
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const online = useStore((s) => s.online);
  // A choice needs the server (Codex #1403 4500095675): with no API (the local demo, `VITE_API_URL` unset) there is none
  // to send it to, so the picker is disabled and says so, as when offline, and reads nothing.
  const connected = online && Boolean(API_BASE);
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
  // the inspection is part of it too: React can keep one picker and hand it another inspection (Codex #1365 r3)
  const seenNow = `${generation}|${inspectionId}|${named ?? ''}`;
  const [seen, setSeen] = useState(seenNow);
  if (seen !== seenNow) {
    setSeen(seenNow);
    setReadFor(undefined);
    setFailedFor(undefined);
  }
  // the naming and scope the picker shows NOW, for a read's completion to check against (Codex #1365 r3)
  const seenRef = useRef(seenNow);
  seenRef.current = seenNow;
  // Busy belongs to the target the read was made for (Codex #1403 4500095659): the naming in the scope shown, `seenNow`.
  // When the picker is handed another inspection or scope while a read is out, the new target is not busy with the old
  // read, so its own read is not blocked by one that stalls; the old read's answer still settles nothing here (below).
  const [readingFor, setReadingFor] = useState<string | null>(null);
  const reading = readingFor === seenNow;
  // Counts the phone coming back online (Codex #1403 4500095669). A read that started before the latest reconnect and
  // fails after it records no failure: the reconnect already forgot failures, and the read it would block is the retry
  // the reconnect promised. A failure with no reconnect in between is recorded as before (no automatic retry).
  const reconnects = useRef(0);
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
  const readTeam = (opts?: { after?: boolean }): Promise<unknown> | undefined => {
    if (!allowed || !connected || reading) return undefined;
    const asked = named;
    const askedIn = seenNow;
    const startedAt = reconnects.current;
    // a list written after this read started (any caller's) is fresher than this read's failure (#1406)
    const okAt = useStore.getState().teamReadOk;
    setReadingFor(askedIn);
    return readTeamShared(opts).then((ok) => {
      if (!live.current) return;
      // only this read's own busy mark is cleared: a read made since for another target keeps its own
      setReadingFor((cur) => (cur === askedIn ? null : cur));
      // A read answers only the naming and scope it was made for (Codex #1365 r3): one that settles after the naming or
      // the scope generation moved (a failed switch keeps the naming but moves the generation) settles nothing, and the
      // hold stays until a read made for what is shown now answers.
      if (seenRef.current !== askedIn) return;
      if (ok) { setReadFor(asked); setFailedFor(undefined); } else if (reconnects.current === startedAt && useStore.getState().teamReadOk === okAt) setFailedFor(asked);
    });
  };
  // a pending name is read for once on its own; after a failure only the user opening the picker, or the phone coming
  // back online, asks again (no automatic retry). The failure is forgotten when the phone comes BACK online (Codex #1365
  // r3), not when it goes offline: a read in flight when the connection dropped fails after that, and must not leave the
  // hold unread once the phone is online again.
  useEffect(() => { if (online) { reconnects.current += 1; setFailedFor(undefined); } }, [online]);
  // A team read written by ANY caller (another row's retry, the Team screen) is a fresh list (Codex #1403 4500368262,
  // #1406): a failure this picker recorded is forgotten, so the hold effect reads once more, shared with every row that
  // failed, and each settles under its own identity guard. A row that did not fail has nothing to forget.
  const teamReadOk = useStore((s) => s.teamReadOk);
  useEffect(() => { setFailedFor(undefined); }, [teamReadOk]);
  // A picker handed another target while its read for the old one is out (`readingFor` set, not this target) asks for a
  // read that starts AFTER that one (Codex #1403 4500095659 with #1365 r3): the read out was made before this target was
  // shown, so it may predate this naming and must not settle it. With nothing of its own out, it shares any read in flight.
  useEffect(() => {
    if (pending && failedFor !== named) readTeam(readingFor !== null ? { after: true } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, named, failedFor, connected, reading]);
  // Every opening reads the list again (Codex #1361 r1): a member added, removed or re-roled in another tab after an
  // earlier read sends no snapshot event, so only a fresh read offers them as they stand now. The first read, and a read
  // after a failure, hold the picker busy; later ones refresh in the background under the same shared read.
  // An opening's reads START after it (Codex #1365 r1): a read already in flight may have been answered before a change
  // made elsewhere, so one more is chained behind it (shared by every opening until it is sent), never only joined.
  // One gesture is one opening (Codex #1365 r2): a tap on a select that is not focused fires pointerdown and then focus,
  // so the focus that follows a pointerdown is the same opening and is skipped. Blur clears the mark, so a later keyboard
  // focus still opens (a pointerdown on a select already focused fires no focus).
  // A select already focused can also be opened from the keyboard (Space, Alt+Arrow, F4; plain Up/Down on macOS), which fires neither
  // pointerdown nor focus (Codex #1365 r3), so those keys are an opening too. Focus alone does not open a native select, so
  // a key that opens it reads again even right after a focus (Codex #1403 4500368269, #1406): the list it opens is never
  // older than the opening. The mark says only that a focus belongs to the pointerdown before it. Blur clears it.
  const opened = useRef<'pointer' | null>(null);
  const onPointerOpen = (e: ReactPointerEvent<HTMLSelectElement>) => {
    opened.current = document.activeElement === e.currentTarget ? null : 'pointer';
    onOpen();
  };
  const onFocusOpen = () => {
    if (opened.current === 'pointer') { opened.current = null; return; }
    onOpen();
  };
  const onKeyOpen = (e: ReactKeyboardEvent<HTMLSelectElement>) => {
    const arrow = e.key === 'ArrowDown' || e.key === 'ArrowUp';
    const opens = e.key === ' ' || e.key === 'F4' || (arrow && (e.altKey || ARROWS_OPEN));
    if (!opens) return;
    opened.current = null;
    onOpen();
  };
  const onOpen = () => {
    if (!allowed || !connected) return;
    // The picker's own first read (and a read after a failure) holds its busy state. A reopening while that read is out
    // still asks for a read that starts after it (Codex #1365 4490532251): the read out may have been answered before a
    // change made elsewhere. Either way the read is the shared one, chained once after a read in flight.
    const team = !reading && (readFor === undefined || failedFor !== undefined) ? readTeam({ after: true }) : readTeamShared({ after: true });
    // Every opening, the first too (Codex #1365 4490108371), reads the shown name (the server's) again: a member's
    // standing change sends no snapshot event, so a member re-roled away and back is no longer the one named (Codex #1361
    // r2). A read in flight gets one rerun queued behind it, shared by every opening until it starts, so opening many
    // pickers makes one more read, not one each.
    // The project is read only AFTER the opening's team read settles (Codex #1403 4500095681), so the name it serves is
    // never older than the list: read side by side, a member removed and re-added between the two could be shown by an
    // old name and offered by a fresh list, a naming the server no longer serves.
    void Promise.resolve(team).finally(() => { if (live.current) joinSnapshotRead(); });
  };

  if (!allowed) return null;

  // The server serves only a member who still stands. Once the list is read, one it does not offer reads as nobody, as
  // it does there.
  const value = known || pending ? (named as string) : '';
  // An opening's read never disables the select (Codex #1365 r2): disabling it on the tap that opens it would stop the
  // native list from opening. The list fills in when the read lands, and a choice from a list that is out of date is
  // checked by the server (a 400 re-reads it). Only a held name ("…") being read for keeps it disabled, as before.
  const disabled = saving || !connected || (reading && pending);

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
        onFocus={onFocusOpen}
        onPointerDown={onPointerOpen}
        onKeyDown={onKeyOpen}
        onBlur={() => { opened.current = null; }}
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
        {connected ? L.hint[lang] : L.offline[lang]}
      </div>
    </div>
  );
}

const label: CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 };
// the shared field token (44px, the four-copies rule in IssueChecklistModal)
const field: CSSProperties = { height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', width: '100%', maxWidth: 360 };
const hint: CSSProperties = { fontSize: 12, color: 'var(--muted)', marginTop: 5 };
