import { useMemo, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type IssueDecisionPayload } from '@/store/store';
import { selectLogDecisions } from '@/store/selectors';
import { Eyebrow, DecisionChip, Button, Modal } from '@/components';
import { LocationPicker } from '@/components/LocationPicker';
import { Lock, Plus, X, ChevronRight, Pencil, Trash2, BookmarkPlus } from '@/lib/icons';
import { signed, swatch as swatchGradient, decisionRail, can, SW, type Decision, type SwatchKey } from '@vitan/shared';
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
];

export function DecisionLogScreen() {
  const rows = useStore(useShallow(selectLogDecisions));
  const nodes = useStore(useShallow((s) => s.nodes));
  const openChange = useStore((s) => s.openChange);
  const role = useStore((s) => s.role);
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
                  </span>
                </button>
              )}
              {!isCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {g.rows.map(({ decision, subLabel }) => (
                    <DecisionRowCard key={decision.id} d={decision} subLabel={subLabel} onChange={() => openChange(decision.id)} />
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
function DecisionRowCard({ d, subLabel, onChange }: { d: Decision; subLabel: string; onChange: () => void }) {
  const locked = d.status === 'approved';
  const attribution = d.approver ? `Approved by ${d.approver} · ${d.date}` : `Ageing ${d.ageDays} days · awaiting client`;
  const approvedLine = d.status === 'pending' ? `${d.options.length} options presented` : `${d.approvedOption} — ${d.material}`;
  const costStr = d.status === 'pending' ? 'up to ' + signed(Math.max(...d.options.map((o) => o.delta))) : signed(d.cost ?? 0);
  const photoLabel = d.status === 'pending' ? 'OPTIONS' : 'APPROVED';

  return (
    <div
      data-testid={`log-row-${d.id}`}
      style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderLeft: `4px solid ${decisionRail[d.status]}`, borderRadius: 12, overflow: 'hidden', animation: 'vpop .3s' }}
    >
      <div className={styles.logRow}>
        <div className={styles.logPhoto} style={{ background: swatchGradient(d.photoSwatch), position: 'relative', flex: 'none' }}>
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
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{subLabel || d.room}</div>
            </div>
            <DecisionChip status={d.status} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(35,33,28,.1)', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{approvedLine}</div>
              <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 3 }}>{attribution}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: (d.cost ?? 0) > 0 ? 'var(--ink)' : 'var(--muted)' }}>{costStr}</div>
              {locked && (
                <Button variant="outline" onClick={onChange} style={{ marginTop: 7, padding: '6px 12px', fontSize: 11.5, fontWeight: 500 }}>
                  Request Change
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface OptionDraft {
  material: string;
  delta: string; // rupee delta as typed
  swatch: SwatchKey;
  recommended: boolean;
  photo?: { mime: string; data: string; preview: string };
}

const SWATCH_KEYS = Object.keys(SW) as SwatchKey[];
const blankOption = (): OptionDraft => ({ material: '', delta: '0', swatch: 'tile', recommended: false });

/** PMC issues a new decision: location (tree) + title + 2–4 options. */
function IssueDecisionModal({ onClose }: { onClose: () => void }) {
  const issueDecision = useStore((s) => s.issueDecision);
  const [title, setTitle] = useState('');
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [options, setOptions] = useState<OptionDraft[]>([blankOption(), blankOption()]);

  const setOpt = (i: number, patch: Partial<OptionDraft>) =>
    setOptions((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : patch.recommended ? { ...o, recommended: false } : o)));

  const pickPhoto = (i: number, file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const [head, data] = dataUrl.split(',');
      const mime = head.match(/data:(.*?);/)?.[1] ?? 'image/jpeg';
      setOpt(i, { photo: { mime, data, preview: dataUrl } });
    };
    reader.readAsDataURL(file);
  };

  const ready = Boolean(title.trim() && nodeId && options.every((o) => o.material.trim()));
  const save = (publish: boolean) => {
    if (!ready) return;
    const payload: IssueDecisionPayload = {
      title: title.trim(),
      nodeId: nodeId ?? undefined,
      publish,
      options: options.map((o) => ({
        material: o.material.trim(),
        delta: parseInt(o.delta.replace(/[^\d-]/g, ''), 10) || 0,
        swatch: o.swatch,
        recommended: o.recommended,
        ...(o.photo ? { photo: { mime: o.photo.mime, data: o.photo.data } } : {}),
      })),
    };
    issueDecision(payload);
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={560} labelledBy="issue-dec-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="issue-dec-title" style={{ fontWeight: 700, fontSize: 17 }}>New decision</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          Place it in the building, then present 2–4 options. <b>Save as draft</b> to keep working privately, or <b>Publish</b> to send it to the client to choose.
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (e.g. Veneer finish, Lock & hardware)" style={{ ...fldD, marginTop: 14, width: '100%' }} data-testid="dec-title" />

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)', margin: '16px 0 7px' }}>LOCATION</div>
        <LocationPicker value={nodeId} onChange={setNodeId} />

        {options.map((o, i) => (
          <div key={i} style={{ marginTop: 14, padding: 12, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--panel)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)' }}>OPTION {String.fromCharCode(65 + i)}</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, marginLeft: 'auto' }}>
                <input type="radio" name="recommended" checked={o.recommended} onChange={() => setOpt(i, { recommended: true })} /> Recommended
              </label>
              {options.length > 2 && (
                <button onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove option ${i + 1}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
                  <X size={15} />
                </button>
              )}
            </div>
            <input value={o.material} onChange={(e) => setOpt(i, { material: e.target.value })} placeholder="Material (e.g. Italian Marble)" style={{ ...fldD, width: '100%' }} data-testid={`dec-opt-${i}`} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={o.delta} onChange={(e) => setOpt(i, { delta: e.target.value })} placeholder="₹ delta (0 = base)" style={{ ...fldD, flex: '0 0 130px' }} />
              <select value={o.swatch} onChange={(e) => setOpt(i, { swatch: e.target.value as SwatchKey })} style={{ ...fldD, flex: '0 0 120px' }} aria-label="Swatch">
                {SWATCH_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <span style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--hairline)', background: o.photo ? `center/cover url(${o.photo.preview})` : swatchGradient(o.swatch) }} />
              <label style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>
                {o.photo ? 'Change photo' : 'Add sample photo'}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => pickPhoto(i, e.target.files?.[0] ?? null)} />
              </label>
            </div>
          </div>
        ))}

        {options.length < 4 && (
          <button onClick={() => setOptions((prev) => [...prev, blankOption()])} style={{ marginTop: 12, background: 'transparent', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 10, padding: '9px 14px', fontSize: 12.5, cursor: 'pointer', color: 'var(--muted)', width: '100%' }}>
            + Add another option
          </button>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: '0 0 auto', padding: '12px 16px' }}>Cancel</Button>
          <Button variant="light" onClick={() => save(false)} disabled={!ready} data-testid="save-draft" style={{ flex: 1, padding: 12 }}>Save as draft</Button>
          <Button variant="ink" onClick={() => save(true)} disabled={!ready} data-testid="save-decision" style={{ flex: 1, padding: 12 }}>Publish to client</Button>
        </div>
      </div>
    </Modal>
  );
}

/** PMC tree editor — rename / delete zones, rooms and objects (indented by depth). */
function ManageLocationsModal({ onClose }: { onClose: () => void }) {
  const nodes = useStore(useShallow((s) => s.nodes));
  const renameNode = useStore((s) => s.renameNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const publishNode = useStore((s) => s.publishNode);
  const addLocationNode = useStore((s) => s.addLocationNode);
  const saveZoneAsModule = useStore((s) => s.saveZoneAsModule);
  const [newZone, setNewZone] = useState('');
  const [asDraft, setAsDraft] = useState(false);

  const rowsFor = (parentId: string | null, depth: number): { id: string; name: string; kind: string; depth: number; draft: boolean }[] =>
    childrenOf(nodes, parentId).flatMap((n) => [{ id: n.id, name: n.name, kind: n.kind, depth, draft: Boolean(n.draft) }, ...rowsFor(n.id, depth + 1)]);
  const list = rowsFor(null, 0);
  const addZone = () => { if (newZone.trim()) { void addLocationNode({ name: newZone.trim(), kind: 'zone', parentId: null, publish: !asDraft }); setNewZone(''); } };

  return (
    <Modal onClose={onClose} maxWidth={480} labelledBy="manage-loc-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="manage-loc-title" style={{ fontWeight: 700, fontSize: 17 }}>Locations</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          Zones contain rooms; rooms contain objects. Rename or remove any — a location with decisions on it can&apos;t be deleted until you move them. A <b>draft</b> location is private to you until you publish it.
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
            <LocationRow key={n.id} id={n.id} name={n.name} kind={n.kind} depth={n.depth} draft={n.draft} onRename={(name) => renameNode(n.id, name)} onPublish={() => publishNode(n.id)} onDelete={() => deleteNode(n.id)} onSaveAsModule={n.kind === 'zone' ? () => saveZoneAsModule(n.id, n.name) : undefined} />
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <Button variant="ink" onClick={onClose} style={{ padding: '10px 18px' }}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

function LocationRow({ id, name, kind, depth, draft, onRename, onPublish, onDelete, onSaveAsModule }: { id: string; name: string; kind: string; depth: number; draft: boolean; onRename: (name: string) => void; onPublish: () => void; onDelete: () => void; onSaveAsModule?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const commit = () => { if (value.trim()) onRename(value.trim()); setEditing(false); };
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
