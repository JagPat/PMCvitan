import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { dailyLogSendPending } from '@/store/dailyLogPending';
import { ArrowRight, ChevronLeft, Minus, Plus } from '@/lib/icons';
import { engineerCrewLabels as C, engineerCrewMore, engineerCrewPosition, engineerCrewQuestion, engineerCrewSame } from '@vitan/shared';
import { previousCrewCount, previousIsDayBefore } from '@/lib/engineerToday';
import styles from './CrewStepper.module.css';

/** How many of the next trades are named under "Next we'll ask"; the rest are counted. */
const NAMED_AHEAD = 3;
/** Up to this many trades the bar is one segment per trade; a larger roster (it has no size cap,
 *  and a new log copies the last one's) is one continuous bar, so the gaps never outgrow the phone. */
const SEGMENTED_UP_TO = 12;

/**
 * The crew step of the engineer's Today, asked one trade at a time: a large count with one-less /
 * one-more buttons, "Nobody today", and Next. Presentation only — each tap is the Site screen's own
 * `crewStep` on the open log (kept in the device's pending draft, sent with the log), so this and
 * the Site screen's list are two views of the same counts. `today` is false for an earlier day's
 * log that was never sent, so the question doesn't call it today's.
 */
export function CrewStepper({ onClose, today = true }: { onClose: () => void; today?: boolean }) {
  const lang = useStore((s) => s.lang);
  const crew = useStore(useShallow((s) => s.dailyLog?.crew ?? []));
  const crewStep = useStore((s) => s.crewStep);
  // the log before this one, as sent (U1b): "Same as yesterday" offers its count for each trade
  const previous = useStore((s) => s.dailyLog?.previous);
  const logDate = useStore((s) => s.dailyLog?.logDate);
  const confirmCrew = useStore((s) => s.confirmCrew);
  // a send on its way has already captured the counts it carries; Today closes the stepper then,
  // and the controls are disabled here as well so no tap can land in that window
  const sending = useStore(dailyLogSendPending);
  const [pos, setPos] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  // each question is announced and starts at the top: focus moves to its heading
  useEffect(() => {
    heading.current?.focus();
  }, [pos]);

  if (crew.length === 0) return null;
  const at = Math.min(pos, crew.length - 1); // a replaced crew list can be shorter
  const row = crew[at];
  const last = at === crew.length - 1;
  const ahead = crew.slice(at + 1);
  const previousCount = previousCrewCount({ crew, previous }, at);
  // "yesterday" only on today's log whose last log was sent for the day before; else "last time"
  const yesterday = today && previousIsDayBefore({ logDate, previous });
  const step = (delta: number) => {
    // the row on screen, by its position — two rows may carry the same trade text — and only while
    // that position still holds the row asked about (Today closes the stepper on a replaced log)
    if (useStore.getState().dailyLog?.crew[at]?.trade === row.trade) crewStep(at, delta);
  };
  // reaching the end is the engineer's answer for the whole crew, a no-crew day included
  const advance = () => {
    if (!last) return setPos(at + 1);
    confirmCrew();
    onClose();
  };

  return (
    <section className={styles.stepper} data-testid="crew-stepper" data-trade={row.trade}>
      <div className={styles.top}>
        <button className={styles.back} onClick={onClose} aria-label={C.back[lang]} data-testid="crew-back">
          <ChevronLeft size={22} aria-hidden />
        </button>
        <div className={styles.bar} role="img" aria-label={engineerCrewPosition(at + 1, crew.length, lang)} data-testid="crew-progress">
          {crew.length <= SEGMENTED_UP_TO ? (
            crew.map((_, i) => <span key={i} className={`${styles.seg} ${i < at ? styles.segDone : i === at ? styles.segNow : ''}`} />)
          ) : (
            <span className={styles.track}>
              <span className={styles.segDone} style={{ width: `${(at / crew.length) * 100}%` }} />
              <span className={styles.segNow} style={{ width: `${100 / crew.length}%` }} />
            </span>
          )}
        </div>
        <span className={styles.pos} data-testid="crew-position" aria-hidden>
          {at + 1} / {crew.length}
        </span>
      </div>

      <div className={styles.ask}>
        <h1 className={styles.question} ref={heading} tabIndex={-1} data-testid="crew-question">
          {engineerCrewQuestion(row.trade, lang, today)}
        </h1>
        <div className={styles.counter}>
          <button className={styles.less} onClick={() => step(-1)} disabled={sending || row.count === 0} aria-label={`${C.less[lang]}: ${row.trade}`} data-testid="crew-less">
            <Minus size={28} aria-hidden />
          </button>
          <output className={styles.count} aria-live="polite" data-testid="crew-count">
            {row.count}
          </output>
          <button className={styles.more} onClick={() => step(1)} disabled={sending} aria-label={`${C.more[lang]}: ${row.trade}`} data-testid="crew-more">
            <Plus size={28} aria-hidden />
          </button>
        </div>
        {previousCount !== undefined && previousCount > 0 && (
          <button className={styles.same} onClick={() => step(previousCount - row.count)} disabled={sending || row.count === previousCount} data-testid="crew-same">
            {engineerCrewSame(previousCount, lang, yesterday)}
          </button>
        )}
      </div>

      <div className={styles.foot}>
        {ahead.length > 0 && (
          <div className={styles.ahead} data-testid="crew-ahead">
            <span className={styles.aheadNames}>
              {C.laterAsk[lang]}: {ahead.slice(0, NAMED_AHEAD).map((c) => c.trade).join(', ')}
            </span>
            {ahead.length > NAMED_AHEAD && <span className={styles.aheadMore}>{engineerCrewMore(ahead.length - NAMED_AHEAD, lang)}</span>}
          </div>
        )}
        <button className={styles.next} onClick={advance} data-testid="crew-next">
          {last ? C.finish[lang] : C.next[lang]} <ArrowRight size={20} aria-hidden />
        </button>
        <button
          className={styles.nobody}
          onClick={() => {
            if (row.count > 0) step(-row.count);
            advance();
          }}
          disabled={sending}
          data-testid="crew-nobody"
        >
          {today ? C.nobody[lang] : C.nobodyEarlier[lang]}
        </button>
      </div>
    </section>
  );
}
