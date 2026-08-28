import { useMemo, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectLogDecisions } from '@/store/selectors';
import { Eyebrow, DecisionChip, Button, Modal, LocationContext, EditState } from '@/components';
import { IssueDecisionModal } from '@/screens/modals/IssueDecisionModal';
import { Lock, Plus, ChevronRight, Pencil, Trash2, BookmarkPlus } from '@/lib/icons';
import { signed, swatch as swatchGradient, decisionRail, can, type Decision } from '@vitan/shared';
import { childrenOf, groupDecisions, locationSegments, type GroupBy } from '@/lib/locationTree';
import styles from './responsive.module.css';

const GROUP_OPTIONS: { key: GroupBy; label: string }[] = [
  { key: 'location', label: 'Location' },
  { key: 'room', label: 'Room' },
  { key: 'element', label: 'Object' },
  { key: 'status', label: 'Status' },
  { key: 'flat', label: 'All' },
];
const STATUS_FILTERS: { key: Decision['status']; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'change', label: 'Change' },
  // Phase 6 task 4a — the register keeps withdrawn rows (pmc-only; the server filters them
  // out of every other role's snapshot, so this chip simply never matches for them)
  { key: 'withdrawn', label: 'Withdrawn' },
];

export function DecisionLogScreen() {
  const rows = useStore(useShallow(selectLogDecisions));
  const nodes = useStore(useShallow((s) => s.nodes));
  const openChange = useStore((s) => s.openChange);
  const withdrawChange = useStore((s) => s.withdrawChange);
  const openWithdraw = useStore((s) => s.openWithdraw);
  const role = useStore((s) => s.role);
  const sessionToken = useStore((s) => s.sessionToken);
  // who am I? — the JWT sub, for the requester-may-withdraw rule (null in demo mode)
  const mySub = useMemo(() => {
    if (!sessionToken) return null;
    try {
      return (JSON.parse(atob(sessionToken.split('.')[1])) as { sub?: string }).sub ?? null;
    } catch {
      return null;
    }
  }, [sessionToken]);
  // the SERVICE narrows withdraw to the requester or the PMC — mirror it so the
  // button only appears where the server would accept the call
  const mayWithdraw = (d: Decision): boolean =>
    can('decision.withdrawChange', role) && (role === 'pmc' || (!!mySub && d.changeRequest?.requestedById === mySub));
  // Phase 6 task 4a — withdrawing the DECISION itself: pmc only, and only a published,
  // never-approved pending row is eligible (the service refuses everything else with a 409)
  const mayWithdrawDecision = (d: Decision): boolean =>
    can('decision.withdraw', role) && d.status === 'pending' && !d.draft;
  const [issuing, setIssuing] = useState(false);
  const [managing, setManaging] = useState(false);
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
  const canManage = can('node.manage', role);

  return (
    <div className={`${styles.screen} ${styles.narrow}`}>
      <Eyebrow>CLIENT DECISION LOG</Eyebrow>
      <div className={styles.headRule} style={{ margin: '6px 0 8px' }}>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>Decision Register</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>{filtered.length} DECISIONS</div>
          {canManage && (
            <Button variant="outline" onClick={() => setManaging(true)} data-testid="manage-locations" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 12px', fontSize: 12.5 }}>
              Locations
            </Button>
          )}
          {can('decision.create', role) && (
            <Button variant="ink" onClick={() => setIssuing(true)} data-testid="issue-decision" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
              <Plus size={15} /> Issue decision
            </Button>
          )}
        </div>
      </div>
      {issuing && <IssueDecisionModal onClose={() => setIssuing(false)} />}
      {managing && <ManageLocationsModal onClose={() => setManaging(false)} />}

      {/* controls: group-by, search, status filter */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '12px 0 4px' }}>
        <div role="tablist" aria-label="Group by" style={{ display: 'inline-flex', background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 2 }}>
          {GROUP_OPTIONS.map((g) => {
            const on = groupBy === g.key;
            return (
              <button key={g.key} onClick={() => setGroupBy(g.key)} data-testid={`groupby-${g.key}`} style={{ padding: '6px 11px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, background: on ? 'var(--ink)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
                {g.label}
              </button>
            );
          })}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search decisions…" data-testid="decision-search" style={{ ...fldD, flex: '1 1 160px', minWidth: 0 }} />
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '8px 0 20px' }}>
        {STATUS_FILTERS.map((s) => {
          const on = statuses.has(s.key);
          return (
            <button key={s.key} onClick={() => toggleStatus(s.key)} data-testid={`filter-${s.key}`} style={{ padding: '5px 11px', borderRadius: 20, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, border: `1px solid ${on ? 'var(--ink)' : 'var(--hairline)'}`, background: on ? 'var(--ink)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }}>
              {s.label}
            </button>
          );
        })}
      </div>

      {groups.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 13.5, padding: '10px 0' }}>No decisions match your filters.</div>
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
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 4px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--hairline)', cursor: 'pointer', textAlign: 'left', marginBottom: isCollapsed ? 0 : 12 }}
                >
                  <ChevronRight size={15} style={{ transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s', color: 'var(--muted)' }} />
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{g.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>{g.counts.total}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {g.counts.pending > 0 && <RollupChip n={g.counts.pending} color="var(--amber-solid)" label="pending" />}
                    {g.counts.change > 0 && <RollupChip n={g.counts.change} color="var(--red-solid)" label="change" />}
                    {g.counts.approved > 0 && <RollupChip n={g.counts.approved} color="var(--green-solid)" label="approved" />}
                    {g.counts.withdrawn > 0 && <RollupChip n={g.counts.withdrawn} color="var(--muted)" label="withdrawn" />}
                    {g.counts.recorded > 0 && <RollupChip n={g.counts.recorded} color="var(--muted)" label="recorded" />}
                  </span>
                </button>
              )}
              {!isCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {g.rows.map(({ decision, subLabel }) => (
                    <DecisionRowCard
                      key={decision.id}
                      d={decision}
                      subLabel={subLabel}
                      onChange={() => openChange(decision.id)}
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
    <span title={`${n} ${label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      {n}
    </span>
  );
}

/** One decision card — the register row, with its finer location shown as a caption. */
function DecisionRowCard({ d, subLabel, onChange, onWithdraw, onWithdrawDecision }: { d: Decision; subLabel: string; onChange: () => void; onWithdraw?: () => void; onWithdrawDecision?: () => void }) {
  const locked = d.status === 'approved';
  // Phase 6 task 4b (round-1 Codex F2) — a RECORD is a filed fact: no approver, no options, no
  // approval demand, no cost. It renders its own branch instead of borrowing the approved shape.
  const recorded = d.status === 'recorded';
  // Phase 6 task 4a — a withdrawn decision was never approved: it renders its options (never a
  // fabricated approval line), and its attribution names the withdrawer, not an approver.
  const neverLocked = d.status === 'pending' || d.status === 'withdrawn';
  const attribution = recorded
    ? 'Issue recorded — no approval required'
    : d.status === 'withdrawn'
      ? `Withdrawn by ${d.withdrawnBy ?? 'the PMC'}${d.withdrawnAt ? ` · ${new Date(d.withdrawnAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}`
      : d.approver
        ? `Approved by ${d.approver}${d.onBehalfOf ? ` (on behalf of the ${d.onBehalfOf})` : ''} · ${d.date}`
        : `Ageing ${d.ageDays} days · awaiting client`;
  const approvedLine = recorded
    ? 'Filed on the register — nothing approvable'
    : neverLocked ? `${d.options.length} options presented` : `${d.approvedOption} — ${d.material}`;
  const costStr = recorded
    ? '—'
    : neverLocked ? 'up to ' + signed(Math.max(...d.options.map((o) => o.delta))) : signed(d.cost ?? 0);
  const photoLabel = recorded ? 'RECORDED' : neverLocked ? 'OPTIONS' : 'APPROVED';

  return (
    <div
      data-testid={`log-row-${d.id}`}
      style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderLeft: `4px solid ${decisionRail[d.status]}`, borderRadius: 12, overflow: 'hidden', animation: 'vpop .3s' }}
    >
      <div className={styles.logRow}>
        <div className={styles.logPhoto} style={{ background: swatchGradient(d.photoSwatch ?? ''), position: 'relative', flex: 'none' }}>
          <span style={{ position: 'absolute', left: 8, bottom: 8, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,.9)', background: 'rgba(0,0,0,.4)', padding: '1px 6px', borderRadius: 3 }}>{photoLabel}</span>
        </div>
        <div style={{ flex: 1, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{d.id}</span>
                <span style={{ fontWeight: 600, fontSize: 16 }}>{d.title}</span>
                {locked && <Lock size={13} data-testid={`lock-${d.id}`} />}
              </div>
              {/* WHERE this decision belongs — tappable back to the Site Map at that place.
                  `subLabel` (the finer location under the group header) stays the fallback for a
                  legacy free-text decision that never got a node. */}
              <div style={{ marginTop: 3 }}>
                <LocationContext nodeId={d.nodeId} fallback={subLabel || d.room} compact testId={`decision-place-${d.id}`} />
              </div>
            </div>
            <DecisionChip status={d.status} />
          </div>
          {d.status === 'withdrawn' && d.withdrawReason && (
            <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 10, background: 'rgba(35,33,28,.05)', border: '1px solid rgba(35,33,28,.14)' }} data-testid={`withdraw-detail-${d.id}`}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>Withdrawn: {d.withdrawReason}</div>
            </div>
          )}
          {d.status === 'change' && d.changeRequest && (
            <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 10, background: 'rgba(180,70,46,.07)', border: '1px solid rgba(180,70,46,.2)' }} data-testid={`cr-detail-${d.id}`}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--red-text)' }}>Change requested: {d.changeRequest.reason}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                {d.changeRequest.costImpact === 0 ? 'No cost change' : signed(d.changeRequest.costImpact)}
                {' · '}
                {d.changeRequest.timeImpactDays === 0 ? 'no schedule impact' : `${d.changeRequest.timeImpactDays} day${d.changeRequest.timeImpactDays === 1 ? '' : 's'}`}
                {' · awaiting the client’s re-approval'}
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
                  Withdraw decision
                </Button>
              )}
            </div>
          </div>
          {/* Can I edit this? If not, why — and what may I do instead? The verdict is the domain's
              (approved ⇒ locked; a change request is with the client), never a bare disabled control. */}
          {locked && (
            <div style={{ marginTop: 10 }}>
              <EditState
                state="locked"
                reason="Locked after approval — the approved choice is the record."
                action={{ label: 'Request change', onClick: onChange, testId: `request-change-${d.id}` }}
                testId={`edit-state-${d.id}`}
              />
            </div>
          )}
          {d.status === 'change' && (
            <div style={{ marginTop: 10 }}>
              <EditState
                state="workflow"
                reason="A change request is with the client — the decision reopens when they answer."
                action={onWithdraw ? { label: 'Withdraw request', onClick: onWithdraw, testId: `withdraw-${d.id}` } : undefined}
                testId={`edit-state-${d.id}`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** PMC tree editor — build, rename and delete the location tree (indented by depth).
 *  Nested locations: every zone/room row carries an ADD-CHILD control (a room or an
 *  object, per the tree rule, while the 5-level cap allows it) — the one screen devoted
 *  to building trees can now build every legal shape, instead of only creating zones
 *  and leaving rooms to the filing picker. Exported for the P9 probes. */
export function ManageLocationsModal({ onClose }: { onClose: () => void }) {
  const nodes = useStore(useShallow((s) => s.nodes));
  const renameNode = useStore((s) => s.renameNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const publishNode = useStore((s) => s.publishNode);
  const addLocationNode = useStore((s) => s.addLocationNode);
  const saveZoneAsModule = useStore((s) => s.saveZoneAsModule);
  const saveProjectAsTemplate = useStore((s) => s.saveProjectAsTemplate);
  const [newZone, setNewZone] = useState('');
  const [asDraft, setAsDraft] = useState(false);
  const [tplName, setTplName] = useState('');
  const saveTemplate = () => { if (tplName.trim()) { saveProjectAsTemplate(tplName.trim()); setTplName(''); } };

  const rowsFor = (parentId: string | null, depth: number): { id: string; name: string; kind: string; depth: number; draft: boolean }[] =>
    childrenOf(nodes, parentId).flatMap((n) => [{ id: n.id, name: n.name, kind: n.kind, depth, draft: Boolean(n.draft) }, ...rowsFor(n.id, depth + 1)]);
  const list = rowsFor(null, 0);
  const addZone = () => { if (newZone.trim()) { void addLocationNode({ name: newZone.trim(), kind: 'zone', parentId: null, publish: !asDraft }); setNewZone(''); } };

  return (
    <Modal onClose={onClose} maxWidth={480} labelledBy="manage-loc-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="manage-loc-title" style={{ fontWeight: 700, fontSize: 17 }}>Locations</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          Zones sit at the top; rooms nest under zones or other rooms (to 5 levels); objects sit under a room or directly under a zone. Rename or remove any — a location with decisions on it can&apos;t be deleted until you move them. A <b>draft</b> location is private to you until you publish it.
        </div>

        <div style={{ display: 'flex', gap: 8, margin: '14px 0 6px' }}>
          <input value={newZone} onChange={(e) => setNewZone(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addZone(); }} placeholder="Add a zone (e.g. Ground Floor)" style={{ ...fldD, flex: 1, minWidth: 0 }} data-testid="manage-new-zone" />
          <Button variant="ink" onClick={addZone} style={{ padding: '0 14px', fontSize: 12.5 }}>Add</Button>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer', marginBottom: 4 }}>
          <input type="checkbox" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} data-testid="manage-zone-draft" />
          Add as a private draft (publish later)
        </label>

        {list.length === 0 && <div style={{ color: 'var(--faint)', fontSize: 12.5, padding: '8px 0' }}>No locations yet — add a zone to start.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {list.map((n) => (
            <LocationRow
              key={n.id}
              id={n.id}
              name={n.name}
              kind={n.kind}
              depth={n.depth}
              draft={n.draft}
              onRename={(name) => renameNode(n.id, name)}
              onPublish={() => publishNode(n.id)}
              onDelete={() => deleteNode(n.id)}
              onSaveAsModule={n.kind === 'zone' ? () => saveZoneAsModule(n.id, n.name) : undefined}
              // add-child per the tree rule: a zone or room takes a room or an object while the
              // child would land within the 5-level cap (row depth is 0-based → child level is
              // depth + 2); an element is a LEAF and takes nothing.
              onAddChild={n.kind !== 'element' && n.depth + 2 <= 5
                ? (kind, name) => void addLocationNode({ name, kind, parentId: n.id, publish: !asDraft })
                : undefined}
            />
          ))}
        </div>

        {/* Templates Slice 3: capture this project's whole structure as a named preset */}
        <div style={{ borderTop: '1px dashed rgba(35,33,28,.15)', marginTop: 16, paddingTop: 12 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.14em', color: 'var(--muted)', marginBottom: 6 }}>SAVE AS TEMPLATE</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={tplName} onChange={(e) => setTplName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveTemplate(); }} placeholder="Template name (e.g. G+2 Residence)" style={{ ...fldD, flex: 1, minWidth: 0 }} data-testid="save-template-name" />
            <Button variant="outline" onClick={saveTemplate} data-testid="save-template" style={{ padding: '0 14px', fontSize: 12.5 }}>Save</Button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>
            Captures the whole structure — locations, phases, planned activities, checklists — as a starting point for future projects. Never this project&apos;s approvals, dates, photos or people.
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <Button variant="ink" onClick={onClose} style={{ padding: '10px 18px' }}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

function LocationRow({ id, name, kind, depth, draft, onRename, onPublish, onDelete, onSaveAsModule, onAddChild }: { id: string; name: string; kind: string; depth: number; draft: boolean; onRename: (name: string) => void; onPublish: () => void; onDelete: () => void; onSaveAsModule?: () => void; onAddChild?: (kind: 'room' | 'element', name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [addingKind, setAddingKind] = useState<'room' | 'element' | null>(null);
  const [childName, setChildName] = useState('');
  const commit = () => { if (value.trim()) onRename(value.trim()); setEditing(false); };
  const commitChild = () => {
    if (childName.trim() && addingKind && onAddChild) onAddChild(addingKind, childName.trim());
    setAddingKind(null);
    setChildName('');
  };
  if (addingKind) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: (depth + 1) * 18, minHeight: 34 }} data-testid={`loc-row-${id}`}>
        <input autoFocus value={childName} onChange={(e) => setChildName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitChild(); }} placeholder={`New ${addingKind === 'room' ? 'room' : 'object'} in ${name}`} style={{ ...fldD, flex: 1, minWidth: 0, height: 34 }} data-testid={`loc-add-input-${id}`} />
        <button onClick={commitChild} style={iconBtn} aria-label={`Add inside ${name}`}>✓</button>
        <button onClick={() => { setAddingKind(null); setChildName(''); }} style={iconBtn} aria-label="Cancel">✕</button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: depth * 18, minHeight: 34 }} data-testid={`loc-row-${id}`}>
      {editing ? (
        <>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} style={{ ...fldD, flex: 1, minWidth: 0, height: 34 }} />
          <button onClick={commit} style={iconBtn} aria-label="Save">✓</button>
        </>
      ) : (
        <>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.1em', color: 'var(--faint)', width: 44, flex: 'none' }}>{kind.toUpperCase()}</span>
          <span style={{ flex: 1, fontSize: 13.5, fontWeight: kind === 'zone' ? 600 : 400, color: draft ? 'var(--muted)' : 'var(--ink)' }}>{name}</span>
          {draft && <span style={draftChip} data-testid={`loc-draft-${id}`}>DRAFT</span>}
          {draft && <Button variant="success" onClick={onPublish} data-testid={`loc-publish-${id}`} style={{ padding: '4px 9px', fontSize: 11 }}>Publish</Button>}
          {onAddChild && (
            <>
              <button onClick={() => setAddingKind('room')} style={addChildBtn} data-testid={`loc-add-room-${id}`} title={`Add a room inside ${name}`} aria-label={`Add a room inside ${name}`}>+ Room</button>
              <button onClick={() => setAddingKind('element')} style={addChildBtn} data-testid={`loc-add-element-${id}`} title={`Add an object inside ${name}`} aria-label={`Add an object inside ${name}`}>+ Object</button>
            </>
          )}
          {onSaveAsModule && (
            <button onClick={onSaveAsModule} style={iconBtn} data-testid={`loc-module-${id}`} title="Save this zone (rooms, objects, checklists) as a reusable module" aria-label={`Save ${name} as a module`}>
              <BookmarkPlus size={13} />
            </button>
          )}
          <button onClick={() => { setValue(name); setEditing(true); }} style={iconBtn} aria-label={`Rename ${name}`}><Pencil size={13} /></button>
          <button onClick={onDelete} style={{ ...iconBtn, color: 'var(--red-solid)' }} aria-label={`Delete ${name}`}><Trash2 size={13} /></button>
        </>
      )}
    </div>
  );
}

const addChildBtn: CSSProperties = {
  background: 'transparent',
  border: '1px dashed rgba(35,33,28,.3)',
  borderRadius: 6,
  padding: '2px 7px',
  fontSize: 10.5,
  cursor: 'pointer',
  color: 'var(--muted)',
  flex: 'none',
};

const draftChip: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: '.08em',
  padding: '2px 6px',
  borderRadius: 5,
  border: '1px solid var(--amber-solid)',
  color: 'var(--amber-solid)',
  flex: 'none',
};

const iconBtn: CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', alignItems: 'center', padding: 5 };
const fldD: CSSProperties = { height: 42, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
