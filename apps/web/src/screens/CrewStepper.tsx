import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { dailyLogSendPending } from '@/store/dailyLogPending';
import { ArrowRight, ChevronLeft, Minus, Plus } from '@/lib/icons';
import { engineerCrewLabels as C, engineerCrewMore, engineerCrewPosition, engineerCrewQuestion } from '@vitan/shared';
import styles from './CrewStepper.module.css';

/** How many of the next trades are named under "Next we'll ask"; the rest are counted. */
const NAMED_AHEAD = 3;

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
  const step = (delta: number) => {
    // by trade, not by a remembered index: the log on screen can be replaced by a reconcile
    const i = useStore.getState().dailyLog?.crew.findIndex((c) => c.trade === row.trade) ?? -1;
    if (i >= 0) crewStep(i, delta);
  };
  const advance = () => (last ? onClose() : setPos(at + 1));

  return (
    <section className={styles.stepper} data-testid="crew-stepper" data-trade={row.trade}>
      <div className={styles.top}>
        <button className={styles.back} onClick={onClose} aria-label={C.back[lang]} data-testid="crew-back">
          <ChevronLeft size={22} aria-hidden />
        </button>
        <div className={styles.bar} role="img" aria-label={engineerCrewPosition(at + 1, crew.length, lang)}>
          {crew.map((c, i) => (
            <span key={c.trade} className={`${styles.seg} ${i < at ? styles.segDone : i === at ? styles.segNow : ''}`} />
          ))}
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
      </div>

      <div className={styles.foot}>
        {ahead.length > 0 && (
          <div className={styles.ahead} data-testid="crew-ahead">
            <span>
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
          {C.nobody[lang]}
        </button>
      </div>
    </section>
  );
}
