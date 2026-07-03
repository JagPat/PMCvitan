import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectPending, selectTotalWorkers } from '@/store/selectors';
import { Eyebrow, ProgressBar, Swatch } from '@/components';
import { ArrowRight } from '@/lib/icons';
import { PROJECT, signed, swatch as swatchGradient } from '@vitan/shared';
import styles from './responsive.module.css';

export function ClientHealthScreen() {
  const decisions = useStore(useShallow((s) => s.decisions));
  const pending = useStore(useShallow(selectPending));
  const workers = useStore(selectTotalWorkers);
  const checkedIn = useStore((s) => s.dailyLog.checkedIn);
  const setScreen = useStore((s) => s.setScreen);

  const healthLine = checkedIn ? `Site active today · ${workers} workers` : 'Site opens shortly today';
  const countLabel = `${pending.length} ${pending.length === 1 ? 'decision waiting' : 'decisions waiting'} for you`;
  const approved = decisions.filter((d) => d.status === 'approved');

  const photos = [
    { label: 'Living Room · flooring', date: '02 Jul 2026', swatch: 'marble' },
    { label: 'Master Bath', date: '01 Jul 2026', swatch: 'chrome' },
    { label: 'Staircase', date: '30 Jun 2026', swatch: 'glass' },
  ];

  return (
    <div className={styles.clientScreen}>
      <div style={{ padding: '8px 0 12px' }}>
        <Eyebrow size={9}>PROJECT HEALTH</Eyebrow>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 26, fontWeight: 500, marginTop: 4, lineHeight: 1.15 }}>{PROJECT.short}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>Finishing stage · On track</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 10, background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 20, padding: '6px 12px' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: checkedIn ? 'var(--green-solid)' : 'var(--amber-solid)' }} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{healthLine}</span>
        </div>
      </div>

      {/* photo carousel */}
      <div className={`${styles.carousel} vscroll`} style={{ margin: '6px 0 14px' }}>
        {photos.map((p) => (
          <div key={p.label} style={{ width: 250, borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(35,33,28,.12)' }}>
            <div style={{ height: 170, background: swatchGradient(p.swatch), position: 'relative' }}>
              <span style={{ position: 'absolute', left: 9, bottom: 9, fontFamily: 'var(--font-mono)', fontSize: 8.5, color: '#fff', background: 'rgba(0,0,0,.4)', padding: '2px 7px', borderRadius: 4 }}>{p.label}</span>
            </div>
            <div style={{ padding: '9px 12px', background: '#fff', fontSize: 12, color: 'var(--muted)' }}>{p.date}</div>
          </div>
        ))}
      </div>

      {/* overall progress */}
      <div style={{ background: '#fff', border: '1px solid rgba(35,33,28,.12)', borderRadius: 16, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Overall progress</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>{PROJECT.milestonePct}%</span>
        </div>
        <div style={{ marginTop: 10 }}>
          <ProgressBar pct={PROJECT.milestonePct} />
        </div>
      </div>

      {/* CTA */}
      {pending.length > 0 && (
        <button
          onClick={() => setScreen('client-decisions')}
          style={{ width: '100%', marginTop: 16, background: 'var(--ink)', color: 'var(--sidebar-text)', border: 'none', borderRadius: 16, padding: 18, textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.15em', color: 'var(--accent)' }}>ACTION NEEDED</div>
            <div style={{ fontWeight: 700, fontSize: 16, marginTop: 4 }}>{countLabel}</div>
          </div>
          <ArrowRight size={22} />
        </button>
      )}

      {/* recently approved */}
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.2em', color: 'var(--faint)', margin: '22px 0 10px' }}>RECENTLY APPROVED</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {approved.map((a) => (
          <div key={a.id} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' }}>
            <Swatch swatch={a.photoSwatch} size={42} radius={9} lock />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{a.title}</div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>By {a.approver} · {a.date}</div>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)' }}>{signed(a.cost ?? 0)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
