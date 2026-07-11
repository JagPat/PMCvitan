import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Button } from '@/components';
import { childrenOf } from '@/lib/locationTree';
import type { NodeKind } from '@vitan/shared';

const KIND_LABEL: Record<NodeKind, string> = { zone: 'Zone', room: 'Room', element: 'Object' };

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
 * Cascading location picker — Zone › Room › Object — shared by every module that
 * files onto the location spine (decisions, drawings, photos). Each level picks an
 * existing node or creates one inline (persisted to the tree via `addLocationNode`).
 * The item attaches to the DEEPEST level chosen, so "Main Door" works whether it holds
 * one item or many (Lock, Veneer). `idPrefix` keeps test ids unique when two pickers
 * share a screen.
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
  const nodes = useStore(useShallow((s) => s.nodes));
  const addLocationNode = useStore((s) => s.addLocationNode);
  const [zone, setZone] = useState<string | null>(null);
  const [room, setRoom] = useState<string | null>(null);

  const setLevel = (kind: NodeKind, id: string | null) => {
    if (kind === 'zone') {
      setZone(id);
      setRoom(null);
      onChange(id);
    } else if (kind === 'room') {
      setRoom(id);
      onChange(id ?? zone);
    } else onChange(id ?? room ?? zone);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Level kind="zone" parentId={null} nodes={nodes} selected={zone} idPrefix={idPrefix} onSelect={(id) => setLevel('zone', id)} onCreate={(name) => addLocationNode({ name, kind: 'zone', parentId: null })} />
      {zone && <Level kind="room" parentId={zone} nodes={nodes} selected={room} idPrefix={idPrefix} onSelect={(id) => setLevel('room', id)} onCreate={(name) => addLocationNode({ name, kind: 'room', parentId: zone })} />}
      {room && <Level kind="element" parentId={room} nodes={nodes} selected={value === room ? null : value} idPrefix={idPrefix} onSelect={(id) => setLevel('element', id)} onCreate={(name) => addLocationNode({ name, kind: 'element', parentId: room })} />}
    </div>
  );
}

function Level({
  kind,
  parentId,
  nodes,
  selected,
  idPrefix,
  onSelect,
  onCreate,
}: {
  kind: NodeKind;
  parentId: string | null;
  nodes: ReturnType<typeof useStore.getState>['nodes'];
  selected: string | null;
  idPrefix: string;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => Promise<string | null>;
}) {
  const opts = childrenOf(nodes, parentId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    const id = await onCreate(n);
    setName('');
    setCreating(false);
    if (id) onSelect(id);
  };
  return (
    <div>
      {creating ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder={`New ${KIND_LABEL[kind].toLowerCase()} name`} style={{ ...fld, flex: 1, minWidth: 0 }} data-testid={`${idPrefix}-new-${kind}`} />
          <Button variant="ink" onClick={() => void add()} style={{ padding: '0 14px', fontSize: 12.5 }}>Add</Button>
          <Button variant="outline" onClick={() => { setCreating(false); setName(''); }} style={{ padding: '0 12px', fontSize: 12.5 }}>Cancel</Button>
        </div>
      ) : (
        <select
          value={selected ?? ''}
          onChange={(e) => (e.target.value === '__new__' ? setCreating(true) : onSelect(e.target.value || null))}
          data-testid={`${idPrefix}-select-${kind}`}
          aria-label={KIND_LABEL[kind]}
          style={{ ...fld, width: '100%' }}
        >
          <option value="">{KIND_LABEL[kind]}…</option>
          {opts.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          <option value="__new__">+ New {KIND_LABEL[kind].toLowerCase()}…</option>
        </select>
      )}
    </div>
  );
}
