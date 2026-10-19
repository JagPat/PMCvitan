import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { API_BASE, CONNECTIVITY_SIMULATOR, dailyLogReadMode } from '@/data/apiGateway';
import { dailyLogSettledForLinks, decisionRecordLink, selectTotalWorkers, selectVisibleDecisions } from '@/store/selectors';
import { EmptyState, Eyebrow, Swatch, PhotoViewer, Button, RecordBoundary } from '@/components';
import { useRoutedRecord } from '@/lib/useRoutedRecord';
import { AddMaterialModal } from '@/screens/modals/AddMaterialModal';
import { LocationPicker } from '@/components/LocationPicker';
import { pickProgressPhoto } from '@/lib/pickProgressPhoto';
import { dailyLogCommandInFlight, dailyLogSendPending, dailyLogStartPending } from '@/store/dailyLogPending';
import { pathOf } from '@/lib/locationTree';
import { todayCivil } from '@/lib/civilDate';
import { sentOnEarlierDay } from '@/lib/engineerToday';
import { Crosshair, Camera, Plus, Minus, QrCode, TriangleAlert, Check, MapPin, WifiOff, RefreshCw } from '@/lib/icons';
import { can, dailyLogLabels as L, dailyLogText as T, labourLabels, type ScreenKey, type Lang } from '@vitan/shared';
import styles from './responsive.module.css';

export function DailyLogScreen() {
  const dailyLog = useStore((s) => s.dailyLog);
  const photos = useStore(useShallow((s) => s.dailyLog?.photos ?? []));
  const nodes = useStore(useShallow((s) => s.nodes));
  const online = useStore((s) => s.online);
  const queueCount = useStore((s) => s.syncQueue.length + s.outbox.length);
  const total = useStore(selectTotalWorkers);
  const toggleOnline = useStore((s) => s.toggleOnline);
  const checkIn = useStore((s) => s.checkIn);
  const checkOut = useStore((s) => s.checkOut);
  const crewStep = useStore((s) => s.crewStep);
  const openQr = useStore((s) => s.openQr);
  const openItem = useStore((s) => s.openItem);
  // #775 Codex 4239168292 — the referenced decision opens where THIS viewer acts on it (the decider-aware
  // rule every decision link shares); one the viewer is not served opens the Decision Log, which says so
  const linkFor = (decisionId: string): { screen: ScreenKey; item: string } => {
    const s = useStore.getState();
    const d = selectVisibleDecisions(s).find((x) => x.id === decisionId);
    return d ? decisionRecordLink(s, d) : { screen: 'decision-log', item: decisionId };
  };
  const flagMismatch = useStore((s) => s.flagMismatch);
  const submitDailyLog = useStore((s) => s.submitDailyLog);
  const role = useStore((s) => s.role);
  const startDailyLog = useStore((s) => s.startDailyLog);
  // Phase 4 Task 6 (§E/§J) — the pilot LABOUR presence read: canonical per-worker musters +
  // unresolved mismatches for today, shown ALONGSIDE the aggregate crew steppers (which stay
  // display-only and never drive the Team gate). `labourView` is null off-pilot, so the section
  // is absent and the non-pilot daily log renders byte-identically.
  const labourPresence = useStore(useShallow((s) => s.labourView?.presence ?? null));
  const lang = useStore((s) => s.lang);
  // Phase 2 Task 10 (correction, finding 4): under module read-ownership the daily-log read is a
  // SEPARATE async surface from the project snapshot, with its own honest load state. Never claim
  // "No daily log started" until a read has actually SUCCEEDED with null; while it loads show a
  // loading state; on failure show an unavailable/Retry boundary; and lock the mutating commands
  // until it settles. In snapshot mode `dailyLogLoad` stays 'idle' and these gates never trigger.
  const dailyLogLoad = useStore((s) => s.dailyLogLoad);
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const moduleOwned = dailyLogReadMode() === 'moduleQuery';
  const reading = moduleOwned && (dailyLogLoad === 'idle' || dailyLogLoad === 'loading');
  const unavailable = moduleOwned && dailyLogLoad === 'error';
  const actionsLocked = reading || unavailable; // don't mutate a log whose read hasn't settled
  // Top 10 #3 gap 12c (#798) — `/site/log/<dailyLogId>`: a link (a For You card, a brief task, a shared URL) names
  // ONE log. The slice holds the project's latest log only, so a link to another log is "not found" — never the
  // latest log shown under the wrong log's URL.
  const setRouteItem = useStore((s) => s.setRouteItem);
  const projectLoadState = useStore((s) => s.projectLoadState);
  const logSettled = useStore(dailyLogSettledForLinks);
  const record = useRoutedRecord('daily-log', {
    settled: logSettled,
    failed: unavailable || projectLoadState === 'error',
    holds: (id) => dailyLog?.id === id,
  });
  // a start / send already on its way (queued, or committed and not yet read back): the log on
  // screen predates it, so the same command is never offered twice — the rule the store enforces
  const starting = useStore(dailyLogStartPending);
  const sending = useStore(dailyLogSendPending);
  const inFlight = useStore(dailyLogCommandInFlight);
  // a send on its way has already captured what it carries (check-in, crew, photo count): edits
  // made now would be dropped by the reconcile while the server keeps the sent values, so they wait
  // live project identity — never the seeded Ambli copy (Phase 0 Task 7)
  const short = useStore((s) => s.short);
  const location = useStore((s) => s.location);
  const siteLabel = location || short;

  // #482 (QA 15 Oct, item 1) — the site's civil day (the project's zone, IST for most), the same day the
  // Today card and the PMC brief judge. A minute tick moves a screen left open across midnight on.
  const timeZone = useStore((s) => s.timeZone);
  const [, setMinute] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const today = todayCivil(timeZone);

  const fileRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [addingMaterial, setAddingMaterial] = useState(false);
  const [photoNode, setPhotoNode] = useState<string | null>(null); // location spine: place the next photo

  const onPickPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    // read and filed as every "add a photo" control does: the project and the day's log it was chosen in
    pickProgressPhoto(e.target.files?.[0], photoNode);
    e.target.value = ''; // allow re-picking the same file
  };

  const conn = online
    ? { bg: 'var(--green-chip)', border: 'var(--green-border)', dot: 'var(--green-solid)', color: 'var(--green-text)', text: L.online[lang], toggle: L.simulateOffline[lang] }
    : { bg: 'var(--amber-chip)', border: 'var(--amber-border)', dot: 'var(--amber-solid)', color: 'var(--amber-text)', text: T.offline(queueCount, lang), toggle: L.backOnline[lang] };

  const sectionLabel: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.2em', color: 'var(--faint)', margin: '22px 0 10px' };

  // starting a new day leaves the log the URL names: the route is released first, so the viewer's own start is
  // never shown as that log being "not found"
  // #482 (QA 15 Oct, item 7) — the PMC reviews the site's day, the engineer runs it: Check in, Check out and
  // starting a day are hidden for the PMC (the server's permissions are unchanged); adding a photo stays.
  const runsTheDay = role !== 'pmc';
  const mayStart = runsTheDay && can('dailyLog.start', role);

  const startNewDay = () => {
    setRouteItem(null);
    startDailyLog();
  };

  if (record.state !== 'list' && record.state !== 'record') {
    return (
      <div className={styles.mobileScreen}>
        <Eyebrow size={9}>{L.eyebrow[lang]}</Eyebrow>
        <RecordBoundary
          record={record}
          prefix="daily-log"
          lang={lang}
          what={L.what[lang]}
          loadingText={L.boundaryLoading[lang]}
          unavailableText={L.boundaryUnavailable[lang]}
          showAllLabel={L.openCurrent[lang]}
          onShowAll={() => setRouteItem(null)}
          onRetry={requestFreshSnapshot}
        />
      </div>
    );
  }

  // finding 4 — under module ownership, the module read's honest state gates the screen so a
  // still-loading or failed read is NEVER shown as an empty "No daily log started". These only
  // fire when there is no last-good log to show; a failed refresh that RETAINS last-good data
  // (finding 1) falls through to the log below with its mutating actions locked.
  if (reading && !dailyLog) {
    return (
      <EmptyState
        title={L.loadingTitle[lang]}
        detail={L.loadingDetail[lang]}
      />
    );
  }
  if (unavailable && !dailyLog) {
    return (
      <EmptyState
        icon={<WifiOff size={26} />}
        title={L.unavailableTitle[lang]}
        detail={L.unavailableDetail[lang]}
        action={
          <Button variant="ink" onClick={requestFreshSnapshot} data-testid="daily-log-retry">
            <RefreshCw size={15} /> {L.retry[lang]}
          </Button>
        }
      />
    );
  }

  // honest absence: a read has SUCCEEDED and there is no daily log for this project (or we're in
  // snapshot mode where the snapshot slice is authoritative) — offer to start one instead of
  // rendering a fabricated blank log
  if (!dailyLog) {
    return (
      <EmptyState
        title={L.noLogTitle[lang]}
        detail={L.noLogDetail[lang]}
        action={
          mayStart ? (
            <Button variant="ink" onClick={startNewDay} disabled={inFlight} data-testid="start-new-day">
              <Plus size={15} /> {starting ? L.starting[lang] : L.startToday[lang]}
            </Button>
          ) : undefined
        }
      />
    );
  }

  // #482 (QA 15 Oct, item 1) — the latest log was sent on an EARLIER day: it is not today's, so the screen
  // says what the Today card and the brief say — no log yet today — instead of showing yesterday's log as
  // "Submitted". A link that names that log (`/site/log/<id>`) still opens it as a record, and a read that
  // has not settled (or failed) keeps the last-known log with its warning: today's may already exist.
  if (record.state === 'list' && !actionsLocked && sentOnEarlierDay(dailyLog, today)) {
    return (
      <div data-testid="daily-log-no-today">
        <EmptyState
          title={L.noLogToday[lang]}
          detail={`${T.lastLogSent(dailyLog.logDate ? logDateIn(dailyLog, lang) : null, lang)} ${L.noLogDetail[lang]}`}
          action={
            mayStart ? (
              <Button variant="ink" onClick={startNewDay} disabled={inFlight} data-testid="start-new-day">
                <Plus size={15} /> {starting ? L.starting[lang] : L.startToday[lang]}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className={styles.mobileScreen} style={{ flex: 1, paddingBottom: 20 }}>
        {/* Round 2 finding 2: the module read FAILED but last-good data is retained — show an explicit
            stale/unavailable warning + Retry (not silent stale data with dead controls). Retry re-runs
            the scope-guarded module read; on success it applies fresh data, clears dailyLogLoad→ready
            and re-enables the actions locked below. */}
        {unavailable && (
          <div data-testid="daily-log-stale-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px', marginBottom: 12 }}>
            <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
            <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>
              {L.stale[lang]}
            </span>
            <button onClick={requestFreshSnapshot} data-testid="daily-log-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', minHeight: 44, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <RefreshCw size={12} /> {L.retry[lang]}
            </button>
          </div>
        )}
        <div style={{ padding: '10px 0 12px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <Eyebrow size={9}>{L.eyebrow[lang]}</Eyebrow>
            <div style={{ fontWeight: 700, fontSize: 22, marginTop: 4 }}>{short}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{logDateIn(dailyLog, lang)}</div>
          </div>
          {dailyLog.submitted && mayStart && (
            <Button variant="outline" onClick={startNewDay} disabled={actionsLocked || inFlight} data-testid="start-new-day" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5, whiteSpace: 'nowrap' }}>
              <Plus size={15} /> {L.startNewDay[lang]}
            </Button>
          )}
        </div>

        {/* connectivity — Top 10 #1 (#769): the state is simulated (only "Simulate offline" changes it), so a
            production build never shows the row or its toggle (see CONNECTIVITY_SIMULATOR) */}
        {CONNECTIVITY_SIMULATOR && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: conn.bg, border: `1px solid ${conn.border}`, borderRadius: 11, padding: '9px 12px', marginBottom: 14 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: conn.dot, flex: 'none' }} />
            <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: conn.color }} data-testid="conn-text">{conn.text}</span>
            <button onClick={toggleOnline} data-testid="toggle-online" style={{ background: 'transparent', border: '1px solid rgba(35,33,28,.2)', borderRadius: 7, padding: '6px 10px', minHeight: 44, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' }}>
              {conn.toggle}
            </button>
          </div>
        )}

        {/* check-in */}
        {dailyLog.checkedIn ? (
          <div data-surface="ink" style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', borderRadius: 15, padding: 15, display: 'flex', alignItems: 'center', gap: 13 }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, background: 'linear-gradient(135deg,#6b5a48,#3a2f26)', flex: 'none', position: 'relative' }}>
              <span style={{ position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, borderRadius: '50%', background: 'var(--green-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Check size={10} color="#fff" strokeWidth={3} />
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{T.checkedIn(dailyLog.checkinTime, lang)}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'rgba(237,231,218,.62)', marginTop: 2 }}>{T.checkedInWhere(siteLabel, lang)}</div>
            </div>
            {runsTheDay && (
              <button onClick={checkOut} disabled={sending} data-testid="check-out" style={{ background: 'transparent', border: '1px solid rgba(237,231,218,.3)', color: 'var(--sidebar-text)', padding: '8px 11px', minHeight: 44, borderRadius: 8, fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                {L.checkOut[lang]}
              </button>
            )}
          </div>
        ) : runsTheDay && (
          <>
            <button onClick={checkIn} disabled={sending} data-testid="check-in" style={{ width: '100%', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 15, padding: 18, fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
              <Crosshair size={18} /> {L.checkIn[lang]}
            </button>
            {/* the PRESENCE PROOF is not an eyebrow: it tells the worker what this button is about to
                take from their phone, so F-1b's 13px floor applies (#584 review round 1, finding 3). */}
            <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--muted)', marginTop: 7 }}>{L.proof[lang]}</div>
          </>
        )}

        {/* crew */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '22px 0 10px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.2em', color: 'var(--faint)' }}>{L.crewTitle[lang]}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }} data-testid="crew-total">{T.workers(total, lang)}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {dailyLog.crew.map((c, i) => (
            <div key={c.trade} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 12, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 11 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: c.count > 0 ? 'var(--green-solid)' : 'rgba(35,33,28,.18)' }} />
              <div style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{c.trade}</div>
              <button onClick={() => crewStep(i, -1)} disabled={sending} aria-label={T.removeTrade(c.trade, lang)} style={stepBtn}>
                <Minus size={16} />
              </button>
              <div style={{ width: 26, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 15 }}>{c.count}</div>
              <button onClick={() => crewStep(i, 1)} disabled={sending} aria-label={T.addTrade(c.trade, lang)} style={stepBtn}>
                <Plus size={16} />
              </button>
            </div>
          ))}
        </div>
        {/* Top 10 #1 (#769): the QR check-in is a prototype ("Simulate a scan" bumps the crew with no worker
            record) — demo only; live attendance comes from the labour register below */}
        {!API_BASE && (
          <button onClick={openQr} style={{ width: '100%', marginTop: 10, background: '#fff', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 11, padding: 12, minHeight: 44, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 13, color: 'var(--ink)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <QrCode size={16} /> {L.qr[lang]}
          </button>
        )}

        {/* Phase 4 Task 6 (§E) — the pilot labour register: per-worker musters + unresolved
            mismatches from the labour-owned `labour.presence` read (identity joined server-side).
            Display-only here — recording lives in the Labour hub / the worker's own device. */}
        {labourPresence && (
          <div data-testid="daily-log-labour-presence">
            <div style={sectionLabel}>{labourLabels.attendance[lang].toUpperCase()} · {labourPresence.civilDate}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {labourPresence.musters.length === 0 && labourPresence.mismatches.length === 0 && (
                <div data-testid="daily-log-labour-presence-empty" style={{ fontSize: 12, color: 'var(--faint)' }}>—</div>
              )}
              {labourPresence.musters.map((mu) => (
                <div key={`${mu.workerId}-${mu.shift}`} data-testid={`daily-log-muster-${mu.workerId}`} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 12, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 11 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: 'var(--green-solid)' }} />
                  <div style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{mu.workerName}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>
                    {mu.tradeCode} · {mu.shift === 'night' ? labourLabels.shiftNight[lang] : labourLabels.shiftDay[lang]} · {labourLabels.present[lang]}{mu.deviceId ? '' : ' *'}
                  </div>
                </div>
              ))}
              {labourPresence.mismatches.map((mm) => (
                <div key={mm.id} data-testid={`daily-log-labour-mismatch-${mm.id}`} style={{ background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 12, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TriangleAlert size={13} color="var(--amber-text)" style={{ flex: 'none' }} />
                  <div style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>{labourLabels.mismatch[lang]} · {mm.note}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* materials */}
        <div style={sectionLabel}>{L.materialTitle[lang]}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {dailyLog.materials.map((m, i) => (
            <div key={m.name} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 12, display: 'flex', gap: 12 }}>
              <Swatch swatch={m.swatch} size={52} radius={10} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}</div>
                </div>
                {/* Wave 0 / F-1b — the match verdict is SAFETY-CRITICAL, not metadata: it is the
                    sentence that tells the engineer the material in front of them is not the one
                    that was approved. Off 11.5px onto the 13px floor the brief sets for anything
                    that changes what a user must DO, and it keeps the weight it already carried
                    on the mismatch arm. */}
                <div style={{ fontSize: 13, marginTop: 2, color: m.matched ? 'var(--green-text)' : 'var(--red-solid)', fontWeight: m.matched ? 400 : 600 }}>
                  {m.matched ? L.matches[lang] : L.mismatch[lang]}
                  {/* Top 10 #3 (#774) — the decision it is checked against opens at its own record */}
                  {m.decisionId ? (
                    <button type="button" onClick={() => { const link = linkFor(m.decisionId!); openItem(link.screen, link.item); }} data-testid={`material-decision-${i}`} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
                      {m.decisionId}
                    </button>
                  ) : null}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)', marginTop: 3 }}>{m.qty} · {m.zone}</div>
                {/* Wave 0 / F-1b — THE MISMATCH CONTROL, at a real touch target.
                    It was a borderless 9.5px caption wedged against the material name, about
                    84 × 12 px of hit area, and it is the control that stops wrong material
                    reaching the wall. It is now full-width, bordered and 44px tall — the floor
                    every action target is held to — and it sits BELOW the verdict it acts on
                    rather than beside the name, so the thumb reaches it without covering the
                    sentence that prompted it. Same handler, same disabled rule, same test id. */}
                {m.matched && (
                  <button
                    onClick={() => flagMismatch(i)}
                    disabled={actionsLocked}
                    data-testid={`flag-${m.decisionId}`}
                    style={{
                      width: '100%', minHeight: 44, marginTop: 9, padding: '0 12px',
                      background: 'transparent', border: '1px solid var(--red-solid)', borderRadius: 10,
                      color: 'var(--red-solid)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
                      cursor: actionsLocked ? 'not-allowed' : 'pointer', opacity: actionsLocked ? 0.5 : 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
                  >
                    <TriangleAlert size={14} /> {L.flagMismatch[lang]}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        {can('dailyLog.addMaterial', role) && (
          <button onClick={() => setAddingMaterial(true)} disabled={actionsLocked || sending} data-testid="add-material" style={{ width: '100%', marginTop: 10, background: '#fff', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 11, padding: 12, minHeight: 44, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 13, color: 'var(--ink)', cursor: actionsLocked ? 'not-allowed' : 'pointer', opacity: actionsLocked ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Plus size={16} /> {L.recordDelivery[lang]}
          </button>
        )}

        {/* progress */}
        <div style={sectionLabel}>{L.progressTitle[lang]}</div>
        <div style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{T.photos(dailyLog.progress, lang)}</div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>{L.stamped[lang]}</div>
          </div>
          {/* No `capture`: on Android it forces the camera and hides the gallery. The stamp comes from
              the photo's own EXIF (lib/exif.ts), so a gallery pick is stamped just as honestly. */}
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickPhoto} data-testid="progress-file" style={{ display: 'none' }} />
          <button onClick={() => fileRef.current?.click()} disabled={sending} data-testid="add-progress-photo" style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', border: 'none', padding: '10px 14px', minHeight: 44, borderRadius: 9, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Camera size={14} /> {L.add[lang]}
          </button>
        </div>
        {/* Location spine: place the next photo so it shows up at that zone/room/object. */}
        {nodes.length > 0 && (
          <div style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 12, marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em', color: 'var(--faint)', marginBottom: 8 }}>
              <MapPin size={12} /> {L.placePhoto[lang]} {photoNode ? '' : L.optional[lang]}
            </div>
            <LocationPicker value={photoNode} onChange={setPhotoNode} idPrefix="photo-loc" />
            {photoNode && (
              <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6 }}>{L.nextPhoto[lang]} {pathOf(nodes, photoNode).join(' › ')}</div>
            )}
          </div>
        )}
        {photos.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto', paddingBottom: 4 }}>
            {photos.map((p, i) => (
              <button
                key={p.id ?? i}
                onClick={() => setZoom(p.url)}
                data-testid="progress-thumb"
                style={{ flex: 'none', width: 66, height: 66, borderRadius: 10, border: '1px solid rgba(35,33,28,.12)', padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: '#000' }}
              >
                <img src={p.url} alt={T.photoAlt(i + 1, lang)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </button>
            ))}
          </div>
        )}
      </div>

      {zoom && <PhotoViewer url={zoom} onClose={() => setZoom(null)} />}
      {addingMaterial && <AddMaterialModal onClose={() => setAddingMaterial(false)} />}

      {/* #482 (live 19 Oct) — the engineer sends the day to the PMC, and the server refuses a send that was never
          checked in; the PMC has no Check in (above), so it is not offered the send either, only the sent state */}
      {(runsTheDay || dailyLog.submitted) && (
      <div className={styles.stickyFoot} style={{ padding: '12px 16px 20px', borderTop: '1px solid rgba(35,33,28,.1)', background: 'var(--panel)' }}>
        <button
          onClick={submitDailyLog}
          disabled={actionsLocked || inFlight || dailyLog.submitted}
          data-testid="submit-daily-log"
          style={{ width: '100%', maxWidth: 460, margin: '0 auto', display: 'block', padding: 15, borderRadius: 12, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 15, cursor: actionsLocked || inFlight ? 'not-allowed' : 'pointer', opacity: actionsLocked || inFlight ? 0.6 : 1, border: 'none', background: dailyLog.submitted ? 'var(--green-chip)' : 'var(--ink)', color: dailyLog.submitted ? 'var(--green-text)' : 'var(--sidebar-text)' }}
        >
          {dailyLog.submitted ? L.submitted[lang] : sending ? L.sending[lang] : L.submit[lang]}
        </button>
      </div>
      )}
    </div>
  );
}

/* Wave 0 / F-1b — the crew steppers meet the 44×44 action-target floor. One constant, ten
   rendered buttons: they are tapped repeatedly, with a thumb, to set the crew count the day's
   labour record rests on, and 32px is below the floor every action target is held to. */
const stepBtn: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 8,
  border: '1px solid rgba(35,33,28,.18)',
  background: 'var(--panel)',
  cursor: 'pointer',
  color: 'var(--ink)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const LOCALE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', gu: 'gu-IN' };

/** The log's day. English keeps the server's display string; Hindi and Gujarati format the log's
 *  civil date (ISO) in their own month names. It is already the site's day, so it is formatted as-is
 *  (UTC). A row with no usable civil date falls back to the display string. */
function logDateIn(log: { date: string; logDate?: string | null }, lang: Lang): string {
  if (lang === 'en' || !log.logDate) return log.date;
  const at = new Date(`${log.logDate}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return log.date;
  return new Intl.DateTimeFormat(LOCALE[lang], { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
}
