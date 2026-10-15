import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { can, forYouRole, type Lang, type ProjectMember, type Role } from '@vitan/shared';
import { useStore } from '@/store/store';
import { Button } from '@/components';
import { trailOf } from '@/lib/locationTree';
import { useSiteVisits } from '@/lib/useSiteVisits';
import { SV, visitTime } from '@/lib/siteVisitWords';
import type { SiteVisit } from '@/data/apiGateway';
import styles from './SiteVisitsScreen.module.css';

/**
 * Site Visits SV1-c (#792, QA item 6): every member reads the project's visits; a PMC or consultant starts one,
 * adds the places walked and the people there, and ends it; a PMC closes a visit left open. Buttons follow the
 * server's policy (`siteVisit.*`) and its visitor rule (only the visitor edits, in the role they started in), so
 * nothing is offered that the server would refuse for who the viewer is.
 */
export function SiteVisitsScreen() {
  const lang = useStore((s) => s.lang);
  const role = useStore((s) => s.role);
  const me = useStore((s) => s.sessionUserId);
  const hasServer = useStore((s) => s.serverGateway() !== null);
  const nodes = useStore(useShallow((s) => s.nodes.filter((n) => !n.draft)));
  const sv = useSiteVisits();
  const [startNode, setStartNode] = useState('');
  const members = useStore(useShallow((s) => s.members));
  const loadTeam = useStore((s) => s.loadTeam);
  const [team, setTeam] = useState<'loading' | 'done'>('loading');
  // bumped by Try again on a failed team read
  const [teamAsk, setTeamAsk] = useState(0);

  const placeOptions = useMemo(
    () => nodes.map((n) => ({ id: n.id, label: trailOf(nodes, n.id).map((t) => t.name).join(' › ') })).sort((a, b) => a.label.localeCompare(b.label)),
    [nodes],
  );
  const mineOpen = sv.visits.some((v) => v.visitorId === me && v.status === 'open');
  // the member list is the Team screen's; read it when this viewer can name someone on a visit, and again whenever
  // the server says the project changed (a member removed, re-roled or newly joined). The viewer is a member, so a
  // list still empty after the read means it failed, and the picker offers a retry
  const namesPeople = sv.visits.some((v) => editable(v, role, me));
  useEffect(() => {
    if (!namesPeople) return;
    let on = true;
    setTeam('loading');
    void loadTeam().finally(() => { if (on) setTeam('done'); });
    return () => { on = false; };
  }, [namesPeople, sv.pings, teamAsk, loadTeam]);
  const teamFailed = team === 'done' && members.length === 0;

  if (!hasServer) {
    return (
      <div className={styles.screen}>
        <Header lang={lang} />
        <p className={styles.note}>{SV.needsServer[lang]}</p>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <Header lang={lang} />
      {/* only once the open visits are read: until then the viewer's own open visit is not known */}
      {can('siteVisit.start', role) && sv.load === 'ready' && !mineOpen && (
        <section className={styles.card} aria-label={SV.start[lang]}>
          <label className={styles.label} htmlFor="sv-start-place">{SV.startPlace[lang]}</label>
          <select id="sv-start-place" className={styles.field} value={startNode} onChange={(e) => setStartNode(e.target.value)}>
            <option value="">{SV.noPlace[lang]}</option>
            {placeOptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <p className={styles.note}>{SV.locationNote[lang]}</p>
          <Button variant="ink" fullWidth disabled={sv.busy} data-testid="sv-start" onClick={() => { void sv.start(startNode || null).then((ok) => ok && setStartNode('')); }}>
            {SV.start[lang]}
          </Button>
        </section>
      )}
      {sv.error && <p role="alert" className={styles.error}>{sv.error}</p>}
      {sv.load === 'loading' && sv.visits.length === 0 && <p className={styles.note}>{SV.loading[lang]}</p>}
      {sv.load === 'error' && (
        <div className={styles.note}>
          {SV.loadFailed[lang]} <Button variant="light" onClick={sv.retry}>{SV.retry[lang]}</Button>
        </div>
      )}
      {sv.load === 'ready' && sv.visits.length === 0 && <p className={styles.note}>{SV.empty[lang]}</p>}
      <div className={styles.list}>
        {sv.visits.map((v) => (
          <VisitCard key={v.id} visit={v} lang={lang} role={role} me={me} placeOptions={placeOptions} sv={sv}
            members={members} teamFailed={teamFailed} retryTeam={() => setTeamAsk((n) => n + 1)} />
        ))}
      </div>
      {sv.hasMore && <Button variant="light" fullWidth onClick={sv.more}>{SV.older[lang]}</Button>}
    </div>
  );
}

function Header({ lang }: { lang: Lang }) {
  return (
    <div className={styles.header}>
      <h1 className={styles.title}>{SV.title[lang]}</h1>
      <p className={styles.note}>{SV.intro[lang]}</p>
    </div>
  );
}

/** Whether the viewer may add or remove places and people on this visit: the server narrows every edit to the
 *  visitor, in the role they started in (SV1-b). */
function editable(v: SiteVisit, role: Role, me: string | null): boolean {
  return v.visitorId === me && v.visitorRole === role && can('siteVisit.edit', role) && v.status !== 'closed';
}

function roleName(role: string | null, lang: Lang): string {
  return role && role in forYouRole ? forYouRole[role as Role][lang] : '';
}

function VisitCard({ visit: v, lang, role, me, placeOptions, sv, members, teamFailed, retryTeam }: {
  visit: SiteVisit;
  lang: Lang;
  role: Role;
  me: string | null;
  placeOptions: { id: string; label: string }[];
  sv: ReturnType<typeof useSiteVisits>;
  members: ProjectMember[];
  teamFailed: boolean;
  retryTeam: () => void;
}) {
  const [place, setPlace] = useState('');
  const [person, setPerson] = useState('');
  const [guest, setGuest] = useState('');
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');

  const mine = v.visitorId === me && v.visitorRole === role;
  const canEdit = editable(v, role, me);
  const canEnd = mine && can('siteVisit.end', role) && (v.status === 'open' || (v.status === 'closed' && v.lateEndedAt === null));
  const canClose = can('siteVisit.close', role) && v.status === 'open';
  const standingPlaces = new Set(v.places.filter((p) => !p.retiredAt && p.nodeId).map((p) => p.nodeId));
  const standingPeople = new Set(v.attendees.filter((a) => !a.retiredAt && a.userId).map((a) => `${a.userId}:${a.role}`));
  const freePlaces = placeOptions.filter((p) => !standingPlaces.has(p.id));
  // only a member whose membership is active can be named: an invitation not yet taken is refused by the server
  const freeMembers = members.filter((m) => m.status === 'active' && m.userId !== v.visitorId && !standingPeople.has(`${m.userId}:${m.role}`));
  const status = v.status === 'open' ? SV.open[lang] : v.status === 'ended' ? SV.ended[lang] : SV.closed[lang];

  return (
    <article className={styles.card} data-testid={`sv-visit-${v.id}`} aria-label={`${v.visitorName} · ${status}`}>
      <div className={styles.row}>
        <strong>{v.visitorName}</strong>
        <span className={styles.chip} data-status={v.status}>{status}</span>
      </div>
      <div className={styles.meta}>{roleName(v.visitorRole, lang)}</div>
      <div className={styles.meta}>
        {SV.startedAt[lang]} {visitTime(v.startedAt, lang)}
        {v.endedAt && <> · {SV.endedAt[lang]} {visitTime(v.endedAt, lang)}</>}
        {v.closedAt && <> · {SV.closedAt[lang]} {visitTime(v.closedAt, lang)}</>}
        {v.startPlace && <> · {v.startPlace.name}</>}
      </div>
      {v.location.kind === 'device' && (
        <div className={styles.meta}>{SV.location[lang]}{v.location.approximate ? ` (${SV.approximate[lang]})` : ''}</div>
      )}
      {v.status === 'closed' && v.closeReason && <div className={styles.meta}>{SV.closedBecause[lang]} {v.closeReason}</div>}
      {v.lateEndedAt && <div className={styles.meta}>{SV.lateEnd[lang]} · {visitTime(v.lateEndedAt, lang)}</div>}

      <h2 className={styles.sub}>{SV.places[lang]}</h2>
      {v.places.length === 0 && <div className={styles.meta}>{SV.none[lang]}</div>}
      <ul className={styles.items}>
        {v.places.map((p) => (
          <li key={p.id} className={p.retiredAt ? styles.retired : undefined}>
            <span>{p.name}{p.addedAfterEnd ? ` · ${SV.addedAfterEnd[lang]}` : ''}{p.retiredAt ? ` · ${SV.removed[lang]}` : ''}</span>
            {canEdit && !p.retiredAt && (
              <Button variant="ghost" disabled={sv.busy} aria-label={`${SV.remove[lang]}: ${p.name}`} onClick={() => void sv.retirePlace(v.id, p.id)}>{SV.remove[lang]}</Button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className={styles.add}>
          <select aria-label={SV.choosePlace[lang]} className={styles.field} value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">{SV.choosePlace[lang]}</option>
            {freePlaces.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <Button variant="light" disabled={sv.busy || !place} onClick={() => { void sv.addPlace(v.id, place).then((ok) => ok && setPlace('')); }}>{SV.addPlace[lang]}</Button>
        </div>
      )}

      <h2 className={styles.sub}>{SV.people[lang]}</h2>
      {v.attendees.length === 0 && <div className={styles.meta}>{SV.none[lang]}</div>}
      <ul className={styles.items}>
        {v.attendees.map((a) => (
          <li key={a.id} className={a.retiredAt ? styles.retired : undefined}>
            <span>{a.name} · {a.kind === 'guest' ? SV.guest[lang] : roleName(a.role, lang)}{a.retiredAt ? ` · ${SV.removed[lang]}` : ''}</span>
            {canEdit && !a.retiredAt && (
              <Button variant="ghost" disabled={sv.busy} aria-label={`${SV.remove[lang]}: ${a.name}`} onClick={() => void sv.retireAttendee(v.id, a.id)}>{SV.remove[lang]}</Button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <>
          <div className={styles.add}>
            <select aria-label={SV.choosePerson[lang]} className={styles.field} value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">{SV.choosePerson[lang]}</option>
              {freeMembers.map((m) => <option key={`${m.userId}:${m.role}`} value={`${m.userId}:${m.role}`}>{m.name} · {roleName(m.role, lang)}</option>)}
            </select>
            <Button variant="light" disabled={sv.busy || !person} onClick={() => {
              const [userId, memberRole] = person.split(':');
              void sv.addMember(v.id, userId, memberRole).then((ok) => ok && setPerson(''));
            }}>{SV.addPerson[lang]}</Button>
          </div>
          {teamFailed && (
            <div className={styles.meta}>
              {SV.teamFailed[lang]} <Button variant="light" onClick={retryTeam}>{SV.retry[lang]}</Button>
            </div>
          )}
          <div className={styles.add}>
            <input aria-label={SV.guestName[lang]} placeholder={SV.guestName[lang]} className={styles.field} value={guest} maxLength={120} onChange={(e) => setGuest(e.target.value)} />
            <Button variant="light" disabled={sv.busy || !guest.trim()} onClick={() => { void sv.addGuest(v.id, guest.trim()).then((ok) => ok && setGuest('')); }}>{SV.addGuest[lang]}</Button>
          </div>
        </>
      )}

      {(canEnd || canClose) && (
        <div className={styles.actions}>
          {canEnd && <Button variant="ink" disabled={sv.busy} onClick={() => void sv.end(v.id)}>{SV.end[lang]}</Button>}
          {canClose && !mine && !closing && <Button variant="dangerOutline" disabled={sv.busy} onClick={() => setClosing(true)}>{SV.close[lang]}</Button>}
        </div>
      )}
      {closing && (
        <div className={styles.add}>
          <input aria-label={SV.closeReason[lang]} placeholder={SV.closeReason[lang]} className={styles.field} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <Button variant="danger" disabled={sv.busy || !reason.trim()} onClick={() => { void sv.close(v.id, reason.trim()).then((ok) => { if (ok) { setClosing(false); setReason(''); } }); }}>{SV.closeConfirm[lang]}</Button>
          <Button variant="ghost" onClick={() => setClosing(false)}>{SV.cancel[lang]}</Button>
        </div>
      )}
    </article>
  );
}
