import type { CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { useT } from '@/i18n/useT';
import { LANGS, swatch as swatchGradient, type Lang } from '@vitan/shared';
import {
  Users,
  Wrench,
  HardHat,
  Zap,
  Hammer,
  LayoutGrid,
  Blocks,
  ChevronRight,
  Power,
  Play,
  Camera,
  Hand,
  Check,
  Lock,
  QrCode,
  ScanLine,
  type LucideIcon,
} from '@/lib/icons';
import styles from './responsive.module.css';

const pad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '·', '0', 'del'];

const TRADES: { key: string; color: string; Icon: LucideIcon }[] = [
  { key: 'Plumbing', color: '#2F6B44', Icon: Wrench },
  { key: 'Electrical', color: '#8A6216', Icon: Zap },
  { key: 'Carpentry', color: '#7c4a25', Icon: Hammer },
  { key: 'Tiling', color: '#31567F', Icon: LayoutGrid },
  { key: 'Masonry', color: '#B4462E', Icon: Blocks },
];

const WORKERS = [
  { name: 'Suresh', tradeKey: 'Mason', color: '#B4462E' },
  { name: 'Iqbal', tradeKey: 'Plumber', color: '#2F6B44' },
  { name: 'Ramu', tradeKey: 'Helper', color: '#8A6216' },
  { name: 'Kishan', tradeKey: 'Electrician', color: '#31567F' },
];

function BackBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} style={{ background: 'transparent', border: 'none', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 13, color: 'var(--muted)', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
      ← {label}
    </button>
  );
}

export function TeamAccessScreen() {
  const step = useStore((s) => s.access.step);
  const who = useStore((s) => s.access.who);
  const trade = useStore((s) => s.access.trade);
  const otp = useStore((s) => s.access.otp);
  const worker = useStore((s) => s.access.worker);
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const accWho = useStore((s) => s.accWho);
  const accTrade = useStore((s) => s.accTrade);
  const otpPress = useStore((s) => s.otpPress);
  const accReset = useStore((s) => s.accReset);
  const pickWorker = useStore((s) => s.pickWorker);
  const speakJob = useStore((s) => s.speakJob);
  const workerDone = useStore((s) => s.workerDone);
  const approvedDecisions = useStore(useShallow((s) => s.decisions.filter((d) => d.status === 'approved').slice(0, 2)));
  const { t, trade: tradeLabel, workerTrade } = useT();

  const container = styles.mobileScreen;

  // ---- WHO ----
  if (step === 'who') {
    const cards = [
      { key: 'team' as const, Icon: Users, accent: '#31567F', title: t.team, sub: t.teamSub },
      { key: 'trade' as const, Icon: Wrench, accent: '#8A6216', title: t.trade, sub: t.tradeSub },
      { key: 'worker' as const, Icon: HardHat, accent: '#B4462E', title: t.worker, sub: t.workerSub },
    ];
    return (
      <div className={container} style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>V</span>
          </div>
          <div style={{ fontWeight: 700, letterSpacing: '.14em', fontSize: 14 }}>VITAN PMC</div>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.18em', color: 'var(--faint)', marginTop: 22 }}>{t.pick}</div>
        <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
          {LANGS.map((l) => (
            <button key={l.key} onClick={() => setLang(l.key as Lang)} style={langStyle(lang === l.key)}>
              {l.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, margin: '28px 0 16px' }}>{t.who}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cards.map((c) => (
            <button key={c.key} onClick={() => accWho(c.key)} style={cardBtn}>
              <div style={{ width: 52, height: 52, flex: 'none', borderRadius: 13, background: c.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <c.Icon size={26} color="#fff" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{c.title}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{c.sub}</div>
              </div>
              <ChevronRight size={20} color="#b8b2a6" />
            </button>
          ))}
        </div>
        <div style={{ marginTop: 'auto', paddingTop: 20, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--faint)', textAlign: 'center', lineHeight: 1.6 }}>
          No passwords. Team &amp; mistri use phone + OTP.<br />Workers just tap their photo.
        </div>
      </div>
    );
  }

  // ---- TRADE ----
  if (step === 'trade') {
    return (
      <div className={container}>
        <BackBtn onClick={accReset} label={t.back} />
        <div style={{ fontSize: 23, fontWeight: 700, margin: '18px 0 16px' }}>{t.pickTrade}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {TRADES.map((tr) => (
            <button key={tr.key} onClick={() => accTrade(tr.key)} style={cardBtn}>
              <div style={{ width: 48, height: 48, flex: 'none', borderRadius: 12, background: tr.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <tr.Icon size={24} color="#fff" />
              </div>
              <div style={{ flex: 1, fontWeight: 700, fontSize: 17 }}>{tradeLabel(tr.key)}</div>
              <ChevronRight size={20} color="#b8b2a6" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---- OTP ----
  if (step === 'otp') {
    const phoneShown = who === 'trade' ? '+91 ●●●●● 31207' : '+91 ●●●●● 84021';
    return (
      <div className={container} style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        <BackBtn onClick={accReset} label={t.back} />
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{t.otp}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>{t.sent} {phoneShown}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, margin: '26px 0 8px' }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ width: 52, height: 62, borderRadius: 12, border: '1.5px solid rgba(35,33,28,.2)', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 600 }}>
              {otp[i] || ''}
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 'auto', paddingTop: 20 }}>
          {pad.map((k) => (
            <button
              key={k}
              disabled={k === '·'}
              onClick={() => k !== '·' && otpPress(k)}
              data-testid={`otp-${k}`}
              style={{ height: 56, borderRadius: 13, border: '1px solid rgba(35,33,28,.12)', background: k === '·' ? 'transparent' : '#fff', fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--ink)', cursor: k === '·' ? 'default' : 'pointer', visibility: k === '·' ? 'hidden' : 'visible' }}
            >
              {k === 'del' ? '⌫' : k}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---- BADGE (worker: tap your photo) ----
  if (step === 'badge') {
    return (
      <div className={container}>
        <BackBtn onClick={accReset} label={t.back} />
        <div style={{ fontSize: 23, fontWeight: 700, margin: '16px 0 4px', textAlign: 'center' }}>{t.tapPhoto}</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', marginBottom: 20 }}>{t.badgeAlt}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {WORKERS.map((w) => (
            <button
              key={w.name}
              onClick={() => pickWorker({ name: w.name, trade: workerTrade(w.tradeKey), color: w.color, job: 'living' })}
              style={{ background: '#fff', border: '1px solid rgba(35,33,28,.14)', borderRadius: 18, padding: '18px 10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}
            >
              <div style={{ width: 74, height: 74, borderRadius: '50%', background: w.color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 30 }}>{w.name[0]}</div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{w.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{workerTrade(w.tradeKey)}</div>
              </div>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 20, background: 'var(--ink)', color: 'var(--sidebar-text)', borderRadius: 14, padding: '14px 16px' }}>
          <ScanLine size={20} />
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{t.badgeAlt}</span>
          <QrCode size={16} style={{ opacity: 0.6 }} />
        </div>
      </div>
    );
  }

  // ---- JOBCARD (mason, no navigation) ----
  if (step === 'jobcard') {
    const approvedBy = approvedDecisions[0]?.approver ?? 'Mr. Shah';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--panel)' }}>
        <div style={{ padding: '16px 20px 12px', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--ink)', color: 'var(--sidebar-text)' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: worker?.color ?? '#B4462E', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 19, flex: 'none' }}>{worker ? worker.name[0] : 'W'}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: 'rgba(237,231,218,.6)' }}>{t.hi},</div>
            <div style={{ fontWeight: 700, fontSize: 19 }}>{worker?.name ?? ''}</div>
          </div>
          <button onClick={accReset} aria-label="Sign out" style={{ background: 'rgba(237,231,218,.14)', border: 'none', color: 'var(--sidebar-text)', width: 34, height: 34, borderRadius: 9, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Power size={16} />
          </button>
        </div>
        <div style={{ padding: '18px 20px 0' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.18em', color: 'var(--faint)' }}>{t.today}</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, lineHeight: 1.15 }}>{t.layThis}</div>
        </div>
        <div style={{ margin: '14px 20px 0', borderRadius: 20, overflow: 'hidden', border: '2px solid var(--ink)', position: 'relative' }}>
          <div style={{ height: 210, background: swatchGradient('marble') }} />
          <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', alignItems: 'center', gap: 7, background: 'var(--green-solid)', color: '#fff', padding: '6px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600 }}>
            <Lock size={14} /> {t.approved}
          </div>
          <div style={{ padding: '12px 16px', background: '#fff' }}>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Italian Marble · Living Room</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>{approvedBy} · DL-014</div>
          </div>
        </div>
        <button onClick={speakJob} style={{ margin: '14px 20px 0', background: '#fff', border: '1.5px solid var(--ink)', borderRadius: 14, padding: 14, fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--ink)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Play size={14} fill="#fff" />
          </span>
          {t.listen}
        </button>
        <div style={{ marginTop: 'auto', padding: '16px 20px 26px', display: 'flex', gap: 10 }}>
          <button onClick={workerDone} style={fatBtn(1.4, 'var(--green-solid)', '#fff', 'none')}>
            <Check size={22} strokeWidth={2.5} />
            {t.done}
          </button>
          <button onClick={speakJob} style={fatBtn(1, '#fff', 'var(--ink)', '1px solid rgba(35,33,28,.2)')}>
            <Camera size={22} />
            {t.photo}
          </button>
          <button onClick={speakJob} style={fatBtn(1, '#FBF0EF', 'var(--red-solid)', '1px solid #E7CBC7')}>
            <Hand size={22} />
            {t.problem}
          </button>
        </div>
      </div>
    );
  }

  // ---- TRADEHOME (scoped mistri view) ----
  const sectionLabel: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.2em', color: 'var(--faint)', margin: '22px 0 10px' };
  return (
    <div className={container}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--amber-text)' }}>{trade ? tradeLabel(trade) : ''} · IN-CHARGE</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 3 }}>Mistri Iqbal</div>
        </div>
        <button onClick={accReset} aria-label="Sign out" style={{ background: 'var(--panel)', border: '1px solid rgba(35,33,28,.15)', width: 36, height: 36, borderRadius: 9, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Power size={15} />
        </button>
      </div>
      <div style={sectionLabel}>APPROVED FOR YOUR TRADE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {approvedDecisions.map((d) => (
          <div key={d.id} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ width: 46, height: 46, borderRadius: 10, background: swatchGradient(d.photoSwatch), flex: 'none', position: 'relative' }}>
              <span style={{ position: 'absolute', right: -4, bottom: -4, width: 18, height: 18, borderRadius: '50%', background: '#fff', border: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Lock size={10} />
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{d.title}</div>
              <div style={{ fontSize: 12, color: 'var(--green-text)', marginTop: 2 }}>Use: {d.material}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={sectionLabel}>TODAY'S TASKS FOR YOU</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Rough-in — 2nd floor bath</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Due today · pre-tiling inspection after</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Fit CP fittings — master bath</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Only Kohler (approved) · do not substitute</div>
        </div>
      </div>
    </div>
  );
}

function langStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '8px 4px',
    borderRadius: 9,
    fontFamily: 'var(--font-sans)',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    border: `1px solid ${active ? '#B4462E' : 'rgba(35,33,28,.18)'}`,
    background: active ? '#B4462E' : '#fff',
    color: active ? '#fff' : 'var(--ink)',
  };
}

const cardBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 15,
  textAlign: 'left',
  background: '#fff',
  border: '1px solid rgba(35,33,28,.14)',
  borderRadius: 16,
  padding: 16,
  cursor: 'pointer',
};

function fatBtn(flex: number, bg: string, color: string, border: string): CSSProperties {
  return {
    flex,
    background: bg,
    color,
    border,
    borderRadius: 15,
    padding: '18px 8px',
    fontFamily: 'var(--font-sans)',
    fontWeight: 700,
    fontSize: 15,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 5,
  };
}
