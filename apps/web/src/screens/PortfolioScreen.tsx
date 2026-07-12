import { useEffect, useMemo, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { API_BASE } from '@/data/apiGateway';
import { Eyebrow, Button, EmptyState } from '@/components';
import { ArrowRight } from '@/lib/icons';
import type { PortfolioProject } from '@vitan/shared';
import styles from './responsive.module.css';

const ROLE_LABEL: Record<string, string> = { pmc: 'PMC', client: 'Client', engineer: 'Engineer', contractor: 'Contractor' };

/**
 * Portfolio — a cross-project monitoring board. One card per project the PMC can
 * access, each with a live activity rollup (done/total, running, blocked), open
 * reviews and pending decisions, so several sites are visible at a glance. The
 * "Open" button re-scopes the session to that project (the project switcher, by
 * another route). In the local demo (no server) it synthesises a single row for
 * the seeded project from the in-store activities.
 */
export function PortfolioScreen() {
  const portfolio = useStore(useShallow((s) => s.portfolio));
  const loadPortfolio = useStore((s) => s.loadPortfolio);
  const switchProject = useStore((s) => s.switchProject);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const myOrgs = useStore(useShallow((s) => s.myOrgs));
  const archivedProjects = useStore(useShallow((s) => s.archivedProjects));
  const loadArchivedProjects = useStore((s) => s.loadArchivedProjects);
  const restoreProject = useStore((s) => s.restoreProject);
  // Restore is an org-admin power; use the caller's first owner/admin org (single-practice case).
  const adminOrg = myOrgs.find((o) => o.role === 'owner' || o.role === 'admin');

  // demo fallback: with no server the portfolio endpoint returns nothing, so
  // build one row from the seeded local state (keeps the screen meaningful).
  const activities = useStore(useShallow((s) => s.activities));
  const phases = useStore(useShallow((s) => s.phases));
  // exclude private drafts from the cross-project pending-decision rollup
  const decisions = useStore(useShallow((s) => s.decisions.filter((d) => !d.draft)));
  const reviews = useStore(useShallow((s) => s.reviews));
  const role = useStore((s) => s.role);

  const rows: PortfolioProject[] = useMemo(() => {
    if (portfolio.length > 0) return portfolio;
    // live: the server's portfolio is the truth — an empty one renders honestly
    // empty below, never a fabricated current-project row (Phase 0 Task 7)
    if (API_BASE) return portfolio;
    const done = activities.filter((a) => a.status === 'done').length;
    const inProgress = activities.filter((a) => a.status === 'in-progress').length;
    const blocked = activities.filter((a) => a.status === 'blocked').length;
    const notStarted = activities.filter((a) => a.status === 'not-started').length;
    const canSeePending = role === 'pmc' || role === 'client';
    return [
      {
        projectId: activeProjectId,
        name: 'Residence at Ambli, Ahmedabad',
        short: 'Residence at Ambli',
        stage: 'Finishing Stage',
        role: role,
        orgName: 'Vitan Architecture',
        activityTotal: activities.length,
        done,
        inProgress,
        blocked,
        notStarted,
        donePct: activities.length ? Math.round((done / activities.length) * 100) : 0,
        openReviews: reviews.filter((r) => !r.decided).length,
        pendingDecisions: canSeePending ? decisions.filter((d) => d.status === 'pending').length : 0,
        phaseCount: phases.length,
        milestonePct: 72,
      },
    ];
  }, [portfolio, activities, phases, decisions, reviews, role, activeProjectId]);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio, activeProjectId]);
  useEffect(() => { if (adminOrg) loadArchivedProjects(adminOrg.id); }, [loadArchivedProjects, adminOrg]);

  return (
    <div className={`${styles.screen} ${styles.wide}`}>
      <Eyebrow>PORTFOLIO</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em', margin: '6px 0 4px' }}>Every project at a glance</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 22, maxWidth: 620 }}>
        Progress, what&apos;s blocked, and what&apos;s waiting on you — across all the projects you run. Open one to work in it.
      </div>

      {rows.length === 0 && (
        <EmptyState
          title="No portfolio data available"
          detail="Projects you can access appear here once the server reports them. Create a project or ask your organisation admin for access."
        />
      )}

      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {rows.map((p) => {
          const active = p.projectId === activeProjectId;
          return (
            <div key={p.projectId} style={cardStyle} data-testid={`portfolio-${p.projectId}`}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 16.5, letterSpacing: '-.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.short}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                    {p.orgName ? `${p.orgName} · ` : ''}{p.stage}
                  </div>
                </div>
                <span style={roleChip}>{ROLE_LABEL[p.role] ?? p.role}</span>
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ height: 9, borderRadius: 5, background: 'rgba(35,33,28,.1)', overflow: 'hidden' }}>
                  <div style={{ width: `${p.donePct}%`, height: '100%', background: 'var(--green-solid)' }} />
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>
                  {p.done}/{p.activityTotal} activities done · {p.donePct}%{p.phaseCount > 0 ? ` · ${p.phaseCount} phases` : ''}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 12 }}>
                {[
                  { v: p.inProgress, l: 'running', c: 'var(--amber-text)' },
                  { v: p.blocked, l: 'blocked', c: 'var(--red-solid)' },
                  { v: p.openReviews, l: 'to review', c: 'var(--amber-text)' },
                  { v: p.pendingDecisions, l: 'decisions', c: 'var(--accent)' },
                ].filter((x) => x.v > 0).map((x) => (
                  <span key={x.l} style={{ ...statChip, color: x.c }}>{x.v} {x.l}</span>
                ))}
                {p.inProgress + p.blocked + p.openReviews + p.pendingDecisions === 0 && (
                  <span style={{ ...statChip, color: 'var(--green-text)' }}>on track</span>
                )}
              </div>

              <div style={{ marginTop: 14 }}>
                {active ? (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--green-text)', letterSpacing: '.04em' }}>● CURRENTLY OPEN</span>
                ) : (
                  <Button variant="ink" onClick={() => switchProject(p.projectId)} data-testid={`open-${p.projectId}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', fontSize: 12.5 }}>
                    Open project <ArrowRight size={14} />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {adminOrg && archivedProjects.length > 0 && (
        <div style={{ marginTop: 34, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}>
          <Eyebrow>ARCHIVED PROJECTS</Eyebrow>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 0 14px', maxWidth: 560 }}>
            Archived projects are hidden from the switcher and portfolio. Restore one to bring it back.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {archivedProjects.map((p) => (
              <div key={p.id} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }} data-testid={`archived-${p.id}`}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{p.short}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.name}</div>
                </div>
                <Button variant="outline" onClick={() => restoreProject(adminOrg.id, p.id)} data-testid={`restore-${p.id}`} style={{ fontSize: 12.5, padding: '9px 14px' }}>
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const cardStyle: CSSProperties = { background: '#fff', border: '1px solid var(--hairline)', borderRadius: 14, padding: '16px 18px' };
const roleChip: CSSProperties = { flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--hairline)', color: 'var(--muted)', textTransform: 'uppercase' };
const statChip: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, border: '1px solid var(--hairline)', borderRadius: 6, padding: '3px 8px', background: 'var(--panel)' };
