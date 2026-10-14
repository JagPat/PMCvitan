import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { noticeText, type AppNotification, type Lang, type NoticeFacts } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #827 (Jagrut, 13 Oct: "Client ने मंज़ूरी दी" left the role in English) — the bell says role names in Hindi and
 * Gujarati: Client, PMC, Architect, Engineer, Contractor. It reads them from the facts the server serves beside
 * an approval or forward notice (#839), never out of the text, so a person's name, a title or a material is
 * shown exactly as written, even one that looks like a role or contains "approved" (#840).
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

const approval = (over: Partial<Extract<NoticeFacts, { kind: 'approval' }>> = {}): NoticeFacts => ({
  kind: 'approval', byClient: true, actorName: 'Mr. Shah', actorRole: 'client', title: 'Porch Tiles', material: 'Kota stone', onBehalfOf: null, ending: null, ...over,
});

describe('role names in approval and forward notices', () => {
  const DATA = ['Porch Tiles', 'Kota stone', 'Mr. Shah', 'Priya', 'Arch One', 'PMC'];
  const cases: Array<[string, string, NoticeFacts]> = [
    ['client approval', 'Client approved Porch Tiles — Kota stone', approval()],
    ['on behalf of the client', 'Priya (PMC) approved Porch Tiles on behalf of the client — Kota stone', approval({ byClient: false, actorName: 'Priya', actorRole: 'pmc', onBehalfOf: 'client' })],
    ['on behalf of the named decider', 'Priya (PMC) approved Porch Tiles on behalf of the named decider — Kota stone', approval({ byClient: false, actorName: 'Priya', actorRole: 'pmc', onBehalfOf: 'member' })],
    ['awaiting the countersign', "Client approved Porch Tiles — Kota stone — awaiting the architect's countersign", approval({ ending: { kind: 'provisional' } })],
    ['countersigned', 'Client approved Porch Tiles — Kota stone — countersigned by Arch One', approval({ ending: { kind: 'countersigned', by: 'Arch One' } })],
    ['finalized', 'Priya (PMC) approved Porch Tiles on behalf of the client — Kota stone — finalized by Priya with no active architect', approval({ byClient: false, actorName: 'Priya', actorRole: 'pmc', onBehalfOf: 'client', ending: { kind: 'finalized', by: 'Priya' } })],
    ['forward to the PMC', 'Decision forwarded: Porch Tiles → the PMC', { kind: 'forward', title: 'Porch Tiles', to: 'the PMC', toRole: 'pmc' }],
    ['forward to the client', 'Decision forwarded: Porch Tiles → the client', { kind: 'forward', title: 'Porch Tiles', to: 'the client', toRole: 'client' }],
  ];
  for (const lang of ['hi', 'gu'] as const) {
    for (const [name, text, facts] of cases) {
      it(`${lang}, ${name}: no English left but the names, title and material`, () => {
        const host = document.createElement('div');
        host.textContent = noticeText(text, lang, { decision: true, facts });
        expect(leftoverEnglish(host, DATA)).toEqual([]);
        for (const d of ['Porch Tiles']) expect(host.textContent).toContain(d);
      });
    }
  }

  it('the client role, in each language', () => {
    expect(noticeText('Client approved Porch Tiles — Kota stone', 'hi', { facts: approval() })).toBe('क्लाइंट ने मंज़ूरी दी: Porch Tiles — Kota stone');
    expect(noticeText('Client approved Porch Tiles — Kota stone', 'gu', { facts: approval() })).toBe('ક્લાયન્ટ એ મંજૂરી આપી: Porch Tiles — Kota stone');
  });

  it('English is the text, unchanged, facts or not', () => {
    for (const [, text, facts] of cases) expect(noticeText(text, 'en', { decision: true, facts })).toBe(text);
  });

  it('a material that imitates an ending is shown whole, with no ending invented', () => {
    const facts = approval({ material: 'Oak — countersigned by Supplier' });
    expect(noticeText('Client approved Porch Tiles — Oak — countersigned by Supplier', 'hi', { decision: true, facts }))
      .toBe('क्लाइंट ने मंज़ूरी दी: Porch Tiles — Oak — countersigned by Supplier');
  });

  it('an approver whose name contains "approved" is named whole (#840)', () => {
    const facts = approval({ byClient: false, actorName: 'Ann approved Bob', actorRole: 'engineer' });
    expect(noticeText('Ann approved Bob approved Porch Tiles — Kota stone', 'gu', { decision: true, facts }))
      .toBe('Ann approved Bob એ મંજૂરી આપી: Porch Tiles — Kota stone');
  });

  it('a role this release does not know shows the text as written, never a guess', () => {
    const facts = approval({ byClient: false, actorName: 'Priya', actorRole: 'surveyor', onBehalfOf: 'client' });
    const text = 'Priya (surveyor) approved Porch Tiles on behalf of the client — Kota stone';
    expect(noticeText(text, 'hi', { decision: true, facts })).toBe(text);
  });

  it('the PMC in the site-visit and sign-off notices', () => {
    expect(noticeText('Site visit closed by the PMC: Ravi', 'hi')).toBe('प्रोजेक्ट मैनेजर (PMC) ने साइट विज़िट बंद की: Ravi');
    expect(noticeText('Site visit closed by the PMC: Ravi', 'gu')).toBe('પ્રોજેક્ટ મેનેજર (PMC) એ સાઇટ મુલાકાત બંધ કરી: Ravi');
    expect(noticeText("Sign-off requested: Roof — awaiting the PMC's closing inspection", 'hi', { inspection: true }))
      .toBe('काम पूरा होने की पुष्टि माँगी गई: Roof — प्रोजेक्ट मैनेजर (PMC) के अंतिम निरीक्षण की राह');
  });
});

async function bell(lang: Lang, notifications: AppNotification[]) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ notifOpen: true, notifications, role: 'pmc', screen: 'inbox', lang, projectLoadState: 'ready' });
  const { NotificationPanel } = await import('@/layout/NotificationPanel');
  return { useStore, view: render(<NotificationPanel />) };
}

describe('the bell uses the served facts', () => {
  it('a served approval reads with the role translated', async () => {
    const { view } = await bell('hi', [{ id: 'n1', text: 'Client approved Porch Tiles — Kota stone', time: 'just now', color: '#3F7A54', decisionId: 'DL-1', facts: approval() }]);
    expect(view.container.textContent).toContain('क्लाइंट ने मंज़ूरी दी: Porch Tiles — Kota stone');
  });

  it('the demo: the seeded approval and a fresh one read with the role translated', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState({ ...getInitialState(), lang: 'gu' });
    const d = useStore.getState().decisions.find((x) => x.status === 'pending')!;
    useStore.setState({ modal: { type: 'approve', decId: d.id, optIdx: 0 } } as never);
    useStore.getState().confirmApprove();
    const { view } = await bell('gu', useStore.getState().notifications);
    const lines = [...view.container.querySelectorAll('[data-testid="notif-item"]')].map((e) => e.textContent ?? '');
    expect(lines.filter((l) => l.includes('ક્લાયન્ટ એ મંજૂરી આપી')).length).toBe(2);
    expect(view.container.textContent).not.toContain('Client');
  });
});
