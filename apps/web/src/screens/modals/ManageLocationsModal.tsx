import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Button, Modal } from '@/components';
import { Pencil, Trash2, BookmarkPlus } from '@/lib/icons';
import { childrenOf } from '@/lib/locationTree';
import { ConfirmLocationDelete } from '@/screens/modals/ConfirmLocationDelete';

/** PMC tree editor — build, rename and delete the location tree (indented by depth).
 *  Nested locations: every zone/room row carries an ADD-CHILD control (a room or an
 *  object, per the tree rule, while the 5-level cap allows it) — the one screen devoted
 *  to building trees can now build every legal shape, instead of only creating zones
 *  and leaving rooms to the filing picker. Exported for the P9 probes. */
export function ManageLocationsModal({ onClose }: { onClose: () => void }) {
  const nodes = useStore(useShallow((s) => s.nodes));
  const renameNode = useStore((s) => s.renameNode);
  const publishNode = useStore((s) => s.publishNode);
  const addLocationNode = useStore((s) => s.addLocationNode);
  const saveZoneAsModule = useStore((s) => s.saveZoneAsModule);
  const saveProjectAsTemplate = useStore((s) => s.saveProjectAsTemplate);
  const [newZone, setNewZone] = useState('');
  const [asDraft, setAsDraft] = useState(false);
  const [tplName, setTplName] = useState('');
  // Audit B4 — a delete is confirmed first; the confirmation stands in for this dialog, so one
  // Escape never closes both
  const [deleting, setDeleting] = useState<string | null>(null);
  const saveTemplate = () => { if (tplName.trim()) { saveProjectAsTemplate(tplName.trim()); setTplName(''); } };

  const rowsFor = (parentId: string | null, depth: number): { id: string; name: string; kind: string; depth: number; draft: boolean }[] =>
    childrenOf(nodes, parentId).flatMap((n) => [{ id: n.id, name: n.name, kind: n.kind, depth, draft: Boolean(n.draft) }, ...rowsFor(n.id, depth + 1)]);
  const list = rowsFor(null, 0);
  const addZone = () => { if (newZone.trim()) { void addLocationNode({ name: newZone.trim(), kind: 'zone', parentId: null, publish: !asDraft }); setNewZone(''); } };

  if (deleting) return <ConfirmLocationDelete nodeId={deleting} onClose={() => setDeleting(null)} />;

  return (
    <Modal onClose={onClose} maxWidth={480} labelledBy="manage-loc-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="manage-loc-title" style={{ fontWeight: 700, fontSize: 17 }}>Locations</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          Zones sit at the top; rooms nest under zones or other rooms (to 5 levels); objects sit under a room or directly under a zone. Rename or remove any — a location with decisions on it can&apos;t be deleted until you move them. A <b>draft</b> location is private to you until you publish it.
        </div>

        <div style={{ display: 'flex', gap: 8, margin: '14px 0 6px' }}>
          <input value={newZone} onChange={(e) => setNewZone(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addZone(); }} placeholder="Add a zone (e.g. Ground Floor)" style={{ ...fldD, flex: 1, minWidth: 44 }} data-testid="manage-new-zone" />
          <Button variant="ink" onClick={addZone} style={{ padding: '0 14px', fontSize: 12.5 }}>Add</Button>
        </div>
        {/* Wave 0 / F-1b round 8 — the checkbox itself is a native 13px box; the LABEL is what a
            thumb lands on, and label activation forwards to the control, so the 44px band goes
            here. The box is left native: forcing a checkbox larger changes a platform affordance
            for no gain, and the rule is about what the thumb meets. */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, fontSize: 12, color: 'var(--muted)', cursor: 'pointer', marginBottom: 4 }}>
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
              onDelete={() => setDeleting(n.id)}
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
            <input value={tplName} onChange={(e) => setTplName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveTemplate(); }} placeholder="Template name (e.g. G+2 Residence)" style={{ ...fldD, flex: 1, minWidth: 44 }} data-testid="save-template-name" />
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
        <input autoFocus value={childName} onChange={(e) => setChildName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitChild(); }} placeholder={`New ${addingKind === 'room' ? 'room' : 'object'} in ${name}`} style={{ ...fldD, flex: 1, minWidth: 44 }} data-testid={`loc-add-input-${id}`} />
        <button onClick={commitChild} style={iconBtn} aria-label={`Add inside ${name}`}>✓</button>
        <button onClick={() => { setAddingKind(null); setChildName(''); }} style={iconBtn} aria-label="Cancel">✕</button>
      </div>
    );
  }
  return (
    // Wave 0 / F-1b round 9 — `flexWrap` because the 44px floor MADE this row overflow. Three
    // icon buttons went from ~23px to 44 (+63px), and a normal zone row then needed ~357px before
    // the name got any width against ~310px of usable modal at 390px: the trailing rename and
    // delete were pushed outside the visible modal. A correction that puts controls out of reach
    // is worse than the undersized targets it fixed. The action group now drops to its own line
    // instead of overflowing, and the name may shrink rather than shove.
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingLeft: depth * 18, minHeight: 34 }} data-testid={`loc-row-${id}`}>
      {editing ? (
        <>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} style={{ ...fldD, flex: 1, minWidth: 44 }} />
          <button onClick={commit} style={iconBtn} aria-label="Save">✓</button>
        </>
      ) : (
        <>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.1em', color: 'var(--faint)', width: 44, flex: 'none' }}>{kind.toUpperCase()}</span>
          <span style={{ flex: '1 1 110px', minWidth: 0, overflowWrap: 'anywhere', fontSize: 13.5, fontWeight: kind === 'zone' ? 600 : 400, color: draft ? 'var(--muted)' : 'var(--ink)' }}>{name}</span>
          {draft && <span style={draftChip} data-testid={`loc-draft-${id}`}>DRAFT</span>}
          {draft && <Button variant="success" onClick={onPublish} data-testid={`loc-publish-${id}`} style={{ padding: '4px 9px', fontSize: 11 }}>Publish</Button>}
          {/* ONE group, so the actions wrap together and stay in a predictable order rather than
              breaking apart mid-cluster. `marginLeft: auto` keeps them right-aligned while they
              fit and is harmless once they take their own line. */}
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
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
          </span>
        </>
      )}
    </div>
  );
}

const addChildBtn: CSSProperties = {
  background: 'transparent',
  border: '1px dashed rgba(35,33,28,.3)',
  borderRadius: 6,
  // Wave 0 / F-1b round 8 — these live in the Manage locations dialog, which the round-7 walk
  // reached no more than the round-2 and round-5 sweeps did: it opened four NAMED dialogs, and a
  // named list is the same defect as a named surface list. The label keeps its 10.5px mono size —
  // the floor governs the HIT AREA, not the type.
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
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

// Wave 0 / F-1b round 8 — the glyph-only rename / delete / save / confirm controls of the
// Manage locations tree. A 13px icon in 5px of padding is a 23px target, and these are the
// controls that RENAME and DELETE a location decisions are filed against.
const iconBtn: CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44, padding: 5 };
// Wave 0 / F-1b round 7 — 42 → 44. A text field is a POINTER TARGET before it is a text
// field: a thumb has to land on it to focus it, and the 44×44 floor has no exception for
// "typed into rather than pressed". That exception is what my round-3 sweep wrote into its
// filter, and it is why this control sat four pixels under the floor for four more rounds.
const fldD: CSSProperties = { height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
