import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectPending, selectReviewPending, selectActiveReview, selectFailedCount, selectTotalWorkers, selectPhotoStats, selectProjectProgress, phaseRollup } from '@/store/selectors';
import { API_BASE } from '@/data/apiGateway';
import { Eyebrow, Button, ProgressBar } from '@/components';
import { ArrowUpRight, ArrowRight } from '@/lib/icons';
import { stampText } from '@/lib/captureStamp';
import { swatch as swatchGradient } from '@vitan/shared';
import styles from './responsive.module.css';

export function DashboardScreen() {
  const pending = useStore(useShallow(selectPending));
  const reviewPending = useStore(selectReviewPending);
  const activeReview = useStore(selectActiveReview);
  const failedCount = useStore(selectFailedCount);
  const workers = useStore(selectTotalWorkers);
  const materialsCount = useStore((s) => s.dailyLog?.materials.length ?? 0);
  const progress = useStore((s) => s.dailyLog?.progress ?? 0);
  const checkedIn = useStore((s) => s.dailyLog?.checkedIn ?? false);
  const submitted = useStore((s) => s.dailyLog?.submitted ?? false);
  const setScreen = useStore((s) => s.setScreen);
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
  const sitePhotos = useStore(useShallow((s) => s.photos));
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
    return { id: p.id, label: p.name, done, started, summary: `${p.name}: ${r.done} of ${r.activityTotal} activities done` };
  });

  const siteStatus = submitted ? 'Daily log submitted' : checkedIn ? 'Engineer on site · logging' : 'Awaiting check-in';
  const siteDot = checkedIn ? 'var(--green-solid)' : 'var(--amber-solid)';

  // `onClick` stays optional: a tile with nowhere to go renders as a plain box (B5)
  const tiles: Array<{ key: string; label: string; value: number | string; accent: string; sub: string; onClick?: () => void }> = [
    { key: 'pending', label: 'DECISIONS PENDING WITH CLIENT', value: pending.length, accent: 'var(--amber-solid)', sub: pending.length ? `Oldest ageing ${Math.max(...pending.map((d) => d.ageDays ?? 0))} days` : 'All cleared', onClick: () => setScreen('decision-log') },
    { key: 'review', label: 'INSPECTIONS AWAITING REVIEW', value: reviewPending, accent: 'var(--accent)', sub: reviewPending > 1 ? `${reviewPending} in the queue` : reviewPending === 1 ? (activeReview?.title ?? '1 pending') : 'Nothing pending', onClick: () => setScreen('inspect-review') },
    // API mode never claims WHICH items failed beyond the recorded count — the seeded
    // "Drain slope · Terrace" copy is demo-only prototype fidelity
    { key: 'failed', label: 'FAILED ITEMS AWAITING RE-INSPECTION', value: failedCount, accent: 'var(--red-solid)', sub: failedCount ? (API_BASE ? `${failedCount} to re-inspect` : 'Drain slope · Terrace') : 'None', onClick: () => setScreen('inspect-review') },
    // B7 (F-13): COMPUTED from the placed photos in every mode — the demo's fixed "24 this week ·
    // 6 zones" contradicted the strip above. The strip shows the daily log's reported count; this,
    // every photo on record.
    // The snapshot carries the newest SNAPSHOT_SITE_PHOTO_LIMIT only: a full window is "at least", and its
    // places are the places among those (Codex 4194155412) — never presented as the total on record.
    {
      key: 'photos', label: 'SITE PHOTOS ON RECORD', value: photoStats.capped ? `${photoStats.count}+` : photoStats.count, accent: 'var(--green-solid)',
      sub: photoStats.capped
        ? `Latest ${photoStats.count} shown${photoStats.zones > 0 ? ` · across ${photoStats.zones} place${photoStats.zones === 1 ? '' : 's'}` : ''}`
        : photoStats.zones > 0 ? `Across ${photoStats.zones} place${photoStats.zones === 1 ? '' : 's'}` : photoStats.count > 0 ? 'Not placed on the site map yet' : 'None recorded yet',
      onClick: () => setScreen('places'),
    },
  ];

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
          <Eyebrow>PROJECT DASHBOARD</Eyebrow>
          <div style={{ fontSize: 30, fontWeight: 700, marginTop: 5, letterSpacing: '-.01em' }}>{name}</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            {descriptor && <span>{descriptor}</span>}
            {descriptor && stage && <span>·</span>}
            {stage && <span>{stage}</span>}
            {siteCode && <span>·</span>}
            {siteCode && <span>Site Code {siteCode}</span>}
          </div>
        </div>
        {/* Top 10 #1 / live-bug 6 (#769) — no server export exists, so a live project shows no report action at
            all (never a simulated one, and no dead control); the API-less demo keeps its prototype flash */}
        {!API_BASE && (
          <Button variant="ink" onClick={() => flash('Weekly report generated (PDF) — sent to client & contractor.')}>
            Generate Weekly Report <ArrowUpRight size={15} />
          </Button>
        )}
      </div>

      {/* milestone progress */}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '20px 24px', marginBottom: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Milestone Progress</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent)', fontWeight: 600 }} data-testid="dash-progress-pct">{progressNow.pct === null ? '—' : `${progressNow.pct}% complete`}</span>
        </div>
        <ProgressBar pct={progressNow.pct ?? 0} />
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }} data-testid="dash-progress-basis">
          {progressNow.basis === 'derived'
            ? `${progressNow.done} of ${progressNow.total} activities accepted as done`
            : progressNow.basis === 'recorded'
              ? 'No activities planned yet — this is the figure recorded on the project'
              : progressNow.basis === 'unavailable'
                ? 'The activities could not be loaded, so progress is unavailable — open Schedule to retry'
                : 'Loading the activities…'}
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
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.18em', color: 'rgba(237,231,218,.62)' }}>LIVE FROM SITE</div>
            <div style={{ fontWeight: 600, fontSize: 14, marginTop: 2 }}>{siteStatus}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flex: 1, justifyContent: 'space-around', gap: 12, minWidth: 220 }}>
          {[
            { v: workers, l: 'WORKERS ON SITE' },
            { v: materialsCount, l: 'MATERIALS LOGGED' },
            // the daily log's own reported count (DailyLog.progress — not linked to media, so no
            // "today" claim); named apart from the photos-on-record tile below (F-13)
            { v: progress, l: 'PROGRESS PHOTOS · DAILY LOG' },
          ].map((s) => (
            <div key={s.l} style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 22 }}>{s.v}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.1em', color: 'rgba(237,231,218,.62)', marginTop: 2 }}>{s.l}</div>
            </div>
          ))}
        </div>
        <Button variant="ghost" onClick={() => setScreen('site-schedule')} style={{ background: 'rgba(237,231,218,.1)', border: '1px solid rgba(237,231,218,.2)', color: 'var(--sidebar-text)', padding: '9px 14px', fontSize: 12 }}>
          View Schedule <ArrowRight size={14} />
        </Button>
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
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.sub}</div>
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
      <div style={{ marginTop: 24 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.2em', color: 'var(--muted)', marginBottom: 12 }}>
          {API_BASE ? 'LATEST · SITE PHOTOS' : 'THIS WEEK · PHOTO HIGHLIGHTS'}
        </div>
        {API_BASE ? (
          sitePhotos.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 10, padding: '22px 16px', textAlign: 'center' }}>
              No progress photos recorded
            </div>
          ) : (
            <div className={styles.photos}>
              {sitePhotos.slice(-4).reverse().map((p, i) => (
                <div key={p.id} style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--hairline)' }}>
                  <div style={{ height: 120, position: 'relative', background: '#000' }}>
                    <img src={p.url} alt={`Site photo ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                  <div style={{ padding: '9px 11px', background: 'var(--panel)' }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'capitalize' }}>{p.kind}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)', marginTop: 2 }}>{stampText(p.takenAt)}</div>
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
