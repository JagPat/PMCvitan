import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { ALL_ROLES, ROLE_SUBTITLE } from '@/lib/screens';
import { RolePicker } from '@/layout/RolePicker';

/**
 * #482 QA (Jagrut, 14 Oct) — the role picker's second line. Contractors add to the site now, so their line no
 * longer says "read-only"; the PMC's line names the role it is ("Project manager (PMC)", #849), not "Architect".
 */
describe('role picker subtitles', () => {
  afterEach(() => {
    cleanup();
    useStore.setState(getInitialState());
  });

  it('no role is described as read-only', () => {
    for (const role of ALL_ROLES) expect(ROLE_SUBTITLE[role].toLowerCase()).not.toContain('read-only');
  });

  it('the contractor and PMC lines name their own role', () => {
    expect(ROLE_SUBTITLE.contractor).toBe('Contractor · builds and fixes on site');
    expect(ROLE_SUBTITLE.pmc).toBe('Project manager · full access');
    expect(ROLE_SUBTITLE.pmc).not.toMatch(/architect/i);
  });

  it('the picker shows the new line under a contractor', () => {
    useStore.setState({ role: 'contractor' });
    const { getByText, queryByText } = render(<RolePicker />);
    expect(getByText('Contractor · builds and fixes on site')).toBeTruthy();
    expect(queryByText('Contractor · read-only')).toBeNull();
  });
});
