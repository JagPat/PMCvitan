import { useMemo, type ReactNode } from 'react';
import { useStore } from '@/store/store';
import { pmcBrief, type BriefTask } from '@/lib/pmcBrief';
import { ArrowRight, CircleCheck } from '@/lib/icons';
import {
  pmcBriefAlsoIn,
  pmcBriefClientWaiting,
  pmcBriefLabels as L,
  pmcBriefMore,
  pmcBriefReviews,
  pmcBriefSince,
  pmcBriefSummary,
  type Lang,
  type PmcBriefResult,
  type ScreenKey,
} from '@vitan/shared';
import styles from './PmcBrief.module.css';

const LOCALE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', gu: 'gu-IN' };

/**
 * The PMC's brief (U3b, design review · PMC · Brief): every project they run, on one screen, from
 * `GET /me/brief` (U3a). "Do these first" names the most pressing tasks by the fixed rule in
 * `pmcBrief`; "Since yesterday" sums what moved; each project row opens that project. It shows no
 * schedule verdict and offers no nudge — no rule or command stands behind either yet.
 */
export function PmcBrief({ brief, also }: { brief: PmcBriefResult; also?: ReactNode }) {
  const lang = useStore((s) => s.lang);
  const short = useStore((s) => s.short);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setScreen = useStore((s) => s.setScreen);
  const switchProject = useStore((s) => s.switchProject);

  const view = useMemo(() => pmcBrief(brief.projects, Date.now()), [brief]);
  const { digest } = view;
  // the site's today on the first project; every project carries its own, and they agree but for a
  // brief window around a midnight in another zone
  const today = brief.projects[0]?.today;

  // the active project opens in place; another one is switched to, landing on the task's screen
  const go = (projectId: string, target: ScreenKey) => {
    if (projectId === activeProjectId) setScreen(target);
    else void switchProject(projectId, target);
  };

  return (
    <section className={styles.brief} data-testid="pmc-brief">
      <header>
        {today && <span className={styles.date}>{formatDay(LOCALE[lang], today)}</span>}
        <h1 className={styles.heading}>{L.heading[lang]}</h1>
        <p className={styles.summary} data-testid="brief-summary">{pmcBriefSummary(digest.projects, digest.logsSent, lang)}</p>
      </header>

      {view.first.length ? (
        <div className={styles.block}>
          <h2 className={styles.blockHeading}>{L.first[lang]}</h2>
          <ol className={styles.tasks} data-testid="brief-first">
            {view.first.map((t) => (
              <li key={`${t.kind}-${t.projectId}`}>
                <button className={styles.task} onClick={() => go(t.projectId, t.target)} data-testid={`brief-task-${t.kind}-${t.projectId}`}>
                  <span className={styles.taskText}>
                    <span className={styles.taskProject}>{t.short}</span>
                    <span className={styles.taskWhat}>{taskText(t, lang)}</span>
                  </span>
                  <span className={styles.taskGo}>
                    {taskAction(t, lang)} <ArrowRight size={18} aria-hidden />
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {view.total > view.first.length && <p className={styles.more} data-testid="brief-more">{pmcBriefMore(view.total - view.first.length, lang)}</p>}
        </div>
      ) : (
        <div className={styles.calm} data-testid="brief-clear">
          <CircleCheck size={22} aria-hidden /> {L.clear[lang]}
        </div>
      )}

      <div className={styles.block}>
        <h2 className={styles.blockHeading}>{L.since[lang]}</h2>
        <dl className={styles.since} data-testid="brief-since">
          <Figure n={digest.approvals} label={pmcBriefSince('approvals', digest.approvals, lang)} testId="brief-since-approvals" />
          <Figure n={digest.photos} label={pmcBriefSince('photos', digest.photos, lang)} testId="brief-since-photos" />
          <Figure n={digest.rejectedInspections} label={pmcBriefSince('rejected', digest.rejectedInspections, lang)} testId="brief-since-rejected" />
        </dl>
      </div>

      <div className={styles.block}>
        <h2 className={styles.blockHeading}>{L.projects[lang]}</h2>
        <ul className={styles.projects} data-testid="brief-projects">
          {brief.projects.map((p) => (
            <li key={p.projectId}>
              <button className={styles.project} onClick={() => go(p.projectId, 'dashboard')} data-testid={`brief-project-${p.projectId}`}>
                <span className={styles.taskText}>
                  <span className={styles.taskProject}>{p.name}</span>
                  <span className={`${styles.log} ${p.logToday === 'sent' ? styles.logSent : ''}`} data-log={p.logToday}>
                    {p.logToday === 'sent' ? L.logSent[lang] : p.logToday === 'open' ? L.logOpen[lang] : L.logMissing[lang]}
                  </span>
                </span>
                <ArrowRight size={18} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {also && (
        <div className={styles.block}>
          <h2 className={styles.blockHeading}>{pmcBriefAlsoIn(short, lang)}</h2>
          {also}
        </div>
      )}
    </section>
  );
}

function Figure({ n, label, testId }: { n: number; label: string; testId: string }) {
  return (
    <div className={styles.figure} data-testid={testId}>
      <dt className={styles.figureLabel}>{label}</dt>
      <dd className={styles.figureN}>{n}</dd>
    </div>
  );
}

function taskText(t: BriefTask, lang: Lang): string {
  if (t.kind === 'client') return pmcBriefClientWaiting(t.count, t.days, lang);
  if (t.kind === 'reviews') return pmcBriefReviews(t.count, lang);
  return t.log === 'open' ? L.logOpen[lang] : L.logMissing[lang];
}

function taskAction(t: BriefTask, lang: Lang): string {
  if (t.kind === 'client') return L.openDecisions[lang];
  if (t.kind === 'reviews') return L.openReviews[lang];
  return L.openSite[lang];
}

/** A civil date (ISO), as "Saturday, 3 October" in the reader's language — formatted as-is (UTC),
 *  never shifted by a zone. */
function formatDay(locale: string, iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at);
}
