import { useMemo, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { resolveDrawingUrl } from '@/data/apiGateway';
import { Eyebrow, DecisionChip, ActivityChip, Swatch, PhotoViewer } from '@/components';
import { DrawingViewer } from '@/screens/DrawingsScreen';
import { MapPin, ChevronRight, FileText, Camera, LayoutGrid, Hammer, Blocks, HardHat, CircleCheck } from '@/lib/icons';
import { childrenOf, subtreeIds, trailOf, placeContents, type DrawingRelation, type PlacedDrawing } from '@/lib/locationTree';
import { type Drawing, type Photo, type PlacedInspection, type SwatchKey } from '@vitan/shared';
import styles from './responsive.module.css';

const KIND_LABEL: Record<string, string> = { zone: 'ZONE', room: 'ROOM', element: 'OBJECT' };
const RELATION_META: Record<DrawingRelation, { label: string; color: string }> = {
  here: { label: 'Here', color: 'var(--accent)' },
  inherited: { label: 'Inherited', color: 'var(--muted)' },
  detail: { label: 'Detail', color: 'var(--muted)' },
};

/**
 * Site Map — the location spine's payoff. Browse the project by place (zone → room →
 * object) and see everything filed there at once: the DECISIONS made, the DRAWINGS that
 * govern it (filed here or inherited from a floor/zone), and the PHOTOS of what's actually
 * built. One coordinate every discipline agrees on, so intent and reality sit side by side.
 */
export function PlacesScreen() {
  // drafts are private WIP — the Site Map shows shared reality, so draft locations (and the
  // draft decisions/drawings below) are excluded here. A PMC publishes a draft location from
  // the Decision Log's Locations editor; only then does it appear on the map.
  const nodes = useStore(useShallow((s) => s.nodes.filter((n) => !n.draft)));
  const decisions = useStore(useShallow((s) => s.decisions.filter((d) => !d.draft)));
  // drafts are private WIP — the Site Map shows only published drawings
  const drawings = useStore(useShallow((s) => s.drawings.filter((d) => !d.draft)));
  const photos = useStore(useShallow((s) => s.photos));
  const activities = useStore(useShallow((s) => s.activities));
  const materials = useStore(useShallow((s) => s.materials));
  // AUTH-02: inspections are a pmc/engineer surface — never fed to the client/contractor/
  // consultant Place view (the server already sends them [] for those roles; this mirrors it
  // in the demo where the store is shared across the persona switcher).
  const canSeeInspections = useStore((s) => s.role === 'pmc' || s.role === 'engineer');
  const inspections = useStore(useShallow((s) => (s.role === 'pmc' || s.role === 'engineer' ? s.placedInspections : [])));

  const [sel, setSel] = useState<string | null>(null); // null = whole project
  const [zoom, setZoom] = useState<string | null>(null);
  const [openDrawing, setOpenDrawing] = useState<Drawing | null>(null);

  // if the selected node was deleted out from under us, fall back to the whole project
  const selValid = sel === null || nodes.some((n) => n.id === sel);
  const active = selValid ? sel : null;

  const trail = useMemo(() => [{ id: null as string | null, name: 'Whole project' }, ...trailOf(nodes, active)], [nodes, active]);
  const children = useMemo(() => childrenOf(nodes, active), [nodes, active]);
  const contents = useMemo(
    () => placeContents(active, nodes, decisions, drawings, photos, activities, materials, inspections),
    [active, nodes, decisions, drawings, photos, activities, materials, inspections],
  );

  const countsFor = (id: string) => {
    const sub = subtreeIds(nodes, id);
    const inSub = <T extends { nodeId?: string }>(xs: T[]) => xs.filter((x) => x.nodeId && sub.has(x.nodeId)).length;
    return {
      decisions: inSub(decisions),
      drawings: inSub(drawings),
      photos: inSub(photos),
      activities: inSub(activities),
      materials: inSub(materials),
    };
  };

  const activeNode = nodes.find((n) => n.id === active);
  const total = contents.counts;
  // Only truly empty when there's no tree AND nothing filed anywhere — otherwise the
  // whole-project view still lists unfiled items (e.g. the seeded demo).
  const nothingYet = nodes.length === 0 && total.decisions === 0 && total.drawings === 0 && total.photos === 0 && total.activities === 0 && total.materials === 0;

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <Eyebrow>SITE MAP · BY LOCATION</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em', marginTop: 4 }}>Site Map</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, maxWidth: 560 }}>
        Walk the building by zone, room and object. Each place shows its decisions, the drawings that govern it, and photos of what&apos;s actually built — intent and reality on one coordinate.
      </div>

      {nothingYet ? (
        <div style={{ marginTop: 34, textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '30px 16px', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
          <LayoutGrid size={26} color="#b8b2a6" />
          <div style={{ marginTop: 10, fontWeight: 600, color: 'var(--ink)' }}>No locations yet</div>
          <div style={{ marginTop: 4 }}>Add zones, rooms and objects from the Decision Log&apos;s <b>Locations</b> editor, then file decisions, drawings and photos to them.</div>
        </div>
      ) : (
        <>
          {/* breadcrumb — click any crumb to jump up */}
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3, margin: '18px 0 14px', fontSize: 13 }} data-testid="place-breadcrumb">
            {trail.map((c, i) => {
              const last = i === trail.length - 1;
              return (
                <span key={c.id ?? 'root'} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  {i > 0 && <ChevronRight size={13} color="#b8b2a6" />}
                  <button
                    onClick={() => setSel(c.id)}
                    disabled={last}
                    style={{ background: 'transparent', border: 'none', cursor: last ? 'default' : 'pointer', padding: '2px 4px', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: last ? 700 : 500, color: last ? 'var(--ink)' : 'var(--accent)' }}
                  >
                    {c.name}
                  </button>
                </span>
              );
            })}
          </div>

          {/* drill-down: child zones/rooms/objects with per-place counts */}
          {children.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 22 }}>
              {children.map((n) => {
                const c = countsFor(n.id);
                return (
                  <button key={n.id} onClick={() => setSel(n.id)} data-testid={`place-node-${n.id}`} style={nodeCard}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.12em', color: 'var(--faint)' }}>{KIND_LABEL[n.kind] ?? n.kind.toUpperCase()}</div>
                    <div style={{ fontWeight: 600, fontSize: 14.5, marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</span>
                      <ChevronRight size={15} color="#b8b2a6" style={{ flex: 'none' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 9, marginTop: 8, flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted)' }}>
                      <span title="decisions">◆ {c.decisions}</span>
                      <span title="drawings">▤ {c.drawings}</span>
                      <span title="photos">▦ {c.photos}</span>
                      <span title="activities">⚒ {c.activities}</span>
                      <span title="materials">▧ {c.materials}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.14em', color: 'var(--faint)', margin: '4px 0 12px' }}>
            {activeNode ? `AT ${activeNode.name.toUpperCase()}${children.length ? ' AND BELOW' : ''}` : 'ACROSS THE WHOLE PROJECT'}
          </div>

          {/* Intent vs Reality — the drawing that governs this place beside the photos of
              what's actually built. Only where a comparison is meaningful (a node with both). */}
          {active && contents.drawings.length > 0 && contents.photos.length > 0 && (
            <IntentReality
              placed={contents.drawings[0]}
              photos={contents.photos}
              onOpenDrawing={() => setOpenDrawing(contents.drawings[0].drawing)}
              onZoom={setZoom}
            />
          )}

          {/* Work — activities happening here */}
          <Section icon={<Hammer size={13} />} title="Work" count={contents.activities.length} sub="site activities here">
            {contents.activities.length === 0 ? (
              <Empty>No activities planned here yet.</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {contents.activities.map((a) => (
                  <div key={a.id} data-testid={`place-activity-${a.id}`} style={{ ...rowCard, cursor: 'default' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{a.id}</span>
                        <span style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                      </div>
                      {a.block && <div style={{ fontSize: 11.5, color: 'var(--red-solid)', marginTop: 2 }}>{a.block}</div>}
                    </div>
                    <ActivityChip status={a.status} />
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Inspections — quality checks here (pmc/engineer only) */}
          {canSeeInspections && (
            <Section icon={<CircleCheck size={13} />} title="Inspections" count={contents.inspections.length} sub="quality checks here">
              {contents.inspections.length === 0 ? (
                <Empty>No inspections here yet.</Empty>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {contents.inspections.map((i) => {
                    const st = inspectionStatus(i);
                    return (
                      <div key={i.id} data-testid={`place-inspection-${i.id}`} style={{ ...rowCard, cursor: 'default' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{i.id}</span>
                            <span style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.title}</span>
                          </div>
                        </div>
                        <span style={{ ...relChip, color: st.color, borderColor: st.color }}>{st.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          )}

          {/* Reality — photos */}
          <Section icon={<Camera size={13} />} title="Reality" count={contents.photos.length} sub="photos of what's built">
            {contents.photos.length === 0 ? (
              <Empty>No photos filed here yet.</Empty>
            ) : (
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                {contents.photos.map((p, i) => (
                  <button key={p.id ?? i} onClick={() => setZoom(p.url)} data-testid="place-photo" style={{ flex: 'none', width: 82, height: 82, borderRadius: 10, border: '1px solid rgba(35,33,28,.12)', padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: '#000' }}>
                    <img src={p.url} alt={`Site photo ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </button>
                ))}
              </div>
            )}
          </Section>

          {/* Intent — drawings (filed here or inherited from above) */}
          <Section icon={<FileText size={13} />} title="Drawings" count={contents.drawings.length} sub="what governs this place">
            {contents.drawings.length === 0 ? (
              <Empty>No drawings apply here yet.</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {contents.drawings.map(({ drawing, relation }) => {
                  const cur = drawing.current;
                  const rm = RELATION_META[relation];
                  return (
                    <button key={drawing.id} onClick={() => setOpenDrawing(drawing)} data-testid={`place-drawing-${drawing.number}`} style={rowCard}>
                      <div style={{ width: 38, height: 48, flex: 'none', borderRadius: 5, border: '1px solid var(--hairline)', background: cur ? `center/cover no-repeat url("${resolveDrawingUrl(cur.url)}"), var(--panel)` : 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {!cur && <FileText size={15} color="#b8b2a6" />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12 }}>{drawing.number}</span>
                          {cur && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'var(--accent)' }}>Rev {cur.rev}</span>}
                          <span style={{ ...relChip, color: rm.color, borderColor: rm.color }}>{rm.label}</span>
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{drawing.title}</div>
                      </div>
                      <ChevronRight size={16} color="#b8b2a6" />
                    </button>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Materials delivered here */}
          <Section icon={<Blocks size={13} />} title="Materials" count={contents.materials.length} sub="delivered to this place">
            {contents.materials.length === 0 ? (
              <Empty>No materials delivered here yet.</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {contents.materials.map((m) => (
                  <div key={m.id} data-testid={`place-material-${m.id}`} style={{ ...rowCard, cursor: 'default' }}>
                    <Swatch swatch={m.swatch as SwatchKey} size={30} radius={7} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{m.qty}</div>
                    </div>
                    {!m.matched && <span style={{ ...relChip, color: 'var(--red-solid)', borderColor: 'var(--red-solid)' }}>Mismatch</span>}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Decisions made here */}
          <Section icon={<MapPin size={13} />} title="Decisions" count={contents.decisions.length} sub="choices recorded here">
            {contents.decisions.length === 0 ? (
              <Empty>No decisions recorded here yet.</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {contents.decisions.map((d) => (
                  <div key={d.id} data-testid={`place-decision-${d.id}`} style={{ ...rowCard, cursor: 'default' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{d.id}</span>
                        <span style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</span>
                      </div>
                      {d.approvedOption && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{d.approvedOption}{d.material ? ` — ${d.material}` : ''}</div>}
                    </div>
                    <DecisionChip status={d.status} />
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      {zoom && <PhotoViewer url={zoom} onClose={() => setZoom(null)} />}
      {openDrawing && <DrawingViewer drawing={openDrawing} onClose={() => setOpenDrawing(null)} />}
    </div>
  );
}

/** Intent vs Reality — the governing drawing beside the site photos of what's built, so
 *  "does it match?" is a glance. Shows the build-acknowledgement state on the drawing. */
function IntentReality({
  placed,
  photos,
  onOpenDrawing,
  onZoom,
}: {
  placed: PlacedDrawing;
  photos: Photo[];
  onOpenDrawing: () => void;
  onZoom: (url: string) => void;
}) {
  const { drawing, relation } = placed;
  const cur = drawing.current;
  const acks = cur?.acks ?? [];
  const ackLine = !cur
    ? 'No current revision'
    : acks.length > 0
      ? `Building to Rev ${cur.rev} · ${acks.length} acknowledged`
      : `Rev ${cur.rev} · not yet acknowledged`;
  const hero = photos[0];
  const rm = RELATION_META[relation];

  return (
    <div data-testid="intent-reality" style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 14, padding: 14, marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>Intent vs Reality</span>
        <span style={{ fontSize: 11.5, color: 'var(--faint)', marginLeft: 'auto' }}>drawn vs built</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'stretch' }}>
        {/* Intent — the drawing */}
        <button onClick={onOpenDrawing} data-testid="ir-drawing" style={{ ...irCard, textAlign: 'left' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.14em', color: 'var(--faint)', marginBottom: 6 }}>INTENT · DRAWN</div>
          <div style={{ width: '100%', aspectRatio: '3 / 4', maxHeight: 210, borderRadius: 8, border: '1px solid var(--hairline)', background: cur ? `center/cover no-repeat url("${resolveDrawingUrl(cur.url)}"), var(--panel)` : 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {!cur && <FileText size={22} color="#b8b2a6" />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12 }}>{drawing.number}</span>
            <span style={{ ...relChip, color: rm.color, borderColor: rm.color }}>{rm.label}</span>
          </div>
          <div style={{ fontWeight: 600, fontSize: 13, marginTop: 3, lineHeight: 1.25 }}>{drawing.title}</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: acks.length ? 'var(--green-text, #2F6B44)' : 'var(--muted)', marginTop: 6 }}>
            <HardHat size={12} /> {ackLine}
          </div>
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--faint)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em' }}>VS</span>
        </div>

        {/* Reality — the photos */}
        <div style={{ ...irCard }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.14em', color: 'var(--faint)', marginBottom: 6 }}>REALITY · BUILT</div>
          <button onClick={() => hero && onZoom(hero.url)} data-testid="ir-photo" style={{ width: '100%', aspectRatio: '3 / 4', maxHeight: 210, borderRadius: 8, border: '1px solid rgba(35,33,28,.12)', padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: '#000' }}>
            {hero && <img src={hero.url} alt="Latest site photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {photos.slice(1, 4).map((p) => (
              <button key={p.id} onClick={() => onZoom(p.url)} style={{ width: 34, height: 34, borderRadius: 6, border: '1px solid rgba(35,33,28,.12)', padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: '#000' }}>
                <img src={p.url} alt="Site photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </button>
            ))}
            {photos.length > 4 && <span style={{ fontSize: 11, color: 'var(--faint)' }}>+{photos.length - 4}</span>}
          </div>
          {hero?.takenAt && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Latest · {hero.takenAt}</div>}
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, count, sub, children }: { icon: React.ReactNode; title: string; count: number; sub: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 14.5 }}>{icon} {title}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--faint)' }}>{count}</span>
        <span style={{ fontSize: 11.5, color: 'var(--faint)', marginLeft: 'auto' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: 'var(--faint)', padding: '6px 0' }}>{children}</div>;
}

/** A placed inspection's Site-Map status: open → in review → passed/failed. */
function inspectionStatus(i: PlacedInspection): { label: string; color: string } {
  if (!i.submitted) return { label: 'Open', color: 'var(--muted)' };
  if (!i.decided) return { label: 'In review', color: 'var(--amber-solid)' };
  return i.failedItems > 0 ? { label: 'Failed', color: 'var(--red-solid)' } : { label: 'Passed', color: 'var(--green-solid)' };
}

const nodeCard: CSSProperties = {
  textAlign: 'left',
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 12,
  padding: '11px 13px',
  cursor: 'pointer',
};

const irCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 12,
  padding: 11,
  minWidth: 0,
};

const rowCard: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  textAlign: 'left',
  width: '100%',
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 11,
  padding: '9px 12px',
  cursor: 'pointer',
};

const relChip: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: '.06em',
  padding: '2px 6px',
  borderRadius: 5,
  border: '1px solid',
  textTransform: 'uppercase',
};
