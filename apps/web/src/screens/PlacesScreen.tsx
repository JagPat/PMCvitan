import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { decisionRecordLink, inspectionRecordLink, inspectionsSettledForLinks, selectVisibleDecisions } from '@/store/selectors';
import { API_BASE, activitiesReadMode, inspectionsReadMode, resolveDrawingUrl } from '@/data/apiGateway';
import { Eyebrow, DecisionChip, ActivityChip, Swatch, PhotoViewer, Button, CreateMenu } from '@/components';
import { createOptionsFor, type CreateKind } from '@/lib/createOptions';
import { IssueChecklistModal } from '@/screens/modals/IssueChecklistModal';
import { AddMaterialModal } from '@/screens/modals/AddMaterialModal';
import { IssueDecisionModal } from '@/screens/modals/IssueDecisionModal';
import { captureAtPlace } from '@/lib/captureContext';
import { stampText } from '@/lib/captureStamp';
import { PlaceStructure } from '@/screens/PlaceStructure';
import { PlaceWorkRecords, PlaceRecordsEmpty, type PlaceRecordSection } from '@/components/PlaceWorkRecords';
import { SiteMapLegend } from '@/components/SiteMapLegend';
import { SiteMapTree } from '@/components/SiteMapTree';
import treeCss from '@/components/SiteMapTree.module.css';
import { useNavItems } from '@/layout/useNavItems';
import { plannedWindow } from '@/lib/activityDates';
import { MapPin, ChevronRight, FileText, Camera, LayoutGrid, Hammer, Blocks, HardHat, CircleCheck, Plus, Lock } from '@/lib/icons';
import { placeCountWords, type PlaceCountOptions, type PlaceCountWord } from '@/lib/placeCountWords';
import { childrenOf, trailOf, placeContents, demoSiteMapInspections, spaceStatus, type DrawingRelation, type PlacedDrawing, type SpaceStatus } from '@/lib/locationTree';
import {
  can, navLabels, SNAPSHOT_SITE_PHOTO_LIMIT, siteMapLabels as L, siteMapText as T, placeSectionLabels as SEC, placeKindTag, drawingRelationLabels,
  placeInspectionStatusLabels, spaceStatusLabels, photoTakenAtIn, systemBlockIn, inspectionTitle,
  type Lang, type Photo, type PlacedInspection, type ScreenKey, type SwatchKey,
} from '@vitan/shared';
import styles from './responsive.module.css';

const RELATION_COLOR: Record<DrawingRelation, string> = { here: 'var(--accent)', inherited: 'var(--muted)', detail: 'var(--muted)' };

/**
 * Site Map — the location spine's payoff. Browse the project by place (zone → room →
 * object) and see everything filed there at once: the DECISIONS made, the DRAWINGS that
 * govern it (filed here or inherited from a floor/zone), and the PHOTOS of what's actually
 * built. One coordinate every discipline agrees on, so intent and reality sit side by side.
 */
export function PlacesScreen() {
  // drafts are private WIP — the Site Map shows shared reality, so draft locations (and the
  // draft decisions/drawings below) are excluded here. A PMC publishes a draft location from
  // the "All locations" editor (PlaceStructure); only then does it appear on the map.
  const nodes = useStore(useShallow((s) => s.nodes.filter((n) => !n.draft)));
  // Phase 6 task 4a round 6 (Codex): the shared audience rule — a withdrawn decision's
  // title/location never renders to a role the server filters it from
  const decisions = useStore(useShallow(selectVisibleDecisions));
  // drafts are private WIP — the Site Map shows only published drawings
  const drawings = useStore(useShallow((s) => s.drawings.filter((d) => !d.draft)));
  const photos = useStore(useShallow((s) => s.photos));
  // the snapshot carries only the newest SNAPSHOT_SITE_PHOTO_LIMIT site photos: once that window is full, a
  // place's photos are those among the latest, never its whole record (Codex 4194155412, shadow review)
  const photosCapped = photos.length >= SNAPSHOT_SITE_PHOTO_LIMIT;
  const activities = useStore(useShallow((s) => s.activities));
  // Module-owned activities (`moduleQuery`) are known only once their read answers: until then, or after it
  // fails, an empty list says nothing about where work is — the same boundary the Schedule draws (Codex
  // 4195514775). A failed read with last-good activities still shows them.
  const activitiesLoad = useStore((s) => s.activitiesLoad);
  const activityRead: 'known' | 'loading' | 'unavailable' =
    activitiesReadMode() === 'moduleQuery' && activitiesLoad !== 'ready' && activities.length === 0
      ? (activitiesLoad === 'error' ? 'unavailable' : 'loading')
      : 'known';
  const phases = useStore(useShallow((s) => s.phases));
  const openActivity = useStore((s) => s.openActivity);
  // Audit F-02 — a place's work leads to its schedule row, for a role that has the schedule
  const canOpenSchedule = useNavItems().some((n) => n.key === 'site-schedule');
  const materials = useStore(useShallow((s) => s.materials));
  // AUTH-02: inspections are a pmc/engineer surface — never fed to the client/contractor/
  // consultant Place view (the server already sends them [] for those roles; this mirrors it
  // in the demo where the store is shared across the persona switcher).
  const canSeeInspections = useStore((s) => s.role === 'pmc' || s.role === 'engineer');
  const placedInspections = useStore(useShallow((s) => (s.role === 'pmc' || s.role === 'engineer' ? s.placedInspections : [])));
  // #847 — the API-less demo counts its own open issues from its reviews, by the Dashboard's rule; only for
  // the PMC, the one demo role whose record link opens a review (an engineer keeps the placed rows)
  const demoReviewsForMap = useStore((s) => s.role === 'pmc');
  const demoReviews = useStore((s) => s.reviews);
  const inspections = useMemo(
    () => (API_BASE || !demoReviewsForMap ? placedInspections : demoSiteMapInspections(placedInspections, demoReviews)),
    [placedInspections, demoReviews, demoReviewsForMap],
  );
  const inspectionsKnown = useStore((s) => inspectionsSettledForLinks(s)
    && !(inspectionsReadMode() === 'moduleQuery' && s.inspectionsLoad === 'error' && s.placedInspections.length === 0));

  // B6 — the place on show is the URL's item (`/places/<nodeId>`), so it survives a refresh, can be
  // shared, and back/forward walks the places visited. null = whole project.
  const sel = useStore((s) => s.routeItem);
  const setSel = useStore((s) => s.setRouteItem);
  // Entering the Site Map from an entity's location breadcrumb: `openPlace` has already named the
  // place; the request is consumed ONCE so a later manual walk isn't disturbed by it.
  const placeFocus = useStore((s) => s.placeFocus);
  const clearPlaceFocus = useStore((s) => s.clearPlaceFocus);
  useEffect(() => {
    if (placeFocus === null) return;
    clearPlaceFocus();
  }, [placeFocus, clearPlaceFocus]);
  const [zoom, setZoom] = useState<string | null>(null);
  // Top 10 #3 (#774) — a place's records open AT THEIR OWN URL (reload-safe, shareable, Back returns here):
  // a drawing on the Drawings screen, a decision where this viewer reads it, an inspection on the inspection
  // screen the role holds — never a local overlay, and never a row that goes nowhere
  const openDrawing = useStore((s) => s.openDrawing);
  const openItem = useStore((s) => s.openItem);
  // id → the screen that opens it for this viewer (plain strings, so the shallow compare holds)
  const inspectionScreens = useStore(useShallow((s) => Object.fromEntries(
    [...s.placedInspections.map((i) => i.id), ...(API_BASE || s.role !== 'pmc' ? [] : s.reviews.map((r) => r.id))].flatMap((id) => { const l = inspectionRecordLink(s, id); return l ? [[id, l.screen]] : []; }),
  ) as Record<string, ScreenKey>));
  const decisionScreens = useStore(useShallow((s) => Object.fromEntries(
    selectVisibleDecisions(s).map((d) => [d.id, decisionRecordLink(s, d).screen]),
  ) as Record<string, ScreenKey>));
  // Creating FROM a place: the Site Map was read-only, so the one screen that knows exactly
  // where a record belongs was also the one screen that could not create one. `creating` is
  // the menu; `creatingKind` is the form it chose. Both carry the place with them.
  const [creating, setCreating] = useState(false);
  const [creatingKind, setCreatingKind] = useState<CreateKind | null>(null);
  const role = useStore((s) => s.role);
  const lang = useStore((s) => s.lang);
  const activeProjectId = useStore((s) => s.activeProjectId);
  // a role with nothing it may author is never offered the button, rather than being
  // offered one and refused
  const canCreateHere = createOptionsFor(role).length > 0;

  // if the selected node was deleted out from under us, fall back to the whole project
  const selValid = sel === null || nodes.some((n) => n.id === sel);
  const active = selValid ? sel : null;

  const trail = useMemo(() => [{ id: null as string | null, name: L.wholeProject[lang] }, ...trailOf(nodes, active)], [nodes, active, lang]);
  const children = useMemo(() => childrenOf(nodes, active), [nodes, active]);
  const contents = useMemo(
    () => placeContents(active, nodes, decisions, drawings, photos, activities, materials, inspections),
    [active, nodes, decisions, drawings, photos, activities, materials, inspections],
  );

  // #633 — a child card counts with the SAME function as the place it opens (inherited drawings included),
  // so the card and the opened place can never disagree
  const countsFor = (id: string) =>
    placeContents(id, nodes, decisions, drawings, photos, activities, materials, inspections).counts;
  // a count is only as known as the read behind it: a module read not yet settled (or failed with nothing
  // retained) leaves its counts unknown, never 0 (Codex 4265796887); a full photo window counts recent photos
  // #633 unit C — the one thing a place in the desktop tree needs to say: its open issues (where this viewer
  // sees inspections and their read has settled), else that its work is blocked
  const treeFlag = (id: string): string | null => {
    const open = countsFor(id).openIssues ?? 0;
    if (canSeeInspections && inspectionsKnown && open > 0) return T.count('openIssues', open, lang);
    if (activityRead === 'known' && spaceStatus(nodes, activities, phases, id).state === 'blocked') return spaceStatusLabels.blocked[lang];
    return null;
  };
  const countOpts: PlaceCountOptions = {
    inspections: !canSeeInspections ? 'hidden' : inspectionsKnown ? 'known' : 'unknown',
    activitiesKnown: activityRead === 'known',
    photosCapped,
  };

  const activeNode = nodes.find((n) => n.id === active);
  const canManagePlaces = can('node.manage', role);
  // only a role the server lets request a change is told to (the architect's path is countersign; Codex 4273627437)
  const canRequestChange = can('decision.change', role);
  const total = contents.counts;
  // Only truly empty when there's no tree AND nothing filed anywhere — otherwise the
  // whole-project view still lists unfiled items (e.g. the seeded demo).
  const nothingYet = nodes.length === 0 && total.decisions === 0 && total.drawings === 0 && total.photos === 0 && total.activities === 0 && total.materials === 0;

  // #633 (mockup 7) — the place's records, open issues first: inspections, then decisions, work and drawings,
  // then deliveries and photos. Each row opens its own record; a later kind of record is one more entry.
  const recordSections: PlaceRecordSection[] = [
    ...(canSeeInspections ? [{
      key: 'inspections', icon: <CircleCheck size={13} />, title: SEC.inspections.title[lang], count: contents.inspections.length,
      sub: SEC.inspections.sub[lang],
      body: (
          contents.inspections.length === 0 ? (
            <PlaceRecordsEmpty>{SEC.inspections.empty[lang]}</PlaceRecordsEmpty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {issuesFirst(contents.inspections).map((i) => {
                const st = inspectionStatus(i, lang);
                const screen = inspectionScreens[i.id];
                const RowTag = screen ? 'button' : 'div';
                return (
                  <RowTag key={i.id} data-testid={`place-inspection-${i.id}`} style={screen ? rowCard : { ...rowCard, cursor: 'default' }} {...(screen ? { onClick: () => openItem(screen, i.id, { nodeId: sel }), 'aria-label': T.openInspection(i.id, lang) } : {})}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{i.id}</span>
                        <span style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inspectionTitle(i, lang)}</span>
                      </div>
                    </div>
                    {(i.openIssues ?? 0) > 0 && (
                      <span data-testid={`place-inspection-issues-${i.id}`} style={{ ...countPill, ...alertTone, fontSize: 12 }}>
                        {T.count('openIssues', i.openIssues ?? 0, lang)}
                      </span>
                    )}
                    <span style={{ ...relChip, color: st.color, borderColor: st.color }}>{st.label}</span>
                  </RowTag>
                );
              })}
            </div>
          )
      ),
    }] : []),
    {
      key: 'decisions', icon: <MapPin size={13} />, title: SEC.decisions.title[lang], count: contents.decisions.length,
      sub: SEC.decisions.sub[lang],
      body: (
        contents.decisions.length === 0 ? (
          <PlaceRecordsEmpty>{SEC.decisions.empty[lang]}</PlaceRecordsEmpty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {contents.decisions.map((d) => (
              <button key={d.id} data-testid={`place-decision-${d.id}`} style={rowCard} onClick={() => openItem(decisionScreens[d.id] ?? 'decision-log', d.id, { nodeId: sel })} aria-label={T.openDecision(d.id, lang)} aria-describedby={d.status === 'approved' ? `place-decision-lock-${d.id}` : undefined}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{d.id}</span>
                    <span style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</span>
                  </div>
                  {d.approvedOption && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{d.approvedOption}{d.material ? ` — ${d.material}` : ''}</div>}
                  {/* #633 unit B — a locked record says why, and the way to change it (its record offers "Request change") */}
                  {d.status === 'approved' && (
                    <div id={`place-decision-lock-${d.id}`} data-testid={`place-decision-lock-${d.id}`} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--green-text)', marginTop: 3 }}>
                      <Lock size={12} style={{ flex: 'none' }} /><span>{canRequestChange ? L.lockedRequest[lang] : L.locked[lang]}</span>
                    </div>
                  )}
                </div>
                <DecisionChip status={d.status} lang={lang} />
              </button>
            ))}
          </div>
        )
      ),
    },
    {
      key: 'work', icon: <Hammer size={13} />, title: SEC.work.title[lang], count: contents.activities.length,
      sub: SEC.work.sub[lang],
      body: (
        contents.activities.length === 0 ? (
          <PlaceRecordsEmpty>
            {activityRead === 'unavailable'
              ? L.activitiesUnavailable[lang]
              : activityRead === 'loading' ? L.activitiesLoading[lang] : SEC.work.empty[lang]}
          </PlaceRecordsEmpty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {contents.activities.map((a) => {
              // Audit F-02 — which phase this work belongs to and when it is planned, as the schedule says
              const phase = phases.find((p) => p.id === a.phaseId);
              return (
                <div key={a.id} data-testid={`place-activity-${a.id}`} style={{ ...rowCard, cursor: 'default', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{a.id}</span>
                      <span style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }} data-testid={`place-activity-plan-${a.id}`}>
                      {phase ? phase.name : L.unphased[lang]} · {L.plan[lang]} {plannedWindow(a, lang)}
                    </div>
                    {a.block && <div style={{ fontSize: 11.5, color: 'var(--red-solid)', marginTop: 2 }}>{systemBlockIn(a.block, lang)}</div>}
                  </div>
                  <ActivityChip status={a.status} lang={lang} />
                  {canOpenSchedule && (
                    <Button variant="light" onClick={() => openActivity(a.id, { nodeId: sel })} data-testid={`place-activity-open-${a.id}`} aria-label={T.viewInScheduleAria(a.name, lang)} style={{ padding: '8px 11px', fontSize: 12 }}>
                      {L.viewInSchedule[lang]}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )
      ),
    },
    {
      key: 'drawings', icon: <FileText size={13} />, title: SEC.drawings.title[lang], count: contents.drawings.length,
      sub: SEC.drawings.sub[lang],
      body: (
        contents.drawings.length === 0 ? (
          <PlaceRecordsEmpty>{SEC.drawings.empty[lang]}</PlaceRecordsEmpty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {contents.drawings.map(({ drawing, relation }) => {
              const cur = drawing.current;
              const rm = { label: drawingRelationLabels[relation][lang], color: RELATION_COLOR[relation] };
              return (
                <button key={drawing.id} onClick={() => openDrawing(drawing.id, { nodeId: sel })} data-testid={`place-drawing-${drawing.number}`} style={rowCard}>
                  <div style={{ width: 38, height: 48, flex: 'none', borderRadius: 5, border: '1px solid var(--hairline)', background: cur ? `center/cover no-repeat url("${resolveDrawingUrl(cur.url)}"), var(--panel)` : 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {!cur && <FileText size={15} color="#b8b2a6" />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12 }}>{drawing.number}</span>
                      {cur && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'var(--accent)' }}>{L.rev[lang]} {cur.rev}</span>}
                      <span style={{ ...relChip, color: rm.color, borderColor: rm.color }}>{rm.label}</span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{drawing.title}</div>
                  </div>
                  <ChevronRight size={16} color="#b8b2a6" />
                </button>
              );
            })}
          </div>
        )
      ),
    },
    {
      key: 'materials', icon: <Blocks size={13} />, title: SEC.materials.title[lang], count: contents.materials.length,
      sub: SEC.materials.sub[lang],
      body: (
        contents.materials.length === 0 ? (
          <PlaceRecordsEmpty>{SEC.materials.empty[lang]}</PlaceRecordsEmpty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {contents.materials.map((m) => (
              <div key={m.id} data-testid={`place-material-${m.id}`} style={{ ...rowCard, cursor: 'default' }}>
                <Swatch swatch={m.swatch as SwatchKey} size={30} radius={7} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{m.qty}</div>
                </div>
                {!m.matched && <span style={{ ...relChip, color: 'var(--red-solid)', borderColor: 'var(--red-solid)' }}>{L.mismatch[lang]}</span>}
              </div>
            ))}
          </div>
        )
      ),
    },
    {
      key: 'photos', icon: <Camera size={13} />, title: SEC.photos.title[lang], count: contents.photos.length,
      sub: photosCapped ? T.photosCappedSub(SNAPSHOT_SITE_PHOTO_LIMIT, lang) : SEC.photos.sub[lang],
      body: (
        contents.photos.length === 0 ? (
          <PlaceRecordsEmpty>{photosCapped ? T.photosCappedEmpty(SNAPSHOT_SITE_PHOTO_LIMIT, lang) : SEC.photos.empty[lang]}</PlaceRecordsEmpty>
        ) : (
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
            {contents.photos.map((p, i) => (
              <button key={p.id ?? i} onClick={() => setZoom(p.url)} data-testid="place-photo" aria-label={T.openPhoto(i + 1, contents.photos.length, lang)} style={{ flex: 'none', width: 82, height: 82, borderRadius: 10, border: '1px solid rgba(35,33,28,.12)', padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: '#000' }}>
                <img src={p.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </button>
            ))}
          </div>
        )
      ),
    },
  ];

  return (
    <div className={`${styles.screen} ${styles.wide}`}>
      <Eyebrow>{L.eyebrow[lang]}</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em', marginTop: 4 }}>{navLabels.places[lang]}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, maxWidth: 560 }}>
        {L.intro[lang]}
      </div>

      {nothingYet ? (
        <div style={{ marginTop: 34, textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '30px 16px', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
          <LayoutGrid size={26} color="#b8b2a6" />
          <div style={{ marginTop: 10, fontWeight: 600, color: 'var(--ink)' }}>{L.noLocations[lang]}</div>
          <div style={{ marginTop: 4 }}>
            {canManagePlaces ? L.noLocationsManage[lang] : L.noLocationsView[lang]}
          </div>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
            <PlaceStructure active={undefined} depth={0} />
          </div>
          {/* An empty project is exactly when the first location-backed record gets made, so
              this is the wrong moment to withhold the create action. The forms' own picker
              creates the first zone inline, so nothing here depends on a tree existing. */}
          {canCreateHere && (
            <div style={{ marginTop: 16 }}>
              <Button variant="ink" onClick={() => setCreating(true)} data-testid="place-add-empty" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 14px', fontSize: 13 }}>
                <Plus size={15} /> {L.addHere[lang]}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className={treeCss.layout}>
          <SiteMapTree nodes={nodes} active={active} onSelect={setSel} flag={treeFlag} lang={lang} />
          <div className={treeCss.main}>
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

            {/* #633 (mockup 7) — what this place holds, in words, open issues first */}
            {active && <CountWords words={placeCountWords(total, countOpts, lang)} testId="place-counts-here" pills />}

            {/* Build the tree HERE (audit B3): the PMC adds, renames and deletes locations at the
                place they are standing on */}
            <PlaceStructure active={activeNode} depth={trail.length - 1} />

            {/* Create AT this place. The record inherits the coordinate the user is already
                standing on, so the form never re-asks where — the point of the Site Map is
                that this screen already knows. Same button, same options and same forms on a
                phone and a desktop; only the entry point's placement differs. */}
            {canCreateHere && (
              <div style={{ marginBottom: 18 }}>
                <Button variant="ink" onClick={() => setCreating(true)} data-testid="place-add" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 14px', fontSize: 13 }}>
                  <Plus size={15} /> {L.addHere[lang]}
                </Button>
              </div>
            )}

            {/* #633 unit B — what the status colours below mean, in words */}
            <SiteMapLegend lang={lang} />

            {/* drill-down: child zones/rooms/objects with per-place counts — "Places inside" (mockup 7) */}
            {children.length > 0 && (
              <h2 data-testid="place-children-title" style={{ fontSize: 17, fontWeight: 700, margin: '0 0 10px' }}>{L.placesInside[lang]}</h2>
            )}
            {children.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 22 }}>
                {children.map((n) => {
                  const c = countsFor(n.id);
                  const st = spaceStatus(nodes, activities, phases, n.id);
                  return (
                    <button key={n.id} onClick={() => setSel(n.id)} data-testid={`place-node-${n.id}`} style={nodeCard}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.12em', color: 'var(--faint)' }}>{placeKindTag(n.kind, lang)}</div>
                      <div style={{ fontWeight: 600, fontSize: 14.5, marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</span>
                        <ChevronRight size={15} color="#b8b2a6" style={{ flex: 'none' }} />
                      </div>
                      <CountWords words={placeCountWords(c, countOpts, lang)} testId={`place-counts-${n.id}`} />
                      {/* B8 — where this space stands, derived from its work (never a stored flag) */}
                      {activityRead !== 'known' ? (
                        <div data-testid={`place-status-${n.id}`} data-state={activityRead} style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
                          {activityRead === 'unavailable' ? L.statusUnavailable[lang] : L.statusLoading[lang]}
                        </div>
                      ) : st.state !== 'none' && (
                        <div data-testid={`place-status-${n.id}`} data-state={st.state} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11, color: 'var(--muted)', flexWrap: 'wrap' }}>
                          <span style={{ ...statusChip, ...STATUS_TONE[st.state] }}>{spaceStatusLabels[st.state][lang]}</span>
                          <span>{[st.phase, T.doneOf(st.done, st.total, lang), st.blocked ? T.blocked(st.blocked, lang) : null].filter(Boolean).join(' · ')}</span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Intent vs Reality — the drawing that governs this place beside the photos of
                what's actually built. Only where a comparison is meaningful (a node with both). */}
            {active && contents.drawings.length > 0 && contents.photos.length > 0 && (
              <IntentReality
                placed={contents.drawings[0]}
                photos={contents.photos}
                onOpenDrawing={() => openDrawing(contents.drawings[0].drawing.id, { nodeId: sel })}
                onZoom={setZoom}
                lang={lang}
              />
            )}

            <PlaceWorkRecords
              where={activeNode ? T.at(activeNode.name, children.length > 0, lang) : L.acrossProject[lang]}
              sections={recordSections}
              lang={lang}
            />
          </div>
        </div>
      )}

      {zoom && <PhotoViewer url={zoom} onClose={() => setZoom(null)} />}
      {creating && (
        <CreateMenu
          title={L.addHere[lang]}
          subtitle={trail[trail.length - 1]?.name}
          onPick={(kind) => { setCreating(false); setCreatingKind(kind); }}
          onClose={() => setCreating(false)}
        />
      )}
      {/* `active`, not `sel`: a place deleted out from under the user falls back to the whole
          project, and the form must inherit what the screen is actually showing. */}
      {creatingKind === 'inspection' && (
        <IssueChecklistModal context={captureAtPlace(activeProjectId, active)} onClose={() => setCreatingKind(null)} />
      )}
      {creatingKind === 'material' && (
        <AddMaterialModal context={captureAtPlace(activeProjectId, active)} onClose={() => setCreatingKind(null)} />
      )}
      {creatingKind === 'decision' && (
        <IssueDecisionModal context={captureAtPlace(activeProjectId, active)} onClose={() => setCreatingKind(null)} />
      )}
    </div>
  );
}

/** Intent vs Reality — the governing drawing beside the site photos of what's built, so
 *  "does it match?" is a glance. Shows the build-acknowledgement state on the drawing. */
export function IntentReality({
  placed,
  photos,
  onOpenDrawing,
  onZoom,
  lang = 'en',
}: {
  placed: PlacedDrawing;
  photos: Photo[];
  onOpenDrawing: () => void;
  onZoom: (url: string) => void;
  lang?: Lang;
}) {
  const { drawing, relation } = placed;
  const cur = drawing.current;
  const acks = cur?.acks ?? [];
  const ackLine = !cur
    ? L.noRevision[lang]
    : acks.length > 0
      ? T.buildingTo(cur.rev, acks.length, lang)
      : T.notAcknowledged(cur.rev, lang);
  const hero = photos[0];
  const heroStamp = stampText(hero?.takenAt);
  const rm = { label: drawingRelationLabels[relation][lang], color: RELATION_COLOR[relation] };

  return (
    <div data-testid="intent-reality" style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 14, padding: 14, marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>{L.intentReality[lang]}</span>
        <span style={{ fontSize: 11.5, color: 'var(--faint)', marginLeft: 'auto' }}>{L.drawnVsBuilt[lang]}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'stretch' }}>
        {/* Intent — the drawing */}
        <button onClick={onOpenDrawing} data-testid="ir-drawing" style={{ ...irCard, minWidth: 44, textAlign: 'left' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.14em', color: 'var(--faint)', marginBottom: 6 }}>{L.intentDrawn[lang]}</div>
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
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em' }}>{L.versus[lang]}</span>
        </div>

        {/* Reality — the photos */}
        <div style={{ ...irCard }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.14em', color: 'var(--faint)', marginBottom: 6 }}>{L.realityBuilt[lang]}</div>
          <button onClick={() => hero && onZoom(hero.url)} disabled={!hero} aria-label={hero ? L.latestPhoto[lang] : L.noPhotoYet[lang]} data-testid="ir-photo" style={{ width: '100%', aspectRatio: '3 / 4', maxHeight: 210, borderRadius: 8, border: '1px solid rgba(35,33,28,.12)', padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: '#000' }}>
            {hero && <img src={hero.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {photos.slice(1, 4).map((p, i) => (
              <button key={p.id} onClick={() => onZoom(p.url)} aria-label={T.openEarlierPhoto(i + 1, lang)} style={{ width: 44, height: 44, borderRadius: 6, border: '1px solid rgba(35,33,28,.12)', padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: '#000' }}>
                <img src={p.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </button>
            ))}
            {photos.length > 4 && <span style={{ fontSize: 11, color: 'var(--faint)' }}>+{photos.length - 4}</span>}
          </div>
          {heroStamp && <div data-testid="ir-photo-stamp" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{L.latest[lang]} · {photoTakenAtIn(heroStamp, lang)}</div>}
        </div>
      </div>
    </div>
  );
}

/** #633 — a place's counts in words. On a card they read as one quiet line; above the opened place
 *  (`pills`) each is a pill. An open issue is always the warning colour. With no count to show, nothing is
 *  claimed: an empty line could be a read still loading, never proof the place is empty. */
function CountWords({ words, testId, pills = false }: { words: PlaceCountWord[]; testId: string; pills?: boolean }) {
  if (words.length === 0) return null;
  return (
    <div data-testid={testId} style={{ display: 'flex', gap: pills ? 6 : 4, marginTop: pills ? 0 : 8, marginBottom: pills ? 14 : 0, flexWrap: 'wrap', fontSize: pills ? 12 : 11.5, color: 'var(--muted)' }}>
      {words.map((w, i) => (
        <Fragment key={w.key}>
          <span data-count={w.key} style={w.alert ? { ...countPill, ...alertTone } : pills ? countPill : undefined}>
            {w.text}{!pills && !w.alert && i < words.length - 1 ? ' ·' : ''}
          </span>
          {/* #847 — a space between counts keeps copied and read-aloud text apart; the flex gap hides it */}
          {i < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </div>
  );
}
const countPill: CSSProperties = { padding: '2px 8px', borderRadius: 999, background: 'rgba(35,33,28,.06)', fontWeight: 500 };
const alertTone: CSSProperties = { background: '#f7e1df', color: '#8a2a25', fontWeight: 600 };

/** #633 — the inspections with open issues lead, so the first row under "Work and records here" is what needs
 *  doing; the order is otherwise unchanged. */
function issuesFirst(list: PlacedInspection[]): PlacedInspection[] {
  return [...list].sort((a, b) => Number((b.openIssues ?? 0) > 0) - Number((a.openIssues ?? 0) > 0));
}

/** A placed inspection's Site-Map status: open → in review → passed/failed. */
function inspectionStatus(i: PlacedInspection, lang: Lang): { label: string; color: string } {
  const W = placeInspectionStatusLabels;
  if (!i.submitted) return { label: W.open[lang], color: 'var(--muted)' };
  if (!i.decided) return { label: W.inReview[lang], color: 'var(--amber-text)' };
  return i.failedItems > 0 ? { label: W.failed[lang], color: 'var(--red-solid)' } : { label: W.passed[lang], color: 'var(--green-solid)' };
}
const STATUS_TONE: Record<Exclude<SpaceStatus['state'], 'none'>, CSSProperties> = {
  'not-started': { background: 'rgba(35,33,28,.06)', color: 'var(--muted)' },
  'in-progress': { background: '#f6ead2', color: 'var(--amber-text)' },
  blocked: { background: '#f6dcd5', color: '#8a3320' },
  done: { background: '#dcebdf', color: 'var(--green-text)' },
};
const statusChip: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.06em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 5, fontWeight: 600 };

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
