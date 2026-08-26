import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { Modal } from '@/components/Modal';
import { PhotoViewer } from '@/components/PhotoViewer';

// Read as FILES, not vite `?raw`/`?inline` imports — vitest stubs .css modules
// to empty strings regardless of the query, which would turn these seals into
// vacuous green.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const tokensCss = read('../src/styles/tokens.css');
const globalCss = read('../src/styles/global.css');
const leftRailSrc = read('../src/layout/LeftRail.tsx');

/**
 * UX Wave 0, unit F-1a — focus foundation (docs/ux/WAVE_0_FOUNDATION.md).
 *
 * Reproduced at this head before the fix: apps/web/src carries ZERO
 * `:focus-visible` rules while 14 sites actively remove `outline`, so keyboard
 * focus is invisible app-wide; and no dialog manages focus (open leaves focus
 * behind the backdrop, close strands it). The probes below assert the two
 * contrast-checked ring tokens, the global `:focus-visible` replacement rule
 * (light + ink surfaces), and the dialog focus discipline — in on open,
 * Tab-wrap while open, restored to the opener on close — at the shared
 * primitive (`Modal`, `useFocusTrap`) and the two custom overlays.
 */

function token(name: string): string {
  const m = tokensCss.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token ${name} not found in tokens.css`);
  return m[1];
}

/** WCAG 2.x relative luminance + contrast ratio. */
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
});

// ── the ring tokens, contrast-verified (never assumed) ─────────────────────────

describe('F-1a focus tokens', () => {
  it('tokens.css defines the light ring (paper inset + accent) and the dark ring (ink inset + sidebar-text)', () => {
    const ring = tokensCss.match(/--focus-ring:\s*([^;]+);/)?.[1] ?? '';
    const ringDark = tokensCss.match(/--focus-ring-dark:\s*([^;]+);/)?.[1] ?? '';
    expect(ring).toContain('var(--paper)');
    expect(ring).toContain('var(--accent)');
    expect(ringDark).toContain('var(--ink)');
    expect(ringDark).toContain('var(--sidebar-text)');
  });

  it('the accent ring passes 3:1 on every light surface, the sidebar-text ring passes on ink — and accent on ink FAILS, which is why the dark ring exists', () => {
    const accent = token('--accent');
    const ink = token('--ink');
    const sidebarText = token('--sidebar-text');
    expect(contrast(accent, token('--canvas'))).toBeGreaterThanOrEqual(3);
    expect(contrast(accent, token('--panel'))).toBeGreaterThanOrEqual(3);
    expect(contrast(accent, token('--paper'))).toBeGreaterThanOrEqual(3);
    expect(contrast(sidebarText, ink)).toBeGreaterThanOrEqual(3);
    // The measured failure that forced the two-token design: 2.95:1.
    expect(contrast(accent, ink)).toBeLessThan(3);
  });
});

// ── the global replacement rule: outline may be removed ONLY because this exists ─

describe('F-1a global focus visibility', () => {
  it('the ring FOLLOWS THE SURFACE through the inherited --active-focus-ring property (nearest ancestor wins, so a light modal inside the ink rail resolves light)', () => {
    expect(globalCss).toMatch(/:root\s*{[^}]*--active-focus-ring:\s*var\(--focus-ring\)/);
    expect(globalCss).toMatch(/\[data-surface=['"]ink['"]\]\s*{[^}]*--active-focus-ring:\s*var\(--focus-ring-dark\)/);
    expect(globalCss).toMatch(/\[data-surface=['"]light['"]\]\s*{[^}]*--active-focus-ring:\s*var\(--focus-ring\)/);
    expect(globalCss).toMatch(/:focus-visible\s*{[^}]*box-shadow:\s*var\(--active-focus-ring\)/);
  });

  it('forced-colors mode restores a system-color outline WITH !important — inline outline:none declarations outrank any non-important author rule', () => {
    expect(globalCss).toMatch(/@media\s*\(forced-colors:\s*active\)[\s\S]*?:focus-visible\s*{[^}]*outline:\s*2px solid Highlight\s*!important/);
  });

  it('the left rail (ink background) opts in to the dark ring', () => {
    expect(leftRailSrc).toMatch(/data-surface="ink"/);
  });

  it('responsive/module ink surfaces set the ring in their own CSS: the mobile top bar and the notification panel', () => {
    const topBarCss = read('../src/layout/TopBar.module.css');
    const notifCss = read('../src/layout/NotificationPanel.module.css');
    expect(topBarCss).toMatch(/--active-focus-ring:\s*var\(--focus-ring-dark\)/);
    expect(notifCss).toMatch(/--active-focus-ring:\s*var\(--focus-ring-dark\)/);
  });
});

// ── the dialog discipline at the shared primitive ──────────────────────────────

describe('F-1a Modal focus trap', () => {
  function openerButton(): HTMLButtonElement {
    const outside = document.createElement('button');
    outside.textContent = 'opener';
    document.body.appendChild(outside);
    outside.focus();
    return outside;
  }

  it('focus moves into the dialog on open and returns to the opener on close — and the dialog is a LIGHT surface even inside an ink container', () => {
    const outside = openerButton();
    const { container, unmount } = render(
      <Modal onClose={() => {}}>
        <button>First</button>
        <button>Second</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
    expect(container.querySelector('[role="dialog"][data-surface="light"]')).not.toBeNull();
    unmount();
    expect(document.activeElement).toBe(outside);
  });

  it('when the opener is GONE at close, focus falls to the first focusable in the nearest surviving ancestor — not to body', () => {
    const host = document.createElement('div');
    const opener = document.createElement('button');
    opener.textContent = 'approve';
    const sibling = document.createElement('button');
    sibling.textContent = 'next decision';
    host.append(opener, sibling);
    document.body.appendChild(host);
    opener.focus();
    const { unmount } = render(
      <Modal onClose={() => {}}>
        <button>Confirm</button>
      </Modal>,
    );
    opener.remove();
    unmount();
    expect(document.activeElement).toBe(sibling);
    host.remove();
  });

  it('Tab wraps from the last control to the first, and Shift+Tab wraps back', () => {
    openerButton();
    render(
      <Modal onClose={() => {}}>
        <button>First</button>
        <button>Second</button>
      </Modal>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    second.focus();
    fireEvent.keyDown(second, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(second);
  });

  it('the opener-gone fallback walks PAST an emptied ancestor until something focusable exists', () => {
    // wrapper > card > opener; the page's next focusable lives OUTSIDE the
    // wrapper. Removing the whole card leaves wrapper connected but EMPTY —
    // stopping at the nearest survivor would strand focus on body.
    const wrapper = document.createElement('div');
    const card = document.createElement('div');
    const opener = document.createElement('button');
    opener.textContent = 'approve last';
    card.appendChild(opener);
    wrapper.appendChild(card);
    const elsewhere = document.createElement('button');
    elsewhere.textContent = 'nav';
    document.body.append(wrapper, elsewhere);
    opener.focus();
    const { unmount } = render(
      <Modal onClose={() => {}}>
        <button>Confirm</button>
      </Modal>,
    );
    card.remove();
    unmount();
    expect(document.activeElement).toBe(elsewhere);
    wrapper.remove();
    elsewhere.remove();
  });

  it('the opener-gone fallback preserves RELATIVE POSITION — the nearest FOLLOWING control wins over an earlier one', () => {
    // wrapper > [cardA, cardB(opener), cardC]: approving away the MIDDLE card
    // must continue keyboard flow to cardC's control, never jump backward to
    // cardA's just because it is first in the container.
    const wrapper = document.createElement('div');
    const cardA = document.createElement('div');
    const btnA = document.createElement('button');
    btnA.textContent = 'earlier decision';
    cardA.appendChild(btnA);
    const cardB = document.createElement('div');
    const opener = document.createElement('button');
    opener.textContent = 'approve middle';
    cardB.appendChild(opener);
    const cardC = document.createElement('div');
    const btnC = document.createElement('button');
    btnC.textContent = 'next decision';
    cardC.appendChild(btnC);
    wrapper.append(cardA, cardB, cardC);
    document.body.appendChild(wrapper);
    opener.focus();
    const { unmount } = render(
      <Modal onClose={() => {}}>
        <button>Confirm</button>
      </Modal>,
    );
    cardB.remove();
    unmount();
    expect(document.activeElement).toBe(btnC);
    wrapper.remove();
  });

  it('a PRECEDING control is chosen only when nothing focusable FOLLOWS the vanished opener', () => {
    // Same shape, but the following card is ALSO gone — only then may focus
    // fall back to the earlier card.
    const wrapper = document.createElement('div');
    const cardA = document.createElement('div');
    const btnA = document.createElement('button');
    btnA.textContent = 'earlier decision';
    cardA.appendChild(btnA);
    const cardB = document.createElement('div');
    const opener = document.createElement('button');
    opener.textContent = 'approve last';
    cardB.appendChild(opener);
    const cardC = document.createElement('div');
    const btnC = document.createElement('button');
    btnC.textContent = 'also dismissed';
    cardC.appendChild(btnC);
    wrapper.append(cardA, cardB, cardC);
    document.body.appendChild(wrapper);
    opener.focus();
    const { unmount } = render(
      <Modal onClose={() => {}}>
        <button>Confirm</button>
      </Modal>,
    );
    cardB.remove();
    cardC.remove();
    unmount();
    expect(document.activeElement).toBe(btnA);
    wrapper.remove();
  });

  it('a Tab from focus STRANDED ON BODY (the modal removed its focused control) is recaptured into the dialog', () => {
    openerButton();
    const { rerender } = render(
      <Modal onClose={() => {}}>
        <button>Keep</button>
        <button>Removable</button>
      </Modal>,
    );
    screen.getByRole('button', { name: 'Removable' }).focus();
    // The dialog's own content change removes the focused control.
    rerender(
      <Modal onClose={() => {}}>
        <button>Keep</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
  });

  it('Escape still dismisses', () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose}>
        <button>Only</button>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── the custom overlays carry the same discipline ──────────────────────────────

describe('F-1a PhotoViewer focus', () => {
  it('focus lands on the close control, the overlay is an ink surface, and focus restores on close', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const { unmount, container } = render(<PhotoViewer url="x.png" onClose={() => {}} />);
    expect(container.querySelector('[data-surface="ink"]')).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close photo' }));
    unmount();
    expect(document.activeElement).toBe(outside);
  });
});

describe('F-1a ProjectSwitcher dropdown focus', () => {
  async function loadSwitcher() {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    const { ProjectSwitcher } = await import('@/layout/ProjectSwitcher');
    useStore.setState(getInitialState());
    useStore.setState({
      ...scope.emptyProjectData(),
      activeProjectId: 'p1',
      projectLoadState: 'ready',
      role: 'pmc',
      short: 'Alpha',
      memberships: [
        { projectId: 'p1', short: 'Alpha', role: 'pmc', orgId: 'o1' },
        { projectId: 'p2', short: 'Beta', role: 'pmc', orgId: 'o1' },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return ProjectSwitcher;
  }

  it('opening moves focus into the panel; Escape closes it and returns focus to the trigger', async () => {
    const ProjectSwitcher = await loadSwitcher();
    render(<ProjectSwitcher />);
    const trigger = screen.getByTestId('project-switcher');
    trigger.focus();
    fireEvent.click(trigger);
    // The trigger also carries the active project's name — the panel row is the OTHER match.
    const firstRow = screen.getAllByRole('button', { name: /Alpha/ }).find((b) => b !== trigger)!;
    expect(firstRow).toBeTruthy();
    expect(document.activeElement).toBe(firstRow);
    fireEvent.keyDown(firstRow, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /Beta/ })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('the popup is NON-MODAL: it claims no dialog role, and an outside interaction light-dismisses it without stealing focus back', async () => {
    const ProjectSwitcher = await loadSwitcher();
    const outside = document.createElement('button');
    outside.textContent = 'rail nav';
    document.body.appendChild(outside);
    const { container } = render(<ProjectSwitcher />);
    const trigger = screen.getByTestId('project-switcher');
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getAllByRole('button', { name: /Beta/ }).length).toBeGreaterThan(0);
    // No modal claim anywhere in the switcher subtree, and no menu overclaim
    // on the trigger — the honest semantics are a disclosure (aria-expanded)
    // opening a NAMEABLE group (aria-label on a bare div names nothing).
    expect(container.querySelector('[role="dialog"], [aria-modal]')).toBeNull();
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const group = container.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(group).toHaveAttribute('aria-label', 'Switch project');
    // Clicking elsewhere closes the popup and leaves focus where the user put it.
    fireEvent.mouseDown(outside);
    expect(screen.queryByRole('button', { name: /Beta/ })).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
    outside.remove();
  });

  it('Escape closes the open popup even when focus is back ON THE TRIGGER (Shift+Tab landed there)', async () => {
    const ProjectSwitcher = await loadSwitcher();
    render(<ProjectSwitcher />);
    const trigger = screen.getByTestId('project-switcher');
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getAllByRole('button', { name: /Beta/ }).length).toBeGreaterThan(0);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /Beta/ })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a switcher that CANNOT open claims no disclosure state', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    const { ProjectSwitcher } = await import('@/layout/ProjectSwitcher');
    useStore.setState(getInitialState());
    useStore.setState({
      ...scope.emptyProjectData(),
      activeProjectId: 'p1',
      projectLoadState: 'ready',
      role: 'engineer',
      short: 'Alpha',
      memberships: [{ projectId: 'p1', short: 'Alpha', role: 'engineer', orgId: 'o1' }],
      myOrgs: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    render(<ProjectSwitcher />);
    expect(screen.getByTestId('project-switcher')).not.toHaveAttribute('aria-expanded');
  });

  it('an INTERNAL action parks focus on the trigger before its row unmounts — focus never falls to body', async () => {
    const ProjectSwitcher = await loadSwitcher();
    render(<ProjectSwitcher />);
    const trigger = screen.getByTestId('project-switcher');
    trigger.focus();
    fireEvent.click(trigger);
    const manage = screen.getByRole('button', { name: /Manage team/ });
    manage.focus();
    fireEvent.click(manage);
    expect(screen.queryByRole('button', { name: /Manage team/ })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

// ── the ink-surface INVENTORY (round 9) ────────────────────────────────────────

describe('F-1a ink-surface inventory', () => {
  // Every ink-background site in the app, pinned and classified. An
  // INTERACTIVE ink container (it holds focusable controls) must resolve the
  // dark ring — `data-surface="ink"` on the element itself, or its module CSS
  // setting `--active-focus-ring` beside the ink background. An ink-FILLED
  // control or a decoration sitting on a light surface keeps the light ring:
  // the ring draws against the SURROUNDING surface, not the control's own
  // fill. A NEW ink site fails this probe until it is classified here.
  const TSX_INK = /background:\s*'var\(--ink\)'/g;
  const CSS_INK = /background(?:-color)?:\s*var\(--ink\)/;

  // src-relative path → { total ink sites, of which marked containers }
  const TSX_INVENTORY: Record<string, { total: number; marked: number }> = {
    'components/Toast.tsx': { total: 1, marked: 0 }, // non-interactive toast
    'layout/ProjectSwitcher.tsx': { total: 1, marked: 0 }, // Create button fill
    'screens/ClientHealthScreen.tsx': { total: 1, marked: 0 }, // card-button fill
    'screens/DailyLogScreen.tsx': { total: 2, marked: 1 }, // checked-in card (Check out) IS a surface; photo button is a fill
    'screens/TeamScreen.tsx': { total: 2, marked: 0 }, // avatar circles
    'screens/DrawingsScreen.tsx': { total: 1, marked: 0 }, // dlBtn control fill
    'screens/DashboardScreen.tsx': { total: 1, marked: 1 }, // live-from-site strip (View Schedule) IS a surface
    'screens/TeamAccessScreen.tsx': { total: 4, marked: 1 }, // job-card header (Sign out) IS a surface; icon box, badge row, avatar are decorations
    'screens/ClientDecisionsScreen.tsx': { total: 1, marked: 0 }, // label chip
  };

  // css file → how that ink surface resolves the dark ring
  const CSS_INVENTORY: Record<string, 'sets-active-focus-ring' | 'element-data-surface'> = {
    'layout/TopBar.module.css': 'sets-active-focus-ring',
    'layout/CreateControl.module.css': 'sets-active-focus-ring',
    'layout/NotificationPanel.module.css': 'sets-active-focus-ring',
    'layout/LeftRail.module.css': 'element-data-surface',
  };

  // vitest runs with cwd = apps/web; a wrong cwd fails LOUDLY (ENOENT), and
  // the completeness assertion below would catch an empty listing anyway.
  const files = (readdirSync('src', { recursive: true }) as string[])
    .map((f) => String(f).replace(/\\/g, '/'))
    .sort();

  it('the inventory is COMPLETE — every ink-background site in src is pinned here', () => {
    const foundTsx: Record<string, number> = {};
    for (const f of files.filter((f) => f.endsWith('.tsx'))) {
      const n = (read(`../src/${f}`).match(TSX_INK) ?? []).length;
      if (n > 0) foundTsx[f] = n;
    }
    expect(foundTsx).toEqual(
      Object.fromEntries(Object.entries(TSX_INVENTORY).map(([f, v]) => [f, v.total])),
    );
    const foundCss = files.filter((f) => f.endsWith('.css') && CSS_INK.test(read(`../src/${f}`)));
    expect(foundCss.sort()).toEqual(Object.keys(CSS_INVENTORY).sort());
  });

  it('every INTERACTIVE ink container resolves the dark ring; fills and decorations do not claim it', () => {
    for (const [f, { marked }] of Object.entries(TSX_INVENTORY)) {
      const src = read(`../src/${f}`);
      let markedFound = 0;
      for (const m of src.matchAll(TSX_INK)) {
        // The style prop sits inside the opening tag; the element's own
        // attributes run from the nearest preceding '<' to the match.
        const tag = src.slice(src.lastIndexOf('<', m.index), m.index);
        if (tag.includes('data-surface="ink"')) markedFound += 1;
      }
      expect({ file: f, marked: markedFound }).toEqual({ file: f, marked });
    }
    for (const [f, mode] of Object.entries(CSS_INVENTORY)) {
      if (mode === 'sets-active-focus-ring') {
        expect(read(`../src/${f}`)).toMatch(/--active-focus-ring:\s*var\(--focus-ring-dark\)/);
      } else {
        // The component the stylesheet belongs to carries the mark itself.
        const component = f.replace('.module.css', '.tsx');
        expect(read(`../src/${component}`)).toContain('data-surface="ink"');
      }
    }
  });
});
