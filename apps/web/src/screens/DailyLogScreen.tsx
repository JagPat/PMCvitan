import { useStore } from '@/store/store';
import { selectTotalWorkers } from '@/store/selectors';
import { Eyebrow, Swatch } from '@/components';
import { Crosshair, Camera, Plus, Minus, QrCode, TriangleAlert, Check } from '@/lib/icons';
import styles from './responsive.module.css';

export function DailyLogScreen() {
  const dailyLog = useStore((s) => s.dailyLog);
  const online = useStore((s) => s.online);
  const queueCount = useStore((s) => s.syncQueue.length);
  const total = useStore(selectTotalWorkers);
  const toggleOnline = useStore((s) => s.toggleOnline);
  const checkIn = useStore((s) => s.checkIn);
  const checkOut = useStore((s) => s.checkOut);
  const crewStep = useStore((s) => s.crewStep);
  const openQr = useStore((s) => s.openQr);
  const flagMismatch = useStore((s) => s.flagMismatch);
  const addProgress = useStore((s) => s.addProgress);
  const submitDailyLog = useStore((s) => s.submitDailyLog);

  const conn = online
    ? { bg: 'var(--green-chip)', border: 'var(--green-border)', dot: 'var(--green-solid)', color: 'var(--green-text)', text: 'Online · all synced', toggle: 'Simulate offline' }
    : { bg: 'var(--amber-chip)', border: 'var(--amber-border)', dot: 'var(--amber-solid)', color: 'var(--amber-text)', text: `Offline · ${queueCount} update${queueCount === 1 ? '' : 's'} queued`, toggle: 'Back online' };

  const sectionLabel: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.2em', color: 'var(--faint)', margin: '22px 0 10px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className={styles.mobileScreen} style={{ flex: 1, paddingBottom: 20 }}>
        <div style={{ padding: '10px 0 12px' }}>
          <Eyebrow size={9}>DAILY SITE LOG</Eyebrow>
          <div style={{ fontWeight: 700, fontSize: 22, marginTop: 4 }}>Residence at Ambli</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{dailyLog.date}</div>
        </div>

        {/* connectivity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: conn.bg, border: `1px solid ${conn.border}`, borderRadius: 11, padding: '9px 12px', marginBottom: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: conn.dot, flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: conn.color }} data-testid="conn-text">{conn.text}</span>
          <button onClick={toggleOnline} data-testid="toggle-online" style={{ background: 'transparent', border: '1px solid rgba(35,33,28,.2)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' }}>
            {conn.toggle}
          </button>
        </div>

        {/* check-in */}
        {dailyLog.checkedIn ? (
          <div style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', borderRadius: 15, padding: 15, display: 'flex', alignItems: 'center', gap: 13 }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, background: 'linear-gradient(135deg,#6b5a48,#3a2f26)', flex: 'none', position: 'relative' }}>
              <span style={{ position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, borderRadius: '50%', background: 'var(--green-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Check size={10} color="#fff" strokeWidth={3} />
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Checked in · {dailyLog.checkinTime}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'rgba(237,231,218,.55)', marginTop: 2 }}>Ambli site · within 60 m · GPS + selfie</div>
            </div>
            <button onClick={checkOut} style={{ background: 'transparent', border: '1px solid rgba(237,231,218,.3)', color: 'var(--sidebar-text)', padding: '8px 11px', borderRadius: 8, fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
              Check out
            </button>
          </div>
        ) : (
          <>
            <button onClick={checkIn} data-testid="check-in" style={{ width: '100%', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 15, padding: 18, fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
              <Crosshair size={18} /> Check in at site
            </button>
            <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)', marginTop: 7 }}>Uses this phone's GPS + a selfie as proof of presence</div>
          </>
        )}

        {/* crew */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '22px 0 10px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.2em', color: 'var(--faint)' }}>CREW PRESENT TODAY</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }} data-testid="crew-total">{total} workers</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {dailyLog.crew.map((c, i) => (
            <div key={c.trade} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 12, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 11 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: c.count > 0 ? 'var(--green-solid)' : 'rgba(35,33,28,.18)' }} />
              <div style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{c.trade}</div>
              <button onClick={() => crewStep(i, -1)} aria-label={`Remove ${c.trade}`} style={stepBtn}>
                <Minus size={16} />
              </button>
              <div style={{ width: 26, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 15 }}>{c.count}</div>
              <button onClick={() => crewStep(i, 1)} aria-label={`Add ${c.trade}`} style={stepBtn}>
                <Plus size={16} />
              </button>
            </div>
          ))}
        </div>
        <button onClick={openQr} style={{ width: '100%', marginTop: 10, background: '#fff', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 11, padding: 12, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 13, color: 'var(--ink)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <QrCode size={16} /> Worker self check-in (scan QR)
        </button>

        {/* materials */}
        <div style={sectionLabel}>MATERIAL ON SITE</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {dailyLog.materials.map((m, i) => (
            <div key={m.name} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 12, display: 'flex', gap: 12 }}>
              <Swatch swatch={m.swatch} size={52} radius={10} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}</div>
                  {m.matched && (
                    <button onClick={() => flagMismatch(i)} data-testid={`flag-${m.decisionId}`} style={{ background: 'transparent', border: 'none', color: 'var(--red-solid)', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', padding: 0, display: 'flex', alignItems: 'center', gap: 3 }}>
                      <TriangleAlert size={11} /> Flag mismatch
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11.5, marginTop: 2, color: m.matched ? 'var(--green-text)' : 'var(--red-solid)', fontWeight: m.matched ? 400 : 600 }}>
                  {m.matched ? `✓ Matches locked decision ${m.decisionId}` : `⚠ MISMATCH — not the approved ${m.decisionId}`}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)', marginTop: 3 }}>{m.qty} · {m.zone}</div>
              </div>
            </div>
          ))}
        </div>

        {/* progress */}
        <div style={sectionLabel}>TODAY'S PROGRESS</div>
        <div style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{dailyLog.progress} progress photos</div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>Geo + time stamped, tied to activity</div>
          </div>
          <button onClick={addProgress} style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', border: 'none', padding: '10px 14px', borderRadius: 9, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Camera size={14} /> Add
          </button>
        </div>
      </div>

      <div className={styles.stickyFoot} style={{ padding: '12px 16px 20px', borderTop: '1px solid rgba(35,33,28,.1)', background: 'var(--panel)' }}>
        <button
          onClick={submitDailyLog}
          data-testid="submit-daily-log"
          style={{ width: '100%', maxWidth: 460, margin: '0 auto', display: 'block', padding: 15, borderRadius: 12, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 15, cursor: 'pointer', border: 'none', background: dailyLog.submitted ? 'var(--green-chip)' : 'var(--ink)', color: dailyLog.submitted ? 'var(--green-text)' : 'var(--sidebar-text)' }}
        >
          {dailyLog.submitted ? 'Submitted ✓ — sent to PMC' : 'Submit Daily Log to PMC'}
        </button>
      </div>
    </div>
  );
}

const stepBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: '1px solid rgba(35,33,28,.18)',
  background: 'var(--panel)',
  cursor: 'pointer',
  color: 'var(--ink)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
