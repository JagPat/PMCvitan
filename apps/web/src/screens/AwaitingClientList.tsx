import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import type { AwaitingClientRow } from '@/data/apiGateway';
import { LocationContext } from '@/components';
import { decisionRail } from '@vitan/shared';

const DAY_MS = 86_400_000;

/** The waiting age is re-read on this beat, so a screen left open past midnight does not lag a day behind. */
const CLOCK_TICK_MS = 60_000;

/** How long a row has waited, in whole days: from the server's `waitingSince`, or the demo seed's `ageDays`. */
function waitingDays(row: AwaitingClientRow & { ageDays?: number }, now: number): number | null {
  if (row.waitingSince) return Math.max(0, Math.floor((now - Date.parse(row.waitingSince)) / DAY_MS));
  return row.ageDays ?? null;
}

/**
 * #482 QA check (14 Oct 2026, item 4) — the decisions waiting on the CLIENT, read-only, at the top of the
 * engineer's, contractor's and consultant's Decisions screen, so they can plan around them. A summary from the
 * server (title, place, how long it has waited): never the options, prices or a decide button, which stay with
 * the client. With no server (the local demo) it reads the seeded decisions the same way. Only a NEW decision
 * is listed: a reopened one is already a row of the register below, which these roles read, so it shows once.
 */
export function AwaitingClientList() {
  const fetchAwaitingClient = useStore((s) => s.fetchAwaitingClient);
  const scope = useStore((s) => `${s.activeProjectId}:${s.projectScopeGeneration}`);
  // any reconcile (an approval, a reopening) may change what waits; a fresh read follows the decisions slice
  const decisions = useStore((s) => s.decisions);
  const seeded = useStore(useShallow((s) =>
    s.decisions.filter((d) => !d.draft && (d.deciderKind ?? 'client') === 'client' && d.status === 'pending')));
  const [served, setServed] = useState<{ scope: string; rows: AwaitingClientRow[] | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let live = true;
    fetchAwaitingClient()
      .then((rows) => {
        if (!live) return; // a reply for a screen or a project that is gone
        setServed({ scope, rows });
        setFailed(false);
        setNow(Date.now());
      })
      .catch(() => {
        if (!live) return;
        // an earlier list may no longer be true (the client may have just decided): show the failure, never stale rows
        setServed(null);
        setFailed(true);
      });
    return () => { live = false; };
  }, [fetchAwaitingClient, scope, decisions, attempt]);

  const current = served?.scope === scope ? served : null;
  const rows: (AwaitingClientRow & { ageDays?: number })[] | null = !current
    ? null
    // a reopened decision is already a row of the register below, read by these roles: listed once, there
    : current.rows?.filter((r) => r.status === 'pending')
      ?? seeded.map((d) => ({ id: d.id, title: d.title, room: d.room, nodeId: d.nodeId ?? null, status: 'pending' as const, waitingSince: '', ageDays: d.ageDays }));

  return (
    <section data-testid="awaiting-client" aria-labelledby="awaiting-client-title" style={{ margin: '4px 0 26px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 id="awaiting-client-title" style={{ fontFamily: 'var(--font-serif)', fontSize: 21, fontWeight: 500, margin: 0 }}>Awaiting client</h2>
        {rows && rows.length > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }} data-testid="awaiting-client-count">
            {rows.length} {rows.length === 1 ? 'DECISION' : 'DECISIONS'}
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>New decisions the client still has to make, shown so you can plan around them. Reopened ones are in the list below.</div>

      {rows === null && !failed && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12 }}>Loading…</div>}
      {rows === null && failed && (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12 }} data-testid="awaiting-client-failed">
          Couldn't load what the client is deciding. Check your connection.{' '}
          <button
            type="button"
            onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}
            style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--ink)', textDecoration: 'underline', cursor: 'pointer' }}
            data-testid="awaiting-client-retry"
          >
            Try again
          </button>
        </div>
      )}
      {rows !== null && rows.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12 }} data-testid="awaiting-client-empty">No new decision is waiting on the client.</div>
      )}
      {rows !== null && rows.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => {
            const days = waitingDays(r, now);
            return (
              <li
                key={r.id}
                data-testid={`awaiting-client-${r.id}`}
                style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderLeft: `4px solid ${decisionRail[r.status]}`, borderRadius: 12, padding: '11px 14px' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{r.title}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {days === null ? 'Waiting on the client' : `Waiting ${days} ${days === 1 ? 'day' : 'days'}`}
                  </span>
                </div>
                <div style={{ marginTop: 3 }}>
                  <LocationContext nodeId={r.nodeId ?? undefined} fallback={r.room} compact testId={`awaiting-client-place-${r.id}`} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
