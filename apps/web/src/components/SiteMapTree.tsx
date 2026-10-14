import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ProjectNode } from '@vitan/shared';
import { childrenOf, trailOf } from '@/lib/locationTree';
import css from './SiteMapTree.module.css';

/** One place in the tree, how deep it sits, and the places shown inside it. */
interface TreeItem {
  id: string | null;
  name: string;
  depth: number;
  children: TreeItem[];
}

/**
 * The tree the Site Map shows: the whole project, every top-level place, and the places inside each place on the
 * path to the one on show. A long project stays short; the opened branch is always visible.
 */
export function siteMapTree(nodes: ProjectNode[], active: string | null): TreeItem {
  const open = new Set<string | null>([null, ...trailOf(nodes, active).map((t) => t.id)]);
  const grow = (parent: string | null, depth: number): TreeItem[] =>
    open.has(parent) ? childrenOf(nodes, parent).map((n) => ({ id: n.id, name: n.name, depth, children: grow(n.id, depth + 1) })) : [];
  return { id: null, name: 'Whole project', depth: 0, children: grow(null, 1) };
}

/** The desktop breakpoint of screens/responsive.module.css (>1024). Where matchMedia is missing, assume desktop. */
const DESKTOP = '(min-width: 1025px)';
function useDesktop(): boolean {
  const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(DESKTOP) : null);
  const [desktop, setDesktop] = useState(() => query()?.matches ?? true);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return desktop;
}

/**
 * #633 unit C (mockup 10) — on a desktop the Site Map keeps the places as a tree beside what the opened place
 * holds, so moving between places is one click and the path is always in view. Not rendered below the desktop
 * breakpoint, where the breadcrumb and the "Places inside" cards do the same job. The places are nested lists, so
 * a screen reader hears each place's level and what it sits in.
 */
export function SiteMapTree({ nodes, active, onSelect, flag }: {
  nodes: ProjectNode[];
  active: string | null;
  onSelect: (id: string | null) => void;
  /** a short red note for a place, e.g. "1 open issue" or "Blocked"; null when nothing needs attention */
  flag: (id: string) => string | null;
}) {
  const desktop = useDesktop();
  const navRef = useRef<HTMLElement>(null);

  // a long tree scrolls inside its own column: bring the opened place into that column's view
  useEffect(() => {
    const nav = navRef.current;
    const row = nav?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!nav || !row) return;
    const top = row.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
    if (top < nav.scrollTop || top + row.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = Math.max(0, top - nav.clientHeight / 2);
    }
  }, [active, desktop]);

  if (!desktop) return null;

  const item = (t: TreeItem) => {
    const current = t.id === active;
    const note = t.id === null ? null : flag(t.id);
    return (
      <li key={t.id ?? 'project'} className={css.item}>
        <button
          type="button"
          data-testid={`site-map-tree-${t.id ?? 'project'}`}
          aria-current={current ? 'true' : undefined}
          onClick={() => onSelect(t.id)}
          style={{ ...row, paddingLeft: 10 + t.depth * 16, background: current ? 'var(--amber-chip)' : 'transparent', fontWeight: current || t.depth === 0 ? 700 : 500 }}
        >
          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
          {note && <span data-testid={`site-map-tree-flag-${t.id}`} style={{ flex: 'none', fontSize: 12, fontWeight: 600, color: '#8a2a25' }}>{note}</span>}
        </button>
        {t.children.length > 0 && <ul role="list" className={css.list}>{t.children.map(item)}</ul>}
      </li>
    );
  };

  return (
    <nav ref={navRef} aria-label="Places" data-testid="site-map-tree" className={css.tree}>
      <ul role="list" className={css.list}>{item(siteMapTree(nodes, active))}</ul>
    </nav>
  );
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minHeight: 44,
  paddingRight: 10,
  border: 'none',
  borderRadius: 8,
  textAlign: 'left',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--ink)',
  cursor: 'pointer',
};
