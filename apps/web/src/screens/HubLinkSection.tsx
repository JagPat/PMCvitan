import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { Button, ConfirmDialog } from '@/components';
import { ArrowUpRight } from '@/lib/icons';
import { newIdempotencyKey, type HubProjectChoice } from '@/data/apiGateway';
import { hubFailureText, safeHubUrl, type HubFailure } from '@/lib/hubLink';
import { hubLabels as L, hubText as T } from '@vitan/shared';

/** A link attempt the row may still retry, under its own key: the server replays it if it had already landed. (An
 *  unlink's key lives in the store, `hubUnlinkPending`, so leaving the screen does not lose its Hub cleanup.) */
type LinkAttempt = { hubProjectId: string; key: string };
type Note = { tone: 'ok' | 'err'; text: string; retry: 'link' | 'unlink' | null };
type List = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; projects: HubProjectChoice[] } | { state: 'failed'; failure: HubFailure };

/**
 * #1118 U7a L2 — the active project's Hub project, for an owner or admin of its company: which Hub project this site
 * belongs to, linking it (a picker of the Hub projects PMC's Hub key reaches), and unlinking it. The link itself comes
 * from the project's snapshot, so every screen shows the same answer; this row only asks for changes. Hub keeps the
 * project, plan, drawings and BOQ; PMC keeps a small record that the two are joined.
 */
export function HubLinkSection({ orgId }: { orgId: string }) {
  const lang = useStore((s) => s.lang);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const hubLink = useStore((s) => s.hubLink);
  const unlinkPending = useStore((s) => s.hubUnlinkPending);
  const listHubProjects = useStore((s) => s.listHubProjects);
  const linkHubProject = useStore((s) => s.linkHubProject);
  const unlinkHubProject = useStore((s) => s.unlinkHubProject);

  const [list, setList] = useState<List>({ state: 'idle' });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<'link' | 'unlink' | null>(null);
  const [attempt, setAttempt] = useState<LinkAttempt | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [closed, setClosed] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  // only the newest request of this row may change it: a reply to an older one (another project's, or one this row
  // has since moved past) changes nothing, not even `busy` (Codex 4479979980)
  const command = useRef(0);
  const listing = useRef(0);

  // another project's row starts fresh: its attempts, notes and list are not this one's
  useEffect(() => {
    command.current += 1;
    listing.current += 1;
    setList({ state: 'idle' });
    setPicking(false);
    setBusy(null);
    setAttempt(null);
    setNote(null);
    setClosed(false);
    setConfirmUnlink(false);
  }, [activeProjectId, orgId]);

  const load = async () => {
    const mine = ++listing.current;
    setList({ state: 'loading' });
    const r = await listHubProjects(orgId);
    if (mine !== listing.current || r.kind === 'stale') return;
    if (r.kind === 'ok' || r.kind === 'unconfirmed') setList({ state: 'ready', projects: r.value });
    else {
      if (r.failure.kind === 'closed') setClosed(true);
      setList({ state: 'failed', failure: r.failure });
    }
  };

  const failNote = (failure: HubFailure, retry: 'link' | 'unlink'): Note => {
    if (failure.kind === 'closed') setClosed(true);
    return { tone: 'err', text: hubFailureText(failure, lang), retry: failure.kind === 'retry' ? retry : null };
  };

  const runLink = async (a: LinkAttempt) => {
    const mine = ++command.current;
    setBusy('link');
    setAttempt(a);
    setNote(null);
    const r = await linkHubProject(orgId, a.hubProjectId, a.key);
    if (mine !== command.current) return;
    setBusy(null);
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      setAttempt(null);
      setPicking(false);
      setList({ state: 'idle' });
      setNote({ tone: 'ok', text: L.linked[lang], retry: null });
      return;
    }
    if (r.kind === 'unconfirmed') {
      // it landed, but the screen has not caught up: the same key again replays it and pulls again
      setNote({ tone: 'err', text: L.notShownYet[lang], retry: 'link' });
      return;
    }
    if (r.failure.kind !== 'retry') setAttempt(null);
    setNote(failNote(r.failure, 'link'));
    // the list may have moved under the picker (another site took the Hub project, or Hub archived it)
    if (r.failure.kind === 'refused') void load();
  };

  const unlink = async () => {
    const mine = ++command.current;
    setBusy('unlink');
    setNote(null);
    const r = await unlinkHubProject(orgId);
    if (mine !== command.current) return;
    setBusy(null);
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      // PMC's unlink has landed; Hub's side may not have: the store keeps the key, and the same key retries only it
      setNote(r.value.hubCleared ? { tone: 'ok', text: L.unlinked[lang], retry: null } : { tone: 'err', text: L.hubNotCleared[lang], retry: 'unlink' });
      return;
    }
    if (r.kind === 'unconfirmed') {
      setNote({ tone: 'err', text: L.notShownYet[lang], retry: 'unlink' });
      return;
    }
    setNote(failNote(r.failure, 'unlink'));
  };

  const link = (hubProjectId: string) => {
    const key = attempt?.hubProjectId === hubProjectId ? attempt.key : newIdempotencyKey();
    void runLink({ hubProjectId, key });
  };
  const retry = (what: 'link' | 'unlink') => {
    if (what === 'unlink') void unlink();
    else if (attempt) void runLink(attempt);
  };
  const openPicker = () => {
    setPicking(true);
    setNote(null);
    void load();
  };

  // an unlink not yet settled (this visit's, or one left before leaving the screen) is offered again before any new
  // link: a new link would leave its Hub cleanup behind (Codex 4479979986)
  const shownNote: Note | null = note ?? (unlinkPending && !busy ? { tone: 'err', text: L.hubNotCleared[lang], retry: 'unlink' } : null);
  const canLink = !closed && !unlinkPending;

  const label = hubLink ? T.label(hubLink.number, hubLink.name) : '';
  const hubUrl = safeHubUrl(hubLink?.openUrl);

  return (
    <div style={{ marginTop: 34, paddingTop: 18, borderTop: '1px solid var(--hairline)' }} data-testid="hub-link-section">
      {confirmUnlink && (
        <ConfirmDialog
          title={L.confirmUnlinkTitle[lang]}
          confirmLabel={L.unlink[lang]}
          onConfirm={unlink}
          onCancel={() => setConfirmUnlink(false)}
          testId="confirm-hub-unlink"
          lang={lang}
        >
          {L.confirmUnlinkBody[lang]}
        </ConfirmDialog>
      )}
      <div style={eyebrow}>{L.eyebrow[lang]}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 14px', maxWidth: 560 }}>{L.intro[lang]}</div>

      <div style={row}>
        {hubLink ? (
          <>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }} data-testid="hub-linked-label">{T.linkedTo(label, lang)}</div>
              {hubLink.number && hubLink.name && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{hubLink.name}</div>}
            </div>
            {hubUrl && (
              <a href={hubUrl} target="_blank" rel="noopener noreferrer" data-testid="hub-open" style={{ color: 'var(--accent)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 44 }}>
                {L.openInHub[lang]} <ArrowUpRight size={13} />
              </a>
            )}
            <Button variant="dangerOutline" onClick={() => setConfirmUnlink(true)} disabled={!!busy} data-testid="hub-unlink" style={{ fontSize: 13, padding: '10px 14px' }}>
              {busy === 'unlink' ? L.unlinking[lang] : L.unlink[lang]}
            </Button>
          </>
        ) : (
          <>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14, color: 'var(--muted)' }} data-testid="hub-not-linked">
              {closed ? L.closed[lang] : L.notLinked[lang]}
            </div>
            {canLink && !picking && (
              <Button variant="outline" onClick={openPicker} disabled={!!busy} data-testid="hub-choose" style={{ fontSize: 13, padding: '10px 14px' }}>
                {L.choose[lang]}
              </Button>
            )}
          </>
        )}
      </div>

      {shownNote && (
        <div role="status" data-testid="hub-note" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10, fontSize: 13, color: shownNote.tone === 'ok' ? 'var(--green-solid)' : 'var(--red-solid)' }}>
          <span>{shownNote.text}</span>
          {shownNote.retry && (shownNote.retry === 'unlink' || attempt) && (
            <Button variant="outline" onClick={() => retry(shownNote.retry!)} disabled={!!busy} data-testid="hub-retry" style={{ fontSize: 13, padding: '8px 12px' }}>
              {L.retry[lang]}
            </Button>
          )}
        </div>
      )}

      {picking && !hubLink && canLink && (
        <div style={{ marginTop: 12, padding: 14, background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 13 }} data-testid="hub-picker">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{L.pickerTitle[lang]}</div>
            <Button variant="outline" onClick={() => setPicking(false)} disabled={!!busy} style={{ fontSize: 12.5, padding: '8px 12px' }}>{L.close[lang]}</Button>
          </div>
          {list.state === 'loading' && <div style={muted}>{L.loading[lang]}</div>}
          {list.state === 'failed' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ ...muted, color: 'var(--red-solid)' }} data-testid="hub-list-failed">{hubFailureText(list.failure, lang)}</span>
              {list.failure.kind === 'retry' && (
                <Button variant="outline" onClick={() => void load()} style={{ fontSize: 13, padding: '8px 12px' }}>{L.retry[lang]}</Button>
              )}
            </div>
          )}
          {list.state === 'ready' && list.projects.length === 0 && <div style={muted}>{L.empty[lang]}</div>}
          {list.state === 'ready' && list.projects.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.projects.map((p) => (
                <div key={p.id} style={choice} data-testid={`hub-project-${p.id}`}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{T.choice(p.number, p.name) || p.id}</div>
                  {p.linked === 'other' ? (
                    <span style={chip}>{L.otherSite[lang]}</span>
                  ) : p.linked === 'this' ? (
                    <span style={chip}>{L.thisSite[lang]}</span>
                  ) : (
                    <Button variant="ink" onClick={() => link(p.id)} disabled={!!busy} data-testid={`hub-link-${p.id}`} style={{ fontSize: 13, padding: '9px 14px' }}>
                      {busy === 'link' && attempt?.hubProjectId === p.id ? L.linking[lang] : L.link[lang]}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const eyebrow: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--muted)', marginBottom: 8 };
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: '#fff', border: '1px solid var(--hairline)', borderRadius: 13, padding: '12px 14px' };
const choice: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 12px' };
const chip: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', padding: '4px 9px', borderRadius: 6, border: '1px solid var(--hairline)', color: 'var(--muted)', textTransform: 'uppercase' };
const muted: CSSProperties = { fontSize: 13, color: 'var(--muted)' };
