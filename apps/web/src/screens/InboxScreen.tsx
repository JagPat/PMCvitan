import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { countActionItems, selectActionItems, type ActionItem } from '@/store/selectors';
import { actionItemText, forYouCount, forYouIntro, forYouLabels as FY, forYouNothingDetail, forYouRole } from '@vitan/shared';
import { Eyebrow, Button } from '@/components';
import { ArrowRight, CircleCheck } from '@/lib/icons';
import { EngineerToday } from './EngineerToday';
import { ClientPulse } from './ClientPulse';
import { PmcBrief } from './PmcBrief';
import { BRIEF_REFRESH_MS, briefIsFresh, pmcBrief } from '@/lib/pmcBrief';
import styles from './responsive.module.css';

type Tone = ActionItem['tone'];
const TONE: Record<Tone, { accent: string; chip: string; border: string }> = {
  amber: { accent: 'var(--amber-solid)', chip: 'var(--amber-chip)', border: 'var(--amber-border)' },
  red: { accent: 'var(--red-solid)', chip: 'var(--red-chip)', border: 'var(--red-border)' },
  green: { accent: 'var(--green-solid)', chip: 'var(--green-chip)', border: 'var(--green-border)' },
  ink: { accent: 'var(--muted)', chip: 'var(--panel)', border: 'var(--hairline)' },
};

/**
 * "For You" — the per-role home. One cross-cutting to-do list built live from the same
 * decisions, drawings, inspections, daily log and schedule the rest of the app reads, so
 * everyone opens to exactly what needs *them* — and each item disappears the moment it's
 * acted on. Every card is a one-tap jump to the screen where you do the thing. The list is
 * a pure function of state (nothing stored), which is what keeps it honest.
 */
export function InboxScreen() {
  // selectActionItems builds fresh view-model objects each call, so it can't be a live
  // useStore selector (getSnapshot would never stabilise → infinite loop). Subscribe to the
  // whole (stable) state ref and derive the list with useMemo instead — recomputed only when
  // the state object actually changes, which is exactly when the queue can change.
  const state = useStore((s) => s);
  const items = useMemo(() => selectActionItems(state), [state]);
  const total = countActionItems(items);
  const role = useStore((s) => s.role);
  const short = useStore((s) => s.short); // this queue is scoped to the active project
  const setScreen = useStore((s) => s.setScreen);
  const brief = useStore((s) => s.brief);
  const briefAt = useStore((s) => s.briefAt);
  const loadBrief = useStore((s) => s.loadBrief);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const lang = useStore((s) => s.lang);

  // the PMC's brief (U3b) is read fresh each time they land here, then every minute and whenever the
  // page is shown again while it stays on screen: it spans projects whose access and civil day change
  // with no signal reaching this session (a removal elsewhere, a site's midnight). A sign-in or project
  // switch reads it in `useApiSync`, once the new gateway is installed. `now` ticks so a brief that is
  // no longer fresh stops being shown even if no newer one arrives.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (role !== 'pmc') return;
    loadBrief();
    const refresh = () => {
      setNow(Date.now());
      loadBrief();
    };
    const onShown = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const poll = setInterval(refresh, BRIEF_REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    document.addEventListener('visibilitychange', onShown);
    window.addEventListener('focus', onShown);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onShown);
      window.removeEventListener('focus', onShown);
    };
  }, [role, loadBrief]);

  // the engineer's home is their day: Today's path carries the site log, so its "not submitted"
  // card would only repeat it; everything else still waiting on them follows below
  if (role === 'engineer') {
    const rest = items.filter((it) => it.key !== 'eng-log');
    return (
      <div className={`${styles.screen} ${styles.mid}`}>
        <EngineerToday also={rest.length ? <ActionList items={rest} onOpen={setScreen} /> : undefined} />
      </div>
    );
  }

  // the client's home is their project's Pulse (U2a): the decisions waiting on them are its "one thing
  // needs you", so their approval cards would only repeat it; anything else still follows below
  if (role === 'client') {
    const rest = items.filter((it) => it.key !== 'client-pending' && it.key !== 'client-reapprove');
    return (
      <div className={`${styles.screen} ${styles.mid}`}>
        <ClientPulse also={rest.length ? <ActionList items={rest} onOpen={setScreen} /> : undefined} />
      </div>
    );
  }

  // the PMC's home is their brief across every project they run (U3b). The active project's own cards
  // follow below it; its inspection card is dropped only while "Do these first" already names that
  // task, so nothing is hidden behind the brief's cut. Until a server answers (or in the demo, which
  // has none), and whenever the last answer is no longer fresh, the PMC keeps the list below.
  if (role === 'pmc' && brief && brief.projects.length > 0 && briefIsFresh(briefAt, Date.now())) {
    const named = pmcBrief(brief.projects, Date.now()).first;
    const reviewsNamed = named.some((t) => t.kind === 'reviews' && t.projectId === activeProjectId);
    const rest = items.filter((it) => !(reviewsNamed && it.key === 'pmc-reviews'));
    return (
      <div className={`${styles.screen} ${styles.mid}`}>
        <PmcBrief brief={brief} also={rest.length ? <ActionList items={rest} onOpen={setScreen} /> : undefined} />
      </div>
    );
  }

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <Eyebrow>{FY.eyebrow[lang]} · {lang === 'en' ? forYouRole[role].en.toUpperCase() : forYouRole[role][lang]}</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em', marginTop: 4 }}>
        {total ? forYouCount(total, lang) : FY.caughtUp[lang]}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, maxWidth: 560 }}>
        {forYouIntro(lang, role).before}<b>{short}</b>{forYouIntro(lang, role).after}
      </div>

      {items.length === 0 ? (
        <div
          data-testid="inbox-empty"
          style={{ marginTop: 34, textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '34px 16px', border: '1px dashed var(--hairline)', borderRadius: 14 }}
        >
          <CircleCheck size={28} color="var(--green-solid)" />
          <div style={{ marginTop: 10, fontWeight: 600, color: 'var(--ink)' }}>{FY.nothing[lang]}</div>
          <div style={{ marginTop: 4 }}>{forYouNothingDetail(lang, role)}</div>
        </div>
      ) : (
        <div style={{ marginTop: 22 }}>
          <ActionList items={items} onOpen={setScreen} />
        </div>
      )}
    </div>
  );
}

/** The For You cards: one row per item, each a one-tap jump to where the thing is done. */
function ActionList({ items, onOpen }: { items: ActionItem[]; onOpen: (screen: ActionItem['screen']) => void }) {
  // Top 10 #3 (#774) — an item about ONE record opens that record, at its reload-safe URL, not the list
  const openItem = useStore((s) => s.openItem);
  const lang = useStore((s) => s.lang);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {items.map((it) => {
        const t = TONE[it.tone];
        const words = actionItemText(it, lang);
        return (
          <div key={it.key} data-testid={`inbox-item-${it.key}`} style={{ ...card, borderColor: t.border }}>
            <span aria-hidden style={{ ...rail, background: t.accent }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.3 }}>{words.title}</div>
              {words.detail && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {words.detail}
                </div>
              )}
            </div>
            <Button
              variant={it.tone === 'red' ? 'danger' : it.tone === 'amber' ? 'accent' : 'ink'}
              onClick={() => (it.item ? openItem(it.screen, it.item) : onOpen(it.screen))}
              data-testid={`inbox-cta-${it.key}`}
              style={{ flex: 'none', padding: '9px 13px', fontSize: 13 }}
            >
              {words.cta} <ArrowRight size={15} />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

const card: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 13,
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 13,
  padding: '13px 15px 13px 18px',
  overflow: 'hidden',
};

const rail: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 4,
};
