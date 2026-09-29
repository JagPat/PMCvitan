import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '@/store/store';
import { dailyLogReadMode } from '@/data/apiGateway';
import { selectTotalWorkers } from '@/store/selectors';
import { todayPath, TODAY_STEPS } from '@/lib/engineerToday';
import { todayCivil } from '@/lib/civilDate';
import { dailyLogSendPending, dailyLogStartPending } from '@/store/dailyLogPending';
import { ArrowRight, Circle, CircleCheck, Crosshair, Plus, RefreshCw } from '@/lib/icons';
import { can, engineerNavLabels, engineerTodayLabels as L, engineerTodayLogFor, engineerTodayOverdue, engineerTodayProgress, type Lang } from '@vitan/shared';
import styles from './EngineerToday.module.css';

const LOCALE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', gu: 'gu-IN' };

/**
 * The site engineer's Today: one "do this now" action and the day's four-step path
 * (check in → crew & material → progress photos → send to PMC). Presentation only — every step
 * reads the daily log the Site screen records, and every action is the same store command that
 * screen uses, so Today can never claim a step the log doesn't show.
 */
export function EngineerToday({ also }: { also?: ReactNode }) {
  const lang = useStore((s) => s.lang);
  const role = useStore((s) => s.role);
  const short = useStore((s) => s.short);
  const dailyLog = useStore((s) => s.dailyLog);
  const total = useStore(selectTotalWorkers);
  const dailyLogLoad = useStore((s) => s.dailyLogLoad);
  const timeZone = useStore((s) => s.timeZone);
  const online = useStore((s) => s.online);
  // a start or send already on its way (queued, or committed and not yet read back) is shown as
  // such — the same rule the store's commands enforce (see `dailyLogPending`)
  const pendingStart = useStore(dailyLogStartPending);
  const pendingSend = useStore(dailyLogSendPending);
  const setScreen = useStore((s) => s.setScreen);
  const startDailyLog = useStore((s) => s.startDailyLog);
  const checkIn = useStore((s) => s.checkIn);
  const submitDailyLog = useStore((s) => s.submitDailyLog);
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);

  // the same honest read gates the Site screen uses: never offer "start" before a read has
  // settled, and never mutate a log whose latest read failed
  const moduleOwned = dailyLogReadMode() === 'moduleQuery';
  const reading = moduleOwned && (dailyLogLoad === 'idle' || dailyLogLoad === 'loading');
  const unavailable = moduleOwned && dailyLogLoad === 'error';

  // the site's civil day, re-checked each minute: a page left open across the site's midnight
  // moves on to the new day (and its heading) without a reload
  const [today, setToday] = useState(() => todayCivil(timeZone));
  useEffect(() => {
    const tick = () => setToday(todayCivil(timeZone));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [timeZone]);

  const path = todayPath(dailyLog, total, today);
  const overdueDate = path.overdue ? formatLogDate(LOCALE[lang], path.overdue) : null;
  const next = path.action === 'start' || path.action === 'done' ? null : path.action;
  const openSite = () => setScreen('daily-log');
  const date = formatDay(LOCALE[lang], timeZone);

  let card;
  // an unsettled read (first load, a retry, or a failure) is shown before anything derived from
  // the log: a retained last-known log can't tell the engineer their day is done, offer an action
  // on it, or tick steps on the path until the latest read lands. Background refreshes over a
  // ready log stay 'ready', so this never flashes on an ordinary update.
  const unsettled = reading || unavailable;
  if (unsettled) {
    card = (
      <div className={styles.now} data-surface="ink" data-testid="today-now" data-action={reading ? 'loading' : 'unavailable'}>
        <div className={styles.nowTitle}>{reading ? L.loading[lang] : L.unavailable[lang]}</div>
        {unavailable && (
          <>
            <div className={styles.nowDetail}>{dailyLog ? L.staleDetail[lang] : L.unavailableDetail[lang]}</div>
            <button className={styles.nowAction} onClick={requestFreshSnapshot} data-testid="today-retry">
              <RefreshCw size={18} /> {L.retry[lang]}
            </button>
          </>
        )}
      </div>
    );
  } else if ((path.action === 'start' && pendingStart) || (path.action !== 'start' && path.action !== 'done' && pendingSend)) {
    card = (
      <div className={styles.now} data-surface="ink" data-testid="today-now" data-action={path.action === 'start' ? 'pending-start' : 'pending-send'}>
        <div className={styles.nowTitle} style={{ marginTop: 0 }}>{path.action === 'start' ? L.pendingStart[lang] : L.pendingSend[lang]}</div>
        {!online && <div className={styles.nowDetail}>{L.savedOffline[lang]}</div>}
      </div>
    );
  } else if (path.action === 'done') {
    card = (
      <div className={styles.now} data-surface="ink" data-testid="today-now" data-action="done">
        <div className={styles.nowDone}>
          <CircleCheck size={30} aria-hidden />
          <div>
            <div className={styles.nowTitle} style={{ marginTop: 0 }}>{L.action.done[lang]}</div>
            <div className={styles.nowDetail}>{L.actionDetail.done[lang]}</div>
          </div>
        </div>
      </div>
    );
  } else {
    const a = path.action;
    const canAct = a === 'start' ? can('dailyLog.start', role) : a === 'send' ? can('dailyLog.submit', role) : true;
    const run = a === 'start' ? startDailyLog : a === 'checkIn' ? checkIn : a === 'send' ? submitDailyLog : openSite;
    const Icon = a === 'start' ? Plus : a === 'checkIn' ? Crosshair : ArrowRight;
    // an earlier day's unsent log is never called today's: its own date is named, and sending it
    // says "this log"
    const label = a === 'send' && overdueDate ? L.sendThisLog[lang] : L.action[a][lang];
    // crew and photos are suggestions, never gates: the server sends any checked-in log, so a
    // rain-day or holiday log can go with nothing more recorded
    const sendAnyway = (a === 'crew' || a === 'photos') && path.canSend && can('dailyLog.submit', role);
    card = (
      <div className={styles.now} data-surface="ink" data-testid="today-now" data-action={a}>
        <div className={styles.nowLabel}>{L.doNow[lang]}</div>
        {overdueDate && <div className={styles.nowOverdue} data-testid="today-overdue">{engineerTodayOverdue(overdueDate, lang)}</div>}
        {/* the action names itself once, on the button; a reader who can't act sees it as the title */}
        {!canAct && <div className={styles.nowTitle}>{label}</div>}
        <div className={styles.nowDetail}>{L.actionDetail[a][lang]}</div>
        {canAct && (
          <button className={styles.nowAction} onClick={run} data-testid="today-action">
            <Icon size={20} aria-hidden /> {label}
          </button>
        )}
        {sendAnyway && (
          <button className={styles.nowSecondary} onClick={submitDailyLog} data-testid="today-send-anyway">
            {overdueDate ? L.sendThisLog[lang] : L.sendAnyway[lang]}
          </button>
        )}
      </div>
    );
  }

  return (
    <section data-testid="engineer-today">
      <div className={styles.head}>
        <div className={styles.dayLabel}>{engineerNavLabels.inbox?.[lang]}</div>
        <div className={styles.date}>{date}</div>
        <div style={{ fontSize: 15, color: 'var(--muted)', marginTop: 2 }}>{short}</div>
      </div>

      {card}

      {!unsettled && (
        <>
          <div className={styles.pathHead}>
            <h2 className={styles.pathTitle} style={{ margin: 0 }}>{overdueDate ? engineerTodayLogFor(overdueDate, lang) : L.path[lang]}</h2>
            <span className={styles.pathCount} data-testid="today-count">{engineerTodayProgress(path.doneCount, TODAY_STEPS.length, lang)}</span>
          </div>
          <ol className={styles.steps}>
            {TODAY_STEPS.map((k) => {
              const isDone = path.done[k];
              const isNext = k === next;
              // once the log is sent it is a record, not a to-do list: a step it went without (no
              // crew on a holiday) reads "Not recorded", never an open step beside "nothing more to log"
              const skipped = !isDone && path.action === 'done';
              return (
                <li key={k}>
                  <button
                    className={`${styles.step} ${isNext ? styles.stepNext : ''}`}
                    onClick={openSite}
                    data-testid={`today-step-${k}`}
                    data-state={isDone ? 'done' : skipped ? 'skipped' : isNext ? 'next' : 'todo'}
                  >
                    {isDone ? <CircleCheck size={22} color="var(--green-solid)" aria-hidden /> : <Circle size={22} color="var(--muted)" aria-hidden />}
                    <span className={styles.stepName}>{L.step[k][lang]}</span>
                    <span className={`${styles.stepState} ${isDone ? styles.stepStateDone : isNext ? styles.stepStateNext : ''}`}>
                      {isDone ? L.done[lang] : skipped ? L.notRecorded[lang] : isNext ? `${L.next[lang]} · ${L.estimate[k][lang]}` : L.estimate[k][lang]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {also && (
        <>
          <h2 className={styles.also}>{L.alsoWaiting[lang]}</h2>
          {also}
        </>
      )}
    </section>
  );
}

/** The heading's day, on the SITE's calendar — the same civil day `todayPath` and the server use —
 *  falling back to the device's day when the project zone is unknown or unrecognised. */
function formatDay(locale: string, timeZone: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(new Date());
    } catch {
      /* unknown IANA zone — fall through to the device's day */
    }
  }
  return new Intl.DateTimeFormat(locale, opts).format(new Date());
}

/** A log's own civil date (ISO YYYY-MM-DD), as "28 September" in the reader's language. The date
 *  is already the site's civil day, so it is formatted as-is (UTC), never shifted by a zone. */
function formatLogDate(locale: string, iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at);
}
