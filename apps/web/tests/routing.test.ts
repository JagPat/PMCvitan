import { describe, it, expect } from 'vitest';
import { pathForScreen, parseLocation, screenForPath, screensFor } from '@/lib/screens';

describe('role navigation matches policy', () => {
  it('engineers get the Site Schedule (they hold activity.start/complete)', () => {
    expect(screensFor('engineer').map((m) => m.key)).toContain('site-schedule');
  });
});

describe('project-scoped routing helpers', () => {
  it('pathForScreen builds a /projects/:id/<screen> URL', () => {
    expect(pathForScreen('decision-log', 'ambli')).toBe('/projects/ambli/decisions');
    expect(pathForScreen('inbox', 'ambli')).toBe('/projects/ambli/for-you');
    // a nested screen path is preserved under the project prefix
    expect(pathForScreen('client-decisions', 'villa2')).toBe('/projects/villa2/client/decisions');
  });

  it('pathForScreen encodes an odd project id', () => {
    expect(pathForScreen('dashboard', 'a b/c')).toBe('/projects/a%20b%2Fc/dashboard');
  });

  it('parseLocation reads the project id and screen from a scoped path', () => {
    expect(parseLocation('/projects/ambli/decisions')).toEqual({ projectId: 'ambli', screen: 'decision-log', item: null });
    expect(parseLocation('/projects/villa2/client/decisions')).toEqual({ projectId: 'villa2', screen: 'client-decisions', item: null });
  });

  it('parseLocation returns a null screen for a bare project path (→ role default)', () => {
    expect(parseLocation('/projects/ambli')).toEqual({ projectId: 'ambli', screen: null, item: null });
    expect(parseLocation('/projects/ambli/')).toEqual({ projectId: 'ambli', screen: null, item: null });
  });

  it('parseLocation returns a null screen for an unknown screen under a project', () => {
    expect(parseLocation('/projects/ambli/nope')).toEqual({ projectId: 'ambli', screen: null, item: null });
  });

  it('parseLocation treats a legacy bare path as project-less (caller uses the active project)', () => {
    expect(parseLocation('/decisions')).toEqual({ projectId: null, screen: 'decision-log', item: null });
    expect(parseLocation('/')).toEqual({ projectId: null, screen: null, item: null });
  });

  it('round-trips: parseLocation(pathForScreen(s, id)) recovers the screen', () => {
    for (const s of ['inbox', 'dashboard', 'decision-log', 'client-decisions', 'daily-log', 'places'] as const) {
      const parsed = parseLocation(pathForScreen(s, 'ambli'));
      expect(parsed).toEqual({ projectId: 'ambli', screen: s, item: null });
    }
  });

  it('B6: an item screen carries one item segment, and round-trips it', () => {
    expect(pathForScreen('places', 'ambli', 'N-1')).toBe('/projects/ambli/places/N-1');
    expect(pathForScreen('drawings', 'ambli', 'a b/c')).toBe('/projects/ambli/drawings/a%20b%2Fc');
    expect(pathForScreen('client-decisions', 'ambli', 'D-7')).toBe('/projects/ambli/client/decisions/D-7');
    // a screen with no items ignores one
    expect(pathForScreen('dashboard', 'ambli', 'x')).toBe('/projects/ambli/dashboard');
    for (const s of ['places', 'drawings', 'decision-log', 'client-decisions'] as const) {
      expect(parseLocation(pathForScreen(s, 'ambli', 'id 1/2'))).toEqual({ projectId: 'ambli', screen: s, item: 'id 1/2' });
    }
  });

  it('B6: an exact screen path wins over an item reading, and only item screens take items', () => {
    // `/client/decisions` is the client screen, never the Decision Log's item "client"
    expect(parseLocation('/projects/ambli/client/decisions')).toEqual({ projectId: 'ambli', screen: 'client-decisions', item: null });
    expect(parseLocation('/projects/ambli/dashboard/x')).toEqual({ projectId: 'ambli', screen: null, item: null });
    expect(parseLocation('/projects/ambli/places/a/b')).toEqual({ projectId: 'ambli', screen: null, item: null });
    expect(parseLocation('/projects/ambli/places/%E0%A4')).toEqual({ projectId: 'ambli', screen: 'places', item: null });
  });

  it('screenForPath still matches the bare screen paths', () => {
    expect(screenForPath('/decisions')).toBe('decision-log');
    expect(screenForPath('/site/log')).toBe('daily-log');
    expect(screenForPath('/nope')).toBeNull();
  });
});
