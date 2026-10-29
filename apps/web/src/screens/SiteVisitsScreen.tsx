import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { can, forYouRole, removalReasonShows, SITE_VISIT_REMOVAL_REASON_MAX, type Lang, type ProjectMember, type Role } from '@vitan/shared';
import { useStore } from '@/store/store';
import { Button, Modal } from '@/components';
import { PhotoMarkup } from '@/components/PhotoMarkup';
import { MediaPlayer } from '@/components/MediaPlayer';
import { trailOf } from '@/lib/locationTree';
import { mayAddPhoto, useSiteVisits, VIDEO_MAX_MS, VOICE_MAX_MS } from '@/lib/useSiteVisits';
import { clockText, pickRecordType, RecordError, startRecording, type Recorded, type Recording, type RecordKind, type RecordOptions } from '@/lib/mediaRecorder';
import { UPLOAD_IMAGE_MIMES } from '@/lib/shrinkPhoto';
import { refusalWords, SV, visitTime } from '@/lib/siteVisitWords';
import { stampText } from '@/lib/captureStamp';
import { resolveMediaUrl, type SiteVisit, type SiteVisitFile, type SiteVisitRating, type SiteVisitRemoval } from '@/data/apiGateway';
import { guideRunToken } from '@/guide/outcomes';
import { useVisitGuideReports } from '@/guide/visitGuideReports';
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
  // #482: the visit guide's reports, from what this screen shows
  const guideReports = useVisitGuideReports(sv.visits, sv.read, sv.waiting, sv.notSent, me, sv.load !== 'loading');
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
  // M3: the photo being marked up stays open only while the viewer may still add to its visit and the visit still
  // lists it; a visit closed meanwhile, the viewer no longer present, or a visit no longer shown closes it
  const markup = sv.markup;
  const markupVisit = markup ? sv.visits.find((v) => v.id === markup.visitId) : undefined;
  const markupAllowed = !!markup && mayAddPhoto(markupVisit, role, me) && !!markupVisit?.files?.some((f) => f.mediaId === markup.mediaId);
  const stopMarkup = sv.stopMarkup;
  useEffect(() => { if (markup && !markupAllowed) stopMarkup(); }, [markup, markupAllowed, stopMarkup]);

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
          <Button variant="ink" fullWidth disabled={sv.busy} data-testid="sv-start" data-guide="sv-start" onClick={() => {
            const name = placeOptions.find((p) => p.id === startNode)?.label ?? null;
            const guideRun = guideRunToken();
            void sv.start(startNode || null, name).then((ok) => {
              if (ok) setStartNode('');
              guideReports.started(ok, guideRun);
            });
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
                {recordingKind(p.mime)
                  ? <div className={styles.voice}><MediaPlayer url={p.url} mime={p.mime} label={p.note ?? fileName(p.mime, lang)} words={playWords(lang, p.mime)} /></div>
                  : <img className={styles.thumb} src={p.url} alt={p.note ?? SV.photos[lang]} />}
                <div className={styles.fileText}>
                  {p.copy && <div className={styles.meta}>{SV.markupCopy[lang]}</div>}
                  {p.note && <div>{p.note}</div>}
                  {p.placeName && <div className={styles.meta}>{p.placeName}</div>}
                  <div className={styles.meta}>{/* the server's own words, in every language (Codex 4320122189); a voice refusal in the viewer's */}{p.reason ? `${SV.refused[lang]} ${refusalWords(p.reason, lang)}` : SV.refused[lang]}</div>
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
      {markup?.phase === 'loading' && markupAllowed && (
        <Modal onClose={stopMarkup} labelledBy="sv-markup-opening">
          <div style={{ padding: 16, display: 'grid', gap: 10 }}>
            <p id="sv-markup-opening" role="status" style={{ margin: 0 }}>{SV.markupOpening[lang]}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="light" onClick={stopMarkup}>{SV.cancel[lang]}</Button>
            </div>
          </div>
        </Modal>
      )}
      {markup?.phase === 'open' && markupAllowed && (
        <PhotoMarkup source={markup.blob} lang={lang} busy={sv.busy} notice={sv.markupNotice} onSave={(copy) => { void sv.saveMarkup(copy); }} onCancel={stopMarkup} />
      )}
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

/** M3: a marked-up copy names its original by its place in the visit's photos, with the original's thumbnail, which
 *  opens it (Codex 4327055852). An original the visit does not list now (removed, or not read) is said to be gone,
 *  never guessed. */
function CopyOf({ files, at, copyId, lang }: { files: NonNullable<SiteVisit['files']>; at: number; copyId: string; lang: Lang }) {
  const source = at >= 0 ? files[at] : undefined;
  if (!source) return <div className={styles.meta} data-testid={`sv-copy-of-${copyId}`}>{SV.markupSourceGone[lang]}</div>;
  const label = SV.markupCopyOf[lang].replace('{n}', String(at + 1));
  if (!source.url) return <div className={styles.meta} data-testid={`sv-copy-of-${copyId}`}>{label}</div>;
  return (
    <a className={styles.copyOf} href={resolveMediaUrl(source.url)} target="_blank" rel="noreferrer" data-testid={`sv-copy-of-${copyId}`}>
      <img className={styles.copyThumb} src={resolveMediaUrl(source.url)} alt="" loading="lazy" />
      <span>{label}</span>
    </a>
  );
}

/** #1179: Remove on a visit file the server says the viewer may remove now. It asks once before removing, because the
 *  file goes for everyone and does not come back; the PMC says why when the file is not their own within the hour. When
 *  the hour on one's own file is up, the offer leaves, except the PMC's, which then asks for a reason as the server does.
 *  What went wrong is said beside the file, and stays said once a fresh read withdraws the offer. */
function RemoveFile({ file, lang, pmc, busy, remove }: {
  file: SiteVisitFile; lang: Lang; pmc: boolean; busy: boolean; remove: (file: SiteVisitFile, reason?: string) => Promise<string | null>;
}) {
  const given = file.removable ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const until = given?.until ? Date.parse(given.until) : null;
  const over = until !== null && now >= until;
  const offer = !given ? null : over ? (pmc ? { reasonRequired: true, until: null } : null) : given;
  useEffect(() => {
    if (!given || until === null || over) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [given, until, over]);
  const id = file.mediaId;
  const told = said && <div className={styles.error} role="alert" data-testid={`sv-remove-said-${id}`}>{said}</div>;
  if (!offer) return told || null;
  if (!asking) {
    return (
      <>
        <Button variant="dangerOutline" disabled={busy} data-testid={`sv-remove-${id}`} onClick={() => { setSaid(null); setAsking(true); }}>{SV.remove[lang]}</Button>
        {told}
      </>
    );
  }
  const typed = reason.trim();
  const long = [...typed].length > SITE_VISIT_REMOVAL_REASON_MAX;
  const reasonOk = !offer.reasonRequired || (removalReasonShows(typed) && !typed.includes('\u0000') && !long);
  return (
    <div className={styles.add} data-testid={`sv-remove-ask-${id}`}>
      <div className={styles.meta}>{SV.removeAsk[lang]}{offer.until ? ` ${SV.removeUntil[lang]} ${visitTime(offer.until, lang)}.` : ''}</div>
      {offer.reasonRequired && (
        <input
          aria-label={SV.removeReason[lang]} placeholder={SV.removeReason[lang]} className={styles.field} value={reason}
          disabled={sending} onChange={(e) => setReason(e.target.value)} data-testid={`sv-remove-reason-${id}`}
        />
      )}
      {offer.reasonRequired && long && <div className={styles.meta} data-testid={`sv-remove-long-${id}`}>{SV.removeReasonLong[lang]}</div>}
      <Button variant="danger" disabled={busy || sending || !reasonOk} data-testid={`sv-remove-yes-${id}`} onClick={() => {
        setSending(true);
        setSaid(null);
        void remove(file, offer.reasonRequired ? typed : undefined).then((text) => { setSaid(text); setSending(false); });
      }}>{SV.removeYes[lang]}</Button>
      <Button variant="ghost" disabled={sending} data-testid={`sv-remove-keep-${id}`} onClick={() => { setAsking(false); setReason(''); setSaid(null); }}>{SV.removeKeep[lang]}</Button>
      {told}
    </div>
  );
}

/** #1179: the visit's line for a file taken off it: what it was, who added it, who removed it, when and why. */
function RemovalLine({ r, lang }: { r: SiteVisitRemoval; lang: Lang }) {
  const kind = r.kind === 'voice' ? SV.voiceNote : r.kind === 'video' ? SV.videoClip : r.kind === 'photo' ? SV.photo : SV.file;
  const role = (x: string) => (roleName(x, lang) ? ` · ${roleName(x, lang)}` : '');
  return (
    <li className={styles.retired} data-testid={`sv-removal-${r.mediaId}`}>
      <span>
        {kind[lang]} · {SV.photoBy[lang]} {r.addedByName}{role(r.addedByRole)} · {visitTime(r.addedAt, lang)}
        <br />
        {SV.removedBy[lang]} {r.removedByName}{role(r.removedByRole)} · {visitTime(r.removedAt, lang)}
        <br />
        {r.reason ? `${SV.removalReason[lang]} ${r.reason}` : SV.removedOwn[lang]}
      </span>
    </li>
  );
}

/** Whether the viewer may add or remove places and people on this visit: the server narrows every edit to the
 *  visitor, in the role they started in (SV1-b). */
function editable(v: SiteVisit, role: Role, me: string | null): boolean {
  return v.visitorId === me && v.visitorRole === role && can('siteVisit.edit', role) && v.status !== 'closed';
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
  // one recording at a time on a card: a voice note or a video
  const [recordingNow, setRecordingNow] = useState<RecordKind | null>(null);
  const [reason, setReason] = useState('');
  const [photoNote, setPhotoNote] = useState('');
  const [photoRating, setPhotoRating] = useState<SiteVisitRating | ''>('');
  const [photoPlace, setPhotoPlace] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // M3: the thumbnails this browser decoded, by file, with the link each decoded from: Mark up is offered on a photo
  // only once its own thumbnail has drawn (a HEIC photo where the browser decodes HEIC, never where it does not), and
  // a fresh link waits for its own decode
  const [decoded, setDecoded] = useState<Record<string, string>>({});

  const mine = v.visitorId === me && v.visitorRole === role;
  const canEdit = editable(v, role, me);
  const canEnd = mine && can('siteVisit.end', role) && (v.status === 'open' || (v.status === 'closed' && v.lateEndedAt === null));
  const canClose = can('siteVisit.close', role) && v.status === 'open';
  const standingPlaces = new Set(v.places.filter((p) => !p.retiredAt && p.nodeId).map((p) => p.nodeId));
  // a person stands on the visit once, whatever their role (the server refuses the same person again, re-roled or not)
  const standingPeople = new Set(v.attendees.filter((a) => !a.retiredAt && a.userId).map((a) => a.userId));
  const freePlaces = placeOptions.filter((p) => !standingPlaces.has(p.id));
  // a photo on a visit started without signal waits behind its start
  const canAddPhoto = mayAddPhoto(v, role, me);
  // a stored photo of a type the upload takes (not the phone's own copy, still on its way), whose thumbnail decoded
  const markable = (f: NonNullable<SiteVisit['files']>[number]) =>
    canAddPhoto && !!f.url && f.mediaId !== f.clientKey && UPLOAD_IMAGE_MIMES.includes(f.mime) && decoded[f.mediaId] === f.url;
  // the fields stay as picked while the photo is read and saved on the phone, so what is kept is what was chosen
  const photoBusy = sv.busy;
  // a photo is placed at one of the places this visit walked
  const walked = v.places.filter((p) => !p.retiredAt && p.nodeId);
  const files = v.files ?? [];
  // a copy names its original by its place among the visit's photos, so voice notes and videos between them are not counted
  const photos = files.filter((f) => !recordingKind(f.mime));
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
      {/* SV2: its acts wait behind a photo the phone cannot read just now; the person may send them anyway (Codex 4323247780) */}
      {sv.held.has(v.id) && (
        <div className={styles.note} role="status" data-testid={`sv-held-${v.id}`}>
          {SV.heldStorage[lang]} <Button variant="light" onClick={() => sv.sendAnyway(v.id)}>{SV.sendAnyway[lang]}</Button>
        </div>
      )}
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

      <h2 className={styles.sub}>{SV.files[lang]}</h2>
      {files.length === 0 && <div className={styles.meta}>{SV.none[lang]}</div>}
      <ul className={styles.files}>
        {files.map((f) => (
          <li key={f.mediaId} className={styles.file} data-testid={`sv-file-${f.mediaId}`}>
            {/* a voice note or a video plays where a photo shows; one the phone no longer has (its row is gone) shows without a player */}
            {recordingKind(f.mime) ? (
              <div className={styles.voice}>
                {f.url ? <MediaPlayer url={f.url} mime={f.mime} label={f.note ?? fileName(f.mime, lang)} words={playWords(lang, f.mime)} poster={f.posterUrl ?? undefined} /> : null}
              </div>
            ) : /* a queued photo the phone no longer has a picture of (its row is gone) shows without one until read again */ f.url ? (
              <a href={resolveMediaUrl(f.url)} target="_blank" rel="noreferrer" aria-label={SV.photoOpen[lang]}>
                <img
                  className={styles.thumb} src={resolveMediaUrl(f.url)} alt={f.note ?? SV.photos[lang]} loading="lazy"
                  onLoad={(e) => {
                    const ok = e.currentTarget.naturalWidth > 0;
                    setDecoded((d) => (ok ? { ...d, [f.mediaId]: f.url } : Object.fromEntries(Object.entries(d).filter(([k]) => k !== f.mediaId))));
                  }}
                  onError={() => setDecoded((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== f.mediaId)))}
                />
              </a>
            ) : <div className={styles.thumb} aria-hidden="true" />}
            <div className={styles.fileText}>
              {f.rating && <span className={styles.rating} data-rating={f.rating}>{ratingName(f.rating, lang)}</span>}
              {f.sourceMediaId && <CopyOf files={photos} at={photos.findIndex((x) => x.mediaId === f.sourceMediaId)} copyId={f.mediaId} lang={lang} />}
              {recordingKind(f.mime) && (
                <div className={styles.meta}>{fileName(f.mime, lang)}{typeof f.durationSec === 'number' ? ` · ${clockText(f.durationSec * 1000)}` : ''}</div>
              )}
              {f.note && <div>{f.note}</div>}
              {f.place && <div className={styles.meta}>{f.place.name}</div>}
              <div className={styles.meta}>
                {SV.photoBy[lang]} {f.addedByName}{f.addedByRole ? ` · ${roleName(f.addedByRole, lang)}` : ''} · {visitTime(f.addedAt, lang)}
                {stampText(f.takenAt) && <> · {SV.photoTaken[lang]} {stampText(f.takenAt)}</>}{wait(f.mediaId)}
              </div>
              {markable(f) && (
                <Button variant="light" disabled={sv.busy} data-testid={`sv-markup-${f.mediaId}`} onClick={() => { void sv.openMarkup(v.id, f.mediaId); }}>
                  {SV.markUp[lang]}
                </Button>
              )}
              <RemoveFile file={f} lang={lang} pmc={role === 'pmc'} busy={sv.busy} remove={sv.removeFile} />
            </div>
          </li>
        ))}
      </ul>
      {(v.removals?.length ?? 0) > 0 && (
        <>
          <h3 className={styles.sub}>{SV.removals[lang]}</h3>
          <ul className={styles.items}>
            {v.removals!.map((r) => <RemovalLine key={r.mediaId} r={r} lang={lang} />)}
          </ul>
        </>
      )}
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
              // #482: a photo not kept tells the guide from addPhoto itself
              void sv.addPhoto(v.id, file, { note: photoNote, ...(photoRating ? { rating: photoRating } : {}), ...(photoAt ? { nodeId: photoAt.nodeId!, placeName: photoAt.name } : {}) })
                .then(sent);
            }}
          />
          {/* #482: the visit guide points at the Add photo of the viewer's own open visit (the one it started) */}
          <Button variant="light" disabled={sv.busy} data-guide={v.visitorId === me && v.status === 'open' ? 'sv-add-photo' : undefined} onClick={() => fileRef.current?.click()}>{SV.addPhoto[lang]}</Button>
          {RECORDERS.map((kind) => (
            <MediaRecorderButton
              key={kind} kind={kind} visitId={v.id} lang={lang} busy={sv.busy}
              held={recordingNow !== null && recordingNow !== kind} onActive={(on) => setRecordingNow((k) => (on ? kind : k === kind ? null : k))}
              onRecorded={(rec) => sv.addRecording(kind, v.id, rec, { note: photoNote, ...(photoRating ? { rating: photoRating } : {}), ...(photoAt ? { nodeId: photoAt.nodeId!, placeName: photoAt.name } : {}) })
                .then((ok) => { sent(ok); return ok; })}
            />
          ))}
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

/** A visit file that plays (a voice note or a video clip), by its type; null for a photo. */
const recordingKind = (mime: string): RecordKind | null => (mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : null);
const fileName = (mime: string, lang: Lang) => (mime.startsWith('video/') ? SV.videoClip[lang] : SV.voiceNote[lang]);
const playWords = (lang: Lang, mime: string) => ({ play: SV.play[lang], failed: (mime.startsWith('video/') ? SV.videoPlayFailed : SV.playFailed)[lang], retry: SV.retry[lang] });

/** The recorders a visit card offers, in order: a voice note, then a video clip. */
const RECORDERS: readonly RecordKind[] = ['audio', 'video'];

/** #995 V2b: a video clip records from the back camera where there is one, at about 1 Mbps picture and 64 kbps sound, so a
 *  minute stays inside the upload's size; with the microphone refused (or missing) it records picture only. */
const VIDEO_OPTIONS: RecordOptions = {
  bits: { videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 },
  media: { audio: true, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
  fallback: { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
};

/** What each recorder is called and says, and how long it runs. */
const KINDS: Record<RecordKind, {
  maxMs: number; options?: RecordOptions;
  words: Record<'record' | 'capped' | 'denied' | 'format' | 'unavailable', (typeof SV)[keyof typeof SV]>;
}> = {
  audio: { maxMs: VOICE_MAX_MS, words: { record: SV.recordVoice, capped: SV.voiceCapped, denied: SV.voiceDenied, format: SV.voiceFormat, unavailable: SV.voiceUnavailable } },
  video: { maxMs: VIDEO_MAX_MS, options: VIDEO_OPTIONS, words: { record: SV.recordVideo, capped: SV.videoCapped, denied: SV.videoDenied, format: SV.videoFormat, unavailable: SV.videoUnavailable } },
};

/** Stage 1 voice notes: record a note on the visit (#995 V2b: or a video clip, which shows what the camera sees while it
 *  records). Offered only where this browser's recorder writes a type the upload
 *  takes. It stops itself at the cap and is added then too; Discard keeps nothing. The microphone is let go when the
 *  recording ends, and when the card goes while it runs. What is recorded is handed to the visit-file outbox. */
function MediaRecorderButton({ kind, visitId, lang, busy, held, onActive, onRecorded }: {
  kind: RecordKind;
  visitId: string;
  lang: Lang;
  busy: boolean;
  /** another recorder on this card is starting or running: one recording at a time */
  held: boolean;
  onActive: (on: boolean) => void;
  onRecorded: (rec: Recorded) => Promise<boolean>;
}) {
  const { maxMs, options, words } = KINDS[kind];
  const type = useMemo(() => pickRecordType(kind), [kind]);
  const [live, setLive] = useState<MediaStream | null>(null);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [said, setSaid] = useState<string | null>(null);
  const run = useRef<Recording | null>(null);
  // a start still waiting on the devices (or the camera's first picture): given up when the screen is left
  const starting = useRef<AbortController | null>(null);
  // the recording stays this screen's until it has stopped, so leaving (or Discard) meanwhile still keeps nothing
  const stopping = useRef<Recording | null>(null);
  const alive = useRef(true);
  // the note, rating and place as they are when the recording ends, however it ends (the cap included)
  const recorded = useRef(onRecorded);
  useEffect(() => { recorded.current = onRecorded; });
  // set again on each mount: StrictMode runs the cleanup once before the real mount (as ProjectSwitcher does)
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; starting.current?.abort(); starting.current = null; run.current?.cancel(); run.current = null; };
  }, []);
  // the running time, for the person only: the recording's own cap stops it
  useEffect(() => {
    if (phase !== 'recording') return;
    const began = performance.now();
    setElapsed(0);
    const tick = setInterval(() => setElapsed(performance.now() - began), 250);
    return () => clearInterval(tick);
  }, [phase]);
  // the card holds its other recorder while this one starts or runs
  const active = phase !== 'idle';
  const activeRef = useRef(onActive);
  useEffect(() => { activeRef.current = onActive; });
  useEffect(() => { activeRef.current(active); }, [active]);
  useEffect(() => () => activeRef.current(false), []);
  if (!type) return null;

  const finish = async (rec: Recorded, capped: boolean) => {
    setPhase('idle');
    setLive(null);
    const ok = await recorded.current(rec);
    if (ok && capped && alive.current) setSaid(words.capped[lang]);
  };
  const start = async () => {
    setSaid(null);
    setPhase('starting');
    const given = new AbortController();
    starting.current = given;
    try {
      const r = await startRecording(kind, type, maxMs, { ...options, signal: given.signal });
      if (starting.current === given) starting.current = null;
      if (!alive.current) { r.cancel(); return; }
      run.current = r;
      setLive(r.stream);
      setPhase('recording');
      // stopped by its cap, or ended by the browser: added as if Stop was tapped, unless Stop or Discard came first
      void r.ended.then(({ rec, cause }) => {
        if (run.current !== r || !alive.current) return;
        run.current = null;
        void finish(rec, cause === 'cap');
      });
    } catch (err) {
      if (starting.current === given) starting.current = null;
      if (!alive.current) return;
      setPhase('idle');
      const reason = err instanceof RecordError ? err.reason : 'unavailable';
      setSaid(words[reason][lang]);
    }
  };
  const stop = async () => {
    const r = run.current;
    if (!r || stopping.current === r) return;
    stopping.current = r;
    const rec = await r.stop();
    if (run.current !== r || !alive.current) return;
    run.current = null;
    void finish(rec, false);
  };
  const discard = () => {
    run.current?.cancel();
    run.current = null;
    setLive(null);
    setPhase('idle');
  };
  // voice keeps its own test ids; a video's name its kind
  const id = kind === 'audio' ? visitId : `video-${visitId}`;

  return (
    <>
      {phase === 'recording' ? (
        <div className={styles.recording} role="status" data-testid={`sv-recording-${id}`}>
          {/* what the camera sees, muted: the clip itself is the recorder's */}
          {kind === 'video' && live && (
            <video
              className={styles.preview} muted autoPlay playsInline aria-hidden="true"
              ref={(el) => { if (el && el.srcObject !== live) el.srcObject = live; }}
            />
          )}
          <span>{SV.recording[lang]} {clockText(elapsed)} {SV.recordingOf[lang]} {clockText(maxMs + 500)}</span>
          <Button variant="ink" onClick={() => void stop()}>{SV.voiceStop[lang]}</Button>
          <Button variant="ghost" onClick={discard}>{SV.voiceDiscard[lang]}</Button>
        </div>
      ) : (
        <Button variant="light" disabled={busy || held || phase === 'starting'} data-testid={`sv-record-${id}`} onClick={() => void start()}>
          {phase === 'starting' && kind === 'video' ? SV.videoStarting[lang] : words.record[lang]}
        </Button>
      )}
      {said && <div className={styles.meta} role="status">{said}</div>}
    </>
  );
}
