import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #827 (Top 10 #5) — Hindi and Gujarati text is drawn as those scripts need:
 * 1. the page's `<html lang>` follows the chosen language (DocumentLang);
 * 2. under `:lang(hi)` / `:lang(gu)`, global.css switches off the capitals and wide letter spacing
 *    that pull joined letters apart (the "Gujarati spacing bug");
 * 3. the Hindi typo "आपक के लिए" from the 7 Oct review stays gone.
 */

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('the page language follows the chosen language', () => {
  it('sets <html lang> on mount and on every change', async () => {
    const { useStore } = await import('@/store/store');
    const { DocumentLang } = await import('@/layout/DocumentLang');
    act(() => useStore.getState().setLang('gu'));
    render(<DocumentLang />);
    expect(document.documentElement.lang).toBe('gu');
    act(() => useStore.getState().setLang('hi'));
    expect(document.documentElement.lang).toBe('hi');
    act(() => useStore.getState().setLang('en'));
    expect(document.documentElement.lang).toBe('en');
  });

  it('is mounted above the sign-in gate, so the sign-in screen carries it too', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toMatch(/<DocumentLang \/>\s*<AppShell \/>/);
  });
});

describe('Hindi and Gujarati drop Latin capitals and letter spacing', () => {
  const css = readFileSync('src/styles/global.css', 'utf8');
  const rule = css.match(/:lang\(hi\),\s*:lang\(gu\)\s*\{([^}]*)\}/);

  it('has one rule for both scripts', () => {
    expect(rule).not.toBeNull();
  });

  it('turns off capitals and letter spacing, winning over inline styles', () => {
    const body = rule?.[1] ?? '';
    expect(body).toMatch(/text-transform:\s*none\s*!important/);
    expect(body).toMatch(/letter-spacing:\s*normal\s*!important/);
  });
});

describe('the Hindi "For You" typo stays fixed', () => {
  // "आपक" followed by anything but another Devanagari sign is the broken word ("आपके", "आपका" are fine)
  const typo = /आपक(?![ऀ-ॿ])/;

  function sources(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => join(dir, f));
  }

  it('appears in no dictionary or web source file', () => {
    const files = [...sources('../../packages/shared/src'), ...sources('src')];
    const hits = files.filter((f) => typo.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('still catches the broken spelling', () => {
    expect(typo.test('आपक के लिए')).toBe(true);
    expect(typo.test('आपके लिए')).toBe(false);
  });
});
