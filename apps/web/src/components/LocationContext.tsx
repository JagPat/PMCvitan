import { type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { trailOf } from '@/lib/locationTree';

/**
 * Where a location-bound record BELONGS, shown wherever that record is read.
 *
 * "Residence at Ambli › Site › Zone A" — the project, then the filed trail. It reuses the
 * shared `trailOf` walk (the same one the Site Map's own breadcrumb uses), so path maths
 * lives in exactly one place, and every crumb is a tap that opens the Site Map AT that place.
 *
 * The trail is kind-agnostic by design: after nested locations, a record may be filed
 * directly on a zone, on a nested room, or on an object hanging off a zone. The crumb shows
 * the real chain, never an invented middle level.
 */
export function LocationContext({
  nodeId,
  fallback,
  compact = false,
  testId,
}: {
  nodeId: string | null | undefined;
  /** free-text location for legacy records with no node (e.g. a decision's `room`) */
  fallback?: string;
  /** drop the project crumb — for a list already scoped to one project (rows, cards) */
  compact?: boolean;
  testId?: string;
}) {
  const nodes = useStore(useShallow((s) => s.nodes));
  const projectShort = useStore((s) => s.short);
  const openPlace = useStore((s) => s.openPlace);
  const trail = trailOf(nodes, nodeId);

  // No filed node: say so honestly rather than rendering an empty trail. A legacy free-text
  // location is shown as plain text — it points at no place the Site Map can open.
  if (trail.length === 0) {
    return (
      <span style={{ ...wrap, color: 'var(--faint)' }} data-testid={testId}>
        {fallback?.trim() ? fallback : 'Not filed to a location'}
      </span>
    );
  }

  const crumbs: { id: string | null; name: string }[] = compact ? trail : [{ id: null, name: projectShort }, ...trail];

  return (
    <span style={wrap} data-testid={testId}>
      {crumbs.map((c, i) => (
        <span key={c.id ?? 'project'} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
          {i > 0 && <span style={sep}>›</span>}
          <button
            type="button"
            onClick={() => openPlace(c.id)}
            data-testid={testId ? `${testId}-crumb-${i}` : undefined}
            style={{ ...crumb, fontWeight: i === crumbs.length - 1 ? 600 : 500 }}
          >
            {c.name}
          </button>
        </span>
      ))}
    </span>
  );
}

const wrap: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  // wrapping is deliberate: a deep trail on a 390px screen breaks onto a second line
  // rather than truncating away the place the reader needs
  flexWrap: 'wrap',
  gap: 1,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--muted)',
  maxWidth: '100%',
};

const crumb: CSSProperties = {
  background: 'transparent',
  border: 'none',
  // 44 TALL, and the trail grows to fit (#584 review round 5). A breadcrumb is a navigation
  // control pressed with a thumb on site, so it answers to the same floor as every other action
  // target; at 12px in 2px of padding it was ~18px, and F-1b's completion criterion is "every
  // action target ≥44×44" without exception. Deferring it was the mistake round 5 caught: F-1c is
  // VALIDATION with no new design decisions, so a known violation parked there is parked nowhere.
  // The row is denser for it, and that is the trade this unit is the one allowed to make.
  // BOTH AXES (#584 review round 6). Round 5 gave this a height and stopped, and a location name
  // may legitimately be a single character — `createNodeSchema` accepts `min(1)` and the
  // integration fixtures use `Z` — so a crumb was ~18px WIDE while passing a height-only floor.
  // Round 5 had already caught the identical omission on the register's `All` chip (37px wide
  // after its own height fix) and did not carry the lesson back here, one file over.
  minHeight: 44,
  minWidth: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2px 3px',
  margin: 0,
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  color: 'var(--accent)',
  cursor: 'pointer',
  maxWidth: 190,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const sep: CSSProperties = { color: 'var(--faint)', fontSize: 12, padding: '0 1px' };
