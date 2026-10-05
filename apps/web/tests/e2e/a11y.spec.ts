import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * B5: an automated WCAG 2.1 A/AA sweep (axe-core) over every primary screen, at desktop and
 * phone width. It runs in demo mode, so it needs no sign-in and writes nothing. A violation
 * fails the run with the rule, its impact and the offending nodes, so a regression in contrast,
 * names or roles is caught before review rather than in an audit.
 *
 * A screen outside the default (pmc) persona's set redirects to For You on a direct load, so
 * those are reached as their own persona: switch with the desktop role picker (and to English,
 * since the engineer's default is Gujarati), then open the screen from the rail — the only
 * role-carrying path, since a reload resets the demo persona.
 */
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const VIEWPORTS = [
  { name: 'desktop', size: DESKTOP },
  { name: 'phone', size: PHONE },
];

const PMC_SCREENS = ['for-you', 'dashboard', 'drafts', 'schedule', 'decisions', 'review', 'drawings', 'places', 'team', 'portfolio'];
const PERSONA_SCREENS = [
  { role: 'Engineer', label: 'Daily Site Log', path: 'site/log' },
  { role: 'Engineer', label: "Today's Checklist", path: 'site/checklist' },
  { role: 'Engineer', label: 'Team Access & Login', path: 'access' },
  { role: 'Client', label: 'Decisions Waiting', path: 'client/decisions' },
  { role: 'Client', label: 'Project Health', path: 'client/health' },
];

async function expectNoViolations(page: Page) {
  // let the screen's first render and its async demo data settle before scanning
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const report = violations.map((v) => `${v.id} [${v.impact}] ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`);
  expect(report, report.join('\n')).toEqual([]);
}

for (const vp of VIEWPORTS) {
  for (const screen of PMC_SCREENS) {
    test(`${screen} has no WCAG 2.1 A/AA violations (${vp.name})`, async ({ page }) => {
      await page.setViewportSize(vp.size);
      await page.goto(`/projects/ambli/${screen}`);
      await expect(page).toHaveURL(new RegExp(`/projects/ambli/${screen}$`));
      await expectNoViolations(page);
    });
  }

  for (const s of PERSONA_SCREENS) {
    test(`${s.path} (${s.role}) has no WCAG 2.1 A/AA violations (${vp.name})`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.goto('/projects/ambli/for-you');
      await page.getByRole('button', { name: s.role, exact: true }).click();
      await page.getByRole('button', { name: 'EN', exact: true }).click();
      await page.getByRole('navigation').getByRole('button', { name: new RegExp(`^${s.label}( \\d+)?$`) }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/ambli/${s.path}$`));
      await page.setViewportSize(vp.size);
      await expectNoViolations(page);
    });
  }
}

test('schedule gate reasons: one disclosure that fits its column and lists every gate in words', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/projects/ambli/schedule');
  const gates = page.getByTestId('gates-ACT-31');
  const box = (await gates.boundingBox())!;
  const row = (await page.getByTestId('sched-ACT-31').boundingBox())!;
  // five 44px buttons once overflowed the 136px column over the row's action; the group stays inside it
  expect(box.width).toBeLessThanOrEqual(136);
  expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width);
  await expect(gates).toHaveAttribute('aria-expanded', 'false');
  await gates.click();
  await expect(gates).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('gate-reasons-ACT-31').locator('li')).toHaveCount(5);
});

test('the review queue is a pressed-button group, not a half-built tab set', async ({ page }) => {
  await page.goto('/projects/ambli/review');
  await expect(page.getByRole('tab')).toHaveCount(0);
  const queue = page.getByRole('group', { name: 'Review queue' });
  if (await queue.count()) {
    await expect(queue.locator('button[aria-pressed="true"]')).toHaveCount(1);
  }
});
