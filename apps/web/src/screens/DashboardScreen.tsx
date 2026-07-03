import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectPending, selectReviewPending, selectFailedCount, selectTotalWorkers } from '@/store/selectors';
import { Eyebrow, Button, ProgressBar } from '@/components';
import { ArrowUpRight, ArrowRight } from '@/lib/icons';
import { PROJECT, SEED_MILESTONES, swatch as swatchGradient } from '@vitan/shared';
import styles from './responsive.module.css';

export function DashboardScreen() {
  const pending = useStore(useShallow(selectPending));
  const reviewPending = useStore(selectReviewPending);
  const failedCount = useStore(selectFailedCount);
  const workers = useStore(selectTotalWorkers);
  const materialsCount = useStore((s) => s.dailyLog.materials.length);
  const progress = useStore((s) => s.dailyLog.progress);
  const checkedIn = useStore((s) => s.dailyLog.checkedIn);
  const submitted = useStore((s) => s.dailyLog.submitted);
  const setScreen = useStore((s) => s.setScreen);
  const setRole = useStore((s) => s.setRole);
  const flash = useStore((s) => s.flash);

  const siteStatus = submitted ? 'Daily log submitted' : checkedIn ? 'Engineer on site · logging' : 'Awaiting check-in';
  const siteDot = checkedIn ? 'var(--green-solid)' : 'var(--amber-solid)';

  const tiles = [
    { key: 'pending', label: 'DECISIONS PENDING WITH CLIENT', value: pending.length, accent: 'var(--amber-solid)', sub: pending.length ? `Oldest ageing ${Math.max(...pending.map((d) => d.ageDays ?? 0))} days` : 'All cleared', onClick: () => setRole('client') },
    { key: 'review', label: 'INSPECTIONS AWAITING REVIEW', value: reviewPending, accent: 'var(--accent)', sub: reviewPending ? 'Waterproofing Ponding Test' : 'Nothing pending', onClick: () => setScreen('inspect-review') },
    { key: 'failed', label: 'FAILED ITEMS AWAITING RE-INSPECTION', value: failedCount, accent: 'var(--red-solid)', sub: failedCount ? 'Drain slope · Terrace' : 'None', onClick: () => setScreen('inspect-review') },
    { key: 'photos', label: 'PROGRESS PHOTOS THIS WEEK', value: 24, accent: 'var(--green-solid)', sub: 'Across 6 zones', onClick: () => {} },
  ];

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
          <div style={{ fontSize: 30, fontWeight: 700, marginTop: 5, letterSpacing: '-.01em' }}>{PROJECT.name}</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>{PROJECT.descriptor}</span>
            <span>·</span>
            <span>{PROJECT.stage}</span>
            <span>·</span>
            <span>Site Code {PROJECT.siteCode}</span>
          </div>
        </div>
        <Button variant="ink" onClick={() => flash('Weekly report generated (PDF) — sent to client & contractor.')}>
          Generate Weekly Report <ArrowUpRight size={15} />
        </Button>
      </div>

      {/* milestone progress */}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '20px 24px', marginBottom: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Milestone Progress</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>{PROJECT.milestonePct}% complete</span>
        </div>
        <ProgressBar pct={PROJECT.milestonePct} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
          {SEED_MILESTONES.map((m) => (
            <div key={m.label} style={{ textAlign: 'center', flex: 1 }}>
              <div
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: '50%',
                  margin: '0 auto 6px',
                  background: m.done ? 'var(--green-solid)' : 'transparent',
                  border: m.done ? 'none' : '1.5px solid rgba(35,33,28,.3)',
                }}
              />
              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{m.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* live from site today */}
      <div style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', borderRadius: 12, padding: '16px 22px', marginBottom: 22, display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingRight: 22, borderRight: '1px solid rgba(237,231,218,.14)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: siteDot }} />
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.18em', color: 'rgba(237,231,218,.45)' }}>LIVE FROM SITE · {PROJECT.short === 'Residence at Ambli' ? '03 Jul 2026' : ''}</div>
            <div style={{ fontWeight: 600, fontSize: 14, marginTop: 2 }}>{siteStatus}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flex: 1, justifyContent: 'space-around', gap: 12, minWidth: 220 }}>
          {[
            { v: workers, l: 'WORKERS ON SITE' },
            { v: materialsCount, l: 'MATERIALS LOGGED' },
            { v: progress, l: 'PROGRESS PHOTOS' },
          ].map((s) => (
            <div key={s.l} style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 22 }}>{s.v}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.1em', color: 'rgba(237,231,218,.5)', marginTop: 2 }}>{s.l}</div>
            </div>
          ))}
        </div>
        <Button variant="ghost" onClick={() => setScreen('site-schedule')} style={{ background: 'rgba(237,231,218,.1)', border: '1px solid rgba(237,231,218,.2)', color: 'var(--sidebar-text)', padding: '9px 14px', fontSize: 12 }}>
          View Schedule <ArrowRight size={14} />
        </Button>
      </div>

      {/* KPI tiles */}
      <div className={styles.tiles}>
        {tiles.map((t) => (
          <div
            key={t.key}
            onClick={t.onClick}
            data-testid={`tile-${t.key}`}
            style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderTop: `3px solid ${t.accent}`, borderRadius: 12, padding: '20px 22px', cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--muted)', maxWidth: 150, lineHeight: 1.5 }}>{t.label}</div>
              <ArrowRight size={15} style={{ opacity: 0.5 }} />
            </div>
            <div data-testid={`tile-${t.key}-value`} style={{ fontSize: 44, fontWeight: 700, lineHeight: 1, margin: '14px 0 8px', color: t.accent }}>{t.value}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.sub}</div>
          </div>
        ))}
      </div>

      {/* photo highlights */}
      <div style={{ marginTop: 24 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.2em', color: 'var(--muted)', marginBottom: 12 }}>THIS WEEK · PHOTO HIGHLIGHTS</div>
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
      </div>
    </div>
  );
}
