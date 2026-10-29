import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { decisionRecordLink, inspectionsSettledForLinks, selectDecisionsAwaitingAction, selectOpenReinspections, selectReviewPending, selectActiveReview, selectFailedCount, selectTotalWorkers, selectPhotoStats, selectProjectProgress, phaseRollup } from '@/store/selectors';
import { API_BASE, dailyLogReadMode } from '@/data/apiGateway';
import { decisionsSliceSettled, inspectionsSliceSettled } from '@/lib/notifications';
import { useNavItems } from '@/layout/useNavItems';
import { useHomeNav } from '@/lib/homeNav';
import { DashboardActionsLine } from './DashboardActionsLine';
import { decisionsWaitOn, failedWaitOn, reviewsWaitOn } from './dashboardWaitingOn';
import { ROUTE_ONLY_SCREENS, SCREEN_MODULE } from '@/lib/screens';
import type { ScreenKey } from '@vitan/shared';
import { Eyebrow, Button, ProgressBar } from '@/components';
import { AddSitePhoto } from '@/components/AddSitePhoto';
import { EmptyHint } from '@/guide/EmptyHint';
import { SitePhotoDelete } from '@/components/SitePhotoDelete';
import { queuedSitePhotos } from '@/lib/queuedSitePhotos';
import { ArrowUpRight, ArrowRight } from '@/lib/icons';
import { stampText } from '@/lib/captureStamp';
import { swatch as swatchGradient, dashboardLabels as L, dashboardText as T, inspectionTitle, sitePhotoDeletable, sitePhotoWho, type Lang, type WaitParty } from '@vitan/shared';
import styles from './responsive.module.css';

/** Top 10 #2 (#771) — a count whose slice has not settled is shown as unknown, never as 0. */
const UNKNOWN = '—';
const unknownSub = (failed: boolean, lang: Lang): string => (failed ? L.loadFailed[lang] : L.loading[lang]);

export function DashboardScreen() {
  // #811 — every role lands here, so a part shows only to a role that holds where it leads: the review queue is
  // served to the PMC alone, and a tile or button never opens a screen the viewer would be bounced from.
  // #822 — "holds" is the nav's own screen set (`useNavItems`: the role's screens, filtered by the project's
  // enabled modules and capabilities, plus the decider's approval route), so a module the project switched off
  // offers no Dashboard way in either
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const navItems = useNavItems();
  const navScreens = new Set<ScreenKey>(navItems.map((n) => n.key));
  // Stage 1 H2 (#482) — on a project whose `home-nav` switch is on, one line carries the For You badge's number
  const homeNav = useHomeNav();
  const forYou = navItems.find((n) => n.key === 'inbox');
  // #857 Codex 4269224400 — plus the role's link-only screens (the client's `/decisions`, where an unsettled
  // slice sends the approvals tile so retained rows never offer live controls), while their module is on (#822)
  const enabledModules = useStore((s) => s.enabledModules);
  const canOpen = (screen: ScreenKey): boolean =>
    navScreens.has(screen)
    || ((ROUTE_ONLY_SCREENS[role] ?? []).includes(screen)
      && (!enabledModules.length || enabledModules.includes(SCREEN_MODULE[screen] ?? '')));
  // Top 10 #2 (#771) — the decisions awaiting action, the server's `countPending` definition (the Portfolio
  // card's number for this project), never a second definition of "pending"
  const pending = useStore(useShallow(selectDecisionsAwaitingAction));
  // …and never a confident 0 from a slice that has not landed: a live tile reads "—" until its slice settles
  const decisionsKnown = useStore((s) => decisionsSliceSettled(s) && (!API_BASE || s.projectLoadState === 'ready'));
  const inspectionsKnown = useStore((s) => inspectionsSliceSettled(s) && (!API_BASE || s.projectLoadState === 'ready'));
  const photosKnown = useStore((s) => s.projectLoadState === 'ready');
  const decisionsFailed = useStore((s) => s.decisionsLoad === 'error');
  const inspectionsFailed = useStore((s) => s.inspectionsLoad === 'error');
  const reviewPending = useStore(selectReviewPending);
  const activeReview = useStore(selectActiveReview);
  // Top 10 #2b (#771) — live: the failed items in re-inspections not yet decided (the old count read the
  // review queue, which a rejection leaves, so it was always 0 once re-inspection was sent)
  const reinspections = useStore(useShallow(selectOpenReinspections));
  const demoFailedCount = useStore(selectFailedCount);
  const failedCount = API_BASE ? reinspections.items : demoFailedCount;
  const workers = useStore(selectTotalWorkers);
  const materialsCount = useStore((s) => s.dailyLog?.materials.length ?? 0);
  const checkedIn = useStore((s) => s.dailyLog?.checkedIn ?? false);
  const submitted = useStore((s) => s.dailyLog?.submitted ?? false);
  // #818 Codex 4255945769 — under the daily-log module read, the strip shows the log's facts only once that read
  // has landed: a failed read is unavailable with a Retry (the Daily Log screen's rule), never "Awaiting check-in"
  // and zeros invented from an absent log
  const dailyLogLoad = useStore((s) => s.dailyLogLoad);
  const logPending = dailyLogReadMode() === 'moduleQuery' && dailyLogLoad !== 'ready';
  const logFailed = logPending && dailyLogLoad === 'error';
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const setScreen = useStore((s) => s.setScreen);
  const openItem = useStore((s) => s.openItem);
  // Top 10 #3 (#774) — the one review a single-review tile names opens AT that review, not the queue
  const onlyReviewId = useStore((s) => {
    if (!inspectionsSettledForLinks(s)) return null; // #775 Codex 4239201827 — never from a stale slice
    const open = s.reviews.filter((r) => !r.decided);
    return open.length === 1 ? open[0].id : null;
  });
  const flash = useStore((s) => s.flash);
  // live project identity — never the PROJECT seed, so switching projects re-labels this screen
  const name = useStore((s) => s.name);
  const descriptor = useStore((s) => s.descriptor);
  const stage = useStore((s) => s.stage);
  const siteCode = useStore((s) => s.siteCode);
  // B7 (F-12): derived from the activities, so it moves as work is accepted (see selectProjectProgress)
  const progressNow = useStore(useShallow(selectProjectProgress));
  const phases = useStore(useShallow((s) => s.phases));
  const activities = useStore(useShallow((s) => s.activities));
  const photoStats = useStore(useShallow(selectPhotoStats));
  // a delete took a photo out of a full window: still a window of the newest, so still "at least" until a snapshot
  // rebuilds it (Codex 4337661439)
  const photosCapped = useStore((s) => s.photosWindowShort) || photoStats.capped;
  const recordedPhotos = useStore(useShallow((s) => s.photos));
  // #482 site photos: a photo picked with no signal shows first at once, until its upload is sent
  const outbox = useStore((s) => s.outbox);
  // and one whose online send lost its answer, queued by its key and shown from this phone's copy (#917)
  const keptPhotos = useStore((s) => s.sitePhotosKept);
  const userName = useStore((s) => s.userName);
  // #482 site photos: past the newest four, the viewer's own photos still in their hour, from the window and from the
  // snapshot's list of those past it (Codex 4316959529, 4322976249). The PMC's and engineer's Delete has no hour.
  const myDeletablePhotos = useStore(useShallow((s) => s.myDeletablePhotos));
  // a queued photo is this viewer's own pick: it says their name; its role and time come once the server records it.
  // One the server already holds shows once, as recorded, whether in the window or in the own list past it (Codex 4339094796)
  const queuedPhotos = useMemo(
    () => (API_BASE ? queuedSitePhotos(outbox, [...recordedPhotos, ...myDeletablePhotos], keptPhotos).map((p) => (userName ? { ...p, by: userName } : p)) : []),
    [outbox, recordedPhotos, myDeletablePhotos, keptPhotos, userName],
  );
  const sitePhotos = useMemo(() => [...queuedPhotos, ...recordedPhotos], [queuedPhotos, recordedPhotos]);
  // re-read at the earliest deadline among them, so a card whose hour is up leaves (Codex 4322976255)
  const [photoClock, setPhotoClock] = useState(() => Date.now());
  const extraPhotos = useMemo(
    () => [...sitePhotos.slice(4), ...myDeletablePhotos].filter((p) => p.deletableUntil && sitePhotoDeletable(p, photoClock)),
    [sitePhotos, myDeletablePhotos, photoClock],
  );
  useEffect(() => {
    const deadlines = extraPhotos.map((p) => Date.parse(p.deletableUntil!)).filter(Number.isFinite);
    if (deadlines.length === 0) return;
    // a deadline already past fires at once
    const timer = setTimeout(() => setPhotoClock(Date.now()), Math.max(0, Math.min(...deadlines) - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [extraPhotos]);
  // the photos tile counts the queued photos with the recorded ones, and the places among all of them
  const photoZones = useMemo(() => new Set(sitePhotos.map((p) => p.nodeId).filter(Boolean)).size, [sitePhotos]);
  const timeZone = useStore((s) => s.timeZone);
  // the milestone strip is the project's own phases, read LIVE from their activities (the stored
  // `donePct` is only the snapshot's initial count): done = every activity accepted, started = any
  // accepted or under way. Empty projects show none.
  const milestones = phases.map((p) => {
    const r = phaseRollup(activities, p.id);
    const done = r.activityTotal > 0 && r.done === r.activityTotal;
    // a blocked activity that has ACTUALLY started (labour mismatch keeps its actual start) is still
    // work begun — a phase whose only started work is now blocked must not read as not started
    const begunButBlocked = activities.some((a) => a.phaseId === p.id && a.status === 'blocked' && (a.as != null || !!a.actualStartDate));
    const started = !done && (r.done > 0 || r.inProgress > 0 || r.awaitingSignoff > 0 || begunButBlocked);
    return { id: p.id, label: p.name, done, started, summary: T.phaseSummary(p.name, r.done, r.activityTotal, lang) };
  });

  const siteStatus = logFailed ? L.logFailed[lang] : logPending ? L.logLoading[lang] : submitted ? L.logSubmitted[lang] : checkedIn ? L.logging[lang] : L.awaitingCheckIn[lang];
  const siteDot = logPending ? 'var(--muted)' : checkedIn ? 'var(--green-solid)' : 'var(--amber-solid)';

  // #818 Codex 4255468689 — the approvals tile opens where the viewer acts on them, the action queue's rule: the
  // approval screen when every decision it counts awaits THIS viewer as decider (`decisionRecordLink`, the bell's
  // rule, so a retained row never opens live controls), else the Decision Log, which reads every state
  const approvalsScreen = useStore((s) => {
    const mine = selectDecisionsAwaitingAction(s);
    return mine.length > 0 && mine.every((d) => decisionRecordLink(s, d).screen === 'client-decisions') ? 'client-decisions' : 'decision-log';
  });
  // `onClick` stays optional: a tile with nowhere to go renders as a plain box (B5)
  const openApprovals = canOpen(approvalsScreen) ? () => setScreen(approvalsScreen) : undefined;
  // Stage 1 H3 (#482) — with the home-nav switch on, a tile with items says whom they wait on, ahead of today's line
  const decisionsWait = useStore(decisionsWaitOn);
  const reviewsWait = useStore(reviewsWaitOn);
  const failedWait = useStore(failedWaitOn);
  const waitSub = (party: WaitParty | null, sub: string): string => (homeNav && party ? `${T.waitingOn(party, lang)} · ${sub}` : sub);
  // …and the site photo tile reads in the viewer's language (today it is English only)
  const photoLang: Lang = homeNav ? lang : 'en';
  const tiles: Array<{ key: string; label: string; value: number | string; accent: string; sub: string; onClick?: () => void }> = [
    decisionsKnown
      ? { key: 'pending', label: L.pendingTile[lang], value: pending.length, accent: 'var(--amber-solid)', sub: pending.length ? waitSub(decisionsWait, T.oldestAgeing(Math.max(...pending.map((d) => d.ageDays ?? 0)), lang)) : L.allCleared[lang], onClick: openApprovals }
      : { key: 'pending', label: L.pendingTile[lang], value: UNKNOWN, accent: 'var(--amber-solid)', sub: unknownSub(decisionsFailed, lang), onClick: openApprovals },
  ];
  if (canOpen('inspect-review')) tiles.push(
    inspectionsKnown
      ? { key: 'review', label: L.reviewTile[lang], value: reviewPending, accent: 'var(--accent)', sub: reviewPending > 1 ? waitSub(reviewsWait, T.inQueue(reviewPending, lang)) : reviewPending === 1 ? waitSub(reviewsWait, activeReview ? inspectionTitle(activeReview, lang) : L.onePending[lang]) : L.nothingPending[lang], onClick: () => (onlyReviewId ? openItem('inspect-review', onlyReviewId) : setScreen('inspect-review')) }
      : { key: 'review', label: L.reviewTile[lang], value: UNKNOWN, accent: 'var(--accent)', sub: unknownSub(inspectionsFailed, lang), onClick: () => setScreen('inspect-review') },
    // API mode never claims WHICH items failed beyond the recorded count — the seeded
    // "Drain slope · Terrace" copy is demo-only prototype fidelity
    // #771 — a live server that did not report open-checklist lineage leaves the count unknown, not 0
    inspectionsKnown && API_BASE && !reinspections.known
      ? { key: 'failed', label: L.failedTile[lang], value: UNKNOWN, accent: 'var(--red-solid)', sub: L.reinspectionUnknown[lang], onClick: () => setScreen('inspect-review') }
      : inspectionsKnown
      ? { key: 'failed', label: L.failedTile[lang], value: failedCount, accent: 'var(--red-solid)', sub: failedCount ? waitSub(failedWait, API_BASE ? T.inReinspections(reinspections.count, lang) : 'Drain slope · Terrace') : L.none[lang], onClick: () => setScreen('inspect-review') }
      : { key: 'failed', label: L.failedTile[lang], value: UNKNOWN, accent: 'var(--red-solid)', sub: unknownSub(inspectionsFailed, lang), onClick: () => setScreen('inspect-review') },
  );
  tiles.push(
    // B7 (F-13): COMPUTED from the placed photos in every mode — the demo's fixed "24 this week ·
    // 6 zones" contradicted the strip above. The strip shows the daily log's reported count; this,
    // every photo on record.
    // The snapshot carries the newest SNAPSHOT_SITE_PHOTO_LIMIT only: a full window is "at least", and its
    // places are the places among those (Codex 4194155412) — never presented as the total on record.
    {
      key: 'photos', label: L.photosTile[photoLang], value: photosCapped ? `${sitePhotos.length}+` : sitePhotos.length, accent: 'var(--green-solid)',
      sub: photosCapped
        ? `${T.photosLatest(sitePhotos.length, photoLang)}${photoZones > 0 ? ` · ${T.photosAcross(photoZones, photoLang, true)}` : ''}`
        : photoZones > 0 ? T.photosAcross(photoZones, photoLang) : sitePhotos.length > 0 ? L.photosNotPlaced[photoLang] : L.photosNone[photoLang],
      onClick: canOpen('places') ? () => setScreen('places') : undefined,
    },
  );

  // demo-only prototype highlights; API mode renders the project's own photos (or an honest absence)
  const highlights = [
    { title: 'Living — marble laid', date: '02 JUL 2026', swatch: 'marble' },
    { title: 'Master bath — CP fitted', date: '01 JUL 2026', swatch: 'chrome' },
    { title: 'Staircase — glass railing', date: '30 JUN 2026', swatch: 'glass' },
    { title: 'Terrace — ponding test', date: '02 JUL 2026', swatch: 'water' },
  ];

  return (
    <div className={`${styles.screen} ${styles.wide}`}>
      <div className={styles.headRule} style={{ marginBottom: 24 }}>
        <div>
          <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
          <div style={{ fontSize: 30, fontWeight: 700, marginTop: 5, letterSpacing: '-.01em' }}>{name}</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            {descriptor && <span>{descriptor}</span>}
            {descriptor && stage && <span>·</span>}
            {stage && <span>{stage}</span>}
            {siteCode && <span>·</span>}
            {siteCode && <span>{T.siteCode(siteCode, lang)}</span>}
          </div>
        </div>
        {/* Top 10 #1 / live-bug 6 (#769) — no server export exists, so a live project shows no report action at
            all (never a simulated one, and no dead control); the API-less demo keeps its prototype flash */}
        {/* #818 Codex 4255945761 — the demo's report action is the PMC's; other roles now land here too */}
        {!API_BASE && role === 'pmc' && (
          <Button variant="ink" onClick={() => flash(L.weeklyReportDone[lang])}>
            {L.weeklyReport[lang]} <ArrowUpRight size={15} />
          </Button>
        )}
      </div>

      {homeNav && forYou && <DashboardActionsLine badge={forYou.badge} onOpen={() => setScreen('inbox')} />}

      {/* milestone progress */}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '20px 24px', marginBottom: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{L.milestones[lang]}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent)', fontWeight: 600 }} data-testid="dash-progress-pct">{progressNow.pct === null ? '—' : T.percentComplete(progressNow.pct, lang)}</span>
        </div>
        <ProgressBar pct={progressNow.pct ?? 0} />
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }} data-testid="dash-progress-basis">
          {progressNow.basis === 'derived'
            ? T.activitiesAccepted(progressNow.done, progressNow.total, lang)
            : progressNow.basis === 'recorded'
              ? L.progressRecorded[lang]
              : progressNow.basis === 'unavailable'
                ? L.progressUnavailable[lang]
                : L.progressLoading[lang]}
          {/* #818 Codex 4255945778 — the retry is here, not on the Schedule, which most roles do not hold */}
          {progressNow.basis === 'unavailable' && (
            <button type="button" onClick={requestFreshSnapshot} data-testid="dash-progress-retry" style={{ marginLeft: 8, background: 'transparent', border: '1px solid var(--hairline)', borderRadius: 7, padding: '4px 10px', minHeight: 32, font: 'inherit', fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}>
              {L.retry[lang]}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
          {milestones.map((m) => (
            <div key={m.id} style={{ textAlign: 'center', flex: 1 }} title={m.summary}>
              <div
                role="img"
                aria-label={m.summary}
                data-testid={`milestone-${m.id}`}
                data-state={m.done ? 'done' : m.started ? 'started' : 'not-started'}
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: '50%',
                  margin: '0 auto 6px',
                  background: m.done ? 'var(--green-solid)' : 'transparent',
                  border: m.done ? 'none' : m.started ? '2px solid var(--green-solid)' : '1.5px solid rgba(35,33,28,.3)',
                }}
              />
              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{m.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* live from site today */}
      <div data-surface="ink" style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', borderRadius: 12, padding: '16px 22px', marginBottom: 22, display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingRight: 22, borderRight: '1px solid rgba(237,231,218,.14)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: siteDot }} />
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.18em', color: 'rgba(237,231,218,.62)' }}>{L.liveFromSite[lang]}</div>
            <div style={{ fontWeight: 600, fontSize: 14, marginTop: 2 }}>{siteStatus}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flex: 1, justifyContent: 'space-around', gap: 12, minWidth: 220 }}>
          {[
            { v: logPending ? UNKNOWN : workers, l: L.workers[lang] },
            { v: logPending ? UNKNOWN : materialsCount, l: L.materials[lang] },
            // no photo figure here: the daily log's self-reported count (DailyLog.progress, not linked
            // to media) read as a contradiction beside the "Site photos on record" tile below
          ].map((s) => (
            <div key={s.l} style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 22 }}>{s.v}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.1em', color: 'rgba(237,231,218,.62)', marginTop: 2 }}>{s.l}</div>
            </div>
          ))}
        </div>
        {logFailed && <Button variant="ghost" onClick={requestFreshSnapshot} data-testid="dash-daily-log-retry" style={{ background: 'rgba(237,231,218,.1)', border: '1px solid rgba(237,231,218,.2)', color: 'var(--sidebar-text)', padding: '9px 14px', fontSize: 12 }}>
          {L.retry[lang]}
        </Button>}
        {canOpen('site-schedule') && <Button variant="ghost" onClick={() => setScreen('site-schedule')} style={{ background: 'rgba(237,231,218,.1)', border: '1px solid rgba(237,231,218,.2)', color: 'var(--sidebar-text)', padding: '9px 14px', fontSize: 12 }}>
          {L.viewSchedule[lang]} <ArrowRight size={14} />
        </Button>}
      </div>

      {/* KPI tiles */}
      <div className={styles.tiles}>
        {tiles.map((t) => {
          // B5 (F-5): a tile that opens a screen is a real button — reachable by Tab, activated by
          // Enter or Space, named by its label and value. A tile with nowhere to go stays a plain box
          // with no arrow and no pointer, so it never looks clickable.
          const body = (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--muted)', maxWidth: 150, lineHeight: 1.5 }}>{t.label}</div>
                {t.onClick && <ArrowRight size={15} style={{ opacity: 0.5 }} aria-hidden />}
              </div>
              <div data-testid={`tile-${t.key}-value`} style={{ fontSize: 44, fontWeight: 700, lineHeight: 1, margin: '14px 0 8px', color: t.accent }}>{t.value}</div>
              <div data-testid={`tile-${t.key}-sub`} style={{ fontSize: 12, color: 'var(--muted)' }}>{t.sub}</div>
            </>
          );
          const box = { background: 'var(--panel)', border: '1px solid var(--hairline)', borderTop: `3px solid ${t.accent}`, borderRadius: 12, padding: '20px 22px' } as const;
          return t.onClick ? (
            <button
              key={t.key}
              type="button"
              onClick={t.onClick}
              data-testid={`tile-${t.key}`}
              style={{ ...box, cursor: 'pointer', textAlign: 'left', width: '100%', font: 'inherit', color: 'inherit', display: 'block' }}
            >
              {body}
            </button>
          ) : (
            <div key={t.key} data-testid={`tile-${t.key}`} style={box}>{body}</div>
          );
        })}
      </div>

      {/* photo highlights — live projects show their own recorded photos, honestly empty otherwise */}
      <div data-testid="dash-photo-block" style={{ marginTop: 24 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.2em', color: 'var(--muted)', marginBottom: 12 }}>
          {API_BASE ? L.latestPhotos[lang] : 'THIS WEEK · PHOTO HIGHLIGHTS'}
        </div>
        {API_BASE && <AddSitePhoto />}
        {API_BASE ? (
          sitePhotos.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 10, padding: '22px 16px', textAlign: 'center' }}>
              {L.noProgressPhotos[lang]}
              {/* #482 in-app guide: the button to press, once the project's photos are known to be none */}
              {photosKnown && <EmptyHint task="photo" />}
            </div>
          ) : (
            <div className={styles.photos}>
              {/* the snapshot sends the newest photo first (#482) */}
              {/* the newest four, and any older photo still within the viewer's own hour, so that hour's Delete is never
                  out of reach (Codex 4316959529); the PMC's and engineer's Delete has no hour, so it stays on the four */}
              {[...sitePhotos.slice(0, 4), ...extraPhotos].map((p, i) => (
                <div key={p.id} style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--hairline)' }}>
                  <div style={{ height: 120, position: 'relative', background: '#000' }}>
                    <img src={p.url} alt={T.sitePhotoAlt(i + 1, lang)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                  <div style={{ padding: '9px 11px', background: 'var(--panel)' }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'capitalize' }}>{T.photoKind(p.kind, lang)}</div>
                    {/* #482 site photos: who added it, their role on the project and when */}
                    <div data-testid="dash-photo-who" style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2, overflowWrap: 'anywhere' }}>{sitePhotoWho(p, lang, timeZone)}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)', marginTop: 2 }}>{stampText(p.takenAt)}</div>
                    {/* #482 site photos: the viewer deletes a photo they added, within the hour */}
                    <SitePhotoDelete photo={p} />
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className={styles.photos}>
            {highlights.map((p) => (
              <div key={p.title} style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--hairline)' }}>
                <div style={{ height: 120, background: swatchGradient(p.swatch), position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 8, top: 8, fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '.15em', color: 'rgba(255,255,255,.85)', background: 'rgba(0,0,0,.35)', padding: '2px 6px', borderRadius: 3 }}>PHOTO</span>
                </div>
                <div style={{ padding: '9px 11px', background: 'var(--panel)' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>{p.title}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)', marginTop: 2 }}>{p.date}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
