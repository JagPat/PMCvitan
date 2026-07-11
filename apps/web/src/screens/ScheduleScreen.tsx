import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { gatesFor, activityReady, selectSchToday, pctOf, phaseRollup, activitiesInPhase } from '@/store/selectors';
import { Eyebrow, GateDot, ActivityChip, Button, Modal } from '@/components';
import { LocationPicker } from '@/components/LocationPicker';
import { PencilRuler, Pencil, Plus, X } from '@/lib/icons';
import { dayLabel, gateColor, can, type Activity, type Phase, type Gate } from '@vitan/shared';
import type { AppState } from '@/store/store';
import type { NewActivityInput } from '@/data/apiGateway';
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

function ScheduleRow({ a, todayPct, onEdit }: { a: Activity; todayPct: number; onEdit?: (a: Activity) => void }) {
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
            {onEdit && (
              <button onClick={() => onEdit(a)} aria-label={`Edit ${a.name}`} data-testid={`edit-${a.id}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
                <Pencil size={12} />
              </button>
            )}
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
function PhaseGroup({ phase, activities, todayPct, onEdit, onDeletePhase }: { phase: Phase; activities: Activity[]; todayPct: number; onEdit?: (a: Activity) => void; onDeletePhase?: (phaseId: string) => void }) {
  const acts = activitiesInPhase(activities, [phase], phase.id);
  if (acts.length === 0 && !onDeletePhase) return null;
  const r = phaseRollup(activities, phase.id);
  const window = `${dayLabel(phase.plannedStart)} → ${dayLabel(phase.plannedEnd)}`;

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ minWidth: 200 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.1em', color: 'var(--faint)' }}>PHASE · {window}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-.01em' }}>{phase.name}</div>
            {onDeletePhase && (
              <button onClick={() => onDeletePhase(phase.id)} aria-label={`Remove phase ${phase.name}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
                <X size={14} />
              </button>
            )}
          </div>
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
        {acts.map((a) => <ScheduleRow key={a.id} a={a} todayPct={todayPct} onEdit={onEdit} />)}
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
  const role = useStore((s) => s.role);
  const deletePhase = useStore((s) => s.deletePhase);
  const todayPct = pctOf(todayDay);
  const canPlan = can('activity.manage', role);
  const [plan, setPlan] = useState<'new' | Activity | null>(null);
  const [addingPhase, setAddingPhase] = useState(false);
  const onEdit = canPlan ? (a: Activity) => setPlan(a) : undefined;
  const onDeletePhase = canPlan ? (id: string) => deletePhase(id) : undefined;

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

      {canPlan && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <Button variant="ink" onClick={() => setPlan('new')} data-testid="plan-activity" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
            <Plus size={15} /> Plan activity
          </Button>
          <Button variant="outline" onClick={() => setAddingPhase(true)} data-testid="add-phase" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
            <Plus size={15} /> Add phase
          </Button>
        </div>
      )}
      {plan && <PlanActivityModal activity={plan === 'new' ? null : plan} onClose={() => setPlan(null)} />}
      {addingPhase && <AddPhaseModal onClose={() => setAddingPhase(false)} />}

      {phases.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {phases.map((ph) => (
            <PhaseGroup key={ph.id} phase={ph} activities={activities} todayPct={todayPct} onEdit={onEdit} onDeletePhase={onDeletePhase} />
          ))}
          {/* unphased activities (if any) render under their own group */}
          {activitiesInPhase(activities, phases, null).length > 0 && (
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.1em', color: 'var(--faint)', marginBottom: 10 }}>UNPHASED</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activitiesInPhase(activities, phases, null).map((a) => (
                  <ScheduleRow key={a.id} a={a} todayPct={todayPct} onEdit={onEdit} />
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {activities.map((a) => (
            <ScheduleRow key={a.id} a={a} todayPct={todayPct} onEdit={onEdit} />
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

const GATE_VALUES: Gate[] = ['na', 'wait', 'ok', 'fail'];

/** PMC plans a new activity or edits an existing one (name, zone, planned window in
 *  day-offsets, phase, linked decision, and the material/team/inspection gates). */
function PlanActivityModal({ activity, onClose }: { activity: Activity | null; onClose: () => void }) {
  const createActivity = useStore((s) => s.createActivity);
  const updateActivity = useStore((s) => s.updateActivity);
  const deleteActivity = useStore((s) => s.deleteActivity);
  const phases = useStore(useShallow((s) => s.phases));
  const decisions = useStore(useShallow((s) => s.decisions));
  const [name, setName] = useState(activity?.name ?? '');
  const [zone, setZone] = useState(activity?.zone ?? '');
  const [ps, setPs] = useState(String(activity?.ps ?? 0));
  const [pe, setPe] = useState(String(activity?.pe ?? 7));
  const [phaseId, setPhaseId] = useState(activity?.phaseId ?? '');
  const [decisionId, setDecisionId] = useState(activity?.decisionId ?? '');
  const [nodeId, setNodeId] = useState<string | null>(activity?.nodeId ?? null);
  const [gm, setGm] = useState<Gate>(activity?.gm ?? 'na');
  const [gt, setGt] = useState<Gate>(activity?.gt ?? 'na');
  const [gi, setGi] = useState<Gate>(activity?.gi ?? 'na');

  const psN = parseInt(ps, 10);
  const peN = parseInt(pe, 10);
  const ready = name.trim() && Number.isFinite(psN) && Number.isFinite(peN) && peN >= psN && psN >= 0;

  const save = () => {
    if (!ready) return;
    const input: NewActivityInput = {
      name: name.trim(),
      zone: zone.trim(),
      plannedStart: psN,
      plannedEnd: peN,
      phaseId: phaseId || null,
      decisionId: decisionId || null,
      nodeId: nodeId,
      gateMaterial: gm,
      gateTeam: gt,
      gateInspection: gi,
    };
    if (activity) updateActivity(activity.id, input);
    else createActivity(input);
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={480} labelledBy="plan-act-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="plan-act-title" style={{ fontWeight: 700, fontSize: 17 }}>{activity ? `Edit ${activity.id}` : 'Plan activity'}</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          Planned dates are day numbers on the schedule timeline; the bar renders from them.
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Activity (e.g. Master Bath Tiling)" style={{ ...fldS, marginTop: 14, width: '100%' }} data-testid="act-name" />
        <input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Zone (free text — or pick a location below)" style={{ ...fldS, marginTop: 10, width: '100%' }} />
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em', color: 'var(--muted)', margin: '12px 0 6px' }}>LOCATION (OPTIONAL)</div>
        <LocationPicker value={nodeId} onChange={setNodeId} idPrefix="act-loc" />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <label style={lblS}>Plan start (day)<input value={ps} onChange={(e) => setPs(e.target.value)} inputMode="numeric" style={{ ...fldS, width: '100%' }} /></label>
          <label style={lblS}>Plan end (day)<input value={pe} onChange={(e) => setPe(e.target.value)} inputMode="numeric" style={{ ...fldS, width: '100%' }} /></label>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <label style={lblS}>Phase
            <select value={phaseId} onChange={(e) => setPhaseId(e.target.value)} style={{ ...fldS, width: '100%' }}>
              <option value="">— unphased —</option>
              {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label style={lblS}>Linked decision
            <select value={decisionId} onChange={(e) => setDecisionId(e.target.value)} style={{ ...fldS, width: '100%' }}>
              <option value="">— none —</option>
              {decisions.map((d) => <option key={d.id} value={d.id}>{d.id} · {d.title}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          {([['Material', gm, setGm], ['Team', gt, setGt], ['Inspection', gi, setGi]] as const).map(([label, v, set]) => (
            <label key={label} style={lblS}>{label} gate
              <select value={v} onChange={(e) => set(e.target.value as Gate)} style={{ ...fldS, width: '100%' }}>
                {GATE_VALUES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          {activity && (
            <Button variant="dangerOutline" onClick={() => { deleteActivity(activity.id); onClose(); }} style={{ padding: 12 }}>Delete</Button>
          )}
          <Button variant="outline" onClick={onClose} style={{ flex: 1, padding: 12 }}>Cancel</Button>
          <Button variant="ink" onClick={save} disabled={!ready} data-testid="save-activity" style={{ flex: 1, padding: 12 }}>{activity ? 'Save' : 'Add to plan'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function AddPhaseModal({ onClose }: { onClose: () => void }) {
  const createPhase = useStore((s) => s.createPhase);
  const [name, setName] = useState('');
  const save = () => {
    if (!name.trim()) return;
    createPhase(name.trim());
    onClose();
  };
  return (
    <Modal onClose={onClose} maxWidth={380} labelledBy="add-phase-title">
      <div style={{ padding: '18px 20px' }}>
        <div id="add-phase-title" style={{ fontWeight: 700, fontSize: 17 }}>Add phase</div>
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="Phase name (e.g. Finishing)" style={{ ...fldS, marginTop: 14, width: '100%' }} data-testid="phase-name" />
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: 1, padding: 12 }}>Cancel</Button>
          <Button variant="ink" onClick={save} disabled={!name.trim()} data-testid="save-phase" style={{ flex: 1, padding: 12 }}>Add</Button>
        </div>
      </div>
    </Modal>
  );
}

const fldS: CSSProperties = { height: 42, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none', marginTop: 4 };
const lblS: CSSProperties = { flex: 1, fontSize: 11.5, color: 'var(--muted)', display: 'flex', flexDirection: 'column' };
