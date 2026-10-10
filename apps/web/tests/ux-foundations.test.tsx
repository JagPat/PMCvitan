import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { navLabels, engineerNavLabels, LANG_SWITCH, type Lang, type Role, type ScreenKey } from '@vitan/shared';
import { Eyebrow, EYEBROW_MIN_SIZE } from '@/components/Eyebrow';
import { splitMobileNav, navLabelFor, MOBILE_ROLE_PRIMARY } from '@/lib/mobileNav';
import { enabledScreensFor, SCREEN_META } from '@/lib/screens';
import { defaultLangFor, langPreferenceKey, readLangPreference, writeLangPreference } from '@/lib/langPreference';

/**
 * UX foundations (the owner's design brief, slice 1): the critical-label floor for eyebrows, a
 * visible language switch for every role that is remembered per person, and the site engineer's
 * shorter phone bar (Today · Site · More).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage always exists; nothing to clear otherwise */
  }
});

const keysOf = (xs: { key: ScreenKey }[]) => xs.map((x) => x.key);
const ALL_MODULES = ['activities', 'decisions', 'inspections', 'daily-log', 'drawings', 'nodes', 'orgs'];
const ALL_CAPS = ['materials', 'labour', 'commercial'];

describe('Eyebrow — the 13px critical-label floor', () => {
  it('renders at 13px by default', () => {
    const r = render(<Eyebrow>DAILY SITE LOG</Eyebrow>);
    expect((r.getByText('DAILY SITE LOG') as HTMLElement).style.fontSize).toBe(`${EYEBROW_MIN_SIZE}px`);
  });

  it('a caller asking for 9px still gets 13px', () => {
    const r = render(<Eyebrow size={9}>TODAY&apos;S INSPECTION</Eyebrow>);
    expect((r.getByText("TODAY'S INSPECTION") as HTMLElement).style.fontSize).toBe('13px');
  });

  it('a style override cannot push it under the floor either', () => {
    const r = render(<Eyebrow style={{ fontSize: 8 }}>PROJECT HEALTH</Eyebrow>);
    expect((r.getByText('PROJECT HEALTH') as HTMLElement).style.fontSize).toBe('13px');
  });

  it('a style asking for larger than the floor is kept, in a number or in px', () => {
    const r = render(
      <>
        <Eyebrow style={{ fontSize: 20 }}>LARGE</Eyebrow>
        <Eyebrow style={{ fontSize: '18px' }}>LARGE PX</Eyebrow>
        <Eyebrow style={{ fontSize: '9px' }}>SMALL PX</Eyebrow>
      </>,
    );
    expect((r.getByText('LARGE') as HTMLElement).style.fontSize).toBe('20px');
    expect((r.getByText('LARGE PX') as HTMLElement).style.fontSize).toBe('18px');
    expect((r.getByText('SMALL PX') as HTMLElement).style.fontSize).toBe('13px');
  });

  it('a caller may still ask for larger', () => {
    const r = render(<Eyebrow size={16}>PORTFOLIO</Eyebrow>);
    expect((r.getByText('PORTFOLIO') as HTMLElement).style.fontSize).toBe('16px');
  });
});

describe("the engineer's phone bar — Today · Site · More", () => {
  it('an engineer gets exactly For You and the daily log on the bar, everything else behind More', () => {
    const items = enabledScreensFor('engineer', ALL_MODULES, ALL_CAPS);
    const { primary, secondary } = splitMobileNav(items, 'engineer');
    expect(keysOf(primary)).toEqual(['inbox', 'daily-log']);
    // nothing is dropped: every other screen the engineer holds is still one tap away
    expect(new Set([...keysOf(primary), ...keysOf(secondary)])).toEqual(new Set(keysOf(items)));
    expect(keysOf(secondary)).toEqual(keysOf(items).filter((k) => k !== 'inbox' && k !== 'daily-log'));
  });

  it('a disabled daily-log module leaves Today alone on the bar — nothing is fabricated', () => {
    const items = enabledScreensFor('engineer', ALL_MODULES.filter((m) => m !== 'daily-log'), []);
    const { primary, secondary } = splitMobileNav(items, 'engineer');
    expect(keysOf(primary)).toEqual(['inbox']);
    expect(keysOf(secondary)).not.toContain('daily-log');
  });

  it('every other role is unchanged by passing its role', () => {
    for (const role of ['pmc', 'client', 'contractor', 'consultant'] as Role[]) {
      expect(MOBILE_ROLE_PRIMARY[role]).toBeUndefined();
      const items = enabledScreensFor(role, ALL_MODULES, ALL_CAPS);
      expect(splitMobileNav(items, role)).toEqual(splitMobileNav(items));
    }
  });

  it('the engineer’s two tabs carry their day names in every language', () => {
    expect(navLabelFor('inbox', 'engineer', 'en')).toBe('Today');
    expect(navLabelFor('daily-log', 'engineer', 'en')).toBe('Site');
    expect(navLabelFor('inbox', 'engineer', 'gu')).toBe('આજે');
    expect(navLabelFor('daily-log', 'engineer', 'gu')).toBe('સાઇટ');
    expect(navLabelFor('inbox', 'engineer', 'hi')).toBe('आज');
    // another role's For You keeps its name
    expect(navLabelFor('inbox', 'pmc', 'en')).toBe('For You');
  });
});

describe('nav labels — complete in all three languages', () => {
  it('every screen has a non-blank label in en, hi and gu, and English matches the existing short label', () => {
    for (const key of Object.keys(SCREEN_META) as ScreenKey[]) {
      for (const lang of ['en', 'hi', 'gu'] as Lang[]) {
        expect(navLabels[key][lang].trim(), `${key}/${lang}`).not.toBe('');
      }
      expect(navLabels[key].en).toBe(SCREEN_META[key].short);
    }
    for (const labels of Object.values(engineerNavLabels)) {
      for (const lang of ['en', 'hi', 'gu'] as Lang[]) expect(labels![lang].trim()).not.toBe('');
    }
  });

  it('the switch offers Gujarati, Hindi and English, in that order', () => {
    expect(LANG_SWITCH.map((l) => l.key)).toEqual(['gu', 'hi', 'en']);
    expect(LANG_SWITCH.map((l) => l.mark)).toEqual(['ગુજ', 'हिं', 'EN']);
  });
});

describe('the language preference — per person, fail-closed storage', () => {
  it('keys a real session by user id and dev auth by persona', () => {
    expect(langPreferenceKey('u-1', 'engineer')).toBe('user:u-1');
    expect(langPreferenceKey(null, 'engineer')).toBe('persona:engineer');
  });

  it('engineers default to Gujarati, every other role to English', () => {
    expect(defaultLangFor('engineer')).toBe('gu');
    for (const role of ['pmc', 'client', 'contractor', 'consultant'] as Role[]) expect(defaultLangFor(role)).toBe('en');
  });

  it('round-trips a choice and rejects a value that is not a language', () => {
    writeLangPreference('user:u-1', 'hi');
    expect(readLangPreference('user:u-1')).toBe('hi');
    localStorage.setItem('vitan.lang.v1:user:u-2', 'fr');
    expect(readLangPreference('user:u-2')).toBeNull();
    expect(readLangPreference('user:nobody')).toBeNull();
  });

  it('a storage that throws reads as "no preference" and never breaks the write', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(readLangPreference('user:u-1')).toBeNull();
    expect(() => writeLangPreference('user:u-1', 'gu')).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

async function loadShell(overrides: Record<string, unknown> = {}, { api = true }: { api?: boolean } = {}) {
  if (api) vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'engineer',
    short: 'Villa Bodakdev',
    enabledModules: ALL_MODULES,
    capabilities: [],
    ...overrides,
  });
  const { BottomTabs } = await import('@/layout/BottomTabs');
  const { TopBar } = await import('@/layout/TopBar');
  const { LanguageSwitch } = await import('@/layout/LanguageSwitch');
  const { LangPreference } = await import('@/layout/LangPreference');
  const pref = await import('@/lib/langPreference');
  const { LeftRail } = await import('@/layout/LeftRail');
  return { useStore, BottomTabs, TopBar, LanguageSwitch, LangPreference, LeftRail, pref };
}

describe('LangPreference — restores and remembers the viewer’s language', () => {
  beforeEach(() => localStorage.clear());

  it('an engineer with no saved choice lands in Gujarati', async () => {
    const { useStore, LangPreference } = await loadShell({ role: 'engineer', lang: 'en' });
    render(<LangPreference />);
    expect(useStore.getState().lang).toBe('gu');
    // the default is applied, not saved: storage stays empty until the viewer chooses
    expect(readLangPreference('persona:engineer')).toBeNull();
  });

  it('a PMC with no saved choice stays in English', async () => {
    const { useStore, LangPreference } = await loadShell({ role: 'pmc', lang: 'en' });
    render(<LangPreference />);
    expect(useStore.getState().lang).toBe('en');
  });

  it('a saved choice wins over the role default, per user', async () => {
    writeLangPreference('user:u-eng', 'hi');
    const { useStore, LangPreference } = await loadShell({ role: 'engineer', sessionUserId: 'u-eng', lang: 'en' });
    render(<LangPreference />);
    expect(useStore.getState().lang).toBe('hi');
  });

  it('a project switch that changes the role, same user, applies the new role default when nothing is saved', async () => {
    const { useStore, LangPreference } = await loadShell({ role: 'engineer', sessionUserId: 'u-x', lang: 'en' });
    const r = render(<LangPreference />);
    expect(useStore.getState().lang).toBe('gu');
    // same JWT subject, re-issued as PMC on another project
    useStore.setState({ role: 'pmc' });
    r.rerender(<LangPreference />);
    expect(useStore.getState().lang).toBe('en');
    expect(readLangPreference('user:u-x')).toBeNull();
  });

  it('a saved choice survives that same role change', async () => {
    writeLangPreference('user:u-y', 'hi');
    const { useStore, LangPreference } = await loadShell({ role: 'engineer', sessionUserId: 'u-y', lang: 'en' });
    const r = render(<LangPreference />);
    expect(useStore.getState().lang).toBe('hi');
    useStore.setState({ role: 'pmc' });
    r.rerender(<LangPreference />);
    expect(useStore.getState().lang).toBe('hi');
  });

  it('a language picked on the sign-in screen is kept and saved for the user who then signs in', async () => {
    // the picker notes the choice before any console identity exists; the client default is English
    const { useStore, LangPreference, pref } = await loadShell({ role: 'client', sessionUserId: 'u-new', lang: 'gu' });
    pref.noteLangChoice('gu');
    render(<LangPreference />);
    expect(useStore.getState().lang).toBe('gu');
    expect(readLangPreference('user:u-new')).toBe('gu');
  });

  it('a sign-in choice outranks an older saved one — it is the newest thing the person said', async () => {
    writeLangPreference('user:u-old', 'en');
    const { useStore, LangPreference, pref } = await loadShell({ role: 'engineer', sessionUserId: 'u-old', lang: 'hi' });
    pref.noteLangChoice('hi');
    render(<LangPreference />);
    expect(useStore.getState().lang).toBe('hi');
    expect(readLangPreference('user:u-old')).toBe('hi');
  });

  it('a choice made inside the console is saved there and never carried to the next person', async () => {
    const { useStore, LangPreference, LanguageSwitch } = await loadShell({ role: 'client', sessionUserId: 'u-a', lang: 'en' });
    const r = render(
      <>
        <LangPreference />
        <LanguageSwitch />
      </>,
    );
    fireEvent.click(r.getByTestId('lang-seg-hi'));
    expect(readLangPreference('user:u-a')).toBe('hi');
    useStore.setState({ sessionUserId: 'u-b' });
    r.rerender(
      <>
        <LangPreference />
        <LanguageSwitch />
      </>,
    );
    // u-b chose nothing: the client default applies, not u-a's Hindi
    expect(useStore.getState().lang).toBe('en');
    expect(readLangPreference('user:u-b')).toBeNull();
  });

  it('a change is saved under this person, and another person keeps their own', async () => {
    const { useStore, LangPreference, pref } = await loadShell({ role: 'client', sessionUserId: 'u-a', lang: 'en' });
    const r = render(<LangPreference />);
    // what every picker does: note the choice, then apply it (a bare setLang is not a choice)
    act(() => {
      pref.noteLangChoice('gu');
      useStore.getState().setLang('gu');
    });
    r.rerender(<LangPreference />);
    expect(readLangPreference('user:u-a')).toBe('gu');
    // a different person signs in on the same device: their (absent) choice applies, not u-a's
    useStore.setState({ sessionUserId: 'u-b', role: 'client' });
    r.rerender(<LangPreference />);
    expect(useStore.getState().lang).toBe('en');
    expect(readLangPreference('user:u-a')).toBe('gu');
    expect(readLangPreference('user:u-b')).toBeNull();
  });
});

describe('a guest picking a language on the in-console Team Access screen', () => {
  beforeEach(() => localStorage.clear());

  // Team Access is a normal engineer screen: the host hands the phone to a worker who picks THEIR
  // language on the sign-in step. That pick is the guest's, not the host's saved preference.
  async function loadTeamAccess(overrides: Record<string, unknown> = {}) {
    const shell = await loadShell({ role: 'engineer', sessionUserId: 'u-host', screen: 'team-access', ...overrides });
    const { TeamAccessScreen } = await import('@/screens/TeamAccessScreen');
    return { ...shell, TeamAccessScreen };
  }

  it('does not overwrite the signed-in host’s saved language', async () => {
    writeLangPreference('user:u-host', 'gu');
    const { useStore, LangPreference, TeamAccessScreen } = await loadTeamAccess({ lang: 'en' });
    const r = render(
      <>
        <LangPreference />
        <TeamAccessScreen />
      </>,
    );
    expect(useStore.getState().lang).toBe('gu');
    fireEvent.click(r.getByRole('button', { name: 'हिंदी' }));
    // the guest sees their language while they sign in…
    expect(useStore.getState().lang).toBe('hi');
    // …but the host's saved choice is untouched
    expect(readLangPreference('user:u-host')).toBe('gu');
  });

  it('gives the host their own language back when they leave Team Access', async () => {
    writeLangPreference('user:u-host', 'gu');
    const { useStore, LangPreference, TeamAccessScreen } = await loadTeamAccess({ lang: 'en' });
    const r = render(
      <>
        <LangPreference />
        <TeamAccessScreen />
      </>,
    );
    fireEvent.click(r.getByRole('button', { name: 'हिंदी' }));
    expect(useStore.getState().lang).toBe('hi');
    useStore.setState({ screen: 'daily-log' });
    r.rerender(<LangPreference />);
    expect(useStore.getState().lang).toBe('gu');
    expect(readLangPreference('user:u-host')).toBe('gu');
  });

  it('a guest pick is not carried to the next identity either', async () => {
    const { useStore, LangPreference, TeamAccessScreen } = await loadTeamAccess({ role: 'client', sessionUserId: 'u-host', lang: 'en', screen: 'team-access' });
    const r = render(
      <>
        <LangPreference />
        <TeamAccessScreen />
      </>,
    );
    fireEvent.click(r.getByRole('button', { name: 'ગુજરાતી' }));
    useStore.setState({ sessionUserId: 'u-next', screen: 'inbox' });
    r.rerender(<LangPreference />);
    // u-next chose nothing: the client default, not the guest's Gujarati
    expect(useStore.getState().lang).toBe('en');
    expect(readLangPreference('user:u-next')).toBeNull();
  });

  it('a guest tapping the host’s own language leaves nothing to carry into a persona switch', async () => {
    writeLangPreference('persona:engineer', 'gu');
    const { useStore, LangPreference, TeamAccessScreen } = await loadTeamAccess({ sessionUserId: null, lang: 'en' });
    const r = render(
      <>
        <LangPreference />
        <TeamAccessScreen />
      </>,
    );
    expect(useStore.getState().lang).toBe('gu');
    fireEvent.click(r.getByRole('button', { name: 'ગુજરાતી' }));
    // the dev persona switch to a PMC: the pmc default, not the guest's tap
    useStore.setState({ role: 'pmc', screen: 'inbox' });
    r.rerender(<LangPreference />);
    expect(useStore.getState().lang).toBe('en');
    expect(readLangPreference('persona:pmc')).toBeNull();
  });

  it('at the sign-in gate a guest IS the person signing in: their pick is still carried', async () => {
    const { useStore, LangPreference, pref } = await loadShell({ role: 'contractor', sessionUserId: 'u-c', lang: 'hi' });
    pref.noteLangChoice('hi', 'guest');
    render(<LangPreference />);
    expect(useStore.getState().lang).toBe('hi');
    expect(readLangPreference('user:u-c')).toBe('hi');
  });

  it('the host explicitly picking back their default after a guest session is saved', async () => {
    // Codex on #666: no saved choice, the engineer default gu on screen, a guest shows hi, and the
    // host then picks ગુજ on the rail — an explicit choice, even though it equals the default
    const { useStore, LangPreference, TeamAccessScreen, LanguageSwitch } = await loadTeamAccess({ lang: 'en' });
    const r = render(
      <>
        <LangPreference />
        <LanguageSwitch />
        <TeamAccessScreen />
      </>,
    );
    expect(useStore.getState().lang).toBe('gu');
    fireEvent.click(r.getByRole('button', { name: 'हिंदी' }));
    fireEvent.click(r.getByTestId('lang-seg-gu'));
    expect(readLangPreference('user:u-host')).toBe('gu');
    // so a later same-user project switch to PMC keeps it rather than the PMC default
    useStore.setState({ role: 'pmc', screen: 'inbox' });
    r.rerender(
      <>
        <LangPreference />
        <LanguageSwitch />
      </>,
    );
    expect(useStore.getState().lang).toBe('gu');
  });

  it('the host explicitly picking the language already on screen is saved (no guest involved)', async () => {
    const { useStore, LangPreference, LanguageSwitch } = await loadShell({ role: 'engineer', sessionUserId: 'u-e', lang: 'en' });
    const r = render(
      <>
        <LangPreference />
        <LanguageSwitch />
      </>,
    );
    expect(useStore.getState().lang).toBe('gu'); // the default, applied, not saved
    expect(readLangPreference('user:u-e')).toBeNull();
    fireEvent.click(r.getByTestId('lang-seg-gu'));
    expect(readLangPreference('user:u-e')).toBe('gu');
  });

  it('the host changing language on the rail while a guest is on Team Access is still saved', async () => {
    writeLangPreference('user:u-host', 'gu');
    const { useStore, LangPreference, TeamAccessScreen, LanguageSwitch } = await loadTeamAccess({ lang: 'en' });
    const r = render(
      <>
        <LangPreference />
        <LanguageSwitch />
        <TeamAccessScreen />
      </>,
    );
    fireEvent.click(r.getByRole('button', { name: 'हिंदी' }));
    fireEvent.click(r.getByTestId('lang-seg-en'));
    expect(useStore.getState().lang).toBe('en');
    expect(readLangPreference('user:u-host')).toBe('en');
  });
});

describe('the sign-in gate picker — carried only to the team member who signs in', () => {
  beforeEach(() => localStorage.clear());

  // the gate: no session, LangPreference not mounted; the WHO step's picker notes the choice. The worker and
  // trade in-charge paths are prototype-only (Top 10 #1, #769), so their cases run in the API-less demo
  async function loadGate({ api = true }: { api?: boolean } = {}) {
    const shell = await loadShell({ role: 'client', sessionUserId: null, lang: 'en' }, { api });
    const { TeamAccessScreen } = await import('@/screens/TeamAccessScreen');
    return { ...shell, TeamAccessScreen };
  }

  it('a worker’s pick at the gate is not saved for the next person who signs in', async () => {
    const { useStore, LangPreference, TeamAccessScreen } = await loadGate({ api: false });
    const gate = render(<TeamAccessScreen />);
    fireEvent.click(gate.getByRole('button', { name: 'हिंदी' }));
    // the worker flow: terminal inside the gate, never takes a token
    fireEvent.click(gate.getByRole('button', { name: /मज़दूर/ }));
    gate.unmount();
    // later, a client signs in on the same phone without touching the picker
    act(() => useStore.setState({ sessionUserId: 'u-client', role: 'client', screen: 'inbox' }));
    render(<LangPreference />);
    expect(readLangPreference('user:u-client')).toBeNull();
    expect(useStore.getState().lang).toBe('en');
  });

  it('a trade in-charge’s pick at the gate is not carried either', async () => {
    const { useStore, LangPreference, TeamAccessScreen } = await loadGate({ api: false });
    const gate = render(<TeamAccessScreen />);
    fireEvent.click(gate.getByRole('button', { name: 'ગુજરાતી' }));
    fireEvent.click(gate.getByRole('button', { name: /મિસ્ત્રી/ }));
    gate.unmount();
    act(() => useStore.setState({ sessionUserId: 'u-client', role: 'client', screen: 'inbox' }));
    render(<LangPreference />);
    expect(readLangPreference('user:u-client')).toBeNull();
    expect(useStore.getState().lang).toBe('en');
  });

  it('a team member’s own pick at the gate is still carried and saved for them', async () => {
    const { useStore, LangPreference, TeamAccessScreen } = await loadGate();
    const gate = render(<TeamAccessScreen />);
    fireEvent.click(gate.getByRole('button', { name: 'हिंदी' }));
    fireEvent.click(gate.getByRole('button', { name: /टीम सदस्य/ }));
    gate.unmount();
    act(() => useStore.setState({ sessionUserId: 'u-client', role: 'client', screen: 'inbox' }));
    render(<LangPreference />);
    expect(useStore.getState().lang).toBe('hi');
    expect(readLangPreference('user:u-client')).toBe('hi');
  });
});

describe('the language switch is visible and works for every role', () => {
  it('the phone top bar opens a language sheet; choosing Hindi applies it and closes', async () => {
    const { useStore, TopBar } = await loadShell({ role: 'client', lang: 'en' });
    const r = render(<TopBar />);
    const btn = r.getByTestId('lang-switch');
    expect(btn.textContent).toBe('EN');
    expect(btn).toHaveAccessibleName('Language: English');
    fireEvent.click(btn);
    const sheet = r.getByTestId('language-sheet');
    expect(sheet).toBeInTheDocument();
    expect(r.getByTestId('lang-option-en')).toHaveAttribute('aria-pressed', 'true');
    expect(r.getByTestId('lang-option-gu')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(r.getByTestId('lang-option-hi'));
    expect(useStore.getState().lang).toBe('hi');
    expect(r.queryByTestId('language-sheet')).not.toBeInTheDocument();
    expect(r.getByTestId('lang-switch').textContent).toBe('हिं');
  });

  it('the rail switch shows all three and marks the current one pressed', async () => {
    const { useStore, LanguageSwitch } = await loadShell({ role: 'pmc', lang: 'en' });
    const r = render(<LanguageSwitch />);
    expect(r.getByTestId('lang-seg-en')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(r.getByTestId('lang-seg-gu'));
    expect(useStore.getState().lang).toBe('gu');
    expect(r.getByTestId('lang-seg-gu')).toHaveAttribute('aria-pressed', 'true');
    expect(r.getByTestId('lang-seg-en')).toHaveAttribute('aria-pressed', 'false');
    expect(r.getByRole('group')).toHaveAccessibleName('ભાષા');
  });
});

describe('LeftRail — the desktop nav follows the switch above it', () => {
  it('in Gujarati the rail header and screen names are Gujarati; in English the full names return', async () => {
    const { useStore, LeftRail } = await loadShell({ role: 'pmc', lang: 'en' });
    const r = render(<LeftRail />);
    expect(r.getByText('SCREENS')).toBeInTheDocument();
    expect(r.getByRole('button', { name: /Site Schedule/ })).toBeInTheDocument();
    fireEvent.click(r.getByTestId('lang-seg-gu'));
    expect(useStore.getState().lang).toBe('gu');
    expect(r.getByText('સ્ક્રીન')).toBeInTheDocument();
    expect(r.getByRole('button', { name: /સમયપત્રક/ })).toBeInTheDocument();
    expect(r.queryByRole('button', { name: /Site Schedule/ })).not.toBeInTheDocument();
    fireEvent.click(r.getByTestId('lang-seg-en'));
    expect(r.getByRole('button', { name: /Site Schedule/ })).toBeInTheDocument();
  });

  it('an engineer’s rail carries their day names, Today and Site, in their language', async () => {
    const { LeftRail } = await loadShell({ role: 'engineer', lang: 'gu' });
    const r = render(<LeftRail />);
    expect(r.getByRole('button', { name: /આજે/ })).toBeInTheDocument();
    expect(r.getByRole('button', { name: /સાઇટ/ })).toBeInTheDocument();
  });
});

describe('BottomTabs — the engineer’s bar, rendered', () => {
  it('shows Today · Site · More in Gujarati, and More still reaches the rest', async () => {
    const { useStore, BottomTabs } = await loadShell({ role: 'engineer', lang: 'gu' });
    const r = render(<BottomTabs />);
    expect(r.getByTestId('tab-inbox').textContent).toContain('આજે');
    expect(r.getByTestId('tab-daily-log').textContent).toContain('સાઇટ');
    expect(r.getByTestId('tab-more').textContent).toContain('વધુ');
    expect(r.queryByTestId('tab-site-schedule')).not.toBeInTheDocument();
    expect(r.queryByTestId('tab-places')).not.toBeInTheDocument();
    fireEvent.click(r.getByTestId('tab-more'));
    expect(r.getByTestId('more-item-site-schedule').textContent).toContain('સમયપત્રક');
    fireEvent.click(r.getByTestId('more-item-places'));
    expect(useStore.getState().screen).toBe('places');
  });

  it('in English the More sheet keeps the full screen names', async () => {
    const { BottomTabs } = await loadShell({ role: 'engineer', lang: 'en' });
    const r = render(<BottomTabs />);
    expect(r.getByTestId('tab-inbox').textContent).toContain('Today');
    fireEvent.click(r.getByTestId('tab-more'));
    expect(r.getByTestId('more-item-site-schedule').textContent).toContain('Site Schedule');
  });
});
