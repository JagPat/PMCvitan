import { useId, useState, type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { Button } from '@/components';
import { Plus, Pencil, Trash2 } from '@/lib/icons';
import { can, type ProjectNode } from '@vitan/shared';
import { ManageLocationsModal } from '@/screens/modals/ManageLocationsModal';
import { ConfirmLocationDelete } from '@/screens/modals/ConfirmLocationDelete';

/** Locations nest to 5 levels; the server refuses deeper (`MAX_TREE_DEPTH`). */
const MAX_TREE_DEPTH = 5;

type NewKind = 'zone' | 'room' | 'element';
const NOUN: Record<NewKind, string> = { zone: 'zone', room: 'room', element: 'object' };

/**
 * Audit B3 — the location tree is built where people look for it: on the Site Map, at the place
 * they are standing on. Whole project offers "+ Zone"; a zone or room offers "+ Room" and
 * "+ Object" (within the 5-level cap, per the server's tree rule); any place can be renamed or
 * deleted (deletes are confirmed, B4). "All locations" opens the full editor for drafts, publishing
 * and templates. Only a role holding `node.manage` (the PMC) sees any of it.
 */
export function PlaceStructure({ active, depth }: { active: ProjectNode | undefined; depth: number }) {
  const role = useStore((s) => s.role);
  const addLocationNode = useStore((s) => s.addLocationNode);
  const renameNode = useStore((s) => s.renameNode);
  const nodes = useStore((s) => s.nodes);
  const [adding, setAdding] = useState<NewKind | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  // #699 Codex 4174074853 — a create is not keyed, so the form takes one submission at a time
  const [pending, setPending] = useState(false);
  const inputId = useId();

  if (!can('node.manage', role)) return null;

  const placeName = active?.name ?? 'the project';
  // a zone or room takes children while they would land within the cap (`depth` is the active
  // place's level, 1 for a zone); an object is a leaf
  const takesChildren = active ? active.kind !== 'element' && depth + 1 <= MAX_TREE_DEPTH : true;

  const close = () => { setAdding(null); setRenaming(false); setValue(''); };
  // …and refuses a name this place already holds (drafts included): a second "Kitchen" under the same
  // floor is either a repeated click, a retry after a lost reply that DID create it, or a name the
  // pickers could not tell apart. Case and spacing do not make a different name.
  const norm = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();
  const siblingsNamed = (name: string, parentId: string | null, except?: string) =>
    nodes.some((n) => n.parentId === parentId && n.id !== except && norm(n.name) === norm(name));
  const duplicate = value.trim() !== '' && (
    renaming && active
      ? siblingsNamed(value, active.parentId, active.id)
      : adding !== null && siblingsNamed(value, active?.id ?? null)
  );
  const startAdd = (kind: NewKind) => { setRenaming(false); setValue(''); setAdding(kind); };
  const startRename = () => { setAdding(null); setValue(active?.name ?? ''); setRenaming(true); };
  const submit = async () => {
    const name = value.trim();
    if (!name || pending || duplicate) return;
    if (renaming && active) {
      renameNode(active.id, name);
      close();
      return;
    }
    if (adding) {
      setPending(true);
      try {
        const id = await addLocationNode({ name, kind: adding, parentId: active?.id ?? null });
        if (id) close();
      } finally {
        setPending(false);
      }
    }
  };

  const formLabel = renaming ? `Rename ${placeName}` : adding ? `New ${NOUN[adding]} in ${placeName}` : '';

  return (
    <div style={{ marginBottom: 18 }} data-testid="place-structure">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {!active && (
          <Button variant="dashed" onClick={() => startAdd('zone')} data-testid="place-add-zone" style={btn}>
            <Plus size={14} /> Zone
          </Button>
        )}
        {active && takesChildren && (
          <>
            <Button variant="dashed" onClick={() => startAdd('room')} data-testid="place-add-room" style={btn}>
              <Plus size={14} /> Room
            </Button>
            <Button variant="dashed" onClick={() => startAdd('element')} data-testid="place-add-object" style={btn}>
              <Plus size={14} /> Object
            </Button>
          </>
        )}
        {active && (
          <>
            <Button variant="light" onClick={startRename} data-testid="place-rename" aria-label={`Rename ${active.name}`} style={btn}>
              <Pencil size={13} /> Rename
            </Button>
            <Button variant="dangerOutline" onClick={() => setDeleting(true)} data-testid="place-delete" aria-label={`Delete ${active.name}`} style={btn}>
              <Trash2 size={13} /> Delete
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={() => setAllOpen(true)} data-testid="manage-locations" style={btn}>
          All locations
        </Button>
      </div>

      {(adding || renaming) && (
        <form
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420 }}
          data-testid="place-structure-form"
        >
          <label htmlFor={inputId} style={{ fontSize: 12.5, fontWeight: 600 }}>{formLabel}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id={inputId}
              autoFocus
              value={value}
              maxLength={80}
              disabled={pending}
              aria-invalid={duplicate || undefined}
              aria-describedby={duplicate ? `${inputId}-dup` : undefined}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
              placeholder={adding === 'zone' ? 'e.g. Ground Floor' : adding === 'room' ? 'e.g. Kitchen' : adding === 'element' ? 'e.g. Main Door' : ''}
              data-testid="place-structure-input"
              style={field}
            />
            <Button variant="ink" type="submit" disabled={!value.trim() || pending || duplicate} data-testid="place-structure-save" style={btn}>
              {renaming ? 'Save' : pending ? 'Adding…' : 'Add'}
            </Button>
            <Button variant="outline" type="button" onClick={close} disabled={pending} style={btn}>Cancel</Button>
          </div>
          {duplicate && (
            <div id={`${inputId}-dup`} role="status" style={{ fontSize: 12.5, color: 'var(--red-solid)' }} data-testid="place-structure-duplicate">
              {renaming ? (nodes.find((n) => n.id === active?.parentId)?.name ?? 'The project') : placeName} already has “{value.trim()}”.
            </div>
          )}
        </form>
      )}

      {deleting && active && <ConfirmLocationDelete nodeId={active.id} onClose={() => setDeleting(false)} />}
      {allOpen && <ManageLocationsModal onClose={() => setAllOpen(false)} />}
    </div>
  );
}

const btn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 12px', fontSize: 12.5 };

const field: CSSProperties = {
  flex: 1,
  minWidth: 44,
  height: 44,
  padding: '0 12px',
  borderRadius: 10,
  border: '1px solid rgba(35,33,28,.18)',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  background: '#fff',
};
