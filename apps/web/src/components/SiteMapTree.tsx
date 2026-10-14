import type { CSSProperties } from 'react';
import type { ProjectNode } from '@vitan/shared';
import { childrenOf, trailOf } from '@/lib/locationTree';
import css from './SiteMapTree.module.css';

/** One row of the tree: a place, how deep it sits, and the one thing on it that needs attention, if any. */
interface TreeRow {
  id: string | null;
  name: string;
  depth: number;
}

/**
 * The rows the tree shows: the whole project, every top-level place, and the places inside each place on the
 * path to the one on show. A long project stays short; the opened branch is always visible.
 */
export function siteMapTreeRows(nodes: ProjectNode[], active: string | null): TreeRow[] {
  const open = new Set<string | null>([null, ...trailOf(nodes, active).map((t) => t.id)]);
  const rows: TreeRow[] = [{ id: null, name: 'Whole project', depth: 0 }];
  const walk = (parent: string | null, depth: number) => {
    if (!open.has(parent)) return;
    for (const n of childrenOf(nodes, parent)) {
      rows.push({ id: n.id, name: n.name, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 1);
  return rows;
}

/**
 * #633 unit C (mockup 10) — on a desktop the Site Map keeps the places as a tree beside what the opened place
 * holds, so moving between places is one click and the path is always in view. Hidden below the desktop
 * breakpoint, where the breadcrumb and the "Places inside" cards do the same job.
 */
export function SiteMapTree({ nodes, active, onSelect, flag }: {
  nodes: ProjectNode[];
  active: string | null;
  onSelect: (id: string | null) => void;
  /** a short red note for a place, e.g. "1 open issue" or "Blocked"; null when nothing needs attention */
  flag: (id: string) => string | null;
}) {
  return (
    <nav aria-label="Places" data-testid="site-map-tree" className={css.tree}>
      {siteMapTreeRows(nodes, active).map((r) => {
        const current = r.id === active;
        const note = r.id === null ? null : flag(r.id);
        return (
          <button
            key={r.id ?? 'project'}
            type="button"
            data-testid={`site-map-tree-${r.id ?? 'project'}`}
            aria-current={current ? 'true' : undefined}
            onClick={() => onSelect(r.id)}
            style={{ ...row, paddingLeft: 10 + r.depth * 16, background: current ? 'var(--amber-chip)' : 'transparent', fontWeight: current || r.depth === 0 ? 700 : 500 }}
          >
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
            {note && <span data-testid={`site-map-tree-flag-${r.id}`} style={{ flex: 'none', fontSize: 12, fontWeight: 600, color: '#8a2a25' }}>{note}</span>}
          </button>
        );
      })}
    </nav>
  );
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minHeight: 40,
  paddingRight: 10,
  border: 'none',
  borderRadius: 8,
  textAlign: 'left',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--ink)',
  cursor: 'pointer',
};
