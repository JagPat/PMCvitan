import { useEffect, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, drawingMutationsBlocked } from '@/store/store';
import { selectDraftDecisions, selectDraftDrawings } from '@/store/selectors';
import { resolveDrawingUrl, drawingsReadMode } from '@/data/apiGateway';
import { Eyebrow, Button, Swatch } from '@/components';
import { Lock, ArrowUpRight, FileEdit, FileText, WifiOff, RefreshCw } from '@/lib/icons';
import { SW, type SwatchKey } from '@vitan/shared';
import styles from './responsive.module.css';

/**
 * Drafts — a private staging area, unified across entity types (decisions + drawings). A thing
 * you save as a draft lands here and is visible ONLY to you (never on the shared surfaces or the
 * counts) while you keep working on it. When it's ready, Publish issues it and the app starts
 * acting on it. "Hold your data, then publish": nothing is shared until you say so. (Server-
 * enforced — the snapshot delivers a draft only to its author.)
 */
export function DraftsScreen() {
  const decisions = useStore(useShallow(selectDraftDecisions));
  const drawings = useStore(useShallow(selectDraftDrawings));
  const publishDecision = useStore((s) => s.publishDecision);
  // Phase 6 task 4b (§A.1/§A.2 round 8) — the draft-edit affordance: re-point WHO decides, or
  // convert to/from a record, while the draft is still private (publication freezes the holder).
  const updateDecisionDraft = useStore((s) => s.updateDecisionDraft);
  const members = useStore(useShallow((s) => s.members));
  const loadTeam = useStore((s) => s.loadTeam);
  useEffect(() => {
    if (decisions.length && !members.length) void loadTeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisions.length]);
  const memberCandidates = members.filter((m) => m.status === 'active' && m.membershipId);
  // Phase 6 task 4b (round-1 Codex F6) — converting a RECORD back to a choice must carry its
  // 2-4 options (incl. the lead swatch) in the SAME edit: the server's option floor and swatch
  // CHECK refuse a bare kind change. Selecting a deciding kind on a record opens this inline
  // form; Confirm submits kind + options together through the one drafting door.
  const [convertForms, setConvertForms] = useState<Record<string, {
    kind: 'client' | 'pmc' | 'member';
    membershipId?: string;
    options: Array<{ material: string; swatch: SwatchKey; delta: string }>;
  }>>({});
  const blankConvertOption = (): { material: string; swatch: SwatchKey; delta: string } => ({ material: '', swatch: 'tile', delta: '0' });
  // round-5 Codex F4 + round-6 Codex F1 — ANY draft edit in flight HOLDS the draft's Publish
  // (and Publish-all): a publish that raced a dispatched-but-unconfirmed edit would win the
  // server lock and permanently publish the OLD kind/holder, then fail the edit with a 409
  // against the user's visible selection. The conversion form additionally stays OPEN until
  // the server accepts it.
  const [draftPending, setDraftPending] = useState<Record<string, boolean>>({});
  // round-6 Codex F1 — the ONE dispatch door for every draft edit on this screen: marks the
  // draft pending, awaits the server's settle, releases.
  const dispatchDraftUpdate = async (id: string, input: Parameters<typeof updateDecisionDraft>[1]): Promise<boolean> => {
    setDraftPending((p) => ({ ...p, [id]: true }));
    const ok = await updateDecisionDraft(id, input);
    setDraftPending((p) => { const { [id]: _x, ...rest } = p; return rest; });
    return ok;
  };
  // round-6 Codex F5 — the ONE per-draft readiness rule, shared by the per-row Publish and
  // Publish-all (a batch that would 409 mid-way publishes a partial set from an action
  // labelled as publishing everything).
  const decisionReady = (d: { deciderKind?: string; deciderMembershipId?: string | null; options: unknown[] }): boolean =>
    d.deciderKind === 'none' ? true : d.options.length >= 2 && (d.deciderKind !== 'member' || !!d.deciderMembershipId);
  const publishDrawing = useStore((s) => s.publishDrawing);
  const publishAllDrafts = useStore((s) => s.publishAllDrafts);
  const total = decisions.length + drawings.length;
  const empty = total === 0;
  // Task 10 correction (C3) — under module read-ownership the draft DRAWINGS come from the module-owned
  // register; never publish from it while its read hasn't settled. Expose an honest loading/stale state
  // and disable publishing (both per-drawing and Publish-all when drawings are in the batch) — the SAME
  // shared predicate the store defensively enforces. In snapshot mode this is always false.
  const drawingsBlocked = useStore(drawingMutationsBlocked);
  const drawingsLoad = useStore((s) => s.drawingsLoad);
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const moduleOwned = drawingsReadMode() === 'moduleQuery';
  const drawingsReading = moduleOwned && (drawingsLoad === 'idle' || drawingsLoad === 'loading');
  const drawingsUnavailable = moduleOwned && drawingsLoad === 'error';

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <Eyebrow>DRAFTS · PRIVATE TO YOU</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em', marginTop: 4 }}>Drafts</div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
          <Lock size={13} /> Work in progress, visible only to you. Keep feeding data — nothing reaches the client or the team until you <b>Publish</b>.
        </div>
        {total >= 2 && (() => {
          // round-5 Codex F4 + round-6 Codex F1/F5 — Publish-all is the same publish door:
          // held while ANY draft edit is in flight, and while any decision draft is not ready
          // (a batch that would 409 mid-way publishes a partial set).
          const allBlocked = (drawings.length > 0 && drawingsBlocked)
            || Object.values(draftPending).some(Boolean)
            || decisions.some((d) => !decisionReady(d));
          return (
            <Button variant="ink" onClick={publishAllDrafts} disabled={allBlocked} data-testid="publish-all" style={{ marginLeft: 'auto', flex: 'none', padding: '9px 14px', fontSize: 13, cursor: allBlocked ? 'not-allowed' : 'pointer', opacity: allBlocked ? 0.6 : 1 }}>
              Publish all {total} <ArrowUpRight size={15} />
            </Button>
          );
        })()}
      </div>

      {empty ? (
        <div style={{ marginTop: 34, textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '34px 16px', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
          <FileEdit size={26} color="#b8b2a6" />
          <div style={{ marginTop: 10, fontWeight: 600, color: 'var(--ink)' }}>No drafts yet</div>
          <div style={{ marginTop: 4 }}>When you save a decision or a drawing as a draft instead of issuing it, it waits here — private — until you publish it.</div>
        </div>
      ) : (
        <>
          {decisions.length > 0 && (
            <Group label="Decisions">
              {decisions.map((d) => {
                // Phase 6 task 4b (§A.2) — readiness follows the KIND: a record (`none`) carries
                // exactly zero options and is always publishable; every deciding kind keeps the
                // 2-option floor (enforced server-side at publication, both doors).
                const record = d.deciderKind === 'none';
                const ready = decisionReady(d);
                return (
                  <div key={d.id} data-testid={`draft-${d.id}`} style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <span style={mono}>{d.id}</span>
                      <span style={{ fontWeight: 700, fontSize: 15.5 }}>{d.title}</span>
                      <span style={draftChip}>{record ? 'DRAFT · RECORD' : 'DRAFT'}</span>
                      <span style={placeCap}>{d.room}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em', color: 'var(--muted)' }}>WHO DECIDES</span>
                      <select
                        value={convertForms[d.id]?.kind ?? d.deciderKind}
                        onChange={(e) => {
                          const kind = e.target.value as 'client' | 'pmc' | 'member' | 'none';
                          // a RECORD converting back to a choice needs its 2-4 options in the
                          // SAME edit (round-1 Codex F6) — open the inline form, submit on Confirm
                          if (record && kind !== 'none') {
                            setConvertForms((f) => ({
                              ...f,
                              [d.id]: { kind, membershipId: kind === 'member' ? memberCandidates[0]?.membershipId : undefined, options: [blankConvertOption(), blankConvertOption()] },
                            }));
                            return;
                          }
                          if (record && kind === 'none') {
                            setConvertForms((f) => { const { [d.id]: _drop, ...rest } = f; return rest; });
                            return;
                          }
                          // round-6 Codex F1 — the direct branches ride the SAME pending
                          // hold as the conversion Confirm: Publish is held until the edit lands
                          if (kind === 'member') return void dispatchDraftUpdate(d.id, { deciderKind: 'member', deciderMembershipId: memberCandidates[0]?.membershipId });
                          // converting to a record must drop the options in the SAME edit (the
                          // server refuses an optioned record); other kinds keep them.
                          void dispatchDraftUpdate(d.id, kind === 'none' ? { deciderKind: 'none', options: [] } : { deciderKind: kind });
                        }}
                        disabled={!!draftPending[d.id]}
                        data-testid={`draft-decider-${d.id}`}
                        style={{ height: 32, padding: '0 8px', borderRadius: 8, border: '1px solid var(--hairline)', fontSize: 12 }}
                        aria-label="Who decides"
                      >
                        <option value="client">The client</option>
                        <option value="pmc">The practice (PMC)</option>
                        <option value="member" disabled={!memberCandidates.length}>A named member</option>
                        <option value="none">Nobody — record only</option>
                      </select>
                      {d.deciderKind === 'member' && (
                        <select
                          value={d.deciderMembershipId ?? ''}
                          onChange={(e) => void dispatchDraftUpdate(d.id, { deciderKind: 'member', deciderMembershipId: e.target.value })}
                          disabled={!!draftPending[d.id]}
                          data-testid={`draft-decider-member-${d.id}`}
                          style={{ height: 32, padding: '0 8px', borderRadius: 8, border: '1px solid var(--hairline)', fontSize: 12 }}
                          aria-label="Named decider"
                        >
                          {memberCandidates.map((m) => (
                            <option key={m.membershipId} value={m.membershipId}>{m.name} · {m.role}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    {record && convertForms[d.id] && (
                      <div data-testid={`convert-form-${d.id}`} style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'rgba(35,33,28,.03)' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em', color: 'var(--muted)', marginBottom: 8 }}>
                          BACK TO A CHOICE — GIVE IT 2–4 OPTIONS (the first is recommended)
                        </div>
                        {/* round-5 Codex F3 — converting to a NAMED member: the picker renders from
                            the FORM's kind (the persisted row is still a record) and binds the
                            form's membershipId, so Confirm assigns the CHOSEN member, never
                            silently the first candidate. */}
                        {convertForms[d.id]!.kind === 'member' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em', color: 'var(--muted)' }}>NAMED DECIDER</span>
                            <select
                              value={convertForms[d.id]!.membershipId ?? ''}
                              onChange={(e) => setConvertForms((f) => ({ ...f, [d.id]: { ...f[d.id]!, membershipId: e.target.value } }))}
                              data-testid={`convert-member-${d.id}`}
                              aria-label="Named decider for the conversion"
                              style={{ height: 32, padding: '0 8px', borderRadius: 8, border: '1px solid var(--hairline)', fontSize: 12 }}
                            >
                              {memberCandidates.map((m) => (
                                <option key={m.membershipId} value={m.membershipId}>{m.name} · {m.role}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        {convertForms[d.id]!.options.map((o, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                            <input
                              value={o.material}
                              onChange={(e) => setConvertForms((f) => {
                                const form = f[d.id]!;
                                const options = form.options.map((x, j) => (j === i ? { ...x, material: e.target.value } : x));
                                return { ...f, [d.id]: { ...form, options } };
                              })}
                              placeholder={`Option ${String.fromCharCode(65 + i)} material`}
                              data-testid={`convert-material-${d.id}-${i}`}
                              aria-label={`Option ${i + 1} material`}
                              style={{ flex: 1, height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--hairline)', fontSize: 12.5 }}
                            />
                            <select
                              value={o.swatch}
                              onChange={(e) => setConvertForms((f) => {
                                const form = f[d.id]!;
                                const options = form.options.map((x, j) => (j === i ? { ...x, swatch: e.target.value as SwatchKey } : x));
                                return { ...f, [d.id]: { ...form, options } };
                              })}
                              data-testid={`convert-swatch-${d.id}-${i}`}
                              aria-label={`Option ${i + 1} swatch`}
                              style={{ height: 32, padding: '0 8px', borderRadius: 8, border: '1px solid var(--hairline)', fontSize: 12 }}
                            >
                              {(Object.keys(SW) as SwatchKey[]).map((k) => <option key={k} value={k}>{k}</option>)}
                            </select>
                            {i === 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 700, color: 'var(--accent)' }}>REC</span>}
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          {convertForms[d.id]!.options.length < 4 && (
                            <Button variant="outline" data-testid={`convert-add-${d.id}`} onClick={() => setConvertForms((f) => ({ ...f, [d.id]: { ...f[d.id]!, options: [...f[d.id]!.options, blankConvertOption()] } }))} style={{ padding: '6px 12px', fontSize: 11.5 }}>
                            Add option
                          </Button>
                          )}
                          <Button
                            variant="ink"
                            data-testid={`convert-confirm-${d.id}`}
                            disabled={draftPending[d.id] || !convertForms[d.id]!.options.every((o) => o.material.trim()) || (convertForms[d.id]!.kind === 'member' && !convertForms[d.id]!.membershipId)}
                            onClick={async () => {
                              const form = convertForms[d.id]!;
                              if (!form.options.every((o) => o.material.trim()) || draftPending[d.id]) return;
                              // round-5 Codex F4 — hold Publish and keep the form until the server
                              // ACCEPTS the conversion; a failed PATCH leaves the form (and the
                              // record) exactly as the user last saw them.
                              const ok = await dispatchDraftUpdate(d.id, {
                                deciderKind: form.kind,
                                ...(form.kind === 'member' ? { deciderMembershipId: form.membershipId } : {}),
                                options: form.options.map((o, i) => ({ material: o.material.trim(), delta: Number(o.delta) || 0, swatch: o.swatch, recommended: i === 0 })),
                              });
                              if (ok) setConvertForms((f) => { const { [d.id]: _drop, ...rest } = f; return rest; });
                            }}
                            style={{ padding: '6px 12px', fontSize: 11.5, marginLeft: 'auto' }}
                          >
                            Convert to a choice
                          </Button>
                          <Button variant="outline" data-testid={`convert-cancel-${d.id}`} disabled={!!draftPending[d.id]} onClick={() => setConvertForms((f) => { const { [d.id]: _drop, ...rest } = f; return rest; })} style={{ padding: '6px 12px', fontSize: 11.5 }}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                      {d.options.map((o) => (
                        <div key={o.key} style={optionPill}>
                          <Swatch swatch={o.swatch as SwatchKey} size={22} radius={5} />
                          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{o.material}</span>
                          {o.recommended && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 700, color: 'var(--accent)' }}>REC</span>}
                        </div>
                      ))}
                    </div>
                    {/* round-5 Codex F4 — a confirmed conversion in flight HOLDS this draft's publication */}
                    <Foot
                      ready={ready && !draftPending[d.id]}
                      readyLabel={record ? 'Ready to publish — filed for the team, no approval required' : 'Ready to publish'}
                      notReadyLabel={
                        draftPending[d.id]
                          ? 'Saving the draft — publishing is held until the edit lands'
                          : d.deciderKind === 'member' && !d.deciderMembershipId
                            ? 'Choose the named decider before publishing'
                            : `Add at least ${2 - d.options.length} more option before publishing`
                      }
                      cta={record ? 'Publish record' : d.deciderKind === 'client' ? 'Publish to client' : 'Publish to decider'}
                      testid={`publish-${d.id}`}
                      onPublish={() => publishDecision(d.id)}
                    />
                  </div>
                );
              })}
            </Group>
          )}

          {(drawings.length > 0 || drawingsReading || drawingsUnavailable) && (
            <Group label="Drawings">
              {/* Task 10 correction (C3) — honest register state: never let the user publish drawing drafts
                  read off an unsettled module read. While it loads, say so; on failure show a stale/Retry
                  banner and pause publishing (the per-draft buttons + Publish-all are disabled). */}
              {drawingsReading && (
                <div data-testid="drafts-drawings-loading" style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 12px', border: '1px dashed var(--hairline)', borderRadius: 11 }}>
                  Loading the drawing register…
                </div>
              )}
              {drawingsUnavailable && (
                <div data-testid="drafts-drawings-stale" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px' }}>
                  <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>
                    The drawing register couldn’t load — showing the last-known drafts. Publishing is paused until it refreshes.
                  </span>
                  <button onClick={() => requestFreshSnapshot()} data-testid="drafts-drawings-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <RefreshCw size={12} /> Retry
                  </button>
                </div>
              )}
              {drawings.map((d) => {
                const cur = d.current;
                const ready = Boolean(cur);
                return (
                  <div key={d.id} data-testid={`draft-${d.id}`} style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <div style={{ width: 40, height: 52, flex: 'none', borderRadius: 6, border: '1px solid var(--hairline)', background: cur ? `center/cover no-repeat url("${resolveDrawingUrl(cur.url)}"), var(--panel)` : 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {!cur && <FileText size={16} color="#b8b2a6" />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12.5 }}>{d.number}</span>
                          {cur && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'var(--accent)' }}>Rev {cur.rev}</span>}
                          <span style={draftChip}>DRAFT</span>
                          <span style={{ ...placeCap, marginLeft: 0 }}>{d.discipline}</span>
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 14, marginTop: 3 }}>{d.title}</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <Foot
                        ready={ready && !drawingsBlocked}
                        readyLabel="Ready to issue"
                        notReadyLabel={drawingsBlocked ? 'Register still loading — publishing paused' : 'Attach a file before issuing'}
                        cta="Publish to team"
                        testid={`publish-${d.id}`}
                        onPublish={() => publishDrawing(d.id)}
                      />
                    </div>
                  </div>
                );
              })}
            </Group>
          )}
        </>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.14em', color: 'var(--faint)', margin: '4px 0 10px' }}>{label.toUpperCase()}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
}

function Foot({ ready, readyLabel, notReadyLabel, cta, testid, onPublish }: { ready: boolean; readyLabel: string; notReadyLabel: string; cta: string; testid: string; onPublish: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 11.5, color: ready ? 'var(--green-text)' : 'var(--amber-text)' }}>{ready ? readyLabel : notReadyLabel}</span>
      <Button variant="accent" disabled={!ready} onClick={onPublish} data-testid={testid} style={{ marginLeft: 'auto', padding: '9px 14px', fontSize: 13, opacity: ready ? 1 : 0.5 }}>
        {cta} <ArrowUpRight size={15} />
      </Button>
    </div>
  );
}

const card: CSSProperties = {
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 13,
  padding: 15,
};

const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' };
const placeCap: CSSProperties = { fontSize: 11.5, color: 'var(--faint)', marginLeft: 'auto' };

const draftChip: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: '.08em',
  padding: '2px 7px',
  borderRadius: 5,
  color: 'var(--muted)',
  background: 'var(--panel)',
  border: '1px solid var(--hairline)',
};

const optionPill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  background: 'var(--panel)',
  border: '1px solid var(--hairline)',
  borderRadius: 9,
  padding: '5px 9px',
};
