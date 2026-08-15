import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
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
  it('global.css applies the light ring on :focus-visible and the dark ring under a data-surface="ink" scope', () => {
    expect(globalCss).toMatch(/:focus-visible\s*{[^}]*box-shadow:\s*var\(--focus-ring\)/);
    expect(globalCss).toMatch(/\[data-surface=['"]ink['"]\]\s+:focus-visible\s*{[^}]*box-shadow:\s*var\(--focus-ring-dark\)/);
  });

  it('the left rail (ink background) opts in to the dark ring', () => {
    expect(leftRailSrc).toMatch(/data-surface="ink"/);
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

  it('focus moves into the dialog on open and returns to the opener on close', () => {
    const outside = openerButton();
    const { unmount } = render(
      <Modal onClose={() => {}}>
        <button>First</button>
        <button>Second</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
    unmount();
    expect(document.activeElement).toBe(outside);
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
});
