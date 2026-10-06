import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectDeciderPending, selectDeciderReapproval, selectProjectProgress } from '@/store/selectors';
import { clientPulse } from '@/lib/clientPulse';
import { todayCivil } from '@/lib/civilDate';
import { ArrowRight, CircleCheck } from '@/lib/icons';
import {
  clientPulseFrom,
  clientPulseHeading,
  clientPulseLabels as L,
  clientPulseNeedsMany,
  clientPulseSeeAll,
  clientPulseSeeOptions,
  clientPulseWaitsOn,
  clientPulseWeek,
  type Lang,
} from '@vitan/shared';
import styles from './ClientPulse.module.css';

const LOCALE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', gu: 'gu-IN' };
const RING = 2 * Math.PI * 68; // the progress ring's circumference (r = 68 in a 160 box)

/**
 * The client's Pulse (U2a, design review · Client · Pulse): how far the project is, what is being
 * built now, the one thing waiting on them, and what happens next. Presentation only, derived by
 * `clientPulse` from the data the client already holds; it shows no schedule verdict.
 */
export function ClientPulse({ also }: { also?: ReactNode }) {
  const lang = useStore((s) => s.lang);
  const short = useStore((s) => s.short);
  const timeZone = useStore((s) => s.timeZone);
  // B7 (F-12): the same derived progress the Dashboard shows
  const milestonePct = useStore((s) => selectProjectProgress(s).pct);
  const scheduleStartDate = useStore((s) => s.scheduleStartDate);
  const scheduleEndDate = useStore((s) => s.scheduleEndDate);
  const activities = useStore((s) => s.activities);
  const reapprovals = useStore(useShallow(selectDeciderReapproval));
  const pending = useStore(useShallow(selectDeciderPending));
  const openDecision = useStore((s) => s.openDecision);
  const setScreen = useStore((s) => s.setScreen);

  // the site's civil day; a minute tick moves "week" and "next" on across the site's midnight
  const [, setMinute] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const today = todayCivil(timeZone);

  const pulse = useMemo(
    () => clientPulse({ milestonePct, scheduleStartDate, scheduleEndDate, today, activities, reapprovals, pending }),
    [milestonePct, scheduleStartDate, scheduleEndDate, today, activities, reapprovals, pending],
  );
  const { needs } = pulse;

  return (
    <section className={styles.pulse} data-testid="client-pulse">
      <h1 className={styles.heading}>{clientPulseHeading(short, lang)}</h1>

      <div className={styles.status}>
        <div className={styles.ring} role="img" aria-label={pulse.progressPct === null ? '—' : `${pulse.progressPct}% ${L.done[lang]}`} data-testid="pulse-progress">
          <svg width="132" height="132" viewBox="0 0 160 160" aria-hidden>
            <circle cx="80" cy="80" r="68" fill="none" className={styles.track} strokeWidth="14" />
            <circle
              cx="80" cy="80" r="68" fill="none" className={styles.fill} strokeWidth="14" strokeLinecap="round"
              strokeDasharray={`${((pulse.progressPct ?? 0) / 100) * RING} ${RING}`} transform="rotate(-90 80 80)"
            />
          </svg>
          <span className={styles.ringText} aria-hidden>
            <span className={styles.pct}>{pulse.progressPct === null ? '—' : `${pulse.progressPct}%`}</span>
            <span className={styles.pctLabel}>{L.done[lang]}</span>
          </span>
        </div>
        <div className={styles.week}>
          {pulse.week && <span className={styles.weekLine} data-testid="pulse-week">{clientPulseWeek(pulse.week.at, pulse.week.of, lang)}</span>}
          {pulse.underWay.length > 0 && (
            <span className={styles.underWay} data-testid="pulse-under-way">
              {L.underWay[lang]}: {pulse.underWay.slice(0, 2).join(', ')}
              {pulse.underWay.length > 2 ? ` +${pulse.underWay.length - 2}` : ''}
            </span>
          )}
        </div>
      </div>

      {needs ? (
        <div className={styles.needs} data-testid="pulse-needs" data-decision={needs.first.id}>
          <span className={styles.needsEyebrow}>{needs.count > 1 ? clientPulseNeedsMany(needs.count, lang) : L.needsOne[lang]}</span>
          <h2 className={styles.needsTitle}>{needs.first.title}</h2>
          {needs.reapproval && <p className={styles.needsNote}>{L.reopened[lang]}</p>}
          <button className={styles.needsGo} onClick={() => openDecision(needs.first.id)} data-testid="pulse-needs-go">
            {needs.first.options.length > 1 ? clientPulseSeeOptions(needs.first.options.length, lang) : L.open[lang]}
            <ArrowRight size={20} aria-hidden />
          </button>
          {needs.count > 1 && (
            <button className={styles.needsAll} onClick={() => setScreen('client-decisions')} data-testid="pulse-needs-all">
              {clientPulseSeeAll(needs.count, lang)}
              <ArrowRight size={16} aria-hidden />
            </button>
          )}
        </div>
      ) : (
        <div className={styles.calm} data-testid="pulse-nothing">
          <CircleCheck size={22} aria-hidden /> {L.nothing[lang]}
        </div>
      )}

      {pulse.next.length > 0 && (
        <div className={styles.nextBlock}>
          <h2 className={styles.nextHeading}>{L.next[lang]}</h2>
          <ol className={styles.nextList} data-testid="pulse-next">
            {pulse.next.map((n) => (
              <li key={n.id} className={styles.nextItem}>
                <span className={`${styles.dot} ${n.waitsOn ? styles.dotHeld : ''}`} aria-hidden />
                <span className={styles.nextText}>
                  <span className={styles.nextName}>{n.name}</span>
                  <span className={styles.nextWhen}>
                    {clientPulseFrom(formatDay(LOCALE[lang], n.from), lang)}
                    {n.waitsOn ? ` · ${clientPulseWaitsOn(n.waitsOn, lang)}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {also && (
        <div className={styles.also}>
          <h2 className={styles.nextHeading}>{L.also[lang]}</h2>
          {also}
        </div>
      )}
    </section>
  );
}

/** A civil date (ISO), as "5 October" in the reader's language — formatted as-is (UTC), never
 *  shifted by a zone. */
function formatDay(locale: string, iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at);
}
