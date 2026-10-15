import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { actionItemText, type ActionItemFacts, type Lang, type Role } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #827 (Top 10 #5, "Also waiting" cards) — the For You cards in Hindi and Gujarati: each card's title, detail and
 * button, built from the card's facts, and the For You screen's own words. Names, titles and reasons a card quotes
 * are shown as written. English stays byte-identical.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

// every card key the builder can emit, read from its source so a new card without a translation fails here
const SOURCE = readFileSync('src/store/selectors.ts', 'utf8');
const KEYS = [...new Set([...SOURCE.matchAll(/key: '([a-z-]+)'/g), ...SOURCE.matchAll(/\? '([a-z-]+)' : '([a-z-]+)'/g)].flatMap((m) => m.slice(1)))]
  .filter((k) => /-(pending|reapprove)$|^(arch|pmc|eng|con|cons|material|labour|commercial)-/.test(k));

// sample facts per key; data (names, titles, reasons) is Latin on purpose, and allowed below
const SAMPLE: Record<string, ActionItemFacts> = {
  'eng-checklist': { title: 'Slab casting', items: 4, zone: 'Ground floor' },
  'eng-log': { checkedIn: true },
  'pmc-pending': { n: 2, who: 'decider' },
  'pmc-reinspections': { n: 2, names: 'Slab casting', issues: 3, due: '2026-10-14' },
  'pmc-override-expiry': { expiresAt: '2026-10-14T06:00:00Z', activity: 'Slab casting', expiring: 2 },
  'material-shortage': { n: 3, blocked: 1, atRisk: 2 },
  'labour-shortage': { n: 1, blocked: 1 },
  'commercial-over-budget': { n: 1, head: 'Civil works', over: '₹40,000' },
  'cons-review': { n: 2, bucket: 'structural' },
};
const DATA = ['Slab casting', 'Ground floor', 'Civil works', 'Kitchen Counter', 'MEP', 'PMC'];

describe('every For You card speaks Hindi and Gujarati', () => {
  it('the builder emits the keys this test covers', () => {
    expect(KEYS.length).toBeGreaterThan(20);
  });

  for (const lang of ['hi', 'gu'] as const) {
    for (const key of KEYS) {
      it(`${lang}, ${key}`, () => {
        const item = { key, title: 'English title', detail: 'Kitchen Counter', cta: 'English button', facts: SAMPLE[key] ?? { n: 2 } };
        const words = actionItemText(item, lang);
        expect(words.title).not.toBe(item.title);
        expect(words.cta).not.toBe(item.cta);
        const host = document.createElement('div');
        host.textContent = [words.title, words.detail ?? '', words.cta].join(' | ');
        expect(leftoverEnglish(host, DATA)).toEqual([]);
      });
    }
  }

  it('one thing reads in the singular', () => {
    expect(actionItemText({ key: 'pmc-reviews', title: 'x', cta: 'y', facts: { n: 1 } }, 'hi').title).toBe('1 निरीक्षण आपकी जाँच की राह देख रहा है');
    expect(actionItemText({ key: 'pmc-reviews', title: 'x', cta: 'y', facts: { n: 2 } }, 'hi').title).toBe('2 निरीक्षण आपकी जाँच की राह देख रहे हैं');
    expect(actionItemText({ key: 'labour-shortage', title: 'x', cta: 'y', facts: { n: 1, blocked: 1 } }, 'gu').title).toBe('1 મજૂરોની અછત (1 અટક્યું)');
  });

  it('a card whose key or facts this release does not know stays as built', () => {
    const unknown = { key: 'something-new', title: 'Something new', cta: 'Open', facts: { n: 1 } };
    expect(actionItemText(unknown, 'hi')).toEqual({ title: 'Something new', detail: undefined, cta: 'Open' });
    const bare = { key: 'pmc-reviews', title: '1 inspection awaiting your review', cta: 'Review' };
    expect(actionItemText(bare, 'gu').title).toBe(bare.title);
  });

  it('English is the built text, unchanged', () => {
    const item = { key: 'pmc-reviews', title: '2 inspections awaiting your review', detail: 'INSP-1, INSP-2', cta: 'Review', facts: { n: 2 } };
    expect(actionItemText(item, 'en')).toEqual({ title: item.title, detail: item.detail, cta: item.cta });
  });
});

async function forYou(role: Role, lang: Lang) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ role, lang, screen: 'inbox', projectLoadState: 'ready' });
  const { selectActionItems } = await import('@/store/selectors');
  const { InboxScreen } = await import('@/screens/InboxScreen');
  const view = render(<InboxScreen />);
  const s = useStore.getState();
  // the data the cards quote: record names, the project's name
  const data = [
    s.short,
    ...s.decisions.map((d) => d.title),
    ...s.drawings.flatMap((d) => [d.number, d.title]),
    ...s.activities.map((a) => a.name),
    ...s.reviews.map((r) => (r as { title?: string; name?: string }).title ?? (r as { name?: string }).name ?? ''),
    ...(s.checklist ? [s.checklist.title, s.checklist.zone] : []),
    'PMC',
  ];
  return { view, items: selectActionItems(s), data };
}

describe('the For You screen in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    for (const role of ['engineer', 'contractor', 'client', 'architect', 'consultant', 'pmc'] as const) {
      it(`${lang}, ${role}: the cards and the screen's own words`, async () => {
        const { view, items, data } = await forYou(role, lang);
        for (const it of items) expect(it.facts, it.key).toBeDefined();
        expect(leftoverEnglish(view.container, data)).toEqual([]);
      });
    }
  }

  it('English shows the built cards and the same words as before', async () => {
    const { view, items } = await forYou('contractor', 'en');
    const text = view.container.textContent ?? '';
    for (const it of items) {
      expect(text).toContain(it.title);
      expect(text).toContain(it.cta);
    }
    expect(text).toContain('FOR YOU · CONTRACTOR');
  });
});

describe('the PMC re-inspection card names its open issues in every language', () => {
  const item = (issues: number) => ({ key: 'pmc-reinspections', title: 'English title', detail: 'x', cta: 'Follow up', facts: { n: 2, names: 'Slab casting', issues } });
  it('Hindi and Gujarati carry the same number as the English card', () => {
    expect(actionItemText(item(3), 'hi').detail).toBe('Slab casting · 3 खुली समस्याएँ');
    expect(actionItemText(item(1), 'hi').detail).toBe('Slab casting · 1 खुली समस्या');
    expect(actionItemText(item(3), 'gu').detail).toBe('Slab casting · 3 ખુલ્લી સમસ્યાઓ');
    expect(actionItemText(item(1), 'gu').detail).toBe('Slab casting · 1 ખુલ્લી સમસ્યા');
  });
});
