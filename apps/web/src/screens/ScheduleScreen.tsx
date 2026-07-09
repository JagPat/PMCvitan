import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { gatesFor, activityReady, selectSchToday, pctOf, phaseRollup, activitiesInPhase } from '@/store/selectors';
import { Eyebrow, GateDot, ActivityChip, Button } from '@/components';
import { PencilRuler } from '@/lib/icons';
import { dayLabel, gateColor, type Activity, type Phase } from '@vitan/shared';
import type { AppState } from '@/store/store';
import styles from './responsive.module.css';

function ActionButton({ a, ready }: { a: Activity; ready: boolean }) {
  const startActivity = useStore((s) => s.startActivity);
  const completeActivity = useStore((s) => s.completeActivity);

  if (a.status === 'done') {
    return <Button variant="light" disabled style={{ opacity: 0.5, background: '#EAE5DA', color: 'var(--muted)', border: '1px solid rgba(35,33,28,.12)', fontSize: 12.5, padding: '9px 14px' }}>Completed</Button>;
  }
  if (a.status === 'blocked') {
    return <Button variant="dangerOutline" disabled style={{ background: '#fff', fontSize: 12.5, padding: '9px 14px' }}>Blocked</Button>;
  }
  if (a.status === 'in-progress') {
    return <Button variant="success" onClick={() => completeActivity(a.id)} style={{ fontSize: 12.5, padding: '9px 14px' }}>Mark complete</Button>;
  }
  if (ready) {
    return <Button variant="ink" onClick={() => startActivity(a.id)} data-testid={`start-${a.id}`} style={{ fontSize: 12.5, padding: '9px 14px' }}>Start activity</Button>;
  }
  return <Button variant="light" disabled style={{ background: 'var(--amber-chip)', color: 'var(--amber-text)', border: '1px solid var(--amber-border)', fontSize: 12.5, padding: '9px 14px' }}>Waiting</Button>;
}

function ScheduleRow({ a, todayPct }: { a: Activity; todayPct: number }) {
  const state = useStore((s) => s) as AppState;
  const setScreen = useStore((s) => s.setScreen);
  const gates = gatesFor(state, a);
  const ready = activityReady(state, a);
  // the controlled drawing this activity builds from (Drawings Slice 2 linkage)
  const linkedDrawing = state.drawings.find((d) => d.activityId === a.id);
  const plannedLine = `Plan ${dayLabel(a.ps)} → ${dayLabel(a.pe)}`;
  const actualLine = a.as == null ? 'Not started' : `Actual ${dayLabel(a.as)} → ${a.ae == null ? 'ongoing' : dayLabel(a.ae)}`;
  const actualColor = a.status === 'blocked' ? 'var(--red-solid)' : a.status === 'done' ? 'var(--green-solid)' : 'var(--accent)';

  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '14px 18px', animation: 'vpop .3s' }} data-testid={`sched-${a.id}`}>
      <div className={styles.schedRow}>
        <div style={{ width: 210, flex: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)' }}>{a.id}</span>
            <ActivityChip status={a.status} />
          </div>
          <div style={{ fontWeight: 600, fontSize: 14.5, marginTop: 4 }}>{a.name}</div>
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 1 }}>{a.zone}</div>
          {linkedDrawing?.current && (
            <button
              onClick={() => setScreen('drawings')}
              data-testid={`sched-dwg-${a.id}`}
              title={`Governed by ${linkedDrawing.number} — open the Drawings register`}
              style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 6, padding: '3px 7px', fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--muted)' }}
            >
              <PencilRuler size={11} /> {linkedDrawing.number} · Rev {linkedDrawing.current.rev}
            </button>
          )}
        </div>

        <div className={styles.schedTimelineWrap} style={{ flex: 1 }}>
          <div style={{ position: 'relative', height: 28, minWidth: 320, margin: '0 4px' }}>
            <div style={{ position: 'absolute', left: 0, right: 0, top: 13, height: 1, background: 'rgba(35,33,28,.1)' }} />
            <div style={{ position: 'absolute', top: 5, height: 7, borderRadius: 4, background: 'rgba(35,33,28,.16)', left: `${pctOf(a.ps)}%`, width: `${pctOf(a.pe - a.ps)}%` }} />
            {a.as != null && (
              <div style={{ position: 'absolute', top: 14, height: 7, borderRadius: 4, background: actualColor, left: `${pctOf(a.as)}%`, width: `${pctOf((a.ae == null ? state.todayDay : a.ae) - a.as)}%` }} />
            )}
            <div style={{ position: 'absolute', top: -4, bottom: -4, width: 2, background: 'var(--accent)', left: `${todayPct}%` }} />
          </div>
        </div>

        <div style={{ width: 130, flex: 'none' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink)' }}>{plannedLine}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)', marginTop: 2 }}>{actualLine}</div>
        </div>

        <div style={{ display: 'flex', gap: 9, width: 104, flex: 'none' }}>
          {gates.map((g) => (
            <div key={g.k} title={`${g.label} — ${{ ok: 'ready', wait: 'waiting', fail: 'failed', na: 'n/a' }[g.v]}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <GateDot v={g.v} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--muted)' }}>{g.k}</span>
            </div>
          ))}
        </div>

        <ActionButton a={a} ready={ready} />
      </div>
    </div>
  );
}

/** A phase header + its activities. Rollup counts are recomputed live from the
 *  activities so Start / Mark-complete move the phase's progress immediately. */
function PhaseGroup({ phase, activities, todayPct }: { phase: Phase; activities: Activity[]; todayPct: number }) {
  const acts = activitiesInPhase(activities, [phase], phase.id);
  if (acts.length === 0) return null;
  const r = phaseRollup(activities, phase.id);
  const window = `${dayLabel(phase.plannedStart)} → ${dayLabel(phase.plannedEnd)}`;

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ minWidth: 200 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.1em', color: 'var(--faint)' }}>PHASE · {window}</div>
          <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-.01em' }}>{phase.name}</div>
        </div>
        <div style={{ flex: 1, minWidth: 150, maxWidth: 320 }}>
          <div style={{ height: 8, borderRadius: 5, background: 'rgba(35,33,28,.1)', overflow: 'hidden' }}>
            <div style={{ width: `${r.donePct}%`, height: '100%', background: 'var(--green-solid)', transition: 'width .3s' }} />
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            {r.done}/{r.activityTotal} done · {r.donePct}%
          </div>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {[
            { v: r.inProgress, l: 'running', c: 'var(--amber-text)' },
            { v: r.blocked, l: 'blocked', c: 'var(--red-solid)' },
            { v: r.notStarted, l: 'to start', c: 'var(--muted)' },
          ].filter((x) => x.v > 0).map((x) => (
            <span key={x.l} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: x.c, border: '1px solid var(--hairline)', borderRadius: 6, padding: '3px 8px', background: 'var(--panel)' }}>
              {x.v} {x.l}
            </span>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {acts.map((a) => <ScheduleRow key={a.id} a={a} todayPct={todayPct} />)}
      </div>
    </div>
  );
}

export function ScheduleScreen() {
  const activities = useStore(useShallow((s) => s.activities));
  const phases = useStore(useShallow((s) => s.phases));
  const sch = useStore(useShallow(selectSchToday));
  const todayDay = useStore((s) => s.todayDay);
  const projStart = useStore((s) => s.projStart);
  const projEnd = useStore((s) => s.projEnd);
  const elapsedPct = useStore((s) => s.elapsedPct);
  const todayPct = pctOf(todayDay);

  const legend: { c: string; label: string }[] = [
    { c: gateColor.ok, label: 'Ready' },
    { c: gateColor.wait, label: 'Waiting' },
    { c: gateColor.fail, label: 'Failed' },
  ];

  return (
    <div className={`${styles.screen} ${styles.wide}`}>
      <Eyebrow>SITE ACTIVITY SCHEDULE</Eyebrow>
      <div className={styles.headRule} style={{ margin: '6px 0 20px' }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>What is starting, running &amp; ending on site</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 7, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>Project {projStart} → {projEnd}</span>
            <span>·</span>
            <span>{elapsedPct}% time elapsed</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {[
            { v: sch.inProgress, l: 'RUNNING', c: 'var(--amber-text)' },
            { v: sch.doneWeek, l: 'DONE', c: 'var(--green-text)' },
            { v: sch.blocked, l: 'BLOCKED', c: 'var(--red-solid)' },
          ].map((s) => (
            <div key={s.l} style={{ textAlign: 'center', background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 14px' }}>
              <div data-testid={`sch-${s.l.toLowerCase()}`} style={{ fontWeight: 700, fontSize: 19, color: s.c }}>{s.v}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--muted)', letterSpacing: '.08em' }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 14, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, letterSpacing: '.1em', color: 'var(--ink)' }}>GATES TO START:</span>
        {legend.map((g) => (
          <span key={g.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: g.c }} />
            {g.label}
          </span>
        ))}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', boxShadow: 'inset 0 0 0 1px rgba(35,33,28,.25)' }} />N/A
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 14, height: 2, background: 'rgba(35,33,28,.3)' }} />Planned
          <span style={{ width: 14, height: 3, background: 'var(--accent)', marginLeft: 8 }} />Actual
        </span>
      </div>

      {phases.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {phases.map((ph) => (
            <PhaseGroup key={ph.id} phase={ph} activities={activities} todayPct={todayPct} />
          ))}
          {/* unphased activities (if any) render under their own group */}
          {activitiesInPhase(activities, phases, null).length > 0 && (
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.1em', color: 'var(--faint)', marginBottom: 10 }}>UNPHASED</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activitiesInPhase(activities, phases, null).map((a) => (
                  <ScheduleRow key={a.id} a={a} todayPct={todayPct} />
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {activities.map((a) => (
            <ScheduleRow key={a.id} a={a} todayPct={todayPct} />
          ))}
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5, maxWidth: 760 }}>
        Each activity can only <strong>Start</strong> when its four gates align — the <strong>Decision</strong> is locked, the approved{' '}
        <strong>Material</strong> is on site, the <strong>Team</strong> is present, and the pre-work <strong>Inspection</strong> has passed.
        It can only be marked <strong>Done</strong> after its closing inspection.
      </div>
    </div>
  );
}
