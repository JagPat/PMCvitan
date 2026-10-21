import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, drawingMutationsBlocked } from '@/store/store';
import { resolveDrawingUrl, drawingsReadMode, type IssueDrawingInput } from '@/data/apiGateway';
import { Eyebrow, Button, Modal, LocationContext, EditState, ItemNotFound, ReturnToPlace } from '@/components';
import { drawingsSliceSettled } from '@/lib/notifications';
import { LocationPicker } from '@/components/LocationPicker';
import { pathOf } from '@/lib/locationTree';
import { Download, FileText, History, ChevronRight, X, Plus, Lock, Check, HardHat, MapPin, WifiOff, RefreshCw } from '@/lib/icons';
import { can, drawingDisciplineFor, drawingsLabels as L, drawingsText as T, drawingDisciplineLabels, drawingStatusLabels, drawingDateIn, forYouRole, type Discipline, type Drawing, type DrawingRevision, type Lang } from '@vitan/shared';
import styles from './responsive.module.css';

const DISCIPLINES: Discipline[] = ['architectural', 'structural', 'mep', 'other'];

function statusMeta(status: string, lang: Lang): { label: string; bg: string; fg: string; border: string } {
  if (status === 'for_construction') return { label: drawingStatusLabels.for_construction[lang], bg: 'var(--green-chip, #E7F0E9)', fg: 'var(--green-text, #2F6B44)', border: '#BFD8C6' };
  if (status === 'for_review') return { label: drawingStatusLabels.for_review[lang], bg: 'var(--amber-chip)', fg: 'var(--amber-text)', border: 'var(--amber-border)' };
  return { label: drawingStatusLabels.superseded[lang], bg: 'rgba(35,33,28,.06)', fg: 'var(--faint)', border: 'var(--hairline)' };
}

/** How a revision file previews: PDF inline, image inline, DWG/other download-only. */
function previewKind(mime: string): 'image' | 'pdf' | 'download' {
  if (mime.startsWith('image/') && mime !== 'image/vnd.dwg') return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'download';
}

/** A PDF reader finds the file's `%PDF-` header within its first 1,024 bytes; a file without one never gets this origin. */
async function looksLikePdf(file: Blob): Promise<boolean> {
  return (await file.slice(0, 1024).text()).includes('%PDF-');
}

/** The saved file's extension, from the revision's type, so a CAD app opens it: a blob's name has no other source. */
function fileExtension(mime: string): string {
  if (/dxf/.test(mime)) return '.dxf';
  if (/dwg|acad/.test(mime)) return '.dwg';
  return mime === 'application/pdf' ? '.pdf' : '';
}

/**
 * A PDF revision's file as a `blob:` URL, read with `fetch`. The viewer's <iframe> would navigate to the API, and a
 * navigation there never reaches this site's service worker, so the file could not open offline; a `fetch` from the
 * page does, and the worker answers from its kept copy. The blob is typed as a PDF, and made only from bytes with a PDF
 * header, so a file on this site's origin is never rendered as a page. Null while it is read; the file's own URL when
 * the read fails, is refused or is not a PDF, as before. The read stops, and the blob is let go, when the revision
 * changes or the viewer closes. Any other file is shown from its own URL.
 */
function usePdfUrl(src: string, isPdf: boolean): string | null {
  const direct = !isPdf || src.startsWith('data:');
  const [read, setRead] = useState<{ src: string; url: string } | null>(null);
  useEffect(() => {
    if (direct) return undefined;
    const stop = new AbortController();
    let made: string | undefined;
    fetch(src, { signal: stop.signal, credentials: 'omit' })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`file answered ${res.status}`))))
      .then(async (file) => {
        const pdf = await looksLikePdf(file);
        // closed or moved on while the bytes arrived: no blob from them
        if (stop.signal.aborted) return;
        if (!pdf) throw new Error('not a PDF');
        // re-typed without a copy: the server's type is never trusted
        made = URL.createObjectURL(file.slice(0, file.size, 'application/pdf'));
        setRead({ src, url: made });
      })
      .catch(() => {
        if (!stop.signal.aborted) setRead({ src, url: src });
      });
    return () => {
      stop.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [src, direct]);
  if (direct) return src;
  return read && read.src === src ? read.url : null;
}

/**
 * Saves a CAD revision's file when Download is tapped. The file is read with `fetch`, which this site's service worker
 * answers (from its kept copy when offline), and saved from a blob of plain bytes under `name`. A link pointing at the
 * API would be a navigation the worker never sees. A failed or refused read goes to the file's own URL, as before.
 */
const SAVED_FILE_KEPT_MS = 60_000;

function saveFile(src: string, name: string): Promise<void> {
  const open = (href: string) => {
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    link.click();
  };
  return fetch(src, { credentials: 'omit' })
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`file answered ${res.status}`))))
    .then((file) => {
      const url = URL.createObjectURL(file.slice(0, file.size, 'application/octet-stream'));
      open(url);
      // Some browsers read the blob only once the download starts, after the click returns, so it is let go a minute
      // later rather than at once (Codex, #1057). Until then it holds one file in memory.
      window.setTimeout(() => URL.revokeObjectURL(url), SAVED_FILE_KEPT_MS);
    })
    .catch(() => open(src));
}

export function DrawingsScreen() {
  // drafts are private WIP — the register shows only published drawings
  const drawings = useStore(useShallow((s) => s.drawings.filter((d) => !d.draft)));
  const nodes = useStore(useShallow((s) => s.nodes));
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const memberships = useStore(useShallow((s) => s.memberships));
  const activeProjectId = useStore((s) => s.activeProjectId);
  // Phase 2 Task 10 (Module 2 — Drawings; finding 4): under module read-ownership the drawing register
  // is a SEPARATE async surface from the project snapshot, with its own honest load state. Never claim
  // "No drawings issued yet" until a read has actually SUCCEEDED empty; while it loads show a loading
  // line; on failure show an unavailable/Retry boundary (or a stale banner + paused actions when
  // last-good drawings are retained). In snapshot mode `drawingsLoad` stays 'idle' — gates never fire.
  const drawingsLoad = useStore((s) => s.drawingsLoad);
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const moduleOwned = drawingsReadMode() === 'moduleQuery';
  const reading = moduleOwned && (drawingsLoad === 'idle' || drawingsLoad === 'loading'); // display: loading boundary
  const unavailable = moduleOwned && drawingsLoad === 'error'; // display: unavailable/stale boundary
  // the SINGLE mutation-readiness predicate (Task 10 correction, C3): the same guard the store's actions
  // defensively enforce — Issue/Acknowledge are disabled while the module read is unsettled.
  const actionsLocked = useStore(drawingMutationsBlocked);
  // hold the open drawing by id so the viewer always reflects live store state
  // (e.g. an acknowledgement) rather than a stale snapshot captured on click.
  // B6 — the open drawing is the URL's item (`/drawings/<id>`): shareable, and Back closes it
  const openId = useStore((st) => st.routeItem);
  const setOpenId = useStore((st) => st.setRouteItem);
  const open = openId ? drawings.find((d) => d.id === openId) ?? null : null;
  // Live bug 1c (owner, #482 6063443276) — a link (a push notification, a shared URL) naming a drawing this
  // register does not hold — missing, removed, unpublished or not visible to this viewer — says so once
  // the register has settled; while it is still loading the load boundary stands in, never the whole
  // register under the drawing's URL
  const settled = useStore(drawingsSliceSettled);
  const loadFailed = useStore((s) => s.drawingsLoad === 'error' || s.projectLoadState === 'error');
  const routedAbsent = openId !== null && open === null;
  const missingItem = routedAbsent && settled ? openId : null;
  const unsettledItem = routedAbsent && !settled;
  const [issuing, setIssuing] = useState(false);

  // Discipline-scoped default: a consultant lands on THEIR discipline's drawings (e.g. a
  // lighting consultant → the MEP set), with a one-tap escape to the whole register. Their
  // discipline comes from the active membership (live API); the demo persona has no
  // membership, so a consultant there falls back to a representative discipline.
  const myMembership = memberships.find((m) => m.projectId === activeProjectId);
  const myDiscipline = myMembership?.discipline ?? (role === 'consultant' && memberships.length === 0 ? 'structural' : undefined);
  const scopeKey = role === 'consultant' && myDiscipline ? drawingDisciplineFor(myDiscipline) : null;
  const [scoped, setScoped] = useState(true); // consultants default to their discipline

  const groups = useMemo(() => {
    const all = DISCIPLINES.map((key) => ({ key, label: drawingDisciplineLabels[key][lang], items: drawings.filter((dr) => dr.discipline === key) })).filter((g) => g.items.length);
    return scopeKey && scoped ? all.filter((g) => g.key === scopeKey) : all;
  }, [drawings, scopeKey, scoped, lang]);
  const scopeLabel = scopeKey ? drawingDisciplineLabels[scopeKey]?.[lang] ?? scopeKey : '';

  const intro = T.intro(lang);

  if (unsettledItem) {
    return (
      <div className={`${styles.screen} ${styles.mid}`} data-testid={loadFailed ? 'drawings-unavailable' : 'drawings-loading'}>
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        {loadFailed ? (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14, display: 'grid', gap: 12, justifyItems: 'center' }}>
            <span>{L.loadFailed[lang]}</span>
            <Button data-testid="drawings-retry" onClick={() => requestFreshSnapshot()}>{L.retry[lang]}</Button>
          </div>
        ) : (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{L.loading[lang]}</div>
        )}
      </div>
    );
  }
  if (missingItem) {
    return (
      <div className={`${styles.screen} ${styles.mid}`}>
        <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
        <ItemNotFound what={L.what[lang]} id={missingItem} onShowAll={() => setOpenId(null)} showAllLabel={L.showAll[lang]} lang={lang} />
      </div>
    );
  }

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, maxWidth: 520 }}>
            {intro[0]}<b>{intro[1]}</b>{intro[2]}<b>{intro[3]}</b>{intro[4]}
          </div>
        </div>
        {can('drawing.issue', role) && (
          <Button variant="ink" onClick={() => setIssuing(true)} disabled={actionsLocked} data-testid="issue-drawing" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '11px 15px', fontSize: 13, cursor: actionsLocked ? 'not-allowed' : 'pointer', opacity: actionsLocked ? 0.6 : 1 }}>
            <Plus size={16} /> {L.issue[lang]}
          </Button>
        )}
      </div>

      {/* finding 4 — the module read FAILED but last-good drawings are retained: show an explicit
          stale/unavailable warning + Retry (never silent stale data with a live Issue button). Retry
          re-runs the scope-guarded module read; on success it applies fresh data, clears
          drawingsLoad→ready and re-enables the paused actions. Only shows when there IS a register to
          keep — an empty failed read falls to the unavailable boundary below. */}
      {unavailable && drawings.length > 0 && (
        <div data-testid="drawings-stale-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px', marginTop: 14 }}>
          <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>
            {L.stale[lang]}
          </span>
          <button onClick={() => requestFreshSnapshot()} data-testid="drawings-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={12} /> {L.retry[lang]}
          </button>
        </div>
      )}

      {/* consultant discipline scope — their set by default, one tap to see everything */}
      {scopeKey && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 2px', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.12em', color: 'var(--faint)' }}>{L.showing[lang]}</span>
          <div style={{ display: 'inline-flex', background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 2 }}>
            <button onClick={() => setScoped(true)} data-testid="scope-mine" style={scopeBtn(scoped)}>{T.myDiscipline(scopeLabel, lang)}</button>
            <button onClick={() => setScoped(false)} data-testid="scope-all" style={scopeBtn(!scoped)}>{L.allDisciplines[lang]}</button>
          </div>
        </div>
      )}

      {/* finding 4 — under module read-ownership the register is a SEPARATE async surface: never claim
          "No drawings issued yet" until a read has SUCCEEDED empty. While it loads show a loading line;
          on failure with no last-good register show an unavailable/Retry boundary. In snapshot mode
          `reading`/`unavailable` are false and only the honest-empty branch renders. */}
      {reading && drawings.length === 0 && (
        <div data-testid="drawings-loading" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{L.loading[lang]}</div>
      )}
      {unavailable && drawings.length === 0 && (
        <div data-testid="drawings-unavailable" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><WifiOff size={18} /> {L.unavailableTitle[lang]}</div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>{L.unavailableDetail[lang]}</div>
          <div style={{ marginTop: 14 }}>
            <Button variant="ink" onClick={() => requestFreshSnapshot()} data-testid="drawings-retry-empty" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={15} /> {L.retry[lang]}
            </Button>
          </div>
        </div>
      )}
      {!reading && !unavailable && drawings.length === 0 && (
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{L.none[lang]}</div>
      )}

      {scopeKey && scoped && groups.length === 0 && drawings.length > 0 && (
        <div style={{ marginTop: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
          {T.noneInScope(scopeLabel, lang)}
          {/* #584 review round 11 — the escape from a valid-but-empty discipline scope, measured at
              116 x 15 the first time any walk reached this branch. A zero-padding caption is not a
              target, and this one is the only way out of a screen showing the viewer nothing. */}
          <div style={{ marginTop: 4 }}>
            <button
              onClick={() => setScoped(false)}
              data-testid="scope-all-empty"
              style={{
                minHeight: 44,
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 12px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--accent)',
                fontSize: 13.5,
                fontWeight: 600,
              }}
            >
              {L.showAllDisciplines[lang]}
            </button>
          </div>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key} style={{ marginTop: 26 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.18em', color: 'var(--faint)', marginBottom: 10 }}>{g.label.toUpperCase()}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {g.items.map((d) => {
              const cur = d.current;
              // No governing construction set (Phase 1 Task 3): a drawing whose only
              // live revisions are review copies is labeled, never built from.
              const inReviewOnly = !cur && d.revisions.some((r) => r.status === 'for_review');
              const sm = inReviewOnly
                ? { ...statusMeta('for_review', lang), label: drawingStatusLabels.inReview[lang] }
                : statusMeta(cur?.status ?? 'superseded', lang);
              const place = pathOf(nodes, d.nodeId).join(' › ');
              return (
                <button key={d.id} onClick={() => setOpenId(d.id)} data-testid={`drawing-${d.number}`} style={cardStyle}>
                  <div style={{ width: 46, height: 60, flex: 'none', borderRadius: 6, border: '1px solid var(--hairline)', background: cur ? `center/cover no-repeat url("${resolveDrawingUrl(cur.url)}"), var(--panel)` : 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {!cur && <FileText size={18} color="#b8b2a6" />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13 }}>{d.number}</span>
                      {cur && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 700, color: 'var(--accent)' }}>{T.rev(cur.rev, lang)}</span>}
                      <span style={{ ...chip, background: sm.bg, color: sm.fg, borderColor: sm.border }}>{sm.label}</span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 14.5, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {place ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent)' }}><MapPin size={11} /> {place}</span>
                      ) : (
                        <span>{d.zone ?? '—'}</span>
                      )}
                      {d.activityId ? T.governs(d.activityId, lang) : ''}
                      {d.revisions.length > 1 ? T.revisions(d.revisions.length, lang) : ''}
                    </div>
                  </div>
                  <ChevronRight size={18} color="#b8b2a6" />
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {open && <DrawingViewer drawing={open} onClose={() => setOpenId(null)} />}
      {issuing && <IssueDrawingModal onClose={() => setIssuing(false)} />}
    </div>
  );
}

/** A role chip in the reader's language (the member roles' words are For You's); a role with no label is
 *  shown as served. */
const ROLE_SHORT: Record<string, Record<Lang, string>> = {
  pmc: forYouRole.pmc, client: forYouRole.client, engineer: forYouRole.engineer, contractor: forYouRole.contractor,
  consultant: forYouRole.consultant, architect: forYouRole.architect, worker: { en: 'Worker', hi: 'कारीगर', gu: 'કારીગર' },
};
const roleShort = (role: string, lang: Lang): string => ROLE_SHORT[role]?.[lang] ?? role;

/** The build-acknowledgement block for the current revision (Slice 2). Contractor/
 *  engineer confirm they're building to it; the PMC/everyone sees who has. Reads
 *  the live current revision so a fresh ack shows immediately. */
function AckBlock({ drawing }: { drawing: Drawing }) {
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const acknowledgeDrawing = useStore((s) => s.acknowledgeDrawing);
  // finding 4 / Task 10 correction (C3) — the ack is a mutating command; don't record it against a
  // register whose module read hasn't settled. The SINGLE shared predicate the store also enforces.
  const ackLocked = useStore(drawingMutationsBlocked);
  const rev = drawing.current;
  // Reads the shared policy so the button appears for exactly the roles the API accepts
  // (pmc/engineer/contractor) — previously omitted pmc, who the server allows.
  const canAck = can('drawing.acknowledge', role);
  const acks = rev?.acks ?? [];
  if (!rev) return null;

  return (
    <div style={{ padding: '12px 18px 14px', borderTop: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--faint)', marginBottom: 9 }}>
        <HardHat size={13} /> {T.buildingTo(rev.rev, lang)}
      </div>
      {acks.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: canAck ? 12 : 0 }}>
          {acks.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <Check size={14} color="#2F6B44" />
              <span style={{ fontWeight: 600 }}>{a.userName}</span>
              <span style={{ ...chip, background: 'var(--panel)', color: 'var(--muted)', borderColor: 'var(--hairline)' }}>{roleShort(a.role, lang)}</span>
              <span style={{ fontSize: 11, color: 'var(--faint)', marginLeft: 'auto' }}>{drawingDateIn(a.at, lang)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: canAck ? 12 : 0 }}>{L.noAcks[lang]}</div>
      )}
      {/* the frozen distribution (Phase 1 Task 3): who this revision was ISSUED to and hasn't confirmed yet */}
      {(rev.recipients ?? []).some((r) => !r.acked) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: canAck ? 12 : 0 }} data-testid="ack-outstanding">
          {/* #584 review round 1, finding 3 — the outstanding ISSUED-TO status is the reason a
              revision is still chased, so it carries F-1b's 13px floor rather than eyebrow type. */}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{L.outstanding[lang]}</div>
          {(rev.recipients ?? []).filter((r) => !r.acked).map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted)' }}>
              <span style={{ fontWeight: 600 }}>{r.userName}</span>
              <span style={{ ...chip, background: 'var(--panel)', color: 'var(--muted)', borderColor: 'var(--hairline)' }}>{roleShort(r.role, lang)}</span>
            </div>
          ))}
        </div>
      )}
      {canAck && (
        drawing.ackedByMe ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--green-text, #2F6B44)' }}>
            <Check size={16} /> {T.youBuild(rev.rev, lang)}
          </div>
        ) : (
          <Button variant="ink" onClick={() => acknowledgeDrawing(drawing.id)} disabled={ackLocked} data-testid="ack-drawing" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 15px', fontSize: 13, cursor: ackLocked ? 'not-allowed' : 'pointer', opacity: ackLocked ? 0.6 : 1 }}>
            <HardHat size={15} /> {T.ackButton(rev.rev, lang)}
          </Button>
        )
      )}
    </div>
  );
}

export function DrawingViewer({ drawing, onClose }: { drawing: Drawing; onClose: () => void }) {
  const lang = useStore((s) => s.lang);
  const [rev, setRev] = useState<DrawingRevision>(drawing.current ?? drawing.revisions[0]);
  const src = resolveDrawingUrl(rev.url);
  const kind = previewKind(rev.mime);
  const pdfUrl = usePdfUrl(src, kind === 'pdf');
  const saveAs = `${drawing.number}-Rev${rev.rev}${fileExtension(rev.mime)}`;
  // the file a Download tap is reading: a second tap waits for it, and the viewer says it is coming
  const [saving, setSaving] = useState<string | null>(null);
  const sm = statusMeta(rev.status, lang);
  const isCurrent = drawing.current?.id === rev.id;

  return (
    <Modal onClose={onClose} maxWidth={760} labelledBy="dwg-title">
      {/* #633 — opened from a Site Map place: the way back, inside the viewer that covers the shell */}
      <ReturnToPlace inViewer />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--hairline)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id="dwg-title" style={{ fontWeight: 700, fontSize: 16 }}>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{drawing.number}</span> · {drawing.title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {T.issuedLine(rev.rev, T.issuer(rev.issuedBy, lang), drawingDateIn(rev.issuedAt, lang), lang)}
          </div>
        </div>
        <span style={{ ...chip, background: sm.bg, color: sm.fg, borderColor: sm.border }}>{sm.label}</span>
        {/* Wave 0 / F-1b round 8 — the drawing viewer's dismiss. A glyph with no padding measured
            32x22; it is the only way out of a full-screen sheet on a phone, so it takes the floor. */}
        <button onClick={onClose} aria-label={L.close[lang]} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44 }}>
          <X size={20} />
        </button>
      </div>

      <div style={{ background: '#e9e4d8', maxHeight: '58vh', overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        {kind === 'image' && <img src={src} alt={`${drawing.number} ${T.rev(rev.rev, lang)}`} style={{ maxWidth: '100%', display: 'block' }} />}
        {kind === 'pdf' && !pdfUrl && <div role="status" style={{ fontSize: 13.5, color: 'var(--muted)', padding: 40 }}>{L.openingFile[lang]}</div>}
        {kind === 'pdf' && pdfUrl && <iframe src={pdfUrl} title={`${drawing.number} ${T.rev(rev.rev, lang)}`} style={{ width: '100%', height: '58vh', border: 'none', background: '#fff' }} />}
        {kind === 'download' && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <FileText size={40} color="#b8b2a6" />
            <div style={{ fontSize: 13.5, color: 'var(--muted)', margin: '12px 0 16px', maxWidth: 320 }}>
              {rev.mime.includes('dwg') || rev.mime.includes('dxf') ? L.cadNote[lang] : L.noPreview[lang]}
            </div>
            <a
              href={src}
              download={saveAs}
              onClick={(e) => {
                // a demo drawing's data: URL saves as it is
                if (src.startsWith('data:')) return;
                e.preventDefault();
                if (saving === src) return;
                setSaving(src);
                void saveFile(src, saveAs).finally(() => setSaving((now) => (now === src ? null : now)));
              }}
              style={{ ...dlBtn }}
            >
              <Download size={16} /> {L.download[lang]}
            </a>
            {saving === src && <div role="status" style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 12 }}>{L.savingFile[lang]}</div>}
          </div>
        )}
      </div>

      {rev.note && <div style={{ padding: '12px 18px', fontSize: 12.5, color: 'var(--muted)', borderTop: '1px solid var(--hairline)' }}>{rev.note}</div>}

      <DrawingLocationBlock drawing={drawing} />

      {isCurrent && rev.status !== 'superseded' && <AckBlock drawing={drawing} />}

      <div style={{ padding: '12px 18px 16px', borderTop: '1px solid var(--hairline)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--faint)', marginBottom: 8 }}>
          <History size={13} /> {L.history[lang]}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {drawing.revisions.map((r) => {
            const on = r.id === rev.id;
            const s = statusMeta(r.status, lang);
            return (
              // #584 review round 12 — selecting a revision is an ordinary phone interaction and
              // these rows measured ~35px. Inside the viewer dialog, in the default demo.
              <button key={r.id} onClick={() => setRev(r)} data-testid={`rev-${r.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', minHeight: 44, padding: '9px 11px', borderRadius: 9, cursor: 'pointer', border: `1px solid ${on ? 'var(--ink)' : 'var(--hairline)'}`, background: on ? 'rgba(35,33,28,.04)' : '#fff' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12, minWidth: 42 }}>{T.rev(r.rev, lang)}</span>
                <span style={{ ...chip, background: s.bg, color: s.fg, borderColor: s.border }}>{s.label}</span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1 }}>{drawingDateIn(r.issuedAt, lang)} · {T.issuer(r.issuedBy, lang)}</span>
                {r.status !== 'superseded' && <Lock size={12} color="#2F6B44" />}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/** Location of a drawing on the spine + a PMC re-file control. Everyone sees where the
 *  drawing sits; the PMC (drawing.file) can move it, and rooms below inherit it. */
function DrawingLocationBlock({ drawing }: { drawing: Drawing }) {
  const nodes = useStore(useShallow((s) => s.nodes));
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const fileDrawing = useStore((s) => s.fileDrawing);
  const canFile = can('drawing.file', role);
  // Task 10 correction (C2b) — re-file / unfile are drawing MUTATIONS: never run them against a register
  // whose module read hasn't settled. The SINGLE shared predicate the store also defensively enforces;
  // it's reactive, so if the register goes idle/loading/error while the location editor is OPEN, the
  // picker + Unfile disable immediately and every location mutation command is prevented until 'ready'.
  const locked = useStore(drawingMutationsBlocked);
  const filed = Boolean(drawing.nodeId && nodes.some((n) => n.id === drawing.nodeId));
  const [editing, setEditing] = useState(false);

  return (
    <div style={{ padding: '12px 18px 14px', borderTop: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--faint)', marginBottom: 9 }}>
        <MapPin size={13} /> {L.location[lang]}
      </div>
      {!editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <LocationContext nodeId={drawing.nodeId} fallback={L.unfiled[lang]} lang={lang} compact testId={`drawing-place-${drawing.id}`} />
          {/* Every one of these states used to look the same from outside: a control that was
              simply absent or greyed. Each now states its reason, and offers the action when there is one. */}
          {!canFile ? (
            <EditState
              state="restricted"
              reason={L.onlyPmcFiles[lang]}
              testId="drawing-location-state"
            />
          ) : (
            // The control stays VISIBLE while the register is unsettled — the user can see what
            // will be possible — but it is disabled AND the reason is stated beside it, rather
            // than a greyed button that explains nothing.
            <EditState
              state={locked ? 'paused' : 'editable'}
              reason={
                locked
                  ? L.locationPaused[lang]
                  : filed
                    ? L.canMove[lang]
                    : L.notFiled[lang]
              }
              action={{
                label: filed ? L.move[lang] : L.fileTo[lang],
                onClick: () => { if (!locked) setEditing(true); },
                disabled: locked,
                testId: 'drawing-refile',
              }}
              testId="drawing-location-state"
            />
          )}
        </div>
      )}
      {editing && canFile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {locked && (
            <div data-testid="drawing-location-paused" style={{ fontSize: 12, color: 'var(--amber-text)', background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 9, padding: '7px 10px' }}>
              {L.locationPaused[lang]}
            </div>
          )}
          {/* the picker is inert while locked: pointer-events off + a guarded onChange (belt-and-braces
              with the store's own defensive fileDrawing guard) */}
          <div style={{ pointerEvents: locked ? 'none' : 'auto', opacity: locked ? 0.5 : 1 }} aria-disabled={locked}>
            <LocationPicker value={drawing.nodeId ?? null} onChange={(id) => { if (locked) return; fileDrawing(drawing.id, id); }} idPrefix="dwg-refile" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {drawing.nodeId && (
              <Button variant="outline" disabled={locked} onClick={() => { if (locked) return; fileDrawing(drawing.id, null); setEditing(false); }} data-testid="drawing-unfile" style={{ padding: '7px 12px', fontSize: 12, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.5 : 1 }}>{L.unfile[lang]}</Button>
            )}
            <Button variant="ink" onClick={() => setEditing(false)} style={{ padding: '7px 12px', fontSize: 12, marginLeft: 'auto' }}>{L.done[lang]}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function IssueDrawingModal({ onClose }: { onClose: () => void }) {
  const issueDrawing = useStore((s) => s.issueDrawing);
  const lang = useStore((s) => s.lang);
  const lead = T.newIntro(lang);
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [discipline, setDiscipline] = useState<Discipline>('architectural');
  const [rev, setRev] = useState('A');
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [file, setFile] = useState<{ mime: string; data: string; name: string } | null>(null);
  // Codex #902 — the hidden native input still takes keyboard focus, so the app's own button shows it
  const [fileFocused, setFileFocused] = useState(false);
  const [busy, setBusy] = useState(false);

  const onPick = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      const comma = res.indexOf(',');
      setFile({ mime: f.type || 'application/octet-stream', data: res.slice(comma + 1), name: f.name });
    };
    reader.readAsDataURL(f);
  };

  const ready = number.trim() && title.trim() && rev.trim() && file && !busy;
  const submit = (publish: boolean) => {
    if (!ready || !file) return;
    setBusy(true);
    const input: IssueDrawingInput = { number: number.trim(), title: title.trim(), discipline, rev: rev.trim(), mime: file.mime, data: file.data, status: 'for_construction', publish, ...(nodeId ? { nodeId } : {}) };
    issueDrawing(input);
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={440} labelledBy="issue-title">
      <div style={{ padding: '18px 20px' }}>
        <div id="issue-title" style={{ fontWeight: 700, fontSize: 17 }}>{L.newTitle[lang]}</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{lead[0]}<b>{lead[1]}</b>{lead[2]}<b>{lead[3]}</b>{lead[4]}</div>

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder={L.numberPlaceholder[lang]} style={{ ...fld, flex: 1 }} />
          <input value={rev} onChange={(e) => setRev(e.target.value)} placeholder={L.revPlaceholder[lang]} style={{ ...fld, width: 70 }} />
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L.titlePlaceholder[lang]} style={{ ...fld, marginTop: 10 }} />
        <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)} style={{ ...fld, marginTop: 10 }}>
          {DISCIPLINES.map((d) => <option key={d} value={d}>{drawingDisciplineLabels[d][lang]}</option>)}
        </select>

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)', margin: '14px 0 7px' }}>{L.locationOptional[lang]}</div>
        <div style={{ fontSize: 11.5, color: 'var(--faint)', marginBottom: 7 }}>{L.locationHint[lang]}</div>
        <LocationPicker value={nodeId} onChange={setNodeId} idPrefix="dwg-loc" />

        {/* Wave 0 / F-1b round 7 — the file control rendered 254×21, the smallest target in this
            dialog and the one that actually attaches the drawing. It sits inside a `<label>`, so
            label activation forwards a tap anywhere in the box to the picker: giving the input a
            44px band makes the whole band the target rather than the native button alone. */}
        {/* #482 QA item 3 (Codex) — the browser's own file button and "No file chosen" speak the BROWSER's language,
            so a Hindi or Gujarati viewer gets the app's own button and status instead; English keeps the native control */}
        <label style={lang === 'en' ? { display: 'block', marginTop: 10 } : { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, minHeight: 44, cursor: 'pointer' }}>
          <input
            type="file"
            accept=".pdf,.dwg,.dxf,image/*,application/pdf"
            onChange={(e) => onPick(e.target.files?.[0])}
            onFocus={() => setFileFocused(true)}
            onBlur={() => setFileFocused(false)}
            data-testid="issue-drawing-file"
            style={lang === 'en' ? { fontSize: 13, display: 'block', width: '100%', minHeight: 44 } : visuallyHidden}
          />
          {lang !== 'en' && (
            <>
              <span data-testid="issue-drawing-file-button" style={{ flex: 'none', padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontSize: 13, fontWeight: 600, outline: fileFocused ? '2px solid var(--accent)' : undefined, outlineOffset: 2 }}>{L.chooseFile[lang]}</span>
              <span data-testid="issue-drawing-file-status" style={{ fontSize: 12.5, color: 'var(--muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file ? file.name : L.noFile[lang]}</span>
            </>
          )}
        </label>
        {file && lang === 'en' && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{file.name}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: '0 0 auto', padding: '12px 16px' }}>{L.cancel[lang]}</Button>
          <Button variant="light" onClick={() => submit(false)} disabled={!ready} data-testid="save-draft-drawing" style={{ flex: 1, padding: 12 }}>{L.saveDraft[lang]}</Button>
          <Button variant="ink" onClick={() => submit(true)} disabled={!ready} data-testid="publish-drawing" style={{ flex: 1, padding: 12 }}>{L.publish[lang]}</Button>
        </div>
      </div>
    </Modal>
  );
}

// #584 review round 11 — these two toggles shipped at 26px tall and no sweep had ever measured
// them, because the persona walk took its role list from `TopBar`'s switcher and that switcher
// omitted `consultant`. They are the consultant's primary control on this surface.
/** off screen but still focusable and announced: the picker's own label is the visible control */
const visuallyHidden: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

const scopeBtn = (active: boolean): CSSProperties => ({
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  padding: '6px 11px',
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  fontWeight: 600,
  background: active ? 'var(--ink)' : 'transparent',
  color: active ? '#fff' : 'var(--muted)',
});

const cardStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 13,
  textAlign: 'left',
  width: '100%',
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 13,
  padding: '12px 14px',
  cursor: 'pointer',
};

const chip: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '.08em',
  padding: '3px 7px',
  borderRadius: 5,
  border: '1px solid',
};

const fld: CSSProperties = {
  height: 44,
  padding: '0 12px',
  borderRadius: 10,
  border: '1px solid rgba(35,33,28,.18)',
  background: '#fff',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--ink)',
  outline: 'none',
};

// Wave 0 / F-1b round 8 — 11px of padding around a 16px glyph lands at 41.6, and an `<a download>`
// is a press target like any button. The floor is on the anchor, not on a wrapper.
const dlBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  minHeight: 44,
  padding: '11px 18px',
  borderRadius: 11,
  background: 'var(--ink)',
  color: '#fff',
  fontFamily: 'var(--font-sans)',
  fontWeight: 700,
  fontSize: 14,
  textDecoration: 'none',
};
