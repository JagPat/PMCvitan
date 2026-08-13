import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Button } from '@/components';
import { childrenOf } from '@/lib/locationTree';
import type { NodeKind } from '@vitan/shared';

const KIND_LABEL: Record<NodeKind, string> = { zone: 'Zone', room: 'Room', element: 'Object' };

/** Locations nest to 5 levels (the server refuses deeper — the picker simply stops offering). */
const MAX_TREE_DEPTH = 5;

const fld: CSSProperties = {
  height: 42,
  padding: '0 12px',
  borderRadius: 10,
  border: '1px solid rgba(35,33,28,.18)',
  background: '#fff',
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  color: 'var(--ink)',
  outline: 'none',
};

/**
 * Cascading location picker, shared by every module that files onto the location
 * spine (decisions, drawings, photos). STRUCTURALLY RECURSIVE (nested locations):
 * the first level lists zones; each further level lists the children of the level
 * above — nested rooms to the 5-level cap, and elements wherever they legally sit
 * (under a room OR directly under a zone). Each level picks an existing node or
 * creates one inline (a room or an object, per the tree rule). The item attaches
 * to the DEEPEST level chosen. Labels stay Zone/Room/Object — the vocabulary
 * belongs to the deferred rename; only the structure changed here.
 */
export function LocationPicker({
  value,
  onChange,
  idPrefix = 'loc',
}: {
  value: string | null;
  onChange: (nodeId: string | null) => void;
  idPrefix?: string;
}) {
  // Only PUBLISHED locations are offered — a decision/drawing/photo must never file onto a
  // private draft node (that would leak the draft, and orphan the item if the draft is dropped).
  const nodes = useStore(useShallow((s) => s.nodes.filter((n) => !n.draft)));
  const addLocationNode = useStore((s) => s.addLocationNode);
  // The selection PATH from the top level down: path[0] is a zone, each further entry a
  // child of the one before it. The filed target is the deepest selection.
  const [path, setPath] = useState<string[]>([]);
  void value;

  const selectAt = (level: number, id: string | null) => {
    const next = id ? [...path.slice(0, level), id] : path.slice(0, level);
    setPath(next);
    onChange(next.length ? next[next.length - 1]! : null);
  };

  // One rendered level per selectable depth: level 0 always; a level below every selected
  // non-element node while the depth cap allows children (an element is a LEAF; children of
  // level i live at absolute depth i+1).
  const levels: { parentId: string | null; parentKind: NodeKind | null; selected: string | null }[] = [
    { parentId: null, parentKind: null, selected: path[0] ?? null },
  ];
  for (let i = 0; i < path.length && levels.length < MAX_TREE_DEPTH; i += 1) {
    const node = nodes.find((n) => n.id === path[i]);
    if (!node || node.kind === 'element') break;
    levels.push({ parentId: node.id, parentKind: node.kind as NodeKind, selected: path[i + 1] ?? null });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {levels.map((level, i) => (
        <Level
          key={level.parentId ?? 'top'}
          levelIndex={i}
          parentId={level.parentId}
          parentKind={level.parentKind}
          nodes={nodes}
          selected={level.selected}
          idPrefix={idPrefix}
          onSelect={(id) => selectAt(i, id)}
          onCreate={async (kind, name) => {
            const id = await addLocationNode({ name, kind, parentId: level.parentId });
            if (id) selectAt(i, id);
          }}
        />
      ))}
    </div>
  );
}

function Level({
  levelIndex,
  parentId,
  parentKind,
  nodes,
  selected,
  idPrefix,
  onSelect,
  onCreate,
}: {
  levelIndex: number;
  parentId: string | null;
  parentKind: NodeKind | null;
  nodes: ReturnType<typeof useStore.getState>['nodes'];
  selected: string | null;
  idPrefix: string;
  onSelect: (id: string | null) => void;
  onCreate: (kind: NodeKind, name: string) => Promise<void>;
}) {
  const opts = childrenOf(nodes, parentId);
  const [creating, setCreating] = useState<NodeKind | null>(null);
  const [name, setName] = useState('');
  // What this level may CREATE: the top level creates zones; below that, a room and/or an
  // object per the tree rule (both legal under a zone or a room).
  const creatable: NodeKind[] = parentKind === null ? ['zone'] : ['room', 'element'];
  const selectId = levelIndex === 0 ? `${idPrefix}-select-zone` : `${idPrefix}-select-d${levelIndex}`;
  const inputId = (kind: NodeKind) =>
    levelIndex === 0 ? `${idPrefix}-new-zone` : `${idPrefix}-new-${kind}-d${levelIndex}`;
  const placeholder = parentKind === null ? KIND_LABEL.zone : `${KIND_LABEL.room} / ${KIND_LABEL.element}`;
  const add = async () => {
    const n = name.trim();
    if (!n || !creating) return;
    await onCreate(creating, n);
    setName('');
    setCreating(null);
  };
  return (
    <div>
      {creating ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder={`New ${KIND_LABEL[creating].toLowerCase()} name`} style={{ ...fld, flex: 1, minWidth: 0 }} data-testid={inputId(creating)} />
          <Button variant="ink" onClick={() => void add()} style={{ padding: '0 14px', fontSize: 12.5 }}>Add</Button>
          <Button variant="outline" onClick={() => { setCreating(null); setName(''); }} style={{ padding: '0 12px', fontSize: 12.5 }}>Cancel</Button>
        </div>
      ) : (
        <select
          value={selected ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__new_zone__') setCreating('zone');
            else if (v === '__new_room__') setCreating('room');
            else if (v === '__new_element__') setCreating('element');
            else onSelect(v || null);
          }}
          data-testid={selectId}
          aria-label={placeholder}
          style={{ ...fld, width: '100%' }}
        >
          <option value="">{placeholder}…</option>
          {opts.map((n) => (
            <option key={n.id} value={n.id}>
              {n.kind === 'element' && parentKind !== null ? `${n.name} (${KIND_LABEL.element.toLowerCase()})` : n.name}
            </option>
          ))}
          {creatable.map((kind) => (
            <option key={kind} value={`__new_${kind}__`}>+ New {KIND_LABEL[kind].toLowerCase()}…</option>
          ))}
        </select>
      )}
    </div>
  );
}
