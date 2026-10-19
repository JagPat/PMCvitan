import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { can, forYouRole, type Lang, type ProjectMember, type Role } from '@vitan/shared';
import { useStore } from '@/store/store';
import { Button } from '@/components';
import { trailOf } from '@/lib/locationTree';
import { useSiteVisits } from '@/lib/useSiteVisits';
import { SV, visitTime } from '@/lib/siteVisitWords';
import { stampText } from '@/lib/captureStamp';
import { resolveMediaUrl, type SiteVisit, type SiteVisitRating } from '@/data/apiGateway';
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
  const [team, setTeam] = useState<'loading' | 'done' | 'failed'>('loading');
  // bumped by Try again on a failed team read
  const [teamAsk, setTeamAsk] = useState(0);

  const placeOptions = useMemo(
    () => nodes.map((n) => ({ id: n.id, label: trailOf(nodes, n.id).map((t) => t.name).join(' › ') })).sort((a, b) => a.label.localeCompare(b.label)),
    [nodes],
  );
  const mineOpen = sv.visits.some((v) => v.visitorId === me && v.status === 'open');
  // the member list is the Team screen's; read it when this viewer can name someone on a visit, and again whenever
  // the server says the project changed (a member removed, re-roled or newly joined). A read that failed, even
  // with an older list on hand, makes the picker offer a retry
  const namesPeople = sv.visits.some((v) => editable(v, role, me));
  useEffect(() => {
    if (!namesPeople) return;
    let on = true;
    setTeam('loading');
    void loadTeam().then((ok) => { if (on) setTeam(ok === false ? 'failed' : 'done'); });
    return () => { on = false; };
  }, [namesPeople, sv.pings, teamAsk, loadTeam]);
  const teamFailed = team === 'failed';

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
      {/* once the open visits are read, or the read failed (no signal): a start queued then, while the viewer
          already had a visit open, is moved onto that visit when the server refuses it (F53, Codex 4278908034) */}
      {can('siteVisit.start', role) && sv.load !== 'loading' && !mineOpen && (
        <section className={styles.card} aria-label={SV.start[lang]}>
          <label className={styles.label} htmlFor="sv-start-place">{SV.startPlace[lang]}</label>
          <select id="sv-start-place" className={styles.field} value={startNode} onChange={(e) => setStartNode(e.target.value)}>
            <option value="">{SV.noPlace[lang]}</option>
            {placeOptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <p className={styles.note}>{SV.locationNote[lang]}</p>
          <Button variant="ink" fullWidth disabled={sv.busy} data-testid="sv-start" onClick={() => {
            const name = placeOptions.find((p) => p.id === startNode)?.label ?? null;
            void sv.start(startNode || null, name).then((ok) => ok && setStartNode(''));
          }}>
            {SV.start[lang]}
          </Button>
        </section>
      )}
      {sv.error && <p role="alert" className={styles.error}>{sv.error}</p>}
      {sv.notice && <p role="status" className={styles.note}>{sv.notice}</p>}
      {sv.queued > 0 && (
        <div className={styles.note} data-testid="sv-waiting">
          {SV.waitingCount[lang]} {sv.queued} <Button variant="light" onClick={sv.sendNow}>{SV.sendNow[lang]}</Button>
        </div>
      )}
      {/* SV2: a photo the server refused, or whose visit could not be started, stays on the phone until read here */}
      {sv.notSent.length > 0 && (
        <section className={styles.card} aria-label={SV.notSent[lang]} data-testid="sv-not-sent">
          <h2 className={styles.sub}>{SV.notSent[lang]}</h2>
          <ul className={styles.files}>
            {sv.notSent.map((p) => (
              <li key={p.key} className={styles.file} data-testid={`sv-not-sent-${p.key}`}>
                <img className={styles.thumb} src={p.url} alt={p.note ?? SV.photos[lang]} />
                <div className={styles.fileText}>
                  {p.note && <div>{p.note}</div>}
                  {p.placeName && <div className={styles.meta}>{p.placeName}</div>}
                  <div className={styles.meta}>{lang === 'en' && p.reason ? `${SV.refused.en} ${p.reason}` : SV.refused[lang]}</div>
                  <Button variant="light" onClick={() => sv.dismiss(p.key)}>{SV.dismiss[lang]}</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
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

/** Whether the viewer may add a photo to this visit: the visitor, or anyone recorded as present on it (Jagrut, 19 Oct
 *  2026), while it is not closed. A photo on a visit started without signal waits behind its start. The server asks
 *  again before it stores a byte. */
function mayAddPhoto(v: SiteVisit, role: Role, me: string | null): boolean {
  if (!me || v.status === 'closed' || !can('media.upload', role)) return false;
  return v.visitorId === me || v.attendees.some((a) => a.userId === me && !a.retiredAt);
}

const RATINGS: { value: SiteVisitRating; word: keyof typeof SV }[] = [
  { value: 'fine', word: 'fine' }, { value: 'concern', word: 'concern' }, { value: 'action_needed', word: 'actionNeeded' },
];
function ratingName(rating: SiteVisitRating, lang: Lang): string {
  return SV[RATINGS.find((r) => r.value === rating)!.word][lang];
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
  const [photoNote, setPhotoNote] = useState('');
  const [photoRating, setPhotoRating] = useState<SiteVisitRating | ''>('');
  const [photoPlace, setPhotoPlace] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const mine = v.visitorId === me && v.visitorRole === role;
  const canEdit = editable(v, role, me);
  const canEnd = mine && can('siteVisit.end', role) && (v.status === 'open' || (v.status === 'closed' && v.lateEndedAt === null));
  const canClose = can('siteVisit.close', role) && v.status === 'open';
  const standingPlaces = new Set(v.places.filter((p) => !p.retiredAt && p.nodeId).map((p) => p.nodeId));
  // a person stands on the visit once, whatever their role (the server refuses the same person again, re-roled or not)
  const standingPeople = new Set(v.attendees.filter((a) => !a.retiredAt && a.userId).map((a) => a.userId));
  const freePlaces = placeOptions.filter((p) => !standingPlaces.has(p.id));
  const canAddPhoto = mayAddPhoto(v, role, me);
  // the fields stay as picked while the photo is read and saved on the phone, so what is kept is what was chosen
  const photoBusy = sv.busy;
  // a photo is placed at one of the places this visit walked
  const walked = v.places.filter((p) => !p.retiredAt && p.nodeId);
  const files = v.files ?? [];
  // a place chosen for the photo and then removed from the visit is no longer offered, so it is not sent either
  const photoAt = walked.find((p) => p.nodeId === photoPlace);
  useEffect(() => { if (photoPlace && !photoAt) setPhotoPlace(''); }, [photoPlace, photoAt]);
  // the fields are locked while a photo goes, so what they hold is that photo's: clear them once it is added
  const sent = (ok: boolean) => { if (ok) { setPhotoNote(''); setPhotoRating(''); setPhotoPlace(''); } };
  // only a member whose membership is active can be named: an invitation not yet taken is refused by the server
  const freeMembers = members.filter((m) => m.status === 'active' && m.userId !== v.visitorId && !standingPeople.has(m.userId));
  const status = v.status === 'open' ? SV.open[lang] : v.status === 'ended' ? SV.ended[lang] : SV.closed[lang];
  // the close form stays only while closing is still possible: the visitor may end it, or another PMC close it, first
  const mayClose = canClose && !mine;
  useEffect(() => { if (!mayClose) setClosing(false); }, [mayClose]);
  const wait = (id: string) => (sv.waiting.has(id) ? ` · ${SV.waiting[lang]}` : '');
  const adjusted = (flag: boolean | null) => (flag ? ` (${SV.adjusted[lang]})` : '');

  return (
    <article className={styles.card} data-testid={`sv-visit-${v.id}`} aria-label={`${v.visitorName} · ${status}`}>
      <div className={styles.row}>
        <strong>{v.visitorName}</strong>
        <span className={styles.chip} data-status={v.status}>{status}{wait(v.id)}</span>
      </div>
      <div className={styles.meta}>{roleName(v.visitorRole, lang)}</div>
      <div className={styles.meta}>
        {SV.startedAt[lang]} {visitTime(v.startedAt, lang)}{adjusted(v.startTimeAdjusted)}
        {v.endedAt && <> · {SV.endedAt[lang]} {visitTime(v.endedAt, lang)}{adjusted(v.endTimeAdjusted)}</>}
        {v.closedAt && <> · {SV.closedAt[lang]} {visitTime(v.closedAt, lang)}</>}
        {v.startPlace && <> · {v.startPlace.name}</>}
      </div>
      {v.location.kind === 'device' && (
        <div className={styles.meta}>{SV.location[lang]}{v.location.approximate ? ` (${SV.approximate[lang]})` : ''}</div>
      )}
      {v.status === 'closed' && v.closeReason && <div className={styles.meta}>{SV.closedBecause[lang]} {v.closeReason}</div>}
      {v.lateEndedAt && <div className={styles.meta}>{SV.lateEnd[lang]} · {visitTime(v.lateEndedAt, lang)}{adjusted(v.lateEndTimeAdjusted)}</div>}

      <h2 className={styles.sub}>{SV.places[lang]}</h2>
      {v.places.length === 0 && <div className={styles.meta}>{SV.none[lang]}</div>}
      <ul className={styles.items}>
        {v.places.map((p) => (
          <li key={p.id} className={p.retiredAt ? styles.retired : undefined}>
            <span>{p.name}{adjusted(p.addedTimeAdjusted)}{p.addedAfterEnd ? ` · ${SV.addedAfterEnd[lang]}` : ''}{p.retiredAt ? ` · ${SV.removed[lang]}` : ''}{wait(p.id)}</span>
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
          <Button variant="light" disabled={sv.busy || !place} onClick={() => {
            const name = placeOptions.find((p) => p.id === place)?.label ?? '';
            void sv.addPlace(v.id, place, name).then((ok) => ok && setPlace(''));
          }}>{SV.addPlace[lang]}</Button>
        </div>
      )}

      <h2 className={styles.sub}>{SV.people[lang]}</h2>
      {v.attendees.length === 0 && <div className={styles.meta}>{SV.none[lang]}</div>}
      <ul className={styles.items}>
        {v.attendees.map((a) => (
          <li key={a.id} className={a.retiredAt ? styles.retired : undefined}>
            <span>{a.name} · {a.kind === 'guest' ? SV.guest[lang] : roleName(a.role, lang)}{a.retiredAt ? ` · ${SV.removed[lang]}` : ''}{wait(a.id)}</span>
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
              const name = members.find((m) => m.userId === userId && m.role === memberRole)?.name ?? '';
              void sv.addMember(v.id, userId, memberRole, name).then((ok) => ok && setPerson(''));
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

      <h2 className={styles.sub}>{SV.photos[lang]}</h2>
      {files.length === 0 && <div className={styles.meta}>{SV.none[lang]}</div>}
      <ul className={styles.files}>
        {files.map((f) => (
          <li key={f.mediaId} className={styles.file} data-testid={`sv-file-${f.mediaId}`}>
            {/* a queued photo the phone no longer has a picture of (its row is gone) shows without one until read again */}
            {f.url ? (
              <a href={resolveMediaUrl(f.url)} target="_blank" rel="noreferrer" aria-label={SV.photoOpen[lang]}>
                <img className={styles.thumb} src={resolveMediaUrl(f.url)} alt={f.note ?? SV.photos[lang]} loading="lazy" />
              </a>
            ) : <div className={styles.thumb} aria-hidden="true" />}
            <div className={styles.fileText}>
              {f.rating && <span className={styles.rating} data-rating={f.rating}>{ratingName(f.rating, lang)}</span>}
              {f.note && <div>{f.note}</div>}
              {f.place && <div className={styles.meta}>{f.place.name}</div>}
              <div className={styles.meta}>
                {SV.photoBy[lang]} {f.addedByName}{f.addedByRole ? ` · ${roleName(f.addedByRole, lang)}` : ''} · {visitTime(f.addedAt, lang)}
                {stampText(f.takenAt) && <> · {SV.photoTaken[lang]} {stampText(f.takenAt)}</>}{wait(f.mediaId)}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {canAddPhoto && (
        <div className={styles.add}>
          <input aria-label={SV.photoNote[lang]} placeholder={SV.photoNote[lang]} className={styles.field} value={photoNote} maxLength={500} disabled={photoBusy} onChange={(e) => setPhotoNote(e.target.value)} />
          <select aria-label={SV.photoRating[lang]} className={styles.field} value={photoRating} disabled={photoBusy} onChange={(e) => setPhotoRating(e.target.value as SiteVisitRating | '')}>
            <option value="">{SV.photoRating[lang]}</option>
            {RATINGS.map((r) => <option key={r.value} value={r.value}>{SV[r.word][lang]}</option>)}
          </select>
          {walked.length > 0 && (
            <select aria-label={SV.photoPlace[lang]} className={styles.field} value={photoPlace} disabled={photoBusy} onChange={(e) => setPhotoPlace(e.target.value)}>
              <option value="">{SV.photoPlace[lang]}</option>
              {walked.map((p) => <option key={p.id} value={p.nodeId!}>{p.name}</option>)}
            </select>
          )}
          {/* No `capture`: on Android it forces the camera and hides the gallery (as AddSitePhoto). */}
          <input
            ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} data-testid={`sv-photo-file-${v.id}`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void sv.addPhoto(v.id, file, { note: photoNote, ...(photoRating ? { rating: photoRating } : {}), ...(photoAt ? { nodeId: photoAt.nodeId!, placeName: photoAt.name } : {}) })
                .then(sent);
            }}
          />
          <Button variant="light" disabled={sv.busy} onClick={() => fileRef.current?.click()}>{SV.addPhoto[lang]}</Button>
        </div>
      )}

      {(canEnd || canClose) && (
        <div className={styles.actions}>
          {canEnd && <Button variant="ink" disabled={sv.busy} onClick={() => void sv.end(v.id)}>{SV.end[lang]}</Button>}
          {mayClose && !closing && <Button variant="dangerOutline" disabled={sv.busy} onClick={() => setClosing(true)}>{SV.close[lang]}</Button>}
        </div>
      )}
      {closing && mayClose && (
        <div className={styles.add}>
          <input aria-label={SV.closeReason[lang]} placeholder={SV.closeReason[lang]} className={styles.field} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <Button variant="danger" disabled={sv.busy || !reason.trim()} onClick={() => { void sv.close(v.id, reason.trim()).then((ok) => { if (ok) { setClosing(false); setReason(''); } }); }}>{SV.closeConfirm[lang]}</Button>
          <Button variant="ghost" onClick={() => setClosing(false)}>{SV.cancel[lang]}</Button>
        </div>
      )}
    </article>
  );
}
