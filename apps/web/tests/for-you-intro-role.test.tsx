import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { forYouIntro, forYouNothingDetail, type Lang, type Role } from '@vitan/shared';

/**
 * #482 live QA item 6 — the For You subtitle depends on the role. A contractor's and a consultant's For You holds
 * only decisions and drawings, so neither the intro nor the empty-list line mentions inspections or the site log,
 * in any language. The architect (and the PMC when the list shows) keep the full wording.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

const INSPECTION_OR_LOG = {
  en: /inspection|site log/i,
  hi: /निरीक्षण|साइट लॉग/,
  gu: /નિરીક્ષણ|સાઇટ લોગ/,
} satisfies Record<Lang, RegExp>;

async function inbox(role: Role, lang: Lang, empty: boolean) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ role, lang, screen: 'inbox', projectLoadState: 'ready' });
  if (empty) useStore.setState({ decisions: [], drawings: [], activities: [], reviews: [], openChecklists: [] });
  const { InboxScreen } = await import('@/screens/InboxScreen');
  return render(<InboxScreen />).container.textContent ?? '';
}

describe('the For You subtitle names only what the role can find there', () => {
  for (const role of ['contractor', 'consultant'] as const) {
    for (const lang of ['en', 'hi', 'gu'] as const) {
      it(`${role}, ${lang}: no inspections or site log, on the list and on the empty screen`, async () => {
        const intro = forYouIntro(lang, role);
        expect(`${intro.before}${intro.after}`).not.toMatch(INSPECTION_OR_LOG[lang]);
        expect(forYouNothingDetail(lang, role)).not.toMatch(INSPECTION_OR_LOG[lang]);
        expect(await inbox(role, lang, false)).not.toMatch(INSPECTION_OR_LOG[lang]);
        expect(await inbox(role, lang, true)).not.toMatch(INSPECTION_OR_LOG[lang]);
      });
    }
  }

  it('the contractor reads decisions and drawings in plain words', async () => {
    const text = await inbox('contractor', 'en', true);
    expect(text).toContain('Decisions and drawings waiting on you in ');
    expect(text).toContain('When a decision or drawing is waiting on you, it’ll show up here.');
  });

  it('the architect keeps the full wording', async () => {
    const text = await inbox('architect', 'en', true);
    expect(text).toContain('— decisions, drawings, inspections and the site log —');
    expect(text).toContain('When a decision, drawing or inspection is waiting on you, it’ll show up here.');
    expect(forYouIntro('en')).toEqual(forYouIntro('en', 'pmc'));
  });
});
