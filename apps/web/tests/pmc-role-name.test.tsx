import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { forYouRole, type Lang } from '@vitan/shared';
import { ROLE_LABEL } from '@/lib/screens';
import { warmImports } from './warm-imports';

/**
 * #827 (Board decision: rename the PMC role) — the role reads "Project manager (PMC)" wherever the app names
 * it: the persona switcher, the signed-in line, the Team and Portfolio chips, and the For You eyebrow (in
 * Hindi and Gujarati too). "PMC" stays in brackets, so people who know the short name still find it.
 */

await warmImports(() => import('@/store/store'), () => import('@/layout/RolePicker'), () => import('@/screens/InboxScreen'));

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe('the PMC role reads "Project manager (PMC)"', () => {
  it('the shared role label', () => {
    expect(ROLE_LABEL.pmc).toBe('Project manager (PMC)');
  });

  it('the For You eyebrow word, in every language', () => {
    expect(forYouRole.pmc).toEqual({ en: 'Project manager (PMC)', hi: 'प्रोजेक्ट मैनेजर (PMC)', gu: 'પ્રોજેક્ટ મેનેજર (PMC)' });
  });

  it('the persona switcher offers it by its full name', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const { RolePicker } = await import('@/layout/RolePicker');
    render(<RolePicker />);
    expect(screen.getByRole('button', { name: 'Project manager (PMC)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'PMC' })).toBeNull();
  });

  const eyebrow: Record<Lang, string> = {
    en: 'FOR YOU · PROJECT MANAGER (PMC)',
    hi: 'प्रोजेक्ट मैनेजर (PMC)',
    gu: 'પ્રોજેક્ટ મેનેજર (PMC)',
  };
  for (const lang of ['en', 'hi', 'gu'] as const) {
    it(`the For You eyebrow, ${lang}`, async () => {
      const { useStore, getInitialState } = await import('@/store/store');
      useStore.setState(getInitialState());
      useStore.setState({ role: 'pmc', lang, screen: 'inbox', projectLoadState: 'ready' });
      const { InboxScreen } = await import('@/screens/InboxScreen');
      const view = render(<InboxScreen />);
      expect(view.container.textContent).toContain(eyebrow[lang]);
    });
  }

  it('other roles keep their names', () => {
    expect(ROLE_LABEL.client).toBe('Client');
    expect(forYouRole.client.hi).toBe('क्लाइंट');
  });
});
