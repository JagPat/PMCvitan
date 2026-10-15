import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { pathForScreen } from '@/lib/screens';
import { decisionsSliceSettled } from '@/lib/notifications';
import { useMayWithdrawChange } from '@/lib/mayWithdrawChange';
import { useStore } from '@/store/store';
import { selectDecisionsNeedingViewer, selectLogDecisions } from '@/store/selectors';
import { Eyebrow, DecisionChip, Button, LocationContext, EditState, ConsultationThread, CountersignControls, ItemNotFound } from '@/components';
import { IssueDecisionModal } from '@/screens/modals/IssueDecisionModal';
import { AwaitingClientList } from './AwaitingClientList';
import { EmptyHint } from '@/guide/EmptyHint';
import { Lock, Plus, ChevronRight } from '@/lib/icons';
import {
  swatch as swatchGradient, decisionRail, can, decisionLogLabels as L, decisionGroupByLabels, decisionStatusWords, decisionLogText as T,
  type Decision, type Lang, type ProjectNode,
} from '@vitan/shared';
import { groupDecisions, locationSegments, pathOf, type DecisionGroup, type GroupBy } from '@/lib/locationTree';
import styles from './responsive.module.css';

const GROUP_OPTIONS: GroupBy[] = ['location', 'room', 'element', 'status', 'flat'];
// Phase 6 task 4a — the register keeps withdrawn rows (pmc-only; the server filters them out of every
// other role's snapshot, so that chip simply never matches for them).
// Phase 6 task 4d-ii-b / B3 — the filter set answers EVERY status (the API's status tripwire pins it): a
// record is a filed fact the reader may want alone, and a decision awaiting the architect's countersign is
// its own state between approval and lock. Neither new chip matches a row while the doors stand (no row can
// be awaiting) unless the project files records.
/** The roles who decide nothing the client holds but plan their work around it (#482 QA check, 14 Oct 2026). */
const PLANS_AROUND_CLIENT: ReadonlySet<string> = new Set(['engineer', 'contractor', 'consultant']);
// (#482 QA item 3 — each chip's words are the shared `decisionStatusWords`, in the viewer's language)
const STATUS_FILTERS: { key: Decision['status'] }[] = [
  { key: 'pending' },
  { key: 'approved' },
  { key: 'change' },
  { key: 'withdrawn' },
  { key: 'recorded' },
  { key: 'awaiting_countersign' },
];

/** A decision with no published place and no free-text room: `locationSegments` files it under "Unfiled". */
const isUnfiled = (d: Decision, nodes: ProjectNode[]): boolean => !d.room && pathOf(nodes, d.nodeId).length === 0;

/** A group heading in the viewer's language: a status, or a group the register itself names ("No room");
 *  a place is project data and is shown as recorded. English is the grouping's own label. */
function groupLabel(g: DecisionGroup, groupBy: GroupBy, nodes: ProjectNode[], lang: Lang): string {
  if (lang === 'en') return g.label;
  if (groupBy === 'status') return (decisionStatusWords as Record<string, { group: Record<Lang, string> } | undefined>)[g.key]?.group[lang] ?? g.label;
  if (g.key === 'room:~none') return L.noRoom[lang];
  if (g.key === 'el:~none') return L.noObject[lang];
  if (g.key === 'all') return L.allDecisions[lang];
  // the register's own bucket for decisions filed nowhere, with no free-text room; a place someone named
  // "Unfiled" is project data and stays as recorded (Codex review of #928)
  if (g.label === 'Unfiled' && g.rows.length > 0 && g.rows.every((r) => isUnfiled(r.decision, nodes))) return L.unfiled[lang];
  return g.label;
}

/** `history` (QA check 14 Oct 2026, #482) — the register as the lower half of the client's one "Decisions"
 *  screen: the decisions still waiting on the viewer are listed above it, so they are left out here, and it
 *  sits inside that screen instead of being a page of its own. */
export function DecisionLogScreen({ variant = 'register' }: { variant?: 'register' | 'history' } = {}) {
  const history = variant === 'history';
  const logRows = useStore(useShallow(selectLogDecisions));
  const nodes = useStore(useShallow((s) => s.nodes));
  const openChange = useStore((s) => s.openChange);
  const withdrawChange = useStore((s) => s.withdrawChange);
  const openWithdraw = useStore((s) => s.openWithdraw);
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  // exactly the list above it on the client's screen (re-approvals and new ones waiting on this viewer)
  const waiting = useStore(useShallow(selectDecisionsNeedingViewer));
  const mayWithdraw = useMayWithdrawChange();
  // #482 follow-up — a decision waiting on the viewer is answered on its card above, which now carries its advice
  // thread and its "Withdraw request", so the history leaves every one of them out
  const rows = useMemo(() => {
    if (!history) return logRows;
    const above = new Set(waiting.map((d) => d.id));
    return logRows.filter((d) => !above.has(d.id));
  }, [history, logRows, waiting]);
  // Phase 6 task 4a — withdrawing the DECISION itself: pmc only, and only a published,
  // never-approved pending row is eligible (the service refuses everything else with a 409)
  const mayWithdrawDecision = (d: Decision): boolean =>
    can('decision.withdraw', role) && d.status === 'pending' && !d.draft;
  // Live bug 1 — a link naming a decision this register does not hold says so, once the decision
  // slice has settled (never during a load, and never over a failed read that holds nothing).
  const routeItem = useStore((s) => s.routeItem);
  const setRouteItem = useStore((s) => s.setRouteItem);
  // Codex 4204448859 — and never while a committed command's reconcile is still owed: its own snapshot
  // can land while the decision slice is still the pre-command one
  const settled = useStore(decisionsSliceSettled);
  const loadFailed = useStore((s) => s.decisionsLoad === 'error' || s.projectLoadState === 'error');
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const routedAbsent = routeItem !== null && !logRows.some((d) => d.id === routeItem);
  const missingItem = routedAbsent && settled ? routeItem : null;
  // Codex 4204448863 — a named decision not (yet) in the slice while the read is unsettled shows the
  // load boundary, never the whole register standing in for it under its URL
  const unsettledItem = routedAbsent && !settled;
  const [issuing, setIssuing] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('location');
  const [query, setQuery] = useState('');
  const [statuses, setStatuses] = useState<Set<Decision['status']>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((d) => {
      if (statuses.size && !statuses.has(d.status)) return false;
      if (!q) return true;
      const hay = [d.title, d.room, d.id, d.material ?? '', ...locationSegments(d, nodes)].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [rows, nodes, query, statuses]);

  const groups = useMemo(() => groupDecisions(filtered, nodes, groupBy), [filtered, nodes, groupBy]);
  // Codex 4203544317 — a record opened by its URL (a notification, a shared link) is SHOWN, not merely
  // named: when the register's own search or status filters hide it they are cleared, and its group is
  // expanded if collapsed. Once per navigation, and only when it is hidden: clicking a visible row keeps
  // the viewer's filters, and a group they collapse afterwards stays collapsed.
  const lastRoute = useRef<string | null>(null);
  const revealing = useRef<string | null>(null);
  useEffect(() => {
    if (routeItem !== lastRoute.current) {
      lastRoute.current = routeItem;
      revealing.current = routeItem;
    }
    const id = revealing.current;
    if (id === null || !rows.some((d) => d.id === id)) return; // not loaded yet: reveal when it is
    if (!filtered.some((d) => d.id === id)) {
      setQuery('');
      setStatuses(new Set());
      return; // the groups recompute, and this runs again to expand its group
    }
    const group = groups.find((g) => g.rows.some((r) => r.decision.id === id));
    if (group && collapsed.has(group.key)) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(group.key);
        return next;
      });
    }
    revealing.current = null;
  }, [routeItem, rows, filtered, groups, collapsed]);
  const toggleStatus = (s: Decision['status']) =>
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Codex 4206188374 — "Show all decisions" means all: the register may still be mounted with the
  // viewer's search, status filters or collapsed groups from before the link, so they are cleared too
  const showAll = () => {
    setQuery('');
    setStatuses(new Set());
    setCollapsed(new Set());
    setRouteItem(null);
  };
  const wrap = history ? undefined : `${styles.screen} ${styles.narrow}`;
  const eyebrow = history ? null : <Eyebrow>{L.eyebrow[lang]}</Eyebrow>;
  const title = history ? L.history[lang] : L.register[lang];
  const titleStyle: CSSProperties = history
    ? { fontFamily: 'var(--font-serif)', fontSize: 21, fontWeight: 500, marginTop: 28 }
    : { fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' };
  // Codex 4203544331 — a link to a decision this register does not hold shows ONLY that: the register
  // is not rendered beneath it as if it were the answer, and "Show all decisions" reveals it.
  if (unsettledItem) {
    return (
      <div className={wrap} data-testid={loadFailed ? 'decisions-unavailable' : 'decisions-loading'}>
        {eyebrow}
        {loadFailed ? (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14, display: 'grid', gap: 12, justifyItems: 'center' }}>
            <span>{L.loadFailed[lang]}</span>
            <Button data-testid="decisions-retry" onClick={() => requestFreshSnapshot()}>{L.retry[lang]}</Button>
          </div>
        ) : (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{L.loading[lang]}</div>
        )}
      </div>
    );
  }
  if (missingItem) {
    return (
      <div className={wrap}>
        {eyebrow}
        {/* inside the client's screen this boundary stands alone (#857 Codex 4268290494), so it names the screen */}
        <div style={{ ...titleStyle, margin: '6px 0 8px' }}>{history ? L.decisions[lang] : title}</div>
        <ItemNotFound what={L.what[lang]} id={missingItem} onShowAll={showAll} showAllLabel={L.showAll[lang]} lang={lang} />
      </div>
    );
  }

  return (
    <div className={wrap} data-testid={history ? 'decisions-history' : undefined}>
      {eyebrow}
      <div className={styles.headRule} style={{ margin: '6px 0 8px' }}>
        <div style={titleStyle}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>{T.count(filtered.length, lang)}</div>
          {can('decision.create', role) && (
            <Button variant="ink" onClick={() => setIssuing(true)} data-testid="issue-decision" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
              <Plus size={15} /> {L.issue[lang]}
            </Button>
          )}
        </div>
      </div>
      {issuing && <IssueDecisionModal onClose={() => setIssuing(false)} />}

      {/* #482 QA check (14 Oct 2026) — the engineer, contractor and consultant see what waits on the client, read-only */}
      {!history && PLANS_AROUND_CLIENT.has(role) && <AwaitingClientList />}

      {/* controls: group-by, search, status filter */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '12px 0 4px' }}>
        <div role="group" aria-label={L.groupBy[lang]} style={{ display: 'inline-flex', background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 2 }}>
          {GROUP_OPTIONS.map((key) => {
            const on = groupBy === key;
            return (
              <button key={key} onClick={() => setGroupBy(key)} aria-pressed={on} data-testid={`groupby-${key}`} style={{ padding: '6px 11px', minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, background: on ? 'var(--ink)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
                {decisionGroupByLabels[key][lang]}
              </button>
            );
          })}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={L.searchHint[lang]} aria-label={L.search[lang]} type="search" data-testid="decision-search" style={{ ...fldD, flex: '1 1 160px', minWidth: 44 }} />
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '8px 0 20px' }}>
        {STATUS_FILTERS.map((s) => {
          const on = statuses.has(s.key);
          return (
            <button key={s.key} onClick={() => toggleStatus(s.key)} aria-pressed={on} data-testid={`filter-${s.key}`} style={{ padding: '5px 11px', minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 20, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, border: `1px solid ${on ? 'var(--ink)' : 'var(--hairline)'}`, background: on ? 'var(--ink)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }}>
              {decisionStatusWords[s.key].filter[lang]}
            </button>
          );
        })}
      </div>

      {groups.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 13.5, padding: '10px 0' }}>
          {L.noMatch[lang]}
          {/* only once the decision slice has settled: a load, a failed read or a command still reconciling
              can show an empty register that is not empty on the server */}
          {rows.length === 0 && settled && <EmptyHint task="decision" />}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          const single = groupBy === 'flat';
          return (
            <div key={g.key} data-testid={`group-${g.key}`}>
              {!single && (
                <button
                  onClick={() => toggleGroup(g.key)}
                  data-testid={`group-head-${g.key}`}
                  style={{ width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', gap: 9, padding: '9px 4px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--hairline)', cursor: 'pointer', textAlign: 'left', marginBottom: isCollapsed ? 0 : 12 }}
                >
                  <ChevronRight size={15} style={{ transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s', color: 'var(--muted)' }} />
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{groupLabel(g, groupBy, nodes, lang)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>{g.counts.total}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {g.counts.pending > 0 && <RollupChip n={g.counts.pending} color="var(--amber-solid)" label={decisionStatusWords.pending.rollup[lang]} />}
                    {g.counts.change > 0 && <RollupChip n={g.counts.change} color="var(--red-solid)" label={decisionStatusWords.change.rollup[lang]} />}
                    {g.counts.awaiting_countersign > 0 && <RollupChip n={g.counts.awaiting_countersign} color={decisionRail.awaiting_countersign} label={decisionStatusWords.awaiting_countersign.rollup[lang]} />}
                    {g.counts.approved > 0 && <RollupChip n={g.counts.approved} color="var(--green-solid)" label={decisionStatusWords.approved.rollup[lang]} />}
                    {g.counts.withdrawn > 0 && <RollupChip n={g.counts.withdrawn} color="var(--muted)" label={decisionStatusWords.withdrawn.rollup[lang]} />}
                    {g.counts.recorded > 0 && <RollupChip n={g.counts.recorded} color="var(--muted)" label={decisionStatusWords.recorded.rollup[lang]} />}
                  </span>
                </button>
              )}
              {!isCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {g.rows.map(({ decision, subLabel }) => (
                    <DecisionRowCard
                      key={decision.id}
                      lang={lang}
                      d={decision}
                      subLabel={subLabel}
                      onChange={can('decision.change', role) ? () => openChange(decision.id) : undefined}
                      onWithdraw={mayWithdraw(decision) ? () => withdrawChange(decision.id) : undefined}
                      onWithdrawDecision={mayWithdrawDecision(decision) ? () => openWithdraw(decision.id) : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RollupChip({ n, color, label }: { n: number; color: string; label: string }) {
  return (
    <span title={T.rollup(n, label)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      {n}
    </span>
  );
}

/** One decision card — the register row, with its finer location shown as a caption. */
function DecisionRowCard({ d, subLabel, lang, onChange, onWithdraw, onWithdrawDecision }: { d: Decision; subLabel: string; lang: Lang; onChange?: () => void; onWithdraw?: () => void; onWithdrawDecision?: () => void }) {
  // B6 — `/decisions/<id>` names this decision: it is brought into view and marked, and its id is
  // a real link, so the register entry can be bookmarked or shared.
  const focused = useStore((st) => st.routeItem === d.id);
  const nodes = useStore(useShallow((st) => st.nodes));
  const setRouteItem = useStore((st) => st.setRouteItem);
  const openItem = useStore((st) => st.openItem);
  // the client's history sits inside their approval screen, where the item setter means the approval FOCUS
  // (#857 Codex 4268120369): there a register link opens the register's own path, which renders the same screen
  const onRegister = useStore((st) => st.screen === 'decision-log');
  const activeProjectId = useStore((st) => st.activeProjectId);
  useEffect(() => {
    if (focused) document.querySelector(`[data-testid="log-row-${CSS.escape(d.id)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focused, d.id]);
  const locked = d.status === 'approved';
  // Phase 6 task 4b (round-1 Codex F2) — a RECORD is a filed fact: no approver, no options, no
  // approval demand, no cost. It renders its own branch instead of borrowing the approved shape.
  const recorded = d.status === 'recorded';
  // Phase 6 task 4d-ii-b / B3 — a decision AWAITING its countersign carries its decider's PROVISIONAL
  // approval (the chosen option, the approver, the cost) but no lock: the attribution says who approved
  // it and what it still waits for, the photo tag says PROVISIONAL, and the lock icon stays final-only.
  const awaiting = d.status === 'awaiting_countersign';
  // Phase 6 task 4a — a withdrawn decision was never approved: it renders its options (never a
  // fabricated approval line), and its attribution names the withdrawer, not an approver.
  const neverLocked = d.status === 'pending' || d.status === 'withdrawn';
  // round-5 Codex F2 — the open-row attribution names the ACTUAL decider (the shared
  // `deciderNoun`): a pmc- or member-held row must not direct its own decider at the client.
  // The client-held text stays byte-identical (the legacy default).
  const kind = d.deciderKind ?? 'client';
  // #482 QA item 3 — every line in the viewer's language (English byte-identical); names, dates' digits,
  // options and materials are project data
  const attribution = recorded
    ? L.recorded[lang]
    : d.status === 'withdrawn'
      ? T.withdrawnBy(d.withdrawnBy, d.withdrawnAt ? new Date(d.withdrawnAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null, lang)
      : awaiting
        ? T.approvedAwaiting(d.approver, kind, lang)
        : d.approver
          ? T.approvedBy(d.approver, d.onBehalfOf, d.date, lang)
          : T.ageing(d.ageDays, kind, lang);
  const approvedLine = recorded
    ? L.recordedLine[lang]
    : neverLocked ? T.optionsPresented(d.options.length, lang) : `${d.approvedOption} — ${d.material}`;
  const costStr = recorded
    ? '—'
    : neverLocked ? T.costUpTo(Math.max(...d.options.map((o) => o.delta)), lang) : T.cost(d.cost ?? 0, lang);
  const photoLabel = (recorded ? L.tagRecorded : neverLocked ? L.tagOptions : awaiting ? L.tagProvisional : L.tagApproved)[lang];

  return (
    <div
      data-testid={`log-row-${d.id}`}
      aria-current={focused ? 'true' : undefined}
      style={{ outline: focused ? '2px solid var(--accent)' : undefined, outlineOffset: 2, background: 'var(--panel)', border: '1px solid var(--hairline)', borderLeft: `4px solid ${decisionRail[d.status]}`, borderRadius: 12, overflow: 'hidden', animation: 'vpop .3s' }}
    >
      <div className={styles.logRow}>
        <div className={styles.logPhoto} style={{ background: swatchGradient(d.photoSwatch ?? ''), position: 'relative', flex: 'none' }}>
          <span style={{ position: 'absolute', left: 8, bottom: 8, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,.9)', background: 'rgba(0,0,0,.4)', padding: '1px 6px', borderRadius: 3 }}>{photoLabel}</span>
        </div>
        <div style={{ flex: 1, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <a
                  href={pathForScreen('decision-log', activeProjectId, d.id)}
                  onClick={(e) => {
                    // only a plain primary click stays in-app; Ctrl/Cmd/Shift/Alt or a middle click
                    // keeps the browser's own behaviour (open the shared link in a new tab/window)
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    if (onRegister) setRouteItem(d.id);
                    else openItem('decision-log', d.id);
                  }}
                  data-testid={`log-link-${d.id}`}
                  aria-label={T.link(d.id, lang)}
                  // 44px hit area (WAVE_0 floor) without growing the title line: the negative
                  // margin gives the extra height back to the layout
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)', display: 'inline-flex', alignItems: 'center', minHeight: 44, minWidth: 44, margin: '-12px 0' }}
                >{d.id}</a>
                <span style={{ fontWeight: 600, fontSize: 16 }}>{d.title}</span>
                {locked && <Lock size={13} data-testid={`lock-${d.id}`} />}
              </div>
              {/* WHERE this decision belongs — tappable back to the Site Map at that place.
                  `subLabel` (the finer location under the group header) stays the fallback for a
                  legacy free-text decision that never got a node. */}
              <div style={{ marginTop: 3 }}>
                <LocationContext nodeId={d.nodeId} fallback={subLabel === 'Unfiled' && isUnfiled(d, nodes) ? L.unfiled[lang] : subLabel || d.room} compact testId={`decision-place-${d.id}`} lang={lang} />
              </div>
            </div>
            <DecisionChip status={d.status} lang={lang} />
          </div>
          {d.status === 'withdrawn' && d.withdrawReason && (
            <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 10, background: 'rgba(35,33,28,.05)', border: '1px solid rgba(35,33,28,.14)' }} data-testid={`withdraw-detail-${d.id}`}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>{L.withdrawn[lang]} {d.withdrawReason}</div>
            </div>
          )}
          {/* Phase 6 unit 4c-ii — the consultation thread and its affordances. Renders nothing at
              all off-pilot (the component reads the same per-project capability the server does),
              and nothing for a decision with no thread and no action available to this viewer. */}
          <ConsultationThread decision={d} lang={lang} />
          {/* Phase 6 task 4d-ii-b / B5b — the countersign chain's affordances and controls: Forward while the
              rollout is open, the architect's Countersign / Reject back / Forward on, the PMC's stranded
              resolution. Renders nothing for a delivered role while the doors stand. */}
          {/* English renders exactly as before (the component's default); another language is passed on */}
          <CountersignControls decision={d} lang={lang} />
          {d.status === 'change' && d.changeRequest && (
            <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 10, background: 'rgba(180,70,46,.07)', border: '1px solid rgba(180,70,46,.2)' }} data-testid={`cr-detail-${d.id}`}>
              {/* Phase 6 task 4d-ii-b / B4 — a request the architect opened by REJECTING the countersign names
                  its origin: the decider reads that their provisional approval was sent back, not that a
                  colleague asked for a change. A standard request reads exactly as it always did. */}
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--red-text)' }}>
                {d.changeRequest.origin === 'countersign_rejection'
                  ? <span data-testid={`cr-origin-${d.id}`}>{L.sentBack[lang]} {d.changeRequest.reason}</span>
                  : <>{L.changeRequested[lang]} {d.changeRequest.reason}</>}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                {T.cost(d.changeRequest.costImpact, lang)}
                {' · '}
                {T.scheduleImpact(d.changeRequest.timeImpactDays, lang)}
                {T.awaitingReapproval(kind, lang)}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(35,33,28,.1)', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{approvedLine}</div>
              <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 3 }}>{attribution}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: (d.cost ?? 0) > 0 ? 'var(--ink)' : 'var(--muted)' }}>{costStr}</div>
              {onWithdrawDecision && (
                <Button variant="outline" onClick={onWithdrawDecision} data-testid={`withdraw-decision-${d.id}`} style={{ marginTop: 7, padding: '6px 12px', fontSize: 11.5, fontWeight: 500 }}>
                  {L.withdrawDecision[lang]}
                </Button>
              )}
            </div>
          </div>
          {/* Can I edit this? If not, why — and what may I do instead? The verdict is the domain's
              (approved ⇒ locked; a change request is with the DECIDER — round-11 Codex F2:
              every message on this workflow derives from `deciderNoun(kind)`, so a pmc- or
              member-held reopening never directs anyone at the client; the client-held text is
              byte-identical since deciderNoun('client') === 'the client'). */}
          {locked && (
            <div style={{ marginTop: 10 }}>
              <EditState
                state="locked"
                reason={L.locked[lang]}
                action={onChange ? { label: L.requestChange[lang], onClick: onChange, testId: `request-change-${d.id}` } : undefined}
                testId={`edit-state-${d.id}`}
              />
            </div>
          )}
          {d.status === 'change' && (
            <div style={{ marginTop: 10 }}>
              <EditState
                state="workflow"
                reason={T.changeWithDecider(kind, lang)}
                action={onWithdraw ? { label: L.withdrawRequest[lang], onClick: onWithdraw, testId: `withdraw-${d.id}` } : undefined}
                testId={`edit-state-${d.id}`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const fldD: CSSProperties = { height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
